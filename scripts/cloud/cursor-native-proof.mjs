import { createHash } from 'node:crypto';

const sha = /^[a-f0-9]{40}$/;
const fail = message => { throw Object.assign(new Error(message), { code: 'SOURCE_UNVERIFIED' }); };
const marker = 'CG_CURSOR_PROOF ';
const record = value => value && typeof value === 'object' && !Array.isArray(value);

// The host chooses argv from its explicitly authorized test policy. This
// produces an observation command, not a model loop or a shell sandbox.
export function cursorProofCommand({ nonce, sourceSha, argv }) {
  if (!/^[a-f0-9]{64}$/.test(nonce || '') || !sha.test(sourceSha || '') || !Array.isArray(argv) || !argv.length || argv.length > 40 ||
      argv.some(value => typeof value !== 'string' || !value || value.length > 2000 || /[\x00-\x1f]/.test(value))) fail('Use a fixed source, nonce and explicitly authorized test argv');
  const program = `import {spawnSync} from 'node:child_process';
const readGit = args => {const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:262144,timeout:10000,shell:false});if(r.error||r.signal||r.status!==0)throw new Error('Git observation failed');return r.stdout.trim();};
const snapshot = () => ({sha:readGit(['rev-parse','HEAD']),clean:readGit(['status','--porcelain','--untracked-files=all'])===''});
const before=snapshot();const argv=${JSON.stringify(argv)};
const result=before.sha===${JSON.stringify(sourceSha)}&&before.clean?spawnSync(argv[0],argv.slice(1),{encoding:'utf8',maxBuffer:262144,timeout:300000,shell:false}):null;
const after=snapshot();console.log(${JSON.stringify(marker)}+JSON.stringify({format:1,nonce:${JSON.stringify(nonce)},sourceSha:${JSON.stringify(sourceSha)},argv,before,after,exitCode:result?.status??null,signal:result?.signal??null,spawnError:result?.error?.code??null,stdout:result?.stdout??'',stderr:result?.stderr??''}));`;
  // POSIX quoting is exact, including apostrophes in approved argv. Never
  // interpolate model arguments into a shell command outside this literal.
  return "node --input-type=module -e '" + program.replace(/'/g, "'\\''") + "'";
}

function tapCounts(output) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...output.matchAll(new RegExp('^# ' + key + ' (\\d+)\\r?$', 'gm'))];
    if (matches.length !== 1) fail('Expected one complete TAP test summary');
    counts[key] = Number(matches[0][1]);
    if (!Number.isSafeInteger(counts[key])) fail('Invalid native test count');
  }
  if (!counts.tests || counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) fail('No valid native test execution was observed');
  return counts;
}

// Only provider-scoped typed tool output is an execution observation. This is
// NOT an attestation of immutable source during the test: the guest controls
// its environment and a before/after sample cannot detect edits then restores.
// Never use this result alone as verifiedCi or synthesize arbitrary TODO checks.
export function verifyCursorNativeProof({ observation, run, command, nonce, sourceSha, argv }) {
  if (!observation?.complete || observation.agentId !== run?.agentId || observation.runId !== run?.id || run.status !== 'FINISHED' ||
      command !== cursorProofCommand({ nonce, sourceSha, argv })) fail('Use the confirmed exact native Run and observation command');
  const results = observation.events?.filter(event => event.event === 'result') || [];
  if (observation.events?.some(event => event.event === 'error') || results.length !== 1 || results[0].data?.runId !== run.id || results[0].data.status !== 'FINISHED') fail('Native stream did not confirm the same completed Run');
  const matching = new Map();
  for (const event of observation.events || []) {
    const tool = event.data;
    if (event.event !== 'tool_call' || tool.name !== 'run_terminal_cmd' || tool.status !== 'completed' || tool.args?.command !== command) continue;
    if (typeof tool.callId !== 'string' || !tool.callId || tool.truncated && Object.keys(tool.truncated).length || tool.result?.isBackground !== false ||
        !record(tool.result.success) || tool.result.success.command !== command || typeof tool.result.success.stdout !== 'string') fail('Native terminal output is missing, backgrounded or truncated');
    const content = JSON.stringify(tool);
    if (matching.has(tool.callId) && matching.get(tool.callId).content !== content) fail('Native tool evidence changed');
    matching.set(tool.callId, { content, stdout: tool.result.success.stdout });
  }
  if (matching.size !== 1) fail('Expected exactly one completed native proof command');
  const [callId, tool] = matching.entries().next().value;
  const lines = tool.stdout.split(/\r?\n/).filter(line => line.startsWith(marker));
  if (lines.length !== 1) fail('Expected one native proof envelope');
  let proof;
  try { proof = JSON.parse(lines[0].slice(marker.length)); } catch { fail('Invalid native proof envelope'); }
  if (!record(proof) || proof.format !== 1 || proof.nonce !== nonce || proof.sourceSha !== sourceSha || JSON.stringify(proof.argv) !== JSON.stringify(argv) ||
      proof.before?.sha !== sourceSha || proof.after?.sha !== sourceSha || proof.before?.clean !== true || proof.after?.clean !== true ||
      !Number.isInteger(proof.exitCode) || proof.signal !== null || proof.spawnError !== null || typeof proof.stdout !== 'string' || typeof proof.stderr !== 'string') fail('The exact source, clean checkout or actual process status was not proved');
  const counts = tapCounts(proof.stdout);
  const testOutcome = proof.exitCode === 0 && counts.pass > 0 && !counts.fail && !counts.cancelled && !counts.skipped && !counts.todo ? 'passed' : 'failed';
  return { assurance: 'native-observation', nativeAgentId: run.agentId, runId: run.id, sourceSha, callId, exitCode: proof.exitCode, testOutcome, counts,
    outputHash: createHash('sha256').update(tool.stdout).digest('hex') };
}
