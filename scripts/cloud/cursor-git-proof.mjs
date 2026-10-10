import fs from 'node:fs/promises';
import path from 'node:path';

const sha = /^[a-f0-9]{40}$/;
const fail = message => { throw Object.assign(new Error(message), { code: 'SOURCE_UNVERIFIED' }); };
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 1000 &&
  !value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f]/.test(value) &&
  value.replace(/\/$/, '').split('/').every(part => part && part !== '.' && part !== '..') &&
  !value.split('/').includes('.codex');
const repositorySlug = url => typeof url === 'string' && /^(?:https:\/\/)?github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/i.exec(url)?.[1];
const label = value => typeof value === 'string' && !!value.trim() && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

export function cursorTrustedChecks(checks) {
  const fields = ['name', 'appId', 'workflowPath', 'workflowBlobSha', 'testStep'];
  if (!Array.isArray(checks) || !checks.length || checks.length > 20 || checks.some(check => !check || Object.keys(check).some(key => !fields.includes(key)) ||
      !label(check.name) || check.appId !== 15368 || !/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(check.workflowPath || '') ||
      !sha.test(check.workflowBlobSha || '') || !label(check.testStep)) || new Set(checks.map(check => check.name)).size !== checks.length) fail('Pin GitHub Actions jobs, workflow blob versions and actual test steps explicitly');
  return structuredClone(checks);
}

export function cursorApprovedPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 100 || !paths.every(relative)) fail('Use bounded relative paths from the reviewed Plan');
  return structuredClone(paths);
}

