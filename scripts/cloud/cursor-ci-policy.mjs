import { cursorTrustedChecks } from './cursor-git-proof.mjs';

const fail = message => { throw Object.assign(new Error(message), { code: 'SOURCE_UNVERIFIED' }); };
const label = value => typeof value === 'string' && !!value.trim() && value.length <= 128 && !/[\x00-\x1f]/.test(value);

// Private host policy, NOT model-selected commands or an automatic mapping
// from aggregate TAP counts to arbitrary CI TODOs.
export function validateCursorCiPolicy(policy) {
  const fields = ['todoId', 'testId', 'argv', 'name', 'appId', 'workflowPath', 'workflowBlobSha', 'testStep'];
  if (!policy || Object.keys(policy).some(key => key !== 'checks') || !Array.isArray(policy.checks) || !policy.checks.length || policy.checks.length > 20 ||
      policy.checks.some(check => !check || Object.keys(check).some(key => !fields.includes(key)) || !label(check.todoId) || !label(check.testId) ||
        !Array.isArray(check.argv) || !check.argv.length || check.argv.length > 40 || check.argv.some(arg => typeof arg !== 'string' || !arg || arg.length > 2000 || /[\x00-\x1f]/.test(arg))) ||
      new Set(policy.checks.map(check => check.todoId)).size !== policy.checks.length || new Set(policy.checks.map(check => check.testId)).size !== policy.checks.length) fail('Configure numbered CI coverage and fixed test argv explicitly');
  cursorTrustedChecks(cursorCiRequirements(policy));
  if (Buffer.byteLength(JSON.stringify(policy)) > 8192) fail('Keep the complete trusted CI policy within its context budget');
  return structuredClone(policy);
}

export function cursorCiRequirements(policy) {
  const checks = new Map();
  for (const { name, appId, workflowPath, workflowBlobSha, testStep } of policy.checks) {
    const requirement = { name, appId, workflowPath, workflowBlobSha, testStep };
    if (checks.has(name) && JSON.stringify(checks.get(name)) !== JSON.stringify(requirement)) fail('A named workflow check cannot have conflicting trusted definitions');
    checks.set(name, requirement);
  }
  return [...checks.values()];
}

export function cursorCiOutcome(facts, name) {
  const matching = facts.filter(fact => fact.name === name);
  if (!matching.length) fail('The declared workflow check is unavailable');
  if (matching.some(fact => fact.testConclusion === 'skipped')) return 'incomplete';
  if (matching.some(fact => [fact.conclusion, fact.testConclusion, fact.runConclusion].some(value => value !== 'success'))) return 'failed';
  return 'passed';
}

export function cursorCiCoverage(policy, items) {
  if (!Array.isArray(items) || items.length !== policy.checks.length || new Set(items.map(item => item?.id)).size !== items.length ||
      items.some(item => !policy.checks.some(check => check.todoId === item?.id))) fail('The original CI TODOs do not match the explicitly authorized test policy');
}
