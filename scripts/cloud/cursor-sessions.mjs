import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicWrite, encode, hash, readJSON, withFileLock } from '../shared/io.mjs';
import { canonical } from '../shared/protocol.mjs';
import { cursorRunTerminal, validateCursorSource } from './cursor-provider.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail = (code, message) => { throw Object.assign(new Error(message), { code, status: code === 'NOT_FOUND' ? 404 : code === 'RUNTIME_BUSY' || code === 'ID_REUSED' || code === 'CURSOR_ACCEPTANCE_UNKNOWN' ? 409 : 400 }); };
const validatePrompt = input => {
  if (!input || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 128 || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) fail('INVALID_ARGUMENT', 'Provide a bounded message ID and prompt');
};

// A provider invocation ledger, not a new queue: one Run per native Agent.
// Unknown POST acceptance is inspected via saved IDs, never blindly retried.
export class CursorCloudSessions {
  constructor({ directory, provider, repositoryUrl, startingRef, model }) {
    validateCursorSource({ repositoryUrl, startingRef, model });
    this.directory = directory; this.provider = provider; this.repositoryUrl = repositoryUrl; this.startingRef = startingRef; this.model = model;
    this.running = new Set();
  }
  file(sessionId) {
    if (!uuid.test(sessionId || '')) fail('INVALID_ARGUMENT', 'Use the saved Cursor Cloud Session ID');
    return path.join(this.directory, 'sessions', sessionId + '.json');
  }
  async list() {
    const directory = path.join(this.directory, 'sessions');
    const names = await fs.readdir(directory).catch(cause => cause.code === 'ENOENT' ? [] : Promise.reject(cause));
    const sessions = [];
    for (const name of names.filter(name => uuid.test(name.slice(0, -5)) && name.endsWith('.json'))) {
      const state = await readJSON(path.join(directory, name));
      sessions.push({ id: 'cloud:' + state.id, name: state.name, kind: 'cloud' });
    }
    return sessions.slice(-100);
  }
  runJob(work) {
    const pending = Promise.resolve().then(work);
    this.running.add(pending);
    pending.catch(() => {}).finally(() => this.running.delete(pending));
  }
  async create(input) {
    validatePrompt(input);
    const receiptFile = path.join(this.directory, 'creations', hash(input.id) + '.json'), fingerprint = hash(canonical(input));
    return withFileLock(receiptFile + '.lock', async () => {
      const previous = await readJSON(receiptFile, null);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('ID_REUSED', 'Cursor creation ID belongs to another prompt');
        return previous.result;
      }
      const sessionId = randomUUID(), agentId = 'bc-' + randomUUID();
      const state = { id: sessionId, agentId, name: 'Cursor Cloud', turns: [{ id: input.id, text: input.text, state: 'creating',
        at: new Date().toISOString() }], source: { repositoryUrl: this.repositoryUrl, startingRef: this.startingRef } };
      await atomicWrite(this.file(sessionId), encode(state));
      const result = { sessionId: 'cloud:' + sessionId, state: 'received' };
      await atomicWrite(receiptFile, encode({ fingerprint, result }));
      this.runJob(() => this.invoke(sessionId, input.id, true));
      return result;
    });
  }
  async followUp(sessionId, input) {
    validatePrompt(input);
    const file = this.file(sessionId);
    return withFileLock(file + '.lock', async () => {
      const state = await readJSON(file, null);
      if (!state) fail('NOT_FOUND', 'Cursor Cloud Session does not exist');
      const prior = state.turns.find(turn => turn.id === input.id);
      if (prior) {
        if (prior.text !== input.text) fail('ID_REUSED', 'Cursor message ID belongs to another prompt');
        return { sessionId: 'cloud:' + sessionId, state: 'received' };
      }
      if (state.turns.some(turn => !['finished', 'failed', 'interrupted'].includes(turn.state))) fail('RUNTIME_BUSY', 'Wait for the current native Run before following up');
      state.turns.push({ id: input.id, text: input.text, state: 'creating', at: new Date().toISOString() });
      await atomicWrite(file, encode(state));
      this.runJob(() => this.invoke(sessionId, input.id, false));
      return { sessionId: 'cloud:' + sessionId, state: 'received' };
    });
  }
  async invoke(sessionId, requestId, creating) {
    const file = this.file(sessionId);
    try {
      const state = await readJSON(file), turn = state.turns.find(item => item.id === requestId);
      await withFileLock(file + '.lock', async () => {
        const latest = await readJSON(file); latest.turns.find(item => item.id === requestId).state = 'dispatching';
        await atomicWrite(file, encode(latest));
      });
      const run = creating ? (await this.provider.create({ agentId: state.agentId, repositoryUrl: this.repositoryUrl,
        startingRef: this.startingRef, text: turn.text, ...(this.model ? { model: this.model } : {}) })).run
        : await this.provider.followUp(state.agentId, turn.text);
      await this.recordRun(file, requestId, run);
    } catch (cause) {
      await withFileLock(file + '.lock', async () => {
        const latest = await readJSON(file), turn = latest.turns.find(item => item.id === requestId);
        turn.state = cause.deliveryUncertain === true ? 'unknown' : 'failed';
        turn.error = String(cause.code || 'CURSOR_FAILED').slice(0, 100);
        await atomicWrite(file, encode(latest));
      });
    }
  }
  async recordRun(file, requestId, run) {
    await withFileLock(file + '.lock', async () => {
      const state = await readJSON(file), turn = state.turns.find(item => item.id === requestId);
      if (run.agentId !== state.agentId || turn.runId && run.id !== turn.runId) fail('CURSOR_RUN_MISMATCH', 'Provider Run belongs to another Session');
      turn.runId = run.id; turn.run = run;
      delete turn.error;
      turn.state = !cursorRunTerminal(run) ? 'running' : run.status === 'FINISHED' ? 'finished' : run.status === 'ERROR' ? 'failed' : 'interrupted';
      await atomicWrite(file, encode(state));
    });
  }
  async conversation(sessionId) {
    const file = this.file(sessionId), initial = await readJSON(file, null);
    if (!initial) fail('NOT_FOUND', 'Cursor Cloud Session does not exist');
    const last = initial.turns.at(-1);
    if (last.runId && !cursorRunTerminal(last.run)) {
      await this.recordRun(file, last.id, await this.provider.getRun(initial.agentId, last.runId));
    } else if (last.state === 'unknown' && initial.turns.length === 1) {
      // The client-supplied Agent ID makes a lost CREATE response inspectable.
      const agent = await this.provider.getAgent(initial.agentId);
      if (agent.latestRunId) await this.recordRun(file, last.id, await this.provider.getRun(initial.agentId, agent.latestRunId));
    }
    const state = await readJSON(file), active = state.turns.at(-1);
    return { sessionId: 'cloud:' + sessionId, configured: true, nativeAgentId: state.agentId,
      status: active.state === 'finished' ? 'stopped' : active.state === 'running' ? 'active' : active.state,
      pending: !['finished', 'failed', 'interrupted'].includes(active.state), error: active.error || null,
      messages: state.turns.slice(-20).flatMap(turn => [
        { id: turn.id + ':user', role: 'user', text: turn.text },
        ...(turn.run?.result ? [{ id: turn.id + ':assistant', role: 'assistant', text: turn.run.result.slice(0, 40000).replace(/[\uD800-\uDBFF]$/, ''), truncated: turn.run.result.length > 40000, git: turn.run.git || null }] : []),
      ]) };
  }
  async close() { await Promise.allSettled([...this.running]); }
}