// Read-only verification against the source host, never an Agent's description
// or a local cached checkout. No push, PR creation, merge or repository mutation.
export class CursorGitProof {
  constructor({ repository, tokenFile, fetch: request = globalThis.fetch } = {}) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || tokenFile !== undefined && !path.isAbsolute(tokenFile) || typeof request !== 'function') fail('Configure the approved repository and an optional private GitHub credential file');
    Object.assign(this, { repository, tokenFile, request });
  }

  async verify({ run, baseSha, sourceSha, approvedPaths }) {
    if (run?.status !== 'FINISHED' || !sha.test(baseSha || '') || !sha.test(sourceSha || '')) fail('Use a completed native Run, exact revisions and reviewed source paths');
    approvedPaths = cursorApprovedPaths(approvedPaths);
    const branches = run.git?.branches?.filter(item => repositorySlug(item.repoUrl)?.toLowerCase() === this.repository.toLowerCase()) || [];
    if (branches.length !== 1 || !/^cursor\/.+/.test(branches[0].branch || '') || !relative(branches[0].branch)) fail('Use the one native-created branch in the approved repository');
    const branch = branches[0].branch;
    return this.withReader(async get => {
      const head = await get('branches/' + encodeURIComponent(branch));
      if (head.name !== branch || head.commit?.sha !== sourceSha) fail('The native branch does not contain the reported source revision');
      const commit = await get(`commits/${sourceSha}?per_page=100&page=1`);
      if (commit.sha !== sourceSha) fail('The reported source commit is unavailable');
      const comparison = await get(`compare/${baseSha}...${sourceSha}?per_page=100&page=1`);
      if (comparison.base_commit?.sha !== baseSha || comparison.merge_base_commit?.sha !== baseSha ||
          !['ahead', 'identical'].includes(comparison.status) || comparison.behind_by !== 0 || !Number.isSafeInteger(comparison.total_commits) ||
          comparison.total_commits < 0 || comparison.total_commits > 100 || !Array.isArray(comparison.commits) || comparison.commits.length !== comparison.total_commits ||
          comparison.status === 'identical' && (sourceSha !== baseSha || comparison.total_commits !== 0) ||
          comparison.status === 'ahead' && (!comparison.commits.length || comparison.commits.at(-1).sha !== sourceSha) ||
          !Array.isArray(comparison.files) || comparison.files.length >= 300) fail('The complete change against the approved base was not verified');
      const allowed = filename => relative(filename) && approvedPaths.some(item => item.endsWith('/') ? filename.startsWith(item) : filename === item);
      const verifyFiles = files => {
        if (!Array.isArray(files) || files.length >= 100) fail('A complete commit file list is unavailable');
        for (const file of files) if (!allowed(file.filename) || file.previous_filename !== undefined && !allowed(file.previous_filename)) fail('The source history changed a path outside the reviewed Plan');
      };
      // A final net diff can hide an out-of-scope add/delete or modify/revert.
      // Inspect every new commit; reject unverified merge/partial history.
      let parent = baseSha;
      for (const item of comparison.commits) {
        if (!sha.test(item?.sha || '')) fail('Invalid source history');
        const currentCommit = item.sha === sourceSha ? commit : await get(`commits/${item.sha}?per_page=100&page=1`);
        if (currentCommit.sha !== item.sha || !Array.isArray(currentCommit.parents) || currentCommit.parents.length !== 1 || currentCommit.parents[0].sha !== parent) fail('The complete linear source history was not verified');
        verifyFiles(currentCommit.files); parent = item.sha;
      }
      for (const file of comparison.files) if (!allowed(file.filename) || file.previous_filename !== undefined && !allowed(file.previous_filename)) fail('The final source tree changed a path outside the reviewed Plan');
      const current = await get('branches/' + encodeURIComponent(branch));
      if (current.name !== branch || current.commit?.sha !== sourceSha) fail('The native branch changed during verification');
      return { repository: this.repository, branch, baseSha, sourceSha, files: comparison.files.map(file => file.filename) };
    });
  }

  async checks({ sourceSha, requiredChecks }) {
    if (!sha.test(sourceSha || '') || !Array.isArray(requiredChecks) || !requiredChecks.length || requiredChecks.length > 100 ||
        requiredChecks.some(check => !check || Object.keys(check).some(key => !['name', 'appId'].includes(key)) ||
          typeof check.name !== 'string' || !check.name.trim() || check.name.length > 200 || /[\x00-\x1f]/.test(check.name) || !Number.isSafeInteger(check.appId) || check.appId <= 0) ||
        new Set(requiredChecks.map(check => JSON.stringify([check.name, check.appId]))).size !== requiredChecks.length) fail('Require explicit trusted check names and issuer IDs for the exact SHA');
    return this.withReader(async get => {
      const result = await get(`commits/${sourceSha}/check-runs?filter=latest&per_page=100`);
      if (!Array.isArray(result.check_runs) || !Number.isSafeInteger(result.total_count) || result.total_count !== result.check_runs.length || result.total_count >= 100) fail('The complete exact-SHA check list is unavailable');
      return requiredChecks.flatMap(required => {
        const matching = result.check_runs.filter(check => check.name === required.name && check.app?.id === required.appId);
        // GitHub latest is per check suite, not unique across push/PR suites.
        // Keep all matching machine facts; never cherry-pick a green duplicate.
        if (!matching.length || matching.some(check => check.head_sha !== sourceSha || check.status !== 'completed' ||
            !['success', 'failure', 'cancelled', 'timed_out', 'action_required'].includes(check.conclusion) ||
            !Number.isSafeInteger(check.id) || check.id <= 0)) fail('Required check is absent, unfinished, skipped or from another source/issuer');
        return matching.map(check => ({ name: required.name, appId: required.appId, sourceSha, checkRunId: check.id, conclusion: check.conclusion }));
      });
    });
  }

  async trustedChecks({ sourceSha, branch, requiredChecks }) {
    if (!sha.test(sourceSha || '') || !relative(branch)) fail('Use an exact source and its verified branch');
    requiredChecks = cursorTrustedChecks(requiredChecks);
    return this.withReader(async get => {
      const list = await get(`commits/${sourceSha}/check-runs?filter=latest&per_page=100`);
      if (!Array.isArray(list.check_runs) || list.total_count !== list.check_runs.length || list.total_count >= 100) fail('The complete source check list is unavailable');
      const suites = new Map(), workflows = new Map(), facts = [];
      for (const policy of requiredChecks) {
        const matching = list.check_runs.filter(check => check.name === policy.name && check.app?.id === policy.appId);
        let selected = 0;
        for (const check of matching) {
          if (!positive(check.id) || !positive(check.check_suite?.id) || check.head_sha !== sourceSha) fail('The check identity or source is unverified');
          const suite = check.check_suite.id;
          if (!suites.has(suite)) {
            const runs = await get(`actions/runs?check_suite_id=${suite}&head_sha=${sourceSha}&per_page=100`);
            if (runs.total_count !== 1 || !Array.isArray(runs.workflow_runs) || runs.workflow_runs.length !== 1) fail('A unique workflow run for the check suite is unavailable');
            const run = runs.workflow_runs[0];
            if (!positive(run.id) || run.check_suite_id !== suite || run.head_sha !== sourceSha ||
                run.repository?.full_name?.toLowerCase() !== this.repository.toLowerCase() || run.head_repository?.full_name?.toLowerCase() !== this.repository.toLowerCase()) fail('The workflow source or repository is unverified');
            suites.set(suite, { run });
          }
          const context = suites.get(suite), run = context.run;
          // Provenance is selected BEFORE results: a PR merge checkout or a
          // different branch is not this exact-source push execution. Keep ALL
          // matching contexts in the selected provenance, including failures.
          if (run.event !== 'push' || run.head_branch !== branch) continue;
          selected++;
          if (!positive(run.run_attempt) || run.status !== 'completed' || check.status !== 'completed' ||
              !['success', 'failure', 'cancelled', 'timed_out', 'action_required'].includes(run.conclusion) ||
              !['success', 'failure', 'cancelled', 'timed_out', 'action_required'].includes(check.conclusion) ||
              ![policy.workflowPath, policy.workflowPath + '@' + branch, policy.workflowPath + '@refs/heads/' + branch].includes(run.path)) fail('Use the completed pinned workflow for the source branch');
          if (!workflows.has(policy.workflowPath)) {
            const file = await get(`contents/${policy.workflowPath.split('/').map(encodeURIComponent).join('/')}?ref=${sourceSha}`);
            if (file.type !== 'file' || file.path !== policy.workflowPath || !positive(file.size) || file.size > 1024 * 1024 || !sha.test(file.sha || '')) fail('The source workflow file is unavailable');
            workflows.set(policy.workflowPath, file.sha);
          }
          if (workflows.get(policy.workflowPath) !== policy.workflowBlobSha) fail('The workflow changed from the explicitly trusted version');
          context.jobs ||= await get(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
          if (!Array.isArray(context.jobs.jobs) || context.jobs.total_count !== context.jobs.jobs.length || context.jobs.total_count >= 100) fail('The complete current-attempt job list is unavailable');
          const jobs = context.jobs.jobs.filter(job => job.name === policy.name && job.check_run_url?.toLowerCase() ===
            `https://api.github.com/repos/${this.repository}/check-runs/${check.id}`.toLowerCase());
          const job = jobs[0];
          if (jobs.length !== 1 || !positive(job.id) || job.run_id !== run.id || job.head_sha !== sourceSha || job.status !== 'completed' ||
              job.conclusion !== check.conclusion || job.run_attempt !== undefined && job.run_attempt !== run.run_attempt || !Array.isArray(job.steps)) fail('The check is not the exact workflow job and source');
          const steps = job.steps.filter(step => step.name === policy.testStep), step = steps[0];
          if (steps.length !== 1 || step.status !== 'completed' || !['success', 'failure', 'cancelled', 'skipped'].includes(step.conclusion)) fail('The declared test step was not observed');
          const latest = await get(`actions/runs/${run.id}`);
          for (const field of ['id', 'check_suite_id', 'head_sha', 'head_branch', 'event', 'path', 'run_attempt', 'status', 'conclusion']) if (latest[field] !== run[field]) fail('The workflow changed during verification');
          if (latest.repository?.full_name?.toLowerCase() !== this.repository.toLowerCase() ||
              latest.head_repository?.full_name?.toLowerCase() !== this.repository.toLowerCase()) fail('The workflow repository changed during verification');
          facts.push({ name: policy.name, appId: policy.appId, sourceSha, checkRunId: check.id, workflowRunId: run.id,
            jobId: job.id, runAttempt: run.run_attempt, workflowPath: policy.workflowPath, workflowBlobSha: policy.workflowBlobSha,
            conclusion: check.conclusion, runConclusion: run.conclusion, testConclusion: step.conclusion });
        }
        if (!selected) fail('No declared exact-source push execution was verified');
      }
      return facts;
    });
  }

  async withReader(action) {
    let token = '';
    if (this.tokenFile) {
      try {
        const info = await fs.stat(this.tokenFile);
        if (!info.isFile() || info.mode & 0o077) fail('GitHub credential file must be private');
        token = (await fs.readFile(this.tokenFile, 'utf8')).trim();
        if (!token || token.length > 8192 || /[\r\n]/.test(token)) fail('GitHub credential file is invalid');
      } catch { fail('GitHub verification credential is unavailable'); }
    }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    const get = async route => {
      let reader;
      try {
        const response = await this.request(`https://api.github.com/repos/${this.repository}/${route}`, {
          redirect: 'error', signal: controller.signal, headers: { Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        });
        if (!response.ok) fail(`GitHub verification returned HTTP ${response.status}`);
        if (/rel=["']?next/i.test(response.headers.get('link') || '')) fail('GitHub verification returned a partial paginated result');
        reader = response.body?.getReader();
        if (!reader) fail('GitHub verification returned an empty response');
        const chunks = []; let bytes = 0;
        for (;;) { const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.length; if (bytes > 2 * 1024 * 1024) fail('GitHub verification exceeds the limit'); chunks.push(Buffer.from(chunk.value)); }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (cause) {
        if (cause.code === 'SOURCE_UNVERIFIED') throw cause;
        fail(controller.signal.aborted ? 'GitHub verification timed out' : 'GitHub verification is unavailable');
      } finally { if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); } }
    };
    try { return await action(get); } finally { clearTimeout(timer); controller.abort(); }
  }
}
