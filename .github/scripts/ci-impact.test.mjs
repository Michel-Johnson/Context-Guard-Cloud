import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectImpact, validateConfig, verifyRequired } from './ci-impact.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../ci-impact.json', import.meta.url), 'utf8'));
const select = (changedPaths, eventName = 'pull_request') => selectImpact({ config, eventName, changedPaths });
const selectedJobs = (plan) => Object.keys(plan.jobs).filter((job) => plan.jobs[job]);

function resultsFor(plan) {
  return {
    impact: {
      result: 'success',
      outputs: Object.fromEntries([
        ['full', String(plan.full)],
        ...Object.entries(plan.jobs).map(([job, enabled]) => [job.replaceAll('-', '_'), String(enabled)]),
      ]),
    },
    security: { result: 'success' },
    ...Object.fromEntries(Object.entries(plan.jobs).map(([job, enabled]) =>
      [job, { result: enabled ? 'success' : 'skipped' }])),
  };
}

test('Main, tags and unknown events always select complete CI', () => {
  for (const event of ['push', 'workflow_dispatch', 'unknown', '']) {
    const plan = select(['docs/slack-conversation-acceptance.md'], event);
    assert.equal(plan.full, true);
    assert.deepEqual(selectedJobs(plan), config.jobs);
  }
});

test('repository-only documents skip functional jobs, distributed documents select package', () => {
  assert.deepEqual(selectedJobs(select(['AGENTS.md', 'CI_todo.md', 'docs/slack-conversation-acceptance.md', 'plugins/slack/README.md'])), []);
  assert.deepEqual(selectedJobs(select(['README.md', 'references/cloud-deployment.md', 'licenses/Marked-MIT.txt'])), ['package']);
});

test('Slack runtime includes Cloud integration but does not select unrelated browser acceptance', () => {
  assert.deepEqual(selectedJobs(select(['plugins/slack/src/plugin.mjs'])), ['test', 'minimum-runtime', 'slack', 'package']);
  assert.deepEqual(selectedJobs(select(['plugins/slack/test/plugin.test.mjs'])), ['slack']);
});

test('Cloud runtime and shared build select their dependent jobs', () => {
  assert.deepEqual(selectedJobs(select(['scripts/cloud/cursor-provider.mjs'])), ['test', 'minimum-runtime', 'browser', 'package']);
  for (const file of ['scripts/cloud/coordinator-service.mjs', 'scripts/cloud/integration-gateway.mjs',
    'scripts/cloud/server.mjs', 'scripts/cloud/memory.mjs', 'scripts/build-runtime.mjs']) {
    assert.deepEqual(selectedJobs(select([file])), config.jobs, file);
  }
});

test('unit tests, browser runners, helpers and deployment have explicit impact', () => {
  assert.deepEqual(selectedJobs(select(['tests/cloud-coordinator.test.mjs'])), ['test']);
  assert.deepEqual(selectedJobs(select(['tests/cloud-sync-browser.mjs'])), ['browser']);
  assert.deepEqual(selectedJobs(select(['tests/helpers/skill.mjs'])), ['test', 'minimum-runtime', 'browser']);
  assert.deepEqual(selectedJobs(select(['deploy/context-guard-cloud.service'])), ['test', 'package']);
  assert.deepEqual(selectedJobs(select(['tests/coordinator-dialogue-live-browser.mjs'])), ['test', 'browser']);
});

test('combined, deleted and renamed paths use the union; paths normalize deterministically', () => {
  const plan = select(['plugins\\slack\\test\\store.test.mjs', 'docs/a.md', 'tests/cloud-sync-browser.mjs', 'docs/a.md']);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.changedPaths, ['docs/a.md', 'plugins/slack/test/store.test.mjs', 'tests/cloud-sync-browser.mjs']);
  assert.deepEqual(selectedJobs(plan), ['slack', 'browser']);
  // A rename is deliberately read as deletion + addition, so its old scope is not lost.
  assert.deepEqual(selectedJobs(select(['plugins/slack/src/old.mjs', 'references/new.md'])), ['test', 'minimum-runtime', 'slack', 'package']);
  assert.deepEqual(selectedJobs(select(['plugins/slack/src/deleted.mjs'])), ['test', 'minimum-runtime', 'slack', 'package']);
  const source = fs.readFileSync(new URL('./ci-impact.mjs', import.meta.url), 'utf8');
  assert.match(source, /"diff", "--no-renames", "--name-only"/);
});

