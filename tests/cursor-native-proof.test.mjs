import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cursorProofCommand, verifyCursorNativeProof } from '../scripts/cloud/cursor-native-proof.mjs';

const nonce = 'a'.repeat(64), sourceSha = 'b'.repeat(40), argv = ['node', '--test', '--test-reporter=tap', 'tests/example.test.mjs'];
const run = { id: 'run-1', agentId: 'bc-11111111-1111-4111-8111-111111111111', status: 'FINISHED' };
const tap = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
function fixture() {
  const command = cursorProofCommand({ nonce, sourceSha, argv });
  const proof = { format: 1, nonce, sourceSha, argv, before: { sha: sourceSha, clean: true }, after: { sha: sourceSha, clean: true },
    exitCode: 0, signal: null, spawnError: null, stdout: tap, stderr: '' };
  const terminal = { callId: 'call-1', name: 'run_terminal_cmd', status: 'completed', args: { command }, result: {
    isBackground: false, success: { command, stdout: 'CG_CURSOR_PROOF ' + JSON.stringify(proof) + '\n' },
  } };
  const observation = { complete: true, agentId: run.agentId, runId: run.id, events: [
    { event: 'tool_call', data: terminal }, { event: 'result', data: { runId: run.id, status: 'FINISHED' } }, { event: 'done', data: {} },
  ] };
  return { command, proof, terminal, observation, verify: () => verifyCursorNativeProof({ observation, run, command, nonce, sourceSha, argv }),
    update: () => { terminal.result.success.stdout = 'CG_CURSOR_PROOF ' + JSON.stringify(proof) + '\n'; } };
}
test('Native proof accepts only a fixed command, exact SHA, real exit status and nonempty complete TAP result', () => {
  const f = fixture(), result = f.verify();
  assert.equal(result.sourceSha, sourceSha); assert.equal(result.runId, run.id); assert.equal(result.testOutcome, 'passed');
  assert.equal(result.assurance, 'native-observation'); assert.equal('verdict' in result, false);
  assert.equal(result.exitCode, 0); assert.equal(result.counts.tests, 1); assert.equal(result.callId, 'call-1');
  assert.equal('stdout' in result, false);
});
test('Native proof rejects self-reports, truncation, wrong Run, changed source and missing process status', async t => {
  const cases = {
    assistant: f => { f.observation.events[0].event = 'assistant'; },
    truncated: f => { f.terminal.truncated = { result: true }; },
    background: f => { f.terminal.result.isBackground = true; },
    wrongRun: f => { f.observation.runId = 'other'; },
    wrongCommand: f => { f.terminal.args.command += ' '; },
    missingExit: f => { delete f.proof.exitCode; f.update(); },
    wrongNonce: f => { f.proof.nonce = 'c'.repeat(64); f.update(); },
    changedSha: f => { f.proof.after.sha = 'c'.repeat(40); f.update(); },
    dirty: f => { f.proof.after.clean = false; f.update(); },
    zeroTests: f => { f.proof.stdout = tap.replace(/# tests 1/, '# tests 0').replace(/# pass 1/, '# pass 0'); f.update(); },
    ambiguousCounts: f => { f.proof.stdout += tap; f.update(); },
    streamError: f => { f.observation.events.push({ event: 'error', data: {} }); },
    duplicateCommand: f => { f.observation.events.push({ event: 'tool_call', data: { ...f.terminal, callId: 'call-2' } }); },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const f = fixture(); change(f); assert.throws(f.verify, { code: 'SOURCE_UNVERIFIED' });
  });
});
test('A genuine failed test is a failed verdict; native FINISHED cannot turn its exit status into zero', () => {
  const f = fixture(); f.proof.exitCode = 1; f.proof.stdout = tap.replace('# pass 1', '# pass 0').replace('# fail 0', '# fail 1'); f.update();
  const result = f.verify(); assert.equal(result.exitCode, 1); assert.equal(result.testOutcome, 'failed'); assert.equal(result.counts.fail, 1);
});
test('Host-generated command runs a real child test and observes clean Git SHA before and after, including literal quoting', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-cursor-proof-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Synthetic Test']); git(['config', 'user.email', 'synthetic@example.invalid']);
  await fs.mkdir(path.join(directory, 'tests'));
  const name = "tests/quote's.test.mjs";
  await fs.writeFile(path.join(directory, name), "import {test} from 'node:test'; import assert from 'node:assert/strict'; test('real assertion',()=>assert.equal(2+2,4));\n");
  git(['add', 'tests']); git(['commit', '-qm', 'Synthetic proof fixture']);
  const actualSha = git(['rev-parse', 'HEAD']), actualArgv = [process.execPath, '--test', '--test-reporter=tap', name];
  const command = cursorProofCommand({ nonce, sourceSha: actualSha, argv: actualArgv });
  // Do not inherit node:test's internal child-v8 serialization context into
  // the independent terminal fixture. The vendor VM is not a Node test child.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const stdout = execFileSync('/bin/sh', ['-c', command], { cwd: directory, encoding: 'utf8', timeout: 20000, env });
  // The wrapper is real. Only the vendor tool envelope is a controlled fixture.
  const observation = { complete: true, agentId: run.agentId, runId: run.id, events: [
    { event: 'tool_call', data: { callId: 'real-wrapper', name: 'run_terminal_cmd', status: 'completed', args: { command },
      result: { isBackground: false, success: { command, stdout } } } }, { event: 'result', data: { runId: run.id, status: 'FINISHED' } },
  ] };
  const result = verifyCursorNativeProof({ observation, run, command, nonce, sourceSha: actualSha, argv: actualArgv });
  assert.equal(result.testOutcome, 'passed'); assert.equal(result.counts.tests, 1); assert.equal(git(['status', '--porcelain']), '');
});