test('unknown, empty and critical changes fail closed to complete CI', () => {
  for (const file of ['new-area/service.mjs', '.github/workflows/ci.yml', '.github/ci-impact.json',
    'package.json', 'package-lock.json', 'plugins/slack/package.json', 'plugins/slack/package-lock.json',
    'tests/test-manifest.json', 'docs/ci.md', '.gitignore']) {
    assert.equal(select([file]).full, true, file);
    assert.deepEqual(selectedJobs(select([file])), config.jobs);
  }
  assert.equal(select([]).reason, 'empty-diff');
  assert.deepEqual(select(['unknown/path']).unmatchedPaths, ['unknown/path']);
});

test('invalid rules and unknown jobs are rejected instead of yielding a partial plan', () => {
  const mutations = [
    (c) => { c.schemaVersion = 2; },
    (c) => { c.jobs.push(c.jobs[0]); },
    (c) => { c.jobs.push('security'); },
    (c) => { c.rules[0].jobs.push('invented'); },
    (c) => { c.rules.push(c.rules[0]); },
    (c) => { c.rules[0].patterns = [null]; },
    (c) => { c.fullRunPatterns = [null]; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(config);
    mutate(invalid);
    assert.throws(() => validateConfig(invalid));
  }
});

test('every tracked path is classified or explicitly forces complete CI', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', windowsHide: true })
    .split('\0').filter(Boolean);
  assert.deepEqual(files.filter((file) => select([file]).reason === 'unmatched-path'), []);
});

test('Required accepts only successful selected jobs and deliberately skipped unselected jobs', () => {
  for (const paths of [[], ['docs/a.md'], ['plugins/slack/src/plugin.mjs'], ['tests/cloud-sync-browser.mjs']]) {
    const plan = select(paths);
    assert.doesNotThrow(() => verifyRequired(config, resultsFor(plan)));
    for (const job of config.jobs) {
      for (const result of ['failure', 'cancelled', plan.jobs[job] ? 'skipped' : 'success']) {
        const invalid = resultsFor(plan);
        invalid[job].result = result;
        assert.throws(() => verifyRequired(config, invalid), undefined, job + ':' + result);
      }
    }
  }
});

test('Required fails on missing or failed analysis, security, jobs, or corrupted outputs', () => {
  const plan = select(['docs/a.md']);
  const mutations = [
    (r) => { delete r.security; },
    (r) => { delete r.test; },
    (r) => { r.extra = { result: 'success' }; },
    (r) => { r.impact.result = 'failure'; },
    (r) => { r.security.result = 'skipped'; },
    (r) => { delete r.impact.outputs; },
    (r) => { delete r.impact.outputs.minimum_runtime; },
    (r) => { r.impact.outputs.test = ''; },
    (r) => { r.impact.outputs.test = true; },
    (r) => { r.impact.outputs.full = 'true'; },
  ];
  for (const mutate of mutations) {
    const invalid = resultsFor(plan);
    mutate(invalid);
    assert.throws(() => verifyRequired(config, invalid));
  }
  assert.throws(() => verifyRequired(config, null));
});

test('CLI emits plans and summaries; missing merge-base falls back, invalid config blocks', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-ci-impact-'));
  const cli = path.resolve('.github/scripts/ci-impact.mjs');
  const run = (args, env = process.env) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, env,
  });
  try {
    const output = path.join(directory, 'output');
    const summary = path.join(directory, 'summary');
    const planPath = path.join(directory, 'plan.json');
    const result = run(['--event', 'push', '--base', '', '--head', 'HEAD',
      '--output', output, '--summary', summary, '--plan', planPath]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    assert.equal(plan.full, true);
    assert.match(fs.readFileSync(output, 'utf8'), /^minimum_runtime=true$/m);
    assert.match(fs.readFileSync(summary, 'utf8'), /Mode: full/);
    const fallback = run(['--event', 'pull_request', '--base', 'missing-ci-base', '--head', 'HEAD']);
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(JSON.parse(fallback.stdout).reason, /^selector-error:/);
    assert.deepEqual(selectedJobs(JSON.parse(fallback.stdout)), config.jobs);
    assert.notEqual(run(['--config', path.join(directory, 'absent.json'), '--event', 'push']).status, 0);
    assert.equal(run(['--check-required', 'true'], {
      ...process.env, JOB_RESULTS: JSON.stringify(resultsFor(plan)),
    }).status, 0);
    assert.notEqual(run(['--check-required', 'true'], { ...process.env, JOB_RESULTS: '{}' }).status, 0);
    assert.equal(run(['--event', 'pull_request', '--base', 'HEAD^', '--head', 'HEAD']).status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow keeps immutable actions, security and strict Required while selecting functional jobs', () => {
  const result = spawnSync(process.execPath, ['.github/scripts/verify-workflows.mjs'], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
});
