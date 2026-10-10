import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt as cryptoScrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { applyOperations, entries, validate, MapError, scopeDocumentToSession, filterNodeAccess, isClosedBugStatus } from '../shared/map-model.mjs';
import { atomicWrite, readJSON, withFileLock } from '../shared/io.mjs';
import { commitMainMemoryMap as commitStoredMainMemoryMap, readMainMemoryReceipt, commitSessionMap, completeSessionMemory, createMemoryHandler, enforceMainHistoryRetention, memoryPublicationStatus, publishSessionMemory, readMemoryView as readStoredMemoryProject, sessionCompletionMatches, memoryHeads, memoryHub } from './memory.mjs';
import { projectMemoryFile } from './memory-filesystem.mjs';
import { WorkbenchSnapshots } from '../shared/protocol-snapshots.mjs';
import { verifyChangeReferences } from '../shared/protocol-map.mjs';
import { ProtocolAuth } from './protocol-auth.mjs';
import { DeviceAuthorization } from './device-authorization.mjs';
import { ProtocolStore, hasCiReceiver } from '../shared/protocol-store.mjs';
import { scopedObjectKey } from '../shared/protocol-workflow.mjs';
import { reviewInput, reviewOperations, pendingReviewFeedback } from './task-review.mjs';
import { ProtocolBlobs, serveBlob } from '../shared/protocol-blobs.mjs';
import { canonical, validateMessage, errorReply, fail as protocolFail, MAX_MESSAGE_BYTES } from '../shared/protocol.mjs';
import { CoordinatorModel } from './coordinator-model.mjs';
import { configuredOutputProtocol } from './coordinator-output.mjs';
import { CoordinatorModelSettings } from './coordinator-model-settings.mjs';
import { MapTranslations, translationInput } from './map-translations.mjs';
import { CoordinatorService, CoordinatorInbox, CoordinatorMapIntake, CoordinatorConversations, coordinatorCanAutoResume,
  COORDINATOR_MANUAL_COMPACT_AT_TOKENS } from './coordinator-service.mjs';
import { coordinatorTools, coordinatorReferences, readCoordinatorReferenceFile, createCoordinatorExecutor, selectCoordinatorTools } from './coordinator-tools.mjs';
import { writeProjectFile } from './coordinator-file.mjs';
import { buildCoordinatorContext } from './coordinator-context.mjs';
import { CoordinatorBindings, bindingReplyDecision } from './coordinator-binding.mjs';
import { coordinatorNodePath, coordinatorPathText, coordinatorNodeLabel } from '../shared/coordinator-path.mjs';
import { verifyTaskCompletion, verifyTaskClose, taskSessionPublicationReady, isExperimentTask } from './completion.mjs';
import { CloudAttachments, attachmentInput, attachmentPatch } from './attachments.mjs';
import { createQuarkProvider } from './quark-provider.mjs';
import { startIntegrationGateway, validateIntegrationConfig, validateIntegrationCommand, relevanceInput, relevanceOverview, classifyIntegrationMessage } from './integration-gateway.mjs';
import { recoveryScope, requireEmptyRecoveryState } from './slack-recovery.mjs';
import { IntegrationAttachmentStore } from './integration-attachments.mjs';
import { CoordinatorManualBriefs, filterManualTools, coordinatorRolePrompt } from './coordinator-manual.mjs';
import { releaseIdentity } from './release.mjs';
import { MapProjects, isMapProject } from './map-projects.mjs';
import { CursorCloudProvider } from './cursor-provider.mjs';
import { CursorCloudSessions } from './cursor-sessions.mjs';
import { CursorRoleFactory, cursorTemplateWorktree } from './cursor-role-factory.mjs';
import { createCursorRoleMcpHandler } from './cursor-role-mcp.mjs';
import { CursorGitProof } from './cursor-git-proof.mjs';
import { authorizeCursorCiTask, parseCursorCiTaskHeader, authorizeCursorCiHostEvidence, parseCursorCiEvidenceHeader } from './cursor-ci-task-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const htmlPath = path.join(root, 'prototype/workbench.html');
const workbenchAssetTypes = new Map([
  ['prototype/workbench.css', 'text/css; charset=utf-8'],
  ['prototype/workbench-app.js', 'text/javascript; charset=utf-8'],
  ['prototype/workbench-data.js', 'text/javascript; charset=utf-8'],
  ['prototype/workbench-sync.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/map-graph-view.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/map-translations.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/attachments.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/coordinator-markdown.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/coordinator-working-blot.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/cursor-chat.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/vendor/marked.mjs', 'text/javascript; charset=utf-8'],
  ['prototype/working-blot-atlas.png', 'image/png'],
  ['scripts/shared/map-model.mjs', 'text/javascript; charset=utf-8'],
]);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const now = () => new Date().toISOString();
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const mapWorkTaskId = (projectId, nodeId, kind, itemId) => `map-${kind}-${digest(`${projectId}:${nodeId}:${kind}:${itemId}`).slice(0, 24)}`;
export function applyCoordinatorAssignments(document, assignments) {
  if (!document?.root || !assignments?.size) return document;
  const projectItems = node => ({ ...node,
    // The map snapshot can contain the dispatch receipt from before the
    // Coordinator advanced the task.  Always overlay the current assignment
    // so a stale `pending` receipt cannot mask an executing/awaiting-merge
    // task in the workbench.  This is a read-only projection; the source map
    // remains unchanged.
    todos: (node.todos || []).map(item => item.executionMode !== 'manual' && assignments.has(`${node.id}:todo:${item.id}`)
      ? { ...item, dispatch: { ...(item.dispatch || {}), ...assignments.get(`${node.id}:todo:${item.id}`) } } : item),
    bugs: (node.bugs || []).map(item => item.executionMode !== 'manual' && assignments.has(`${node.id}:bug:${item.id}`)
      ? { ...item, dispatch: { ...(item.dispatch || {}), ...assignments.get(`${node.id}:bug:${item.id}`) } } : item),
    children: (node.children || []).map(projectItems),
  });
  return { ...document, root: projectItems(document.root) };
}
export function coordinatorAssignmentKey(document, owner, taskId) {
  if (owner?.nodeId && ['todo', 'bug'].includes(owner.kind) && owner.itemId) return `${owner.nodeId}:${owner.kind}:${owner.itemId}`;
  if (!document?.root || typeof taskId !== 'string' || !taskId) return '';
  const matches = [];
  const visit = node => {
    for (const kind of ['todo', 'bug']) for (const item of node[`${kind}s`] || []) {
      if (item?.id === taskId) matches.push(`${node.id}:${kind}:${item.id}`);
    }
    for (const child of node.children || []) visit(child);
  };
  visit(document.root);
  return matches.length === 1 ? matches[0] : '';
}
const versionOf = document => digest(JSON.stringify(document));
const newToken = () => randomBytes(32).toString('base64url');
const scrypt = promisify(cryptoScrypt);
const passwordHashPattern = /^scrypt\$([A-Za-z0-9_-]{20,})\$([A-Za-z0-9_-]{80,})$/;
const workbenchCookieMaxAge = 30 * 24 * 60 * 60;
const sessionActivityTtlMs = 2 * 60 * 1000;
const sessionHeartbeatTtlMs = 30 * 1000;
// A legacy project can contain hundreds of megabytes of cold conversation
// history. Automatic publication must not parse that history on the Cloud
// event loop and starve unrelated Coordinator projects.
const automaticPublicationMaxBytes = 128 * 1024 * 1024;
export const coordinatorTaskOwnerRequired = type => type === 'brief.submit';
const compactText = (value, limit = 2000) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);

export function coordinatorStructureOperations(actions, operationId) {
  if (!Array.isArray(actions) || !actions.length || actions.length > 30) protocolFail('INVALID_ARGUMENT', 'Provide 1–30 Map actions');
  return actions.map((action, index) => {
    if (!action || typeof action !== 'object' || Array.isArray(action)) protocolFail('INVALID_ARGUMENT', 'Map action must be an object');
    const allowed = action.op === 'create' ? ['op', 'id', 'parentId', 'order', 'title', 'purpose', 'memoryDocument', 'kind', 'state', 'owns']
      : action.op === 'update' ? ['op', 'id', 'title', 'purpose', 'memoryDocument', 'kind', 'state', 'owns']
      : action.op === 'move' ? ['op', 'id', 'parentId', 'order', 'kind']
      : action.op === 'delete' ? ['op', 'id', 'kind', 'nodeId'] : [];
    if (!allowed.length || Object.keys(action).some(key => !allowed.includes(key))) protocolFail('FORBIDDEN', 'Invalid Coordinator Map action');
    if (Object.hasOwn(action, 'memoryDocument') && (typeof action.memoryDocument !== 'string' || action.memoryDocument.length > 12000)) {
      protocolFail('INVALID_ARGUMENT', 'Memory document must be Markdown within 12000 characters');
    }
    const id = action.id || `NCC${digest(`${operationId}:${index}`).slice(0, 20)}`;
    if (action.op === 'create') {
      if (typeof action.parentId !== 'string' || !action.parentId || typeof action.title !== 'string' || !action.title.trim()) protocolFail('INVALID_ARGUMENT', 'Create needs parentId and title');
      if (action.kind !== undefined && !['module', 'work', 'node'].includes(action.kind)) protocolFail('INVALID_ARGUMENT', 'Create kind must be module or work; node uses the default module kind');
      return { type: 'create', parentId: action.parentId, ...(action.order === undefined ? {} : { order: action.order }), node: {
        id, title: action.title, purpose: action.purpose || '', ...(action.memoryDocument === undefined ? {} : { memoryDocument: action.memoryDocument }),
        kind: action.kind === 'node' ? 'module' : action.kind || 'module', state: action.state || 'untested', owns: action.owns || [],
      } };
    }
    if (action.op === 'delete') {
      if (typeof action.id !== 'string' || !action.id) protocolFail('INVALID_ARGUMENT', 'Delete needs an id');
      const kind = action.kind || 'node';
      if (!['node', 'module', 'work', 'todo', 'bug'].includes(kind)) protocolFail('INVALID_ARGUMENT', 'Delete kind must be node, module, work, todo or bug');
      if (['node', 'module', 'work'].includes(kind)) {
        if (action.nodeId !== undefined) protocolFail('INVALID_ARGUMENT', 'Structural deletion uses id, not nodeId');
        return { type: 'delete', id: action.id };
      }
      if (action.nodeId !== undefined && (typeof action.nodeId !== 'string' || !action.nodeId)) protocolFail('INVALID_ARGUMENT', 'nodeId must be a non-empty string');
      return { type: 'delete-work-item', ...(action.nodeId ? { nodeId: action.nodeId } : {}), kind, itemId: action.id };
    }
    if (typeof action.id !== 'string' || !action.id) protocolFail('INVALID_ARGUMENT', 'Update and move need a node id');
    if (action.op === 'move') {
      if (typeof action.parentId !== 'string' || !action.parentId) protocolFail('INVALID_ARGUMENT', 'Move needs parentId');
      return { type: 'move', id, parentId: action.parentId, ...(action.order === undefined ? {} : { order: action.order }) };
    }
    if (action.kind !== undefined && !['module', 'work', 'node'].includes(action.kind)) protocolFail('INVALID_ARGUMENT', 'Structural update kind must be module or work; node preserves the existing kind');
    const fields = Object.fromEntries(Object.entries(action).filter(([key, value]) => ['title', 'purpose', 'memoryDocument', 'kind', 'state', 'owns'].includes(key) && !(key === 'kind' && value === 'node')));
    if (!Object.keys(fields).length) protocolFail('INVALID_ARGUMENT', 'Update needs at least one structural field');
    return { type: 'update', id, fields };
  });
}

export function cloudSessionActivity({ lifecycleEvent = '', workStatus = '', lastSeen = '' } = {}, currentTime = Date.now(), ttlMs = sessionActivityTtlMs) {
  if (['stop', 'stop-blocked', 'interrupt'].includes(lifecycleEvent) || workStatus === 'completed') return 'stopped';
  const seen = Date.parse(lastSeen);
  if (['session-start', 'user-prompt-submit'].includes(lifecycleEvent) || workStatus === 'working') {
    return Number.isFinite(seen) && currentTime - seen <= ttlMs ? 'active' : 'unknown';
  }
  return 'unknown';
}

export function cloudSessionPresence(lastHeartbeatAt = '', currentTime = Date.now(), ttlMs = sessionHeartbeatTtlMs) {
  const seen = Date.parse(lastHeartbeatAt);
  return Number.isFinite(seen) && currentTime - seen <= ttlMs ? 'online' : 'offline';
}

// Presence is a transport fact, not a claim that the native worker is alive.
// Keep the reason alongside the state so clients do not have to infer a stale
// heartbeat from an old lifecycle/session record.
export function cloudSessionConnection(lastHeartbeatAt = '', currentTime = Date.now(), ttlMs = sessionHeartbeatTtlMs) {
  const state = cloudSessionPresence(lastHeartbeatAt, currentTime, ttlMs);
  return {
    state,
    lastHeartbeatAt: String(lastHeartbeatAt || ''),
    reason: state === 'online' ? 'heartbeat' : lastHeartbeatAt ? 'heartbeat-expired' : 'never-seen',
  };
}

export async function createWorkbenchPasswordHash(password) {
  const value = String(password || '');
  if (!value || Buffer.byteLength(value) > 1024) throw new MapError('INVALID_PASSWORD', 'Password must contain 1–1024 bytes');
  const salt = randomBytes(16);
  const key = await scrypt(value, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

async function verifyWorkbenchPassword(password, encoded) {
  const match = String(encoded || '').match(passwordHashPattern);
  if (!match || Buffer.byteLength(String(password || '')) > 1024) return false;
  const expected = Buffer.from(match[2], 'base64url');
  const actual = Buffer.from(await scrypt(String(password || ''), Buffer.from(match[1], 'base64url'), expected.length));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const escapeHtml = value => String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const validNext = value => {
  const next = String(value || '/');
  if (!next.startsWith('/') || next.startsWith('//')) throw new MapError('INVALID_REDIRECT', 'Invalid redirect');
  return next;
};
const canonicalOrigin = value => {
  try { return new URL(String(value || '')).origin; }
  catch { return ''; }
};

function loginPage({ next = '/', error = '' } = {}) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · Context Guard</title><style>
:root{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#2d2b28;background:#f7f2e8}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background-image:radial-gradient(#ded4c3 1px,transparent 1px);background-size:22px 22px}
main{width:min(420px,100%);padding:34px;background:#fffdf8;border:3px solid #302f2d;border-radius:18px;box-shadow:7px 7px 0 #302f2d}
h1{margin:0 0 8px;font-size:28px}p{margin:0 0 24px;color:#746d63}label{display:block;margin-bottom:8px;font-weight:700}
input{width:100%;height:48px;padding:0 14px;border:2px solid #302f2d;border-radius:10px;font:inherit;background:#fff}input:focus{outline:3px solid #f1cc58;outline-offset:2px}
button{width:100%;height:48px;margin-top:18px;border:2px solid #302f2d;border-radius:10px;background:#f7cf55;font:inherit;font-weight:800;cursor:pointer;box-shadow:3px 3px 0 #302f2d}
.error{color:#b42318;margin:-10px 0 16px;font-weight:700}
</style></head><body><main><h1>Context Guard</h1><p>输入密码进入项目地图</p>${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ''}
<form method="post" action="/auth/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">登录</button></form></main></body></html>`;
}

function deviceAuthorizationPage(grant, projectId) {
  const pending = grant.status === 'pending' && !grant.claimed;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>连接设备 · Context Guard</title>
<style>body{font:18px system-ui,sans-serif;background:#f7f2e8;color:#2d2b28;margin:0;padding:24px}main{max-width:620px;margin:8vh auto;padding:28px;background:#fffdf8;border:2px solid;border-radius:8px}h1{font-size:28px}dt{margin-top:16px;font-weight:700}dd{margin:8px 0;overflow-wrap:anywhere}button{font:inherit;padding:12px 20px;margin:12px 12px 0 0;border:2px solid;border-radius:6px;background:#f7cf55}button[value=deny]{background:#fff}</style></head><body><main><h1>连接设备</h1>
<p>只确认你刚刚发起的连接，并核对验证码。</p><dl><dt>项目</dt><dd>${escapeHtml(grant.repository)}</dd><dt>设备</dt><dd>${escapeHtml(grant.label)}</dd><dt>验证码</dt><dd>${escapeHtml(grant.userCode)}</dd></dl>
<p>允许设备读取本项目 Main，并读写绑定到该设备的 Session；不授予管理或 Main 发布权限。</p>
${pending ? `<form id="device-decision"><button name="decision" value="approve">允许连接</button><button name="decision" value="deny">拒绝</button><p role="status"></p></form>
<script>const project=${JSON.stringify(projectId).replace(/</g, '\\u003c')},request=${JSON.stringify(grant.requestId).replace(/</g, '\\u003c')};
document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,decision=event.submitter.value;for(const button of form.querySelectorAll('button'))button.disabled=true;try{const ticketResponse=await fetch('/api/workbench/projects/'+encodeURIComponent(project)+'/api/device-authorizations/'+encodeURIComponent(request),{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});if(!ticketResponse.ok)throw Error('申请读取失败，请重新登录或刷新');const ticket=await ticketResponse.json();if(ticket.status!=='pending')throw Error('申请已处理，请刷新');const response=await fetch('/auth/device/decision',{method:'POST',credentials:'same-origin',body:new URLSearchParams({projectId:project,userCode:ticket.userCode,csrf:ticket.csrf,decision}),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('决定未确认，请刷新核对后重试');location.reload();}catch(error){form.querySelector('[role=status]').textContent=error.message;for(const button of form.querySelectorAll('button'))button.disabled=false;}});</script>` : `<p role="status">${grant.claimed ? '该授权已领取。' : grant.status === 'denied' ? '已拒绝连接。' : grant.status === 'expired' ? '授权领取已过期，请重新申请。' : '已授权，请返回 Agent；等待中的连接会自动完成。'}</p>`}
</main></body></html>`;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function readJsonLines(file) {
  const text = await fs.readFile(file, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
  const lines = text.split('\n').filter(Boolean), values = [];
  for (let index = 0; index < lines.length; index++) {
    try { values.push(JSON.parse(lines[index])); }
    catch (error) {
      if (index !== lines.length - 1) throw error;
      // A crash can leave only the last append incomplete. Repair that tail from
      // the already validated prefix before transaction recovery appends again.
      await atomicWrite(file, values.length ? `${values.map(value => JSON.stringify(value)).join('\n')}\n` : '');
    }
  }
  return values;
}

async function appendJsonLine(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, 'a', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
}

async function durableUnlink(file) {
  await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (process.platform === 'win32') return;
  const directory = await fs.open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function publicProject(project) {
  const { tokenHash: _tokenHash, ...visible } = project;
  return visible;
}

function compactProject(input, tokenHash = '') {
  const id = String(input?.id || '').trim().toLowerCase();
  const name = String(input?.name || '').trim();
  if (!idPattern.test(id)) throw new MapError('INVALID_PROJECT', 'Project ID must use lowercase letters, numbers, and hyphens');
  if (!name || name.length > 120) throw new MapError('INVALID_PROJECT', 'Project name is required');
  return {
    id,
    name,
    description: String(input?.description || '').trim().slice(0, 500),
    status: ['connected', 'pending', 'error'].includes(input?.status) ? input.status : 'pending',
    updatedAt: now(),
    ...(tokenHash ? { tokenHash } : {}),
  };
}

function mapNode({ id, title, purpose = '', state = 'dirty', children = [] }) {
  return { id, title, purpose, kind: 'module', state, proposal: 'accepted', memories: [], ideas: [], todos: [], bugs: [], dormant: [], files: [], owns: [], children };
}

function overviewChildren(projects) {
  return projects.map(project => ({ ...mapNode({
    id: `P_${project.id}`,
    title: project.name,
    purpose: project.description || `项目 ID：${project.id}`,
    state: project.status === 'connected' ? 'success' : project.status === 'error' ? 'failed' : 'dirty',
  }), cloudProjectId: project.id }));
}

function overviewDocument(projects) {
  return {
    v: 1,
    project: '项目地图',
    bootstrap: 'ready',
    flows: [],
    root: mapNode({
      id: 'T0',
      title: '项目地图',
      purpose: '线上所有 Context Guard 项目的统一入口',
      state: projects.some(project => project.status === 'error') ? 'failed' : 'success',
      children: overviewChildren(projects),
    }),
  };
}

function reconcileOverview(stored, projects) {
  const generated = overviewDocument(projects);
  if (!stored?.document?.root) return generated;
  const savedChildren = Array.isArray(stored.document.root.children) ? stored.document.root.children : [];
  const byProject = new Map(savedChildren.map(node => [node?.cloudProjectId || (String(node?.id || '').startsWith('P_') ? String(node.id).slice(2) : ''), node]).filter(([id]) => id));
  const managedIds = new Set(projects.map(project => project.id));
  const projectChildren = generated.root.children.map(generatedNode => {
    const saved = byProject.get(generatedNode.cloudProjectId);
    if (!saved) return generatedNode;
    return {
      ...generatedNode,
      ...saved,
      id: generatedNode.id,
      cloudProjectId: generatedNode.cloudProjectId,
      // Connection state belongs to the registry. Human-authored fields remain.
      state: generatedNode.state,
      children: Array.isArray(saved.children) ? saved.children : [],
    };
  });
  const customChildren = savedChildren.filter(node => {
    const id = node?.cloudProjectId || (String(node?.id || '').startsWith('P_') ? String(node.id).slice(2) : '');
    return !id || !managedIds.has(id);
  });
  return {
    ...stored.document,
    project: '项目地图',
    bootstrap: 'ready',
    root: { ...stored.document.root, id: 'T0', children: [...projectChildren, ...customChildren] },
  };
}

function emptyProjectDocument(project) {
  return { v: 1, project: project.name, bootstrap: 'pending', flows: [], root: null };
}

function placeholderProjectDocument(project) {
  return { v: 1, project: project.name, bootstrap: 'pending', flows: [], root: mapNode({ id: 'T0', title: project.name, purpose: project.description || '等待本地 Map 首次同步' }) };
}

function normalizeScope(input = {}) {
  const list = value => [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))].sort();
  return { nodeIds: list(input.nodeIds), fields: list(input.fields), paths: list(input.paths), wildcard: !!input.wildcard };
}

function scopeOfOperations(operations = [], extra = {}) {
  const nodeIds = [], fields = [];
  let wildcard = false;
  for (const operation of operations || []) {
    if (operation.id) nodeIds.push(operation.id);
    if (operation.parentId) nodeIds.push(operation.parentId);
    if (operation.node?.id) nodeIds.push(operation.node.id);
    fields.push(...Object.keys(operation.fields || {}));
    if (operation.type === 'document' || operation.type === 'initialize' || operation.type === 'snapshot') wildcard = true;
  }
  return normalizeScope({
    nodeIds: [...nodeIds, ...(extra.nodeIds || [])],
    fields: [...fields, ...(extra.fields || [])],
    paths: extra.paths || [],
    wildcard: wildcard || extra.wildcard,
  });
}

function pathOverlap(a, b) {
  const left = a.replace(/^\.\//, '').replace(/\/$/, '');
  const right = b.replace(/^\.\//, '').replace(/\/$/, '');
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function scopesOverlap(left, right) {
  if (left?.wildcard || right?.wildcard) return true;
  const nodes = new Set(left?.nodeIds || []);
  const sameNode = (right?.nodeIds || []).some(id => nodes.has(id));
  if (sameNode) {
    const a = left?.fields || [], b = right?.fields || [];
    if (!a.length || !b.length || b.some(field => a.includes(field))) return true;
  }
  return (left?.paths || []).some(a => (right?.paths || []).some(b => pathOverlap(a, b)));
}

export async function authorizeCiReceiver({ principal, ciSessionId, message, receivers, store, templates = [] }) {
  const receiver = receivers?.[ciSessionId];
  if (principal.role !== 'device' || !receiver || !message.session?.id) protocolFail('FORBIDDEN', 'CI receiver is not assigned to this task Session');
  const executorId = message.session.id;
  if (executorId !== receiver.executorSessionId && (!templates.includes(receiver.executorSessionId) ||
      await store.creationTemplate(principal, executorId) !== receiver.executorSessionId)) protocolFail('FORBIDDEN', 'CI receiver is not assigned to this task Session');
  if (!['object.read', 'object.put', 'ci.result'].includes(message.type) || message.type === 'object.put' &&
      (message.payload.kind !== 'evidence' || !message.payload.ref.startsWith(`ci:${ciSessionId}:`))) protocolFail('FORBIDDEN', 'CI may only read task references and write its own test evidence/result');
  const ciBinding = await store.registeredBinding(principal, ciSessionId);
  const executorBinding = await store.registeredBinding(principal, executorId);
  if (!ciBinding || ciBinding.worktreeId !== receiver.worktreeId || !executorBinding || executorBinding.worktreeId === ciBinding.worktreeId) protocolFail('FORBIDDEN', 'CI must use its registered independent worktree on the owning device');
  return { ...principal, agentId: ciSessionId, role: 'ci', ciBindingVersion: ciBinding.version, bindings: { [executorId]: executorBinding.worktreeId } };
}

export function authorizeCiTransaction(state, principal, message) {
  authorizeCursorCiTask(state, principal, message);
  authorizeCursorCiHostEvidence(state, principal, message);
  if (principal.role !== 'ci') return;
  // Recheck the delegated identity on the same authoritative snapshot as the
  // object read, before ProtocolStore can reuse any accepted receipt.
  const binding = state.bindings[digest(JSON.stringify([principal.repositoryId, principal.agentId]))];
  if (!binding || binding.version !== principal.ciBindingVersion || binding.deviceId !== principal.deviceId ||
      binding.worktreeId === principal.bindings?.[message.session.id]) protocolFail('FORBIDDEN', 'CI binding changed before the operation');
  if (message.type !== 'object.read') return;
  const tasks = Object.values(state.tasks).filter(task => task.repositoryId === principal.repositoryId &&
    task.session?.id === message.session.id && task.session.generation === message.session.generation && task.busy && task.stage === 'testing');
  if (tasks.length !== 1) protocolFail('FORBIDDEN', 'CI reads require one current testing task');
  const task = tasks[0], { ref, version } = message.payload;
  const assigned = [task.handoff?.ciTodoRef, ...(task.handoff?.unitTestRefs || [])].includes(ref) &&
    Object.hasOwn(task.references || {}, ref) && task.references[ref] === version;
  const ownEvidence = ref.startsWith(`ci:${principal.agentId}:`) &&
    state.objects[scopedObjectKey(principal, message.session, ref)]?.versions?.[version]?.kind === 'evidence';
  if (!assigned && !ownEvidence) protocolFail('FORBIDDEN', 'CI may only read current handoff versions and its own evidence');
}

function readCoordinatorMapNode(snapshot, id, nodeIds) {
  const root = snapshot?.memory?.map?.root;
  id ||= root?.id;
  const node = root && entries(root).get(id)?.node;
  if (!node || Array.isArray(nodeIds) && !nodeIds.includes(id)) protocolFail('FORBIDDEN', 'Requested Main node is not in the Coordinator scope');
  const { children = [], _inbox, ...fields } = node;
  return { version: snapshot.version, mainSha: snapshot.mainSha, node: { ...fields,
    children: children.filter(child => !Array.isArray(nodeIds) || nodeIds.includes(child.id))
      .map(child => ({ id: child.id, title: child.title, purpose: child.purpose })) } };
}

export async function startCloudServer({
  host = process.env.CONTEXT_GUARD_CLOUD_HOST || '127.0.0.1',
  port = Number(process.env.CONTEXT_GUARD_CLOUD_PORT || 8787),
  dataDir = process.env.CONTEXT_GUARD_CLOUD_DATA || path.join(root, '.cloud-data'),
  adminToken = process.env.CONTEXT_GUARD_CLOUD_TOKEN || '',
  browserToken = process.env.CONTEXT_GUARD_CLOUD_WORKBENCH_TOKEN || adminToken,
  browserPasswordHash = process.env.CONTEXT_GUARD_CLOUD_PASSWORD_HASH || '',
  privateAccess = process.env.CONTEXT_GUARD_CLOUD_PRIVATE === '1',
  secureCookies = process.env.CONTEXT_GUARD_CLOUD_SECURE_COOKIES === '1',
  publicOrigin = process.env.CONTEXT_GUARD_CLOUD_ORIGIN || '',
  memoryConfig,
  protocolConfig,
  cursorConfigFile = process.env.CONTEXT_GUARD_CURSOR_CONFIG || '',
  cursorProviderFactory = config => new CursorCloudProvider(config),
  cursorGitProofFactory = config => new CursorGitProof(config),
  coordinatorModelFactory = config => new CoordinatorModel(config),
  integrationConfig,
  attachmentProvider,
  faultInjector = async () => {},
} = {}) {
  const release = await releaseIdentity();
  // Version the entire import graph, not only the entry scripts. A deployment
  // changes the URL of every asset while private Map/API responses stay fresh.
  const workbenchAssets = new Map();
  const assetHash = createHash('sha256');
  for (const [file, contentType] of workbenchAssetTypes) {
    const body = await fs.readFile(path.join(root, file)).catch(cause => {
      if (file === 'prototype/cursor-chat.mjs' && cause.code === 'ENOENT') return null;
      throw cause;
    });
    if (!body) continue; // Older fixed UI versions do not import Cursor chat.
    assetHash.update(file).update(body);
    workbenchAssets.set(file, { body, contentType });
  }
  const assetVersion = assetHash.digest('hex').slice(0, 16);
  const workbenchHtml = (await fs.readFile(htmlPath, 'utf8')).replace(
    /(href|src)="\.\/(workbench\.css|workbench-(?:app|data)\.js)(?:\?[^\"]*)?"/g,
    (_match, attribute, file) => `${attribute}="/assets/${assetVersion}/prototype/${file}"`,
  );
  const registryFile = path.join(dataDir, 'projects.json');
  if (cursorConfigFile && !path.isAbsolute(cursorConfigFile)) throw new MapError('INVALID_CURSOR_CONFIG', 'Cursor configuration requires an absolute private file');
  const cursorConfiguration = cursorConfigFile ? await readJson(cursorConfigFile) : null;
  const cursorServices = new Map();
  const cursorRoleServices = new Map();
  const initializedCursorRoles = new Map();
  const cursorFor = async project => {
    const config = cursorConfiguration?.projects?.[project.id];
    if (!config) throw new MapError('CURSOR_NOT_CONFIGURED', '服务器尚未配置此项目的 Cursor Cloud', 503);
    if (cursorServices.has(project.id)) return cursorServices.get(project.id);
    if (!path.isAbsolute(config.apiKeyFile || '') || Object.keys(config).some(key => !['apiKeyFile', 'repositoryUrl', 'startingRef', 'model', 'roles'].includes(key))) throw new MapError('INVALID_CURSOR_CONFIG', '配置私有密钥文件、仓库和固定提交', 503);
    let apiKey;
    try {
      const secret = (await fs.readFile(config.apiKeyFile, 'utf8')).trim();
      apiKey = secret.startsWith('{') ? JSON.parse(secret).CURSOR_API_KEY : secret;
    } catch { throw new MapError('CURSOR_AUTH_REQUIRED', '无法读取 Cursor 私有密钥，请检查服务器配置', 503); }
    const service = new CursorCloudSessions({ directory: path.join(dataDir, 'cursor', digest(project.id)),
      provider: cursorProviderFactory({ apiKey }), repositoryUrl: config.repositoryUrl, startingRef: config.startingRef, model: config.model });
    cursorServices.set(project.id, service);
    return service;
  };
  const mapsDir = path.join(dataDir, 'maps');
  const eventsDir = path.join(dataDir, 'events');
  const operationsDir = path.join(dataDir, 'operations');
  const worksDir = path.join(dataDir, 'works');
  const transactionsDir = path.join(dataDir, 'transactions');
  const overviewFile = path.join(mapsDir, 'project-overview.json');
  const directoryClients = new Set();
  const workbenchClients = new Set();
  const projectClients = new Map();
  const sockets = new Set();
  const tails = new Map();
  const loginFailures = new Map();
  let registryTail = Promise.resolve();
  const allowedOrigin = canonicalOrigin(publicOrigin);
  if (publicOrigin && !allowedOrigin) throw new MapError('INVALID_ORIGIN', 'CONTEXT_GUARD_CLOUD_ORIGIN must be an absolute HTTP(S) origin');
  if (browserPasswordHash && !passwordHashPattern.test(browserPasswordHash)) throw new MapError('INVALID_PASSWORD_HASH', 'Use a Context Guard scrypt password hash');
  if (browserPasswordHash && !browserToken) throw new MapError('WORKBENCH_TOKEN_REQUIRED', 'Password login requires an independent workbench cookie token');
  const configuredMemory = (memoryConfig && { ...memoryConfig }) || (process.env.CONTEXT_GUARD_MEMORY_CONFIG
    ? await readJson(path.resolve(process.env.CONTEXT_GUARD_MEMORY_CONFIG), null)
    : null);
  const rawIntegrations = integrationConfig || (process.env.CONTEXT_GUARD_INTEGRATIONS_CONFIG
    ? await readJson(path.resolve(process.env.CONTEXT_GUARD_INTEGRATIONS_CONFIG), null) : null);
  const integrations = rawIntegrations ? validateIntegrationConfig(rawIntegrations) : null;
  const mapProjects = new MapProjects({ config: integrations?.mapProjects,
    readOverview: () => workbenchSnapshot('overview', null), registeredProjects: () => registry.projects, memoryConfig: configuredMemory });
  const mapProjectRefs = new Map();
  const coordinatorConfigFor = project => isMapProject(project) ? mapProjects.coordinatorConfig() : configuredMemory?.projects?.[project?.id]?.coordinator;
  const readMemoryProject = (configuration, id) => mapProjectRefs.has(id) ? mapProjects.read(id) : readStoredMemoryProject(configuration, id);
  const commitMainMemoryMap = (configuration, id, input, actor, options) => mapProjectRefs.has(id)
    ? commitOverview(input, actor, mapProjectRefs.get(id)) : commitStoredMainMemoryMap(configuration, id, input, actor, options);
  if (integrations && [adminToken, browserToken, configuredMemory?.adminToken].filter(Boolean).includes(integrations.token)) {
    throw new MapError('INVALID_INTEGRATION_CONFIG', 'Use an independent integration credential', 503);
  }
  const integrationAttachments = integrations ? new IntegrationAttachmentStore({ directory: path.join(dataDir, 'integration-attachments'), maxBytes: 5 * 1024 * 1024 }) : null;
  const manualBriefStores = new Map();
  const bindingStores = new Map();
  const modelSettings = new Map();
  const mapTranslations = new MapTranslations();
  const modelSettingsFor = project => {
    if (!modelSettings.has(project.id)) {
      const config = coordinatorConfigFor(project);
      if (!config?.enabled) protocolFail('COORDINATOR_DISABLED', 'Coordinator is not enabled for this project');
      const creating = (async () => {
        if (isMapProject(project) && config.modelProviders) {
          const source = projectById(integrations.mapProjects.coordinatorProjectId);
          if (!source) protocolFail('COORDINATOR_DISABLED', '默认模型项目不可用');
          config.defaultProviderId = (await (await modelSettingsFor(source)).state()).selectedId;
        }
        return CoordinatorModelSettings.open({ directory: path.join(dataDir, 'coordinators', project.id), config, factory: coordinatorModelFactory });
      })();
      modelSettings.set(project.id, creating);
      creating.catch(() => { if (modelSettings.get(project.id) === creating) modelSettings.delete(project.id); });
    }
    return modelSettings.get(project.id);
  };
  const manualBriefsFor = project => {
    if (!manualBriefStores.has(project.id)) manualBriefStores.set(project.id, new CoordinatorManualBriefs({
      directory: path.join(dataDir, 'manual-briefs', project.id), projectId: project.id,
      ...(isMapProject(project) ? { mapOnly: true } : {}),
      readMain: async () => { const { main } = await readMemoryProject(configuredMemory, project.id); return { version: main?.version, document: main?.memory?.map }; },
      readBinding: conversationId => conversationsFor(project).get(conversationId),
      readCommitReceipt: (input, actor) => mapProjectRefs.has(project.id)
        ? readOverviewReceipt(input, actor, mapProjectRefs.get(project.id))
        : readMainMemoryReceipt(configuredMemory, project.id, input, actor),
      commitMain: (input, actor) => commitMainMemoryMap(configuredMemory, project.id, input, actor),
    }));
    return manualBriefStores.get(project.id);
  };
  const bindingsFor = project => {
    if (!bindingStores.has(project.id)) bindingStores.set(project.id, new CoordinatorBindings({
      directory: path.join(dataDir, 'coordinators', project.id), conversations: conversationsFor(project),
      nodeIds: coordinatorConfigFor(project)?.nodeIds || null,
      readMain: async () => (await readMemoryProject(configuredMemory, project.id)).main,
    }));
    return bindingStores.get(project.id);
  };
  if (configuredMemory) await enforceMainHistoryRetention(configuredMemory);
  const memoryHandler = configuredMemory ? createMemoryHandler(configuredMemory, { authorizeDevice: async ({ credential, projectId, sessionId, scope, method }) => {
    if (!interfaceAuth) return false;
    const principal = await interfaceAuth.authenticate(credential);
    const repository = interfaceConfig.repositories.find(item => item.repositoryId === principal.repositoryId);
    if (principal.role !== 'device' || repository?.projectId !== projectId) return false;
    if (sessionId) return await interfaceStorage(principal).store.registeredBinding(principal, sessionId) || false;
    return ['GET', 'POST'].includes(method) && ['main', 'preferences'].includes(scope) &&
      (method === 'GET' || scope === 'preferences');
  } }) : null;
  const interfaceConfig = protocolConfig || configuredMemory?.interfaceV2;
  const interfaceStores = new Map();
  const interfaceStreams = new Set();
  const interfacePresence = new Map();
  const presenceKey = (repositoryId, sessionId) => `${repositoryId}\0${sessionId}`;
  const interfaceMapHeads = async principal => {
    const repository = interfaceConfig?.repositories?.find(item => item.repositoryId === principal.repositoryId);
    if (!repository?.projectId || !configuredMemory?.projects?.[repository.projectId]) return {};
    return memoryHeads(configuredMemory, repository.projectId);
  };
  const interfaceStorage = principal => {
    const directory = path.join(dataDir, 'interface-v2', digest(principal.repositoryId));
    if (!interfaceStores.has(principal.repositoryId)) interfaceStores.set(principal.repositoryId, {
      store: new ProtocolStore(directory), blobs: new ProtocolBlobs(path.join(directory, 'blobs')), snapshots: new WorkbenchSnapshots(path.join(directory, 'snapshots')),
    });
    return interfaceStores.get(principal.repositoryId);
  };
  const interfaceProject = project => {
    const repository = interfaceConfig?.repositories?.find(item => item.projectId === project?.id && /^\d+$/.test(item.repositoryId));
    if (!repository) protocolFail('UNAVAILABLE', 'Cloud task delivery is not configured for this project');
    const principal = { repositoryId: repository.repositoryId, deviceId: 'cloud-browser', agentId: 'cloud-human', role: 'human' };
    return { repository, principal, ...interfaceStorage(principal) };
  };
  const cursorRolesFor = async project => {
    const config = cursorConfiguration?.projects?.[project?.id], roles = config?.roles;
    if (!roles) return null;
    const coordinator = configuredMemory?.projects?.[project.id]?.coordinator;
    const { repository, store } = interfaceProject(project);
    if (isMapProject(project) || !coordinator?.enabled || Object.keys(roles).some(key => !['templateSessionId', 'githubTokenFile', 'ciPolicy'].includes(key)) ||
        !coordinator.sessionTemplates?.includes(roles.templateSessionId) || coordinator.bindings?.[roles.templateSessionId] !== cursorTemplateWorktree(roles.templateSessionId) ||
        config.repositoryUrl?.replace(/\.git$/, '').toLowerCase() !== `https://github.com/${repository.slug}`.toLowerCase() || !allowedOrigin) protocolFail('FORBIDDEN', 'Configure the hosted Cursor template explicitly for this repository Coordinator');
    if (!cursorRoleServices.has(project.id)) {
      const creating = (async () => {
        // The same private provider, not a human chat Session or device identity.
        const transport = await cursorFor(project);
        const service = new CursorRoleFactory({ directory: path.join(dataDir, 'cursor-roles', digest(project.id)), projectId: project.id,
          repositoryId: repository.repositoryId, templateSessionId: roles.templateSessionId, repositoryUrl: config.repositoryUrl,
          startingRef: config.startingRef, model: config.model, store, provider: transport.provider,
          gitProof: cursorGitProofFactory({ repository: repository.slug, tokenFile: roles.githubTokenFile }),
          ...(roles.ciPolicy ? { ciPolicy: roles.ciPolicy } : {}),
          endpoint: allowedOrigin + `/api/workbench/projects/${project.id}/api/cursor-role-mcp`,
          allowLoopback: allowedOrigin.startsWith('http://127.0.0.1:') || allowedOrigin.startsWith('http://localhost:'),
          authorizeSource: async ({ state, task }) => {
            const original = Object.values(state.projectTasks || {}).find(item => item.repositoryId === repository.repositoryId && item.taskId === task.id && item.sessionId === task.session.id);
            if (original?.cursorDelegation) await requireCursorGrant(project, await conversationsFor(project).get(original.conversationId), null, original.cursorDelegation);
            const template = state.bindings[digest(JSON.stringify([repository.repositoryId, roles.templateSessionId]))];
            if (!template || template.deviceId !== 'cloud-cursor:' + project.id || template.worktreeId !== coordinator.bindings[roles.templateSessionId]) return false;
            const memory = await readMemoryProject(configuredMemory, project.id), document = memory.main?.memory?.map;
            if (!document?.root || memory.main.version !== task.assignment?.mainVersion) return false;
            const readable = filterNodeAccess(document, [...entries(document.root).keys()], task.session.id, 'read');
            return task.assignment.nodeIds.every(id => readable.includes(id));
          } });
        await service.initialize();
        service.mcp = createCursorRoleMcpHandler({ channel: service.channel, projectId: project.id, endpoint: service.endpoint,
          allowLoopback: allowedOrigin.startsWith('http://127.0.0.1:') || allowedOrigin.startsWith('http://localhost:') });
        initializedCursorRoles.set(project.id, service);
        return service;
      })();
      cursorRoleServices.set(project.id, creating);
      creating.catch(() => { if (cursorRoleServices.get(project.id) === creating) cursorRoleServices.delete(project.id); });
    }
    return cursorRoleServices.get(project.id);
  };
  const verifyInterfaceRouting = async (identity, message) => {
    const repository = interfaceConfig?.repositories?.find(item => item.repositoryId === identity.repositoryId);
    if (!repository?.projectId || !configuredMemory?.projects?.[repository.projectId]) return false;
    const memory = await readMemoryProject(configuredMemory, repository.projectId);
    if (!memory.main?.memory?.map?.root || memory.main.version !== message.payload.mainVersion) return false;
    const doc = memory.main.memory.map;
    const binding = await interfaceStorage(identity).store.registeredBinding(identity, message.session.id);
    const readable = filterNodeAccess(doc, [...entries(doc.root).keys()], binding.agentId, 'read');
    return message.payload.nodeIds.every(id => readable.includes(id));
  };
  const interfaceWorkflow = {
    verifyCiReceiver: async (state, principal, session) => {
      // An authenticated CI identity is itself the receiver; session authority
      // has already been checked by ProtocolStore before reaching the reducer.
      if (principal.role === 'ci') return true;
      const repository = interfaceConfig?.repositories?.find(item => item.repositoryId === principal.repositoryId);
      const project = projectById(repository?.projectId);
      if (project && cursorConfiguration?.projects?.[project.id]?.roles && Object.hasOwn(configuredMemory?.projects?.[project.id]?.coordinator?.bindings || {}, cursorConfiguration.projects[project.id].roles.templateSessionId)) {
        // Initialize outside task transactions. Never acquire a factory/lease
        // lock here; callbacks already hold ProtocolStore's transaction lock.
        // Initialization itself needs ProtocolStore. Awaiting its promise here
        // would deadlock when this verifier already holds the store lock.
        const roles = initializedCursorRoles.get(project.id);
        if (roles && await roles.owns(session.id)) return roles.hasCiReceiver(state, session);
      }
      return hasCiReceiver(state, principal, session, configuredMemory?.projects?.[repository?.projectId]?.coordinator);
    },
    verifyRouting: verifyInterfaceRouting,
    verifyCompletion: async (identity, task, receipts) => {
      const repository = interfaceConfig?.repositories?.find(item => item.repositoryId === identity.repositoryId);
      const project = configuredMemory?.projects?.[repository?.projectId];
      if (!project?.completion) return false;
      return verifyTaskCompletion({ project, repositoryId: identity.repositoryId, task, receipts,
        memory: await readMemoryProject(configuredMemory, repository.projectId) });
    },
    verifyClose: verifyTaskClose,
  };
  const interfaceAuth = interfaceConfig ? new ProtocolAuth({
    directory: path.join(dataDir, 'interface-v2'),
    verifyPassword: password => verifyWorkbenchPassword(password, browserPasswordHash),
    authorizeRepository: slug => {
      const repository = interfaceConfig.repositories?.find(item => item.slug === slug);
      return repository && /^\d+$/.test(repository.repositoryId) ? repository.repositoryId : null;
    },
    resolveIdentity: (slug, clientId) => {
      const repository = interfaceConfig.repositories?.find(item => item.slug === slug);
      const client = repository?.clients?.[clientId];
      if (!client || client.disabled || client.role === 'human' || !/^\d+$/.test(repository.repositoryId)) return null;
      return { repositoryId: repository.repositoryId, repositorySlug: slug, clientId, deviceId: client.deviceId, agentId: client.agentId, role: client.role || 'executor', bindings: client.bindings || {}, nodeIds: client.nodeIds || null };
    },
  }) : null;
  const loginResult = opened => {
    const repository = interfaceConfig.repositories.find(item => item.repositoryId === opened.data.repositoryId);
    opened.data.capabilities = repository?.projectId && configuredMemory?.projects?.[repository.projectId] ? ['private-map-heads', 'device-memory'] : [];
    if (opened.data.capabilities.length) opened.data.projectId = repository.projectId;
    return opened;
  };
  const deviceAuthorization = interfaceAuth ? new DeviceAuthorization({
    directory: path.join(dataDir, 'interface-v2'),
    authorizeRepository: slug => {
      const repository = interfaceConfig.repositories?.find(item => item.slug === slug);
      return repository && /^\d+$/.test(repository.repositoryId) && configuredMemory?.projects?.[repository.projectId] ? repository.repositoryId : null;
    },
    issueDevice: async (repository, clientId) => loginResult(await interfaceAuth.issueDevice(repository, clientId)),
  }) : null;
  let registry = await readJson(registryFile, null);
  if (!registry) {
    registry = { v: 2, projects: [compactProject({ id: 'context-guard', name: 'Context Guard', description: 'Context Guard 项目地图' })] };
    await atomicWrite(registryFile, json(registry));
  }

  const projectById = id => registry.projects.find(project => project.id === id);
  const coordinators = new Map();
  const cursorTransitions = new Set();
  const cursorModeEpochs = new Map();
  let integrationGateway = null;
  const conversationsFor = project => new CoordinatorConversations(path.join(dataDir, 'coordinators', project.id));
  const cursorExecutionScope = (project, actor) => {
    const grant = integrations?.cursorExecution?.[project.id], roles = cursorConfiguration?.projects?.[project.id]?.roles;
    const host = cursorConfiguration?.projects?.[project.id], coordinator = configuredMemory?.projects?.[project.id]?.coordinator;
    if (isMapProject(project) || actor?.kind !== 'human' || actor.integration !== 'slack' || actor.teamId !== integrations?.teamId ||
        actor.sessionId !== `slack:${actor.teamId}:${actor.userId}` || !integrations?.actions.includes('conversation.cursor') ||
        !grant?.userIds.includes(actor.userId) || grant.templateSessionId !== roles?.templateSessionId || !coordinator?.enabled ||
        !coordinator.sessionTemplates?.includes(grant.templateSessionId) || coordinator.bindings?.[grant.templateSessionId] !== cursorTemplateWorktree(grant.templateSessionId)) {
      protocolFail('FORBIDDEN', 'Cursor execution requires an explicit repository, template and Slack operator grant');
    }
    const { repository } = interfaceProject(project);
    if (!/^[a-f0-9]{40}$/.test(host.startingRef || '') || host.repositoryUrl?.replace(/\.git$/, '').toLowerCase() !== `https://github.com/${repository.slug}`.toLowerCase()) protocolFail('FORBIDDEN', 'Cursor repository and fixed source commit must match this project');
    return { projectId: project.id, repositoryId: repository.repositoryId, templateSessionId: grant.templateSessionId, actor: structuredClone(actor),
      configurationHash: digest(JSON.stringify([grant, repository.repositoryId, repository.slug, host.repositoryUrl, host.startingRef])) };
  };
  const requireCursorGrant = async (project, conversation, actor = null, delegation = null) => {
    const grant = conversation.cursorExecution;
    if (!grant || conversation.executionMode !== 'automatic') protocolFail('FORBIDDEN', 'This conversation has no Cursor execution grant');
    const current = cursorExecutionScope(project, grant.actor);
    if (actor) cursorExecutionScope(project, actor);
    if (grant.configurationHash !== current.configurationHash || grant.projectId !== current.projectId || grant.repositoryId !== current.repositoryId ||
        grant.templateSessionId !== current.templateSessionId || delegation &&
        (delegation.grantId !== grant.operationId || delegation.templateSessionId !== grant.templateSessionId || delegation.configurationHash !== grant.configurationHash)) {
      protocolFail('FORBIDDEN', 'The original Cursor execution grant changed');
    }
    return grant;
  };
  const normalizedSessions = item => (Array.isArray(item?.sessions) ? item.sessions : [])
    .map(value => String(value || '').trim()).filter(Boolean);
  const mapItem = async (project, nodeId, kind, itemId) => {
    const memory = await readMemoryProject(configuredMemory, project.id);
    const root = memory.main?.memory?.map?.root;
    const node = root && entries(root).get(nodeId)?.node;
    const key = kind === 'todo' ? 'todos' : kind === 'bug' ? 'bugs' : '';
    return { memory, node, key, item: key ? node?.[key]?.find(value => value?.id === itemId) : null };
  };
  const writeItemSessions = async (project, { nodeId, kind, itemId }, sessionId) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { memory, node, key, item } = await mapItem(project, nodeId, kind, itemId);
      if (!item || !memory.main?.version) return null;
      const sessions = normalizedSessions(item);
      if (sessions[0] === sessionId) return sessionId;
      const list = node[key].map(value => value?.id === itemId
        ? { ...value, sessions: [sessionId, ...normalizedSessions(value).filter(id => id !== sessionId)] }
        : value);
      try {
        await commitMainMemoryMap(configuredMemory, project.id, {
          operationId: `coordinator-bind-session:${digest(`${project.id}:${nodeId}:${kind}:${itemId}:${sessionId}`)}`,
          baseVersion: memory.main.version,
          operations: [{ type: 'update', id: nodeId, fields: { [key]: list } }],
        }, { kind: 'coordinator', sessionId: '', agentId: `coordinator:${project.id}` });
        return sessionId;
      } catch (error) {
        if (error.code !== 'VERSION_CONFLICT') throw error;
      }
    }
    protocolFail('VERSION_CONFLICT', 'Main changed while binding the execution Session');
  };
  const itemConversation = async (project, { nodeId, kind, itemId }) => {
    const config = configuredMemory?.projects?.[project.id]?.coordinator;
    if (!config?.enabled) protocolFail('FORBIDDEN', 'Coordinator is not enabled');
    const snapshot = await readMemoryProject(configuredMemory, project.id);
    const node = entries(snapshot.main.memory.map.root).get(nodeId)?.node;
    const item = node?.[kind === 'todo' ? 'todos' : kind === 'bug' ? 'bugs' : kind === 'idea' ? 'ideas' : '']?.find(item => item.id === itemId);
    if (!item || config.nodeIds && !config.nodeIds.includes(nodeId)) protocolFail('FORBIDDEN', 'Map item is not available');
    return conversationsFor(project).ensure({ nodeId, kind, item });
  };
  const mapIntakeFor = (project, service) => new CoordinatorMapIntake({
    directory: path.join(dataDir, 'coordinators', project.id), service,
    onItem: async entry => {
      const conversations = conversationsFor(project), id = await conversations.ensure(entry);
      const dispatch = entry.item.dispatch;
      if (dispatch?.session_id && dispatch.task_id) await conversations.bind(id, dispatch.session_id, dispatch.task_id);
    },
    read: () => readMemoryProject(configuredMemory, project.id),
    nodeIds: configuredMemory.projects[project.id].coordinator.nodeIds || null,
  });
  const coordinatorFor = async (project, conversationId = 'legacy') => {
    const key = `${project.id}:${conversationId}`, epoch = cursorModeEpochs.get(key) || 0;
    const assertCurrentEpoch = () => {
      if (cursorTransitions.has(key) || (cursorModeEpochs.get(key) || 0) !== epoch) throw new MapError('COORDINATOR_BUSY', 'Conversation execution mode is changing', 409);
    };
    assertCurrentEpoch();
    const config = coordinatorConfigFor(project);
    if (!config?.enabled) throw new MapError('COORDINATOR_DISABLED', 'Coordinator is not enabled for this project', 404);
    const conversations = conversationsFor(project);
    if (conversationId.startsWith('session:')) {
      const sessionId = conversationId.slice('session:'.length);
      const { store, principal } = interfaceProject(project);
      const binding = await store.registeredBinding(principal, sessionId);
      if (!binding) protocolFail('NOT_FOUND', 'Session conversation is unavailable');
      await conversations.ensureSession(sessionId, binding.name || 'Session 对话');
    }
    const conversation = await conversations.get(conversationId);
    // A getter can carry an old registry snapshot across retirement. Reject
    // it before it can occupy or overwrite the new mode's cache slot.
    assertCurrentEpoch();
    const modeRevision = value => JSON.stringify([value.executionMode || 'automatic', value.cursorExecution || null]);
    const revision = modeRevision(conversation);
    const assertCurrentMode = async () => {
      assertCurrentEpoch();
      const current = await conversations.get(conversationId);
      assertCurrentEpoch();
      if (modeRevision(current) !== revision) throw new MapError('COORDINATOR_BUSY', 'Conversation execution mode changed', 409);
    };
    const manual = conversation.executionMode === 'manual';
    if (isMapProject(project) && !manual) protocolFail('FORBIDDEN', 'Map 项目只支持人工对话，不创建执行 Session');
    if (!coordinators.has(key)) {
      const creating = (async () => {
        let ownedService;
        try {
        if (!path.isAbsolute(config.providerFile || '') || !config.bindings || typeof config.bindings !== 'object') throw new MapError('INVALID_COORDINATOR_CONFIG', 'Configure provider and explicit Session bindings', 503);
        // A Map-only project has no repository or execution Session. Its
        // isolated workflow store is empty; manual briefs use Map CAS instead.
        const { repository, store, principal: human } = isMapProject(project)
          ? { repository: { repositoryId: project.id },
            store: new ProtocolStore(path.join(dataDir, 'map-conversation-workflow', project.id)),
            principal: { repositoryId: project.id, deviceId: 'cloud-browser', agentId: 'cloud-human', role: 'human' } }
          : interfaceProject(project);
        const bindings = { ...config.bindings };
        const refreshBindings = async () => {
          const next = { ...config.bindings };
          for (const item of await store.sessionCreations(human)) {
            if (item.state !== 'registered' || !config.sessionTemplates?.includes(item.templateSessionId)) continue;
            const binding = await store.registeredBinding(human, item.sessionId);
            if (binding?.worktreeId === item.worktreeId && binding.generation === item.generation) next[item.sessionId] = item.worktreeId;
          }
          for (const id of Object.keys(bindings)) if (!Object.hasOwn(next, id)) delete bindings[id];
          Object.assign(bindings, next);
          return Object.keys(bindings);
        };
        const principal = { repositoryId: repository.repositoryId, deviceId: 'cloud-coordinator', agentId: conversationId === 'legacy' ? `coordinator:${project.id}` : `coordinator:${conversationId}`, role: 'coordinator', bindings, nodeIds: config.nodeIds || null };
        const assertTaskOwner = async (sessionId, taskId) => {
          if (await conversations.owner(sessionId, taskId) !== conversationId) protocolFail('FORBIDDEN', 'Task belongs to another conversation');
        };
        const sessionFor = async id => {
          await refreshBindings();
          if (!Object.hasOwn(bindings, id)) protocolFail('FORBIDDEN', 'This Session is not assigned to the Coordinator');
          const binding = await store.registeredBinding(principal, id);
          if (!binding) protocolFail('NOT_FOUND', 'Session is not registered');
          return { id, generation: binding.generation };
        };
        const references = new Set(coordinatorReferences);
        const tools = selectCoordinatorTools(manual ? filterManualTools(coordinatorTools) : coordinatorTools, { fileWrite: config.fileWrite === true });
        const callerBinding = async (caller, id) => {
          try { return await store.registeredBinding(caller, id); }
          catch (error) { if (error.code === 'FORBIDDEN') return null; throw error; }
        };
        const executionPrincipal = async (caller, id) => {
          if (!caller) return principal;
          const binding = await store.registeredBinding(caller, id);
          if (!binding) protocolFail('FORBIDDEN', 'This Session is not assigned to the caller');
          // Device credentials may delegate Coordinator actions only to their
          // own current worktree. ProtocolStore rechecks this grant on commit.
          return caller.role === 'device' ? { ...caller, role: 'coordinator', bindings: { [id]: binding.worktreeId } } : caller;
        };
        const execute = createCoordinatorExecutor({
          authorizeTool: async (name, input, { caller }) => {
            const liveConversation = await conversations.get(conversationId);
            // A live counted tool makes retireIdle reject the transition.
            // Do not abort that step merely because an enable attempt is busy.
            if (service.retired || (liveConversation.executionMode === 'manual') !== manual) throw new MapError('COORDINATOR_BUSY', 'Conversation execution mode changed', 409);
            if (liveConversation.cursorExecution) await requireCursorGrant(project, liveConversation);
            Object.assign(conversation, liveConversation);
            for (const field of ['nodeId', 'kind', 'itemId', 'bindingApproval']) if (!Object.hasOwn(liveConversation, field)) delete conversation[field];
            if (!tools.some(tool => tool.name === name)) protocolFail('FORBIDDEN', 'Tool is not enabled for this conversation');
            if (caller && input.executionSessionId && !await callerBinding(caller, input.executionSessionId)) {
              protocolFail('FORBIDDEN', 'This Session is not assigned to the caller');
            }
            const scopes = [config.nodeIds, caller?.nodeIds].filter(Array.isArray);
            if (scopes.length) {
              // A node grant is not a repository file grant. This tool has no
              // file-scoped authorization contract, so restricted callers may
              // not use it even when project-wide file writing is enabled.
              if (name === 'write_file') protocolFail('FORBIDDEN', 'Repository file writing requires project-wide authorization');
              if (name === 'read_project_map') protocolFail('FORBIDDEN', 'Cross-project reading requires project-wide authorization');
              const ids = [input.nodeId, input.parentId, ...(input.nodeIds || [])].filter(Boolean);
              if (name === 'edit_map') {
                const snapshot = (await readMemoryProject(configuredMemory, project.id)).main;
                if (snapshot.version !== input.mainVersion) protocolFail('VERSION_CONFLICT', 'Main changed; read the node again');
                const document = snapshot.memory.map, index = entries(document.root);
                // Authorize the operations actually committed, not optional
                // aliases in the model's input. The subsequent CAS prevents a
                // changed subtree being committed after this scope check.
                for (const operation of coordinatorStructureOperations(input.actions, 'scope-check')) {
                  if (operation.type === 'create') ids.push(operation.parentId);
                  else if (operation.type === 'delete-work-item') {
                    if (operation.nodeId) ids.push(operation.nodeId);
                    else {
                      const owners = [...index.values()].filter(({ node }) => (node[`${operation.kind}s`] || []).some(item => item.id === operation.itemId));
                      ids.push(...(owners.length ? owners.map(({ node }) => node.id) : [document.root.id]));
                    }
                  } else {
                    ids.push(operation.id);
                    if (operation.parentId) ids.push(operation.parentId);
                    if (['delete', 'move'].includes(operation.type)) {
                      const target = index.get(operation.id)?.node;
                      if (target) ids.push(...entries(target).keys());
                    }
                  }
                }
              }
              if (name === 'read_map' && !input.nodeId) ids.push((await readMemoryProject(configuredMemory, project.id)).main?.memory?.map?.root?.id);
              if (name === 'prepare_task' && conversation.nodeId) ids.push(conversation.nodeId);
              if (ids.some(id => scopes.some(scope => !scope.includes(id)))) protocolFail('FORBIDDEN', 'Requested Main node is outside the effective Coordinator scope');
            }
          },
          filterResult: async (name, result, { caller }) => {
            const scopes = [config.nodeIds, caller?.nodeIds].filter(Array.isArray);
            const inScope = id => scopes.every(scope => scope.includes(id));
            if (name === 'list_sessions' && caller) {
              const sessions = [];
              for (const item of result.sessions) if (await callerBinding(caller, item.executionSessionId)) sessions.push(item);
              return { ...result, sessions };
            }
            if (name === 'list_tasks') {
              const tasks = [];
              for (const item of result.tasks) if ((!item.nodeId || inScope(item.nodeId)) &&
                (!caller || !item.executionSessionId || await callerBinding(caller, item.executionSessionId))) tasks.push(item);
              return { ...result, tasks };
            }
            if (name === 'list_conversations') {
              const visible = [];
              for (const item of result.conversations) if ((!item.nodeId || inScope(item.nodeId)) &&
                (!caller || !item.conversationId.startsWith('session:') || await callerBinding(caller, item.conversationId.slice(8)))) visible.push(item);
              return { ...result, conversations: visible };
            }
            if (name === 'read_map' && scopes.length) return { ...result,
              node: { ...result.node, children: result.node.children.filter(item => inScope(item.id)) } };
            if (name === 'edit_map' && scopes.length) return { ...result, nodes: result.nodes.filter(item => inScope(item.id)) };
            return result;
          },
          listSessions: async () => {
            const sessions = [];
            for (const id of await refreshBindings()) {
              const binding = await store.registeredBinding(principal, id);
              if (binding && binding.worktreeId === bindings[id]) sessions.push({ executionSessionId: id, generation: binding.generation, worktreeId: binding.worktreeId, name: binding.name || '', platform: binding.platform || '' });
            }
            return { sessions };
          },
          listConversations: async () => ({ conversations: (await conversations.list()).map(({ id, ...item }) => ({ conversationId: id, ...item })) }),
          modelSettings: async () => {
            const catalog = await (await modelSettingsFor(project)).state(), route = (await service.state()).modelRoute;
            return { ...catalog, ...(route ? { currentRoute: { kind: route.kind, model: route.model,
              ...(route.providerId ? { providerId: route.providerId } : {}) } } : {}) };
          },
          listProjects: async ({ operationId, actor }) => {
            if (!integrations || !manual) protocolFail('FORBIDDEN', '当前对话不支持查询 Slack 项目');
            validateIntegrationCommand(integrations, { id: `projects-${digest(operationId)}`, teamId: actor.teamId,
              userId: actor.userId, type: 'project.list', payload: {} });
            await authorizeIntegrationProject(project.id, actor);
            const result = await integrationCommand({ type: 'project.list' }, { actor, operationId });
            const projects = result.projects.map(({ id, name, description }) => ({ id, name, description }));
            return { currentProjectId: project.id, scope: 'authorized', total: projects.length, projects,
              instruction: '这是当前用户的完整授权目录，不是当前绑定项目的模块。总数以 total 为准，同名项目各计一次；只列名称，同名才用简介澄清，不展示内部 ID。' };
          },
          readProjectMap: async ({ projectId: targetId, nodeId }, { operationId, actor }) => {
            if (!integrations || !manual) protocolFail('FORBIDDEN', '当前对话不支持读取 Slack 项目');
            validateIntegrationCommand(integrations, { id: `read-${digest(operationId)}`, teamId: actor.teamId,
              userId: actor.userId, projectId: targetId, type: 'project.read', payload: {} });
            await authorizeIntegrationProject(project.id, actor); await authorizeIntegrationProject(targetId, actor);
            const target = await integrationProject(targetId);
            const result = await integrationCommand({ type: 'project.read', projectId: targetId }, { actor, operationId });
            return { kind: 'project-map-read', project: { id: target.id, name: target.name },
              ...readCoordinatorMapNode({ version: result.version, memory: { map: result.map } }, nodeId, coordinatorConfigFor(target)?.nodeIds) };
          },
          switchProject: async ({ projectId: targetId }, { operationId, actor, requestId }) => {
            if (!integrations || !manual) protocolFail('FORBIDDEN', '当前对话不支持切换 Slack 项目');
            validateIntegrationCommand(integrations, { id: `switch-${digest(operationId)}`, teamId: actor.teamId,
              userId: actor.userId, projectId: targetId, type: 'conversation.create', payload: {} });
            await authorizeIntegrationProject(project.id, actor); await authorizeIntegrationProject(targetId, actor);
            const target = await integrationProject(targetId);
            if (targetId === project.id) return { kind: 'project-current', name: target.name, message: '已经在这个项目，不更改对话。' };
            const targetConversation = await conversationsFor(target).createChat(`switch-${digest(operationId)}`, { executionMode: 'manual' });
            await coordinatorFor(target, targetConversation);
            return { kind: 'project-switch', actionId: operationId, status: 'pending', requestId, actor,
              sourceProjectId: project.id, sourceConversationId: conversationId,
              projectId: target.id, name: target.name, conversationId: targetConversation,
              ...(isMapProject(target) ? { mapNodeId: target.mapNodeId } : {}) };
          },
          selectModel: async (input, { operationId, actor }) => {
            // Apply the same project/action grant as a native human menu click.
            // Identity is supplied by coordinatorStep, not by tool arguments.
            if (!integrations) protocolFail('FORBIDDEN', 'Slack model selection is not enabled');
            const { command } = validateIntegrationCommand(integrations, { id: operationId, teamId: actor.teamId,
              userId: actor.userId, projectId: project.id, type: 'models.select', payload: input });
            await authorizeIntegrationProject(project.id, actor);
            return (await modelSettingsFor(project)).selectForTurn({ id: operationId, ...command.payload });
          },
          pendingBriefApproval: async () => (await store.projectTasks(principal)).some(task =>
            task.conversationId === conversationId && task.stage === 'brief'),
          pendingAcceptanceReview: async () => {
            for (const id of await refreshBindings()) {
              const binding = await store.registeredBinding(principal, id);
              if (!binding) continue;
              for (const task of await store.workflowTasks(principal, { id, generation: binding.generation })) {
                if (task.stage === 'awaiting-merge' && task.ci?.verdict === 'passed' &&
                    await conversations.owner(id, task.id) === conversationId) return true;
              }
            }
            return false;
          },
          listTasks: async () => {
            const snapshot = await readMemoryProject(configuredMemory, project.id);
            const root = snapshot.main?.memory?.map?.root;
            const index = root ? entries(root) : new Map();
            const projectTasks = (await store.projectTasks(principal)).filter(task => task.conversationId === conversationId);
            const tasks = projectTasks.map(task => ({ taskId: task.taskId, stage: task.stage,
              itemId: task.itemId || null, nodeId: task.nodeId || null, kind: task.kind || null,
              executionSessionId: task.sessionId || null, error: task.error }));
            const knownItems = new Set(projectTasks.map(task => task.itemId).filter(Boolean));
            if (root) {
              const allowed = Array.isArray(config.nodeIds) ? new Set(config.nodeIds) : null;
              const inScope = id => {
                if (!allowed) return true;
                for (let current = index.get(id); current; current = current.parentId ? index.get(current.parentId) : null) {
                  if (allowed.has(current.node.id)) return true;
                }
                return false;
              };
              for (const { node } of index.values()) {
                if (!inScope(node.id)) continue;
                for (const kind of ['todo', 'bug']) for (const item of node[`${kind}s`] || []) {
                  if (!item?.id || knownItems.has(item.id)) continue;
                  const closed = kind === 'todo' ? item.status === 'done' : isClosedBugStatus(item.status);
                  if (closed) continue;
                  const legacyDispatch = normalizedSessions(item).length > 0 || item.dispatch?.task_id || item.dispatch?.session_id;
                  tasks.push({ itemId: item.id, kind, title: item.title || item.desc || '',
                    stage: legacyDispatch ? 'legacy-dispatch-review' : item.status || 'pending',
                    executionSessionId: null,
                    ...(legacyDispatch ? { error: 'LEGACY_DISPATCH_REQUIRES_RECONCILIATION' } : {}),
                    // A stable task identity lets the Coordinator prepare a
                    // Map item from the legacy/Main conversation without
                    // inventing a second random task on retry.
                    taskId: mapWorkTaskId(project.id, node.id, kind, item.id), nodeId: node.id });
                }
              }
            }
            return { tasks };
          },
          prepareProjectTask: async (input, operationId) => {
            if (manual) {
              const state = await service.state();
              if (state.messages.findLast(message => message.role === 'user')?.source === 'workflow') {
                protocolFail('APPROVAL_REQUIRED', '这是确认结果通知，不是新的需求指令；简短说明结果并等待用户继续讨论，不自动整理新 brief。');
              }
              const actor = [...state.messages].reverse().find(message => message.role === 'user' && message.actor)?.actor
                || { kind: 'human', sessionId: 'cloud-workbench' };
              const focused = !input.itemId && conversation.itemId && ['todo', 'bug'].includes(conversation.kind);
              if (focused && (input.nodeId !== undefined || input.kind !== undefined)) {
                protocolFail('INVALID_ARGUMENT', 'Provide the complete itemId, nodeId and kind to select an existing item; only fully omitted routing may inherit this conversation focus.');
              }
              const requirements = focused ? { ...input, itemId: conversation.itemId, nodeId: conversation.nodeId, kind: conversation.kind } : input;
              if (!conversation.bindingApproval || input.nodeIds.length !== 1 || input.nodeIds[0] !== conversation.nodeId) {
                protocolFail('APPROVAL_REQUIRED', '先确认本需求的主节点，再整理 brief；复用旧事项也不绕过挂载确认。');
              }
              return bindingsFor(project).withStableFocus(conversationId, live => {
                if (live.executionMode !== 'manual') protocolFail('CONFLICT', 'Conversation execution mode changed');
                return manualBriefsFor(project).prepare(requirements, { operationId, conversationId, actor });
              });
            }
            const requirements = conversation?.itemId
              ? { ...input, itemId: conversation.itemId, nodeId: conversation.nodeId, kind: conversation.kind }
              : { ...input };
            if (requirements.itemId) {
              if (!requirements.nodeId || !['todo', 'bug'].includes(requirements.kind)) protocolFail('INVALID_ARGUMENT', 'Map TODO/Bug routing metadata is incomplete');
              const snapshot = await readMemoryProject(configuredMemory, project.id), root = snapshot.main?.memory?.map?.root;
              const entry = root && entries(root).get(requirements.nodeId)?.node;
              const item = entry?.[`${requirements.kind}s`]?.find(value => value?.id === requirements.itemId);
              if (!item) protocolFail('NOT_FOUND', 'Map TODO/Bug is no longer available');
              if (normalizedSessions(item).length || item.dispatch?.task_id || item.dispatch?.session_id) {
                protocolFail('CONFLICT', 'Legacy Session metadata needs reconciliation before a new Session can be created');
              }
              const expectedTaskId = mapWorkTaskId(project.id, requirements.nodeId, requirements.kind, requirements.itemId);
              if (requirements.taskId !== expectedTaskId) protocolFail('CONFLICT', 'Task identity does not match the Map TODO/Bug');
              if (!requirements.nodeIds.includes(requirements.nodeId)) {
                const routedNodes = [...new Set([...requirements.nodeIds, requirements.nodeId])];
                if (routedNodes.length > 3) protocolFail('INVALID_ARGUMENT', 'Map TODO/Bug routing exceeds three nodes');
                requirements.nodeIds = routedNodes;
              }
              if (conversation.cursorExecution && (await store.projectTasks(human)).some(task => task.itemId === requirements.itemId && task.nodeId === requirements.nodeId && task.kind === requirements.kind &&
                  task.conversationId !== conversationId && !['completed', 'closed', 'cancelled', 'brief-rejected'].includes(task.stage))) protocolFail('CONFLICT', 'This item already belongs to another active execution');
              const ownerId = conversation.cursorExecution ? conversationId : await conversations.ensure({ nodeId: requirements.nodeId, kind: requirements.kind, item });
              if (conversationId !== ownerId) {
                if (!await readJSON(conversations.conversationFile(ownerId), null)) {
                  await conversations.continueIn(conversationId, ownerId);
                  const target = await coordinatorFor(project, ownerId);
                  await target.submit({ id: `item-continue:${digest(ownerId)}`,
                    text: '此事项已转到专属 Coordinator 对话。读取当前 Main 和任务状态，尚未准备 brief 时继续 prepare_task；不要重新挂载或选择旧执行 Session。' },
                  { source: 'workflow' });
                }
                return { kind: 'conversation-mounted', message: '此事项由专属 Coordinator 对话继续；请在那里查看 brief 并审批，不要在当前对话重复提交。',
                  conversationId: ownerId, node: { id: entry.id, title: entry.title },
                  item: { id: item.id, kind: requirements.kind, title: item.title || item.desc || item.id }, version: snapshot.main.version };
              }
            }
            if (JSON.stringify(requirements).length > 2000) protocolFail('INVALID_ARGUMENT', 'Keep requirements within 2000 characters');
            if (conversation.cursorExecution) {
              const grant = await requireCursorGrant(project, await conversations.get(conversationId));
              requirements.cursorDelegation = { grantId: grant.operationId, templateSessionId: grant.templateSessionId, configurationHash: grant.configurationHash };
            }
            const task = await store.prepareProjectTask(principal, requirements, operationId, conversationId);
            return { ...task, projectTask: true, requiresHumanApproval: true };
          },
          resolveNodes: async ids => {
            const memory = await readMemoryProject(configuredMemory, project.id), root = memory.main?.memory?.map?.root;
            const index = root ? entries(root) : new Map();
            return ids.map(id => {
              const entry = index.get(id), node = entry?.node;
              if (!node || Array.isArray(config.nodeIds) && !config.nodeIds.includes(id)) protocolFail('NOT_FOUND', 'Referenced Main node is unavailable');
              const path = coordinatorNodePath(root, id, { nodeIds: config.nodeIds || null })
                .map(({ id, title, purpose }) => ({ id, title, purpose }));
              return { id, title: node.title, label: coordinatorNodeLabel(node), purpose: node.purpose || '', path, pathText: coordinatorPathText(path) };
            });
          },
          readMap: async id => {
            const memory = await readMemoryProject(configuredMemory, project.id);
            // Inbox entries are nested nodes, not fields of this authorized
            // node. Read them separately through the same node-scope check.
            return readCoordinatorMapNode(memory.main, id, config.nodeIds);
          },
          readReference: async name => {
            if (!references.has(name)) protocolFail('FORBIDDEN', 'Reference is not available to the Coordinator');
            const text = await readCoordinatorReferenceFile(root, name);
            return { name, version: digest(text), text };
          },
          editMap: async (input, operationId) => {
            if (config.mapWrite !== true) protocolFail('FORBIDDEN', 'Coordinator Map writing is not enabled for this project');
            if (manual && input.actions.some(action => action.op === 'create')) {
              protocolFail('APPROVAL_REQUIRED', '创建新节点请使用 propose_mount，等人类确认后再创建。');
            }
            const operations = coordinatorStructureOperations(input.actions, operationId);
            const result = await commitMainMemoryMap(configuredMemory, project.id, { operationId: `coordinator-map:${operationId}`,
              baseVersion: input.mainVersion, operations }, { kind: 'coordinator', sessionId: '', agentId: principal.agentId });
            const latest = await readMemoryProject(configuredMemory, project.id), index = entries(latest.main.memory.map.root);
            return { kind: 'map-action', message: 'Map 已更新', version: result.version,
              nodes: [...new Set(result.nodeIds)].map(id => index.get(id)?.node).filter(Boolean).map(node => ({ id: node.id, title: node.title, purpose: node.purpose || '' })) };
          },
          mountConversation: async (input, operationId, { actor }) => {
            if (config.mapWrite !== true) protocolFail('FORBIDDEN', 'Coordinator item mounting is not enabled for this project');
            return bindingsFor(project).propose(input, { operationId, conversationId, actor });
          },
          // Conversation ownership is a UI routing hint, not an authorization
          // boundary. Every Coordinator conversation uses the same project
          // identity and may operate on tasks in explicitly assigned Sessions.
          readTask: async (id, taskId, { caller } = {}) => {
            const session = await sessionFor(id);
            const identity = await executionPrincipal(caller, id);
            const [task, delivery, publication] = await Promise.all([
              store.taskRecord(identity, session, taskId), store.taskStatus(identity, session, taskId),
              publicationState(project, `session:${id}`),
            ]);
            const { status, reason, sessionVersion, sourceCommit, mainSha, publishedAt } = publication;
            return { ...task, deliveryState: delivery.state,
              completionPolicy: isExperimentTask(configuredMemory.projects[project.id], task) || task.completion?.proof?.experimentOnly
                ? { mode: 'experiment-only', gitReceiptRef: 'experiment-only', archiveReceiptRef: task.ci?.ref,
                  instruction: '仅实验关闭：保留准确提交、独立 CI 和人审证据；通知原 Executor 归档、结束计划，不创建 PR、不发布 Main。调用 complete_task 后等待宿主 closed 回执。' }
                : { mode: 'merged' },
              publication: { status, ...(reason ? { reason } : {}), sessionVersion, sourceCommit, mainSha, publishedAt },
              ...(delivery.queue ? { queue: delivery.queue } : {}) };
          },
          writeFile: (input, operationId) => writeProjectFile({
            enabled: config.fileWrite === true,
            root: configuredMemory.projects[project.id].root,
            receiptFile: path.join(dataDir, 'coordinators', project.id, 'file-writes.json'),
            operationId, relativePath: input.path, content: input.content, expectedSha: input.expectedSha,
          }),
          exchange: async (sessionId, id, type, payload, { caller } = {}) => {
            const message = validateMessage({ v: 2, id, type, session: await sessionFor(sessionId), payload });
            const identity = await executionPrincipal(caller, sessionId);
            const binding = await store.registeredBinding(identity, sessionId);
            const hosted = binding?.deviceId === 'cloud-cursor:' + project.id ? await cursorRolesFor(project) : null;
            if (type === 'ci.request' && hosted && await hosted.owns(sessionId)) await hosted.reserveCi(message.session, payload.taskId);
            if (type === 'brief.submit') {
              const existing = (await store.workflowTasks(identity, message.session)).find(task => task.id === payload.taskId);
              // Do not let a second conversation redefine an existing brief.
              // Later lifecycle operations remain available project-wide.
              if (existing && coordinatorTaskOwnerRequired(type)) await assertTaskOwner(sessionId, payload.taskId);
              await conversations.bind(conversationId, sessionId, payload.taskId);
            }
            const reply = (await store.handle(identity, message, { workflow: interfaceWorkflow })).data;
            if (hosted && await hosted.owns(sessionId)) kickTaskScheduler(project);
            return reply;
          },
        });
        const itemScoped = conversationId.startsWith('item-');
        const fileWriteNote = config.fileWrite === true
          ? '\n项目允许 write_file 写入一个仓库相对路径的 UTF-8 文本文件。用户明确要求新建或替换单个文件时使用它，一次一个路径；不提交、不推送、不修改 Main。文件已存在时传入当前内容的 expectedSha。多文件修改和代码开发仍使用 brief。'
          : '';
        const system = coordinatorRolePrompt(await fs.readFile(path.join(root, 'scripts/shared/roles/Coordinator.md'), 'utf8'), { manual }) +
          (conversation.cursorExecution ? '\n当前对话已由真人启用受限 Cursor Cloud 执行能力，启用不是任务批准。\n新 brief 经人确认后，系统固定 Cursor 模板派发；不要请人另开 Session 或粘贴提示。\nPlan、交接和独立 CI 结果回到原对话，仍走原审核协议；不根据本轮结束判断任务完成。\n' : '') + (!itemScoped ? '' :
          '\n本对话仅负责下方「当前事项」；先读取其所在节点的最新原文，不处理其他事项。') + fileWriteNote;
        const directory = conversations.conversationDirectory(conversationId);
        const visionProvider = integrations?.visionProviderFile ? await readJson(integrations.visionProviderFile) : null;
        if (visionProvider && visionProvider.model !== 'glm-5.3-flash') throw new MapError('INVALID_VISION_PROVIDER', 'Slack image turns require glm-5.3-flash', 503);
        const settings = config.modelProviders ? await modelSettingsFor(project) : null;
        const loadContext = async () => {
          const snapshot = (await readMemoryProject(configuredMemory, project.id)).main;
          const context = buildCoordinatorContext(snapshot, { conversation: await conversations.get(conversationId), nodeIds: config.nodeIds || null });
          const pending = (await bindingsFor(project).approvals(conversationId)).find(item => item.pending);
          return { ...context, bindingRef: pending ? { id: pending.id, version: pending.version } : null };
        };
        await assertCurrentMode();
        const service = ownedService = new CoordinatorService({ directory, namespace: conversationId === 'legacy' ? '' : conversationId,
          model: settings?.legacyModel || coordinatorModelFactory(await readJson(config.providerFile)), system, tools, execute,
          ...(settings ? { textModels: settings.models, selectTextModel: () => settings.selection() } : {}),
          ...(manual ? { compactAtTokens: COORDINATOR_MANUAL_COMPACT_AT_TOKENS, compactMinTurns: 8, completePresentations: true, validateReplies: true } : {}),
          ...(manual ? { outputProtocol: configuredOutputProtocol(config, conversationId) } : {}),
          ...(visionProvider ? { visionModel: coordinatorModelFactory({ ...visionProvider, supportsImages: true }) } : {}),
          ...(integrationAttachments ? { resolveAttachment: (id, options) => integrationAttachments.resolve({ teamId: integrations.teamId, projectId: project.id, id, ...options }) } : {}),
          ...(integrations ? { onStateChange: () => integrationGateway?.notify({ projectId: project.id, conversationId }) } : {}),
          context: loadContext,
          beforeAcceptHumanInput: async ({ inputs, context, source, actor }) => {
            if (!context?.bindingRef || !['human', 'slack'].includes(source) || actor?.kind !== 'human') return context;
            const slackAttribution = source === 'slack';
            const current = await service.state();
            const lastAssistant = current.messages.findLast(message => message.role === 'assistant');
            const otherQuestion = current.messages.some(message => message.questions?.some(question => !question.answer && !question.superseded));
            const otherApproval = (await manualBriefsFor(project).approvals(conversationId)).some(proposal => proposal.pending);
            const allowBareConfirmation = current.status === 'waiting-for-user' && !otherQuestion && !otherApproval &&
              lastAssistant?.actions?.some(action => action.kind === 'binding-proposal' && action.id === context.bindingRef.id && action.version === context.bindingRef.version);
            const confirmation = [...inputs].reverse().find(input => bindingReplyDecision(input.text, { slackAttribution, allowBareConfirmation }));
            if (!confirmation) return context;
            try {
              const result = await bindingsFor(project).naturalReview(confirmation.text, { id: confirmation.id, conversationId, actor, reference: context.bindingRef, slackAttribution, allowBareConfirmation });
              if (!result) return context;
              const refreshed = await loadContext();
              return { ...refreshed, internalIds: [...(refreshed.internalIds || []), result.proposalId, result.conversationId],
                dynamicText: refreshed.dynamicText + '\n[服务器已保存本条人类确认；不是新的开发审批]\n' + JSON.stringify(result) +
                  '\n绑定已生效，不能重复提出同一候选要求再次确认；依据此回执简短报告结果。' };
            } catch (error) {
              if (!(error instanceof MapError)) throw error;
              return { ...context, dynamicText: context.dynamicText + '\n绑定未生效：' + error.message };
            }
          }, simulated: config.simulated === true });
        const intake = conversationId === 'legacy' ? mapIntakeFor(project, { submit: async (request, options) => {
          const item = JSON.parse(request.text), id = await itemConversation(project, item);
          return (await coordinatorFor(project, id)).submit(request, options);
        } }) : null;
        await intake?.initialize();
        service.bindings = bindings; service.refreshBindings = refreshBindings;
        service.inbox = manual ? { lastError: null, close: async () => {}, pump: async () => {} } : conversationId !== 'legacy' ? {
          lastError: null, close: async () => {}, pump: async () => (await coordinatorFor(project)).inbox.pump(),
        } : new CoordinatorInbox({ store, principal, sessionIds: refreshBindings, service,
          services: async () => Promise.all((await conversations.list()).map(item => coordinatorFor(project, item.id))),
          autoResume: async ({ session, taskId, messageId, reason }) => {
            const current = await store.taskRecord(principal, session, taskId);
            if (current.stage !== 'interrupted' || !current.busy) return { skipped: true, stage: current.stage };
            return (await store.handle(principal, { v: 2, id: `auto-resume:${messageId}`, type: 'task.control', session,
              payload: { taskId, action: 'resume', expectedVersion: current.version,
                data: { reason: `自动恢复中断任务${reason ? `：${reason}` : ''}` } } }, { workflow: interfaceWorkflow })).data;
          },
          autoRework: async ({ session, taskId, messageId }) => {
            const current = await store.taskRecord(principal, session, taskId);
            if (current.stage !== 'acceptance-rejected' || !current.busy) return { skipped: true, stage: current.stage };
            return (await store.handle(principal, { v: 2, id: messageId, type: 'task.rework', session,
              payload: { taskId, sourceSha: current.sourceSha, ciResultRef: current.ci.ref,
                failedTestIds: [], reason: current.acceptanceReview.reason } }, { workflow: interfaceWorkflow })).data;
          },
          routeEvent: async (type, payload, session) => {
            let taskId = payload.taskId;
            if (!taskId && type === 'review.result') {
              const object = await store.handle(principal, { v: 2, id: randomUUID(), type: 'object.read', session,
                payload: { ref: payload.ref, version: payload.version } });
              taskId = object.data.content.taskId;
            }
            return coordinatorFor(project, await conversations.owner(session.id, taskId));
          },
          intake, memoryEvents: memoryHub(configuredMemory), projectId: project.id });
        // Recover only a durable unfinished turn. Kicking every newly-created
        // idle conversation creates a transient in-memory `running` state, so
        // its first user submission can incorrectly fail with COORDINATOR_BUSY.
        const restored = await service.state();
        const recover = restored.activeTurnId && (restored.status !== 'error' || coordinatorCanAutoResume(restored) ||
          (await service.inputSignals(restored)).interrupted);
        await assertCurrentMode();
        assertCurrentEpoch();
        if (recover) service.kick();
        return service;
        } catch (cause) {
          // Drain only this initializer's instance, outside workflow locks.
          // A late initializer must never close or delete its replacement.
          if (ownedService) { await ownedService.inbox?.close(); await ownedService.close({ stop: true }); }
          throw cause;
        }
      })();
      coordinators.set(key, creating);
      creating.catch(() => { if (coordinators.get(key) === creating) coordinators.delete(key); });
    }
    const service = await coordinators.get(key);
    await assertCurrentMode();
    assertCurrentEpoch();
    return service;
  };
  const notifyManualReviews = async (project, conversationId, service) => {
    let state = await service.state();
    const proposals = await manualBriefsFor(project).approvals(conversationId);
    for (const proposal of proposals) {
      if (!proposal.review || proposal.review.notified) continue;
      const id = `manual-review-${digest(proposal.id).slice(0, 48)}`;
      if (state.acceptedRequestIds?.includes(id)) {
        await manualBriefsFor(project).acknowledgeNotification(proposal.id, conversationId);
        continue;
      }
      if (state.activeTurnId || state.status === 'running') return { pending: true };
      const review = proposal.review;
      try {
        await submitCoordinator(project, conversationId, { id,
          text: `人工已${review.decision === 'approved' ? '确认' : '拒绝'} brief ${proposal.id}。${review.reason || ''}\n工作项：${proposal.kind} ${proposal.itemId}；Main 版本：${review.result.version}。${review.decision === 'approved' ? 'Main 事项已保存，可导出已批准的执行提示，由用户自行执行。' : '依据反馈继续澄清。'}\n此回执不授权自动派发；解释结果并继续当前讨论。` }, { source: 'workflow' });
        await manualBriefsFor(project).acknowledgeNotification(proposal.id, conversationId);
      } catch (error) {
        return { pending: true, error: { code: error.code || 'NOTIFICATION_FAILED', message: error.message } };
      }
      state = await service.state();
    }
    return { pending: false };
  };
  const notifyBindingReviews = async (project, conversationId, service) => {
    for (const result of await bindingsFor(project).notifications(conversationId)) {
      const id = 'binding-notice:' + result.proposalId + ':' + result.decision;
      const state = await service.state();
      if (state.acceptedRequestIds?.includes(id) || result.humanInputId && state.acceptedRequestIds?.includes(result.humanInputId)) {
        await bindingsFor(project).acknowledge(result.proposalId, conversationId); continue;
      }
      if (state.activeTurnId || state.status === 'running') return { pending: true };
      try {
        await service.submit({ id, text: JSON.stringify({ type: 'human.binding-review', ...result }) }, { source: 'workflow' });
        await bindingsFor(project).acknowledge(result.proposalId, conversationId);
      } catch (error) { return { pending: true, error: { code: error.code || 'NOTIFICATION_FAILED' } }; }
    }
    return { pending: false };
  };
  const coordinatorPublicState = async (project, conversationId) => {
    const service = await coordinatorFor(project, conversationId);
    const bindingNotification = await notifyBindingReviews(project, conversationId, service);
    let state = await service.state();
    const conversation = await conversationsFor(project).get(conversationId);
    if (conversation.executionMode === 'manual') {
      const notification = await notifyManualReviews(project, conversationId, service);
      state = await service.state();
      const proposals = await manualBriefsFor(project).approvals(conversationId);
      const ids = new Set(proposals.map(proposal => proposal.id));
      state.approvals = [...state.approvals.filter(proposal => !ids.has(proposal.id) && !proposal.manual), ...proposals];
      state.executionMode = 'manual';
      state.reviewNotification = notification;
      state.acceptances = [];
      state.projectTasks = [];
      state.sessionTemplates = [];
    } else if (conversation.cursorExecution) {
      await requireCursorGrant(project, conversation);
      const { store, principal } = interfaceProject(project);
      const tasks = (await store.projectTasks(principal)).filter(task => task.conversationId === conversationId);
      state.executionMode = 'automatic'; state.executionProvider = 'cursor'; state.projectTasks = tasks;
      state.approvals = [...state.approvals.filter(proposal => !proposal.manual), ...await manualBriefsFor(project).approvals(conversationId)];
      state.approvals = state.approvals.map(proposal => {
        const task = proposal.projectTask && tasks.find(item => item.taskId === proposal.taskId);
        return task ? { ...proposal, executionProvider: 'cursor', pending: task.stage === 'brief' && task.brief.version === proposal.brief.version,
          ...(task.review ? { decision: task.review.decision } : {}) } : proposal;
      });
    }
    const bindingApprovals = await bindingsFor(project).approvals(conversationId);
    const bindingIds = new Set(bindingApprovals.map(proposal => proposal.id));
    return { ...state, approvals: [...state.approvals.filter(item => item.kind !== 'binding-proposal' && !bindingIds.has(item.id)), ...bindingApprovals],
      focus: { nodeId: conversation.nodeId || null, kind: conversation.kind || null }, bindingNotification, conversationId };
  };
  const submitCoordinator = async (project, conversationId, input, options = {}) => {
    if (!input || Object.keys(input).some(key => !['id', 'text', 'inputs', 'retry', 'answerTo', 'attachments', 'followup', 'expectedTurnId'].includes(key))) {
      protocolFail('INVALID_ARGUMENT', 'Provide a message, stable ID and optional attachment references');
    }
    if (input.inputs !== undefined && (options.source !== 'slack' || input.retry ||
        ['text', 'attachments', 'answerTo'].some(key => Object.hasOwn(input, key)))) {
      protocolFail('INVALID_ARGUMENT', 'Only verified Slack batches may supply ordered inputs without replacing retry data');
    }
    const service = await coordinatorFor(project, conversationId);
    if (input.retry) {
      const saved = (await service.state()).retryInput;
      if (options.actor && input.expectedTurnId !== undefined) {
        if (Object.keys(input).some(key => !['id', 'retry', 'expectedTurnId'].includes(key)) || saved?.id !== input.expectedTurnId) protocolFail('INVALID_RETRY', 'Resume only the exact original turn without replacing its input');
        input = { id: saved.id, text: saved.text, ...(saved.answerTo ? { answerTo: saved.answerTo } : {}),
          ...(saved.attachments ? { attachments: saved.attachments } : {}), retry: true };
      }
      if (saved?.id !== input.id) protocolFail('INVALID_RETRY', 'Retry the original failed turn');
      if (options.actor && JSON.stringify(saved.actor) !== JSON.stringify(options.actor)) protocolFail('FORBIDDEN', 'Only the original operator can resume this input');
      options = { source: saved.source || 'human', ...(saved.actor ? { actor: saved.actor } : {}) };
    }
    return service.submit(input, options);
  };
  const reviewManualBrief = async (project, conversationId, input, actor) => {
    const result = await bindingsFor(project).withStableFocus(conversationId, conversation => {
      if (conversation.executionMode !== 'manual') protocolFail('FORBIDDEN', 'This conversation does not use manual execution');
      return manualBriefsFor(project).review(input, { operationId: input.id, conversationId, actor });
    });
    const notification = await notifyManualReviews(project, conversationId, await coordinatorFor(project, conversationId));
    return { ...result, notification };
  };
  const integrationProject = async id => {
    if (integrations?.mapProjects) {
      const project = await mapProjects.get(id);
      if (isMapProject(project)) { mapProjectRefs.set(id, project); return project; }
      return project;
    }
    const project = projectById(id);
    if (!project || !configuredMemory?.projects?.[id]) protocolFail('NOT_FOUND', 'Project is unavailable');
    return project;
  };
  const authorizeIntegrationProject = async (id, actor, input) => {
    if (mapProjects.allowed(actor)) await mapProjects.get(id);
    else if (!integrations.projectIds.includes(id)) protocolFail('FORBIDDEN', '无权访问此项目');
    if (input?.type === 'conversation.cursor') cursorExecutionScope(await integrationProject(id), actor);
    const conversationId = input?.conversationId || (input?.type === 'conversation.bind' && input.payload?.conversationId);
    if (conversationId) {
      const project = await integrationProject(id), conversation = await conversationsFor(project).get(conversationId);
      if (conversation.cursorExecution) await requireCursorGrant(project, conversation, actor);
    }
  };
  const requireIntegrationConversation = async (project, id, actor) => {
    if (typeof id !== 'string') protocolFail('INVALID_ARGUMENT', 'Select a linked conversation');
    const conversation = await conversationsFor(project).get(id);
    if (conversation.executionMode !== 'manual') await requireCursorGrant(project, conversation, actor);
    return conversation;
  };
  const integrationPublicState = async (project, id, actor) => {
    const state = await coordinatorPublicState(project, id);
    if (state.executionMode === 'manual') {
      try { cursorExecutionScope(project, actor); state.cursorAvailable = true; }
      catch (error) { if (error.code !== 'FORBIDDEN') throw error; state.cursorAvailable = false; }
    }
    return state;
  };
  const integrationCommand = async (request, { actor, operationId, recoveryCheck }) => {
    const { type, payload = {}, projectId, conversationId } = request;
    if (type === 'project.list') {
      const projects = mapProjects.allowed(actor) ? await mapProjects.projects() : registry.projects.filter(project => integrations.projectIds.includes(project.id) &&
        configuredMemory?.projects?.[project.id]?.coordinator?.enabled);
      return { projects: projects.map(({ id, name, description, mapNodeId }) => ({ id, name, description,
        ...(mapProjects.allowed(actor) && !integrations.projectIds.includes(id) ? { private: true } : {}),
        ...(mapNodeId ? { mapNodeId } : {}) })) };
    }
    const project = await integrationProject(projectId);
    if (type === 'recovery.preflight') {
      if (typeof recoveryCheck !== 'function') protocolFail('PROOF_UNAVAILABLE', 'Recovery inspection requires its exact receipt lock boundary');
      const scope = recoveryScope(payload, actor, projectId), file = conversationsFor(project).conversationFile(scope.conversationId);
      return withFileLock(file + '.submit.lock', async () => {
        await recoveryCheck();
        const state = await readJSON(file, null), journal = await readJSON(path.join(path.dirname(file), 'input-journal.json'), null);
        requireEmptyRecoveryState(state, journal);
        return { noBusinessEffect: true, scopeHash: scope.fingerprint, conversationId: scope.conversationId, inputIds: scope.inputIds };
      });
    }
    if (type === 'models.state') return (await modelSettingsFor(project)).state();
    if (type === 'models.select') return (await modelSettingsFor(project)).select({ id: operationId, ...payload });
    if (type === 'conversation.relevance') {
      const input = relevanceInput(payload);
      if (conversationId) await requireIntegrationConversation(project, conversationId, actor);
      const config = coordinatorConfigFor(project);
      if (!config?.enabled || !path.isAbsolute(config.providerFile || '')) protocolFail('COORDINATOR_DISABLED', 'Coordinator is unavailable for relevance checks');
      const memory = await readMemoryProject(configuredMemory, projectId);
      const { model } = await (await modelSettingsFor(project)).selection({ timeoutMs: 12000 });
      return classifyIntegrationMessage(model, { overview: relevanceOverview(memory.main, config.nodeIds), input, actor });
    }
    if (type === 'project.read') {
      const memory = await readMemoryProject(configuredMemory, project.id);
      const sessions = (await memorySessions(project)).map(({ id, name, state, status, connection, activity, lastSeen }) =>
        ({ id, name, state, status, connection, activity, lastSeen }));
      return { id: project.id, name: project.name, version: memory.main?.version, map: memory.main?.memory?.map, sessions,
        ...(mapProjects.allowed(actor) && !integrations.projectIds.includes(project.id) ? { private: true } : {}),
        ...(isMapProject(project) ? { mapNodeId: project.mapNodeId } : {}) };
    }
    if (type === 'conversation.create') {
      const id = await conversationsFor(project).createChat(payload.operationId || operationId, { executionMode: 'manual' });
      await coordinatorFor(project, id); return { conversationId: id,
        ...(isMapProject(project) ? { mapNodeId: project.mapNodeId } : {}) };
    }
    if (type === 'conversation.cursor') {
      if (Object.keys(payload).some(key => key !== 'expectedMode') || payload.expectedMode !== 'manual') protocolFail('INVALID_ARGUMENT', 'Confirm the current manual mode explicitly');
      const grant = cursorExecutionScope(project, actor), conversations = conversationsFor(project), before = await conversations.get(conversationId);
      if (before.cursorExecution?.operationId === operationId) return conversations.enableCursor(conversationId, { operationId, expectedMode: payload.expectedMode, grant });
      const service = await coordinatorFor(project, conversationId), key = `${project.id}:${conversationId}`;
      if (cursorTransitions.has(key)) throw new MapError('COORDINATOR_BUSY', 'Conversation execution mode is changing', 409);
      cursorTransitions.add(key);
      cursorModeEpochs.set(key, (cursorModeEpochs.get(key) || 0) + 1);
      try {
        return await service.retireIdle(() => bindingsFor(project).withStableConversation(conversationId, async () => {
          if ((await manualBriefsFor(project).approvals(conversationId)).some(proposal => proposal.pending && !proposal.stale) ||
              (await bindingsFor(project).approvals(conversationId)).some(proposal => proposal.pending)) protocolFail('CONFLICT', 'Resolve pending human approvals before enabling Cursor');
          const { store, principal } = interfaceProject(project);
          if ((await store.projectTasks(principal)).some(task => task.conversationId === conversationId && !['completed', 'closed', 'cancelled', 'brief-rejected'].includes(task.stage))) protocolFail('CONFLICT', 'Resolve the original execution before changing its host');
          cursorExecutionScope(project, actor);
          return conversations.enableCursor(conversationId, { operationId, expectedMode: payload.expectedMode, grant });
        }));
      } finally {
        // Never drain a runner while holding its submit/binding/registry locks.
        if (service.retired) { coordinators.delete(key); await service.inbox.close(); await service.close({ stop: true }); }
        cursorTransitions.delete(key);
      }
    }
    if (type === 'conversation.bind') {
      if (isMapProject(project)) protocolFail('FORBIDDEN', 'Map 项目不能关联仓库执行对话');
      const id = payload.conversationId;
      const conversation = await conversationsFor(project).get(id);
      if (conversation.cursorExecution) { await requireCursorGrant(project, conversation, actor); return { conversationId: id, executionMode: 'automatic' }; }
      const service = await coordinatorFor(project, id), state = await service.state();
      if (state.activeTurnId || state.status === 'running') protocolFail('COORDINATOR_BUSY', 'Wait for the current turn before binding');
      const { store, principal } = interfaceProject(project);
      if ((await store.projectTasks(principal)).some(task => task.conversationId === id && !['closed', 'cancelled'].includes(task.stage))) {
        protocolFail('CONFLICT', 'Existing automatic work must finish before binding');
      }
      if (conversation.executionMode !== 'manual') {
        await conversationsFor(project).setExecutionMode(id, 'manual');
        await service.inbox.close(); await service.close(); coordinators.delete(`${project.id}:${id}`);
      }
      await coordinatorFor(project, id); return { conversationId: id };
    }
    if (type === 'attachment.upload') return integrationAttachments.upload({ ...payload, teamId: integrations.teamId, projectId, actor });
    if (type === 'attachment.read') return integrationAttachments.read({ teamId: integrations.teamId, projectId, id: payload.id });
    if (type === 'map.write') {
      const operations = payload.operations;
      if (!Array.isArray(operations)) protocolFail('INVALID_ARGUMENT', 'Provide Map operations');
      const memory = await readMemoryProject(configuredMemory, projectId);
      const document = memory.main.memory.map;
      const index = document.root ? entries(document.root) : new Map();
      const checkItems = (list, existing = []) => {
        if (!Array.isArray(list)) return;
        for (const item of list) {
          if (!item || typeof item !== 'object') protocolFail('INVALID_ARGUMENT', 'Provide valid integration work items');
          const previous = existing.find(old => old.id === item.id);
          if ((!previous || previous.executionMode === 'manual') && item.executionMode !== 'manual') {
            protocolFail('INVALID_ARGUMENT', 'New integration work items must retain manual execution mode');
          }
        }
      };
      for (const operation of operations) {
        if (!operation || typeof operation !== 'object') protocolFail('INVALID_ARGUMENT', 'Provide valid Map operations');
        for (const field of ['todos', 'bugs']) {
          checkItems(operation.fields?.[field], index.get(operation.id)?.node?.[field]);
          if (operation.node) for (const { node } of entries({ id: 'T0', ...operation.node }).values()) {
            checkItems(node[field], index.get(node.id)?.node?.[field]);
          }
        }
        if (operation.type === 'attach-bug' || operation.type === 'recover-bug') {
          const target = index.get(operation.id)?.node;
          checkItems([operation.bug], target ? target.bugs : document.unassigned_bugs);
        }
        checkItems(operation.fields?.unassigned_bugs, document.unassigned_bugs);
      }
      return commitMainMemoryMap(configuredMemory, projectId, { operationId, baseVersion: payload.baseVersion, operations }, actor);
    }
    const integrationConversation = await requireIntegrationConversation(project, conversationId, actor);
    if (type === 'conversation.state') return integrationPublicState(project, conversationId, actor);
    if (type === 'conversation.submit') {
      const { history, participation, recovery, slackChannelId: _deliveryChannel, ...input } = payload;
      const recoveryOptions = recovery ? { operatorRecovery: recovery.operationId, recoveryGuard: async (state, journal) => {
        if (typeof recoveryCheck !== 'function') protocolFail('PROOF_UNAVAILABLE', 'Recovery requires authoritative checks under the original receipt locks');
        await recoveryCheck(); requireEmptyRecoveryState(state, journal);
      } } : {};
      return submitCoordinator(project, conversationId, { ...input, id: operationId }, { source: 'slack', actor, ...recoveryOptions, ...(history !== undefined ? { history } : {}), ...(participation !== undefined ? { participation } : {}) });
    }
    if (type === 'conversation.interrupt') {
      if (Object.keys(payload).some(key => key !== 'expectedTurnId')) protocolFail('INVALID_ARGUMENT', 'Provide only the active turn identity');
      return (await coordinatorFor(project, conversationId)).interrupt({ ...payload, id: operationId }, { source: 'slack', actor });
    }
    if (type === 'brief.review') {
      if (integrationConversation.executionMode === 'manual') return reviewManualBrief(project, conversationId, { ...payload, id: operationId }, actor);
      if (Object.keys(payload).some(key => !['proposalId', 'version', 'decision', 'reason'].includes(key)) || typeof payload.version !== 'string' ||
          !['approved', 'rejected'].includes(payload.decision) || payload.reason !== undefined && (typeof payload.reason !== 'string' || payload.reason.length > 1000)) protocolFail('INVALID_ARGUMENT', 'Review the exact original brief version');
      const service = await coordinatorFor(project, conversationId), proposal = (await service.state()).approvals.find(value => value.id === payload.proposalId && value.projectTask);
      if (!proposal || proposal.brief.version !== payload.version) protocolFail('CONFLICT', 'The original conversation brief changed');
      const { store, principal } = interfaceProject(project), task = (await store.projectTasks(principal)).find(item => item.taskId === proposal.taskId && item.conversationId === conversationId);
      if (!task?.cursorDelegation) protocolFail('FORBIDDEN', 'Brief belongs to another conversation or execution host');
      await requireCursorGrant(project, await conversationsFor(project).get(conversationId), actor, task.cursorDelegation);
      const result = await store.reviewProjectTask({ ...principal, agentId: actor.sessionId }, task.taskId, proposal.brief, { ...payload, id: operationId });
      kickTaskScheduler(project);
      return { executionMode: 'automatic', taskId: result.taskId, stage: result.stage };
    }
    if (type === 'binding.review') {
      const result = await bindingsFor(project).review({ ...payload, id: operationId }, { conversationId, actor });
      return { ...result, notification: await notifyBindingReviews(project, conversationId, await coordinatorFor(project, conversationId)) };
    }
    if (type === 'prompt.read') return manualBriefsFor(project).prompt(payload.proposalId, conversationId);
    protocolFail('INVALID_ARGUMENT', 'Unsupported integration operation');
  };
  const scheduling = new Set();
  const scheduleProjectTasks = async project => {
    if (stopping || scheduling.has(project.id)) return;
    scheduling.add(project.id);
    try {
      const config = configuredMemory?.projects?.[project.id]?.coordinator;
      if (!config?.enabled) return;
      const { store, principal: human } = interfaceProject(project);
      const hostedTemplateId = cursorConfiguration?.projects?.[project.id]?.roles?.templateSessionId;
      const principal = { ...human, role: 'coordinator', deviceId: 'cloud-scheduler', agentId: `scheduler:${project.id}`,
        bindings: { ...config.bindings }, creationTemplates: config.sessionTemplates || [] };
      const limit = Number.isSafeInteger(config.maxConcurrentTasks) && config.maxConcurrentTasks > 0 ? config.maxConcurrentTasks : 2;
      for (let task of await store.projectTasks(principal)) {
        if (stopping) break;
        try {
        let hosted;
        if (task.cursorDelegation) await requireCursorGrant(project, await conversationsFor(project).get(task.conversationId), null, task.cursorDelegation);
        if (task.stage === 'dispatched') {
          const binding = await store.registeredBinding(human, task.sessionId);
          if (binding?.deviceId === 'cloud-cursor:' + project.id) hosted = await cursorRolesFor(project);
          const current = binding && await store.taskRecord(human, { id: task.sessionId, generation: binding.generation }, task.taskId);
          if (hosted && current && await hosted.owns(task.sessionId)) await hosted.pump(current.session, current.id);
          if (current && !current.busy && ['accepted', 'closed', 'finished', 'cancelled'].includes(current.stage)) await store.updateProjectTask(principal, task.taskId, { stage: 'completed' });
          continue;
        }
        if (task.stage === 'queued') {
            const templates = principal.creationTemplates.filter(id => Object.hasOwn(config.bindings || {}, id) && !config.ciReceivers?.[id] &&
              (!task.cursorDelegation || id === task.cursorDelegation.templateSessionId && id === hostedTemplateId));
            const templateSessionId = templates.find(id => {
              if (hostedTemplateId === id) return true;
              const presence = interfacePresence.get(presenceKey(principal.repositoryId, id));
              return presence && cloudSessionPresence(presence.lastHeartbeatAt) !== 'offline';
            });
            if (!templateSessionId) { await store.updateProjectTask(principal, task.taskId, { error: 'WAITING_DEVICE' }); continue; }
            if (templateSessionId === hostedTemplateId) hosted = await cursorRolesFor(project);
            task = await store.updateProjectTask(principal, task.taskId, { stage: 'creating', templateSessionId, error: null }, { reserveLimit: limit });
            if (task.stage === 'queued') continue;
        }
        if (!hosted && hostedTemplateId && task.templateSessionId === hostedTemplateId) hosted = await cursorRolesFor(project);
        if (task.stage === 'creating') {
          if (task.creationId && task.sessionId) task = await store.updateProjectTask(principal, task.taskId, { stage: 'starting' });
          else {
            const creation = await store.requestSessionCreation(principal, { operationId: `task:${digest(task.taskId)}:${task.attempt || 0}`,
              templateSessionId: task.templateSessionId, name: `任务 ${task.taskId}` });
            task = await store.updateProjectTask(principal, task.taskId, { stage: 'starting', creationId: creation.id, sessionId: creation.sessionId });
            if (task.itemId && task.nodeId && ['todo', 'bug'].includes(task.kind) &&
                await writeItemSessions(project, task, creation.sessionId) !== creation.sessionId) {
              protocolFail('CONFLICT', 'The approved Map item disappeared before Session binding');
            }
          }
        }
        if (task.stage !== 'starting') continue;
        const creation = (await store.sessionCreations(human)).find(item => item.id === task.creationId);
        if (hosted?.templateSessionId === task.templateSessionId && creation?.state === 'pending') {
          await hosted.reserveExecutor({ id: creation.id, sessionId: creation.sessionId, taskId: task.taskId });
          // Registration reserves a logical cloud workspace, not an online VM.
          // The next pass dispatches through the original approved-task gate.
          continue;
        }
        if (creation?.state === 'failed') {
          const retries = task.creationRetries || 0;
          if (retries >= 2) {
            await store.updateProjectTask(principal, task.taskId, { stage: 'failed', error: creation.error || 'CREATION_FAILED' });
            continue;
          }
          if (Date.now() - Date.parse(creation.completedAt || task.updatedAt) < 5000) continue;
          await store.retrySessionCreation(principal, creation.id);
          await store.updateProjectTask(principal, task.taskId, { creationRetries: retries + 1, error: 'RETRYING_SESSION_CREATION' });
          continue;
        }
        if (creation?.state !== 'registered') {
          if (Date.now() - Date.parse(task.updatedAt) > 120000 && !task.error) await store.updateProjectTask(principal, task.taskId, { error: 'WAITING_SESSION_READY' });
          continue;
        }
        const binding = await store.registeredBinding(human, task.sessionId);
        if (!binding || binding.generation !== creation.generation || binding.worktreeId !== creation.worktreeId) continue;
        const memory = await readMemoryProject(configuredMemory, project.id);
        if (task.mainVersion !== memory.main?.version) {
          const document = memory.main?.memory?.map;
          const readable = document?.root ? filterNodeAccess(document, [...entries(document.root).keys()], binding.agentId, 'read') : [];
          if (!memory.main?.version || !task.nodeIds.every(id => readable.includes(id))) protocolFail('FORBIDDEN', 'Approved task nodes are no longer readable on Main');
          task = await store.updateProjectTask(principal, task.taskId, { mainVersion: memory.main.version, error: null });
        }
        principal.bindings[task.sessionId] = binding.worktreeId;
        await conversationsFor(project).bind(task.conversationId, task.sessionId, task.taskId);
        const result = await store.submitApprovedTask(principal, { operationId: `fresh-task:${digest(task.taskId)}`, projectTaskId: task.taskId,
          session: { id: task.sessionId, generation: binding.generation } }, async () => ({ taskId: task.taskId,
          text: JSON.stringify({ v: 1, taskId: task.taskId, text: task.text, acceptance: task.acceptance, nodeIds: task.nodeIds, mainVersion: task.mainVersion }),
          nodeIds: task.nodeIds, mainVersion: task.mainVersion }), interfaceWorkflow);
        await store.updateProjectTask(principal, task.taskId, { stage: 'dispatched', dispatch: result, error: null });
        if (hosted?.templateSessionId === task.templateSessionId) await hosted.pump({ id: task.sessionId, generation: binding.generation }, task.taskId);
        } catch (cause) {
          await store.updateProjectTask(principal, task.taskId, { error: cause.code || 'SCHEDULING_FAILED',
            ...(['FORBIDDEN', 'INVALID_ARGUMENT', 'CONFLICT'].includes(cause.code) ? { stage: 'failed' } : {}) });
        }
      }
    } finally { scheduling.delete(project.id); }
  };
  const kickTaskScheduler = project => {
    const pending = scheduleProjectTasks(project).catch(cause => console.error(`[context-guard] task scheduling deferred: ${cause.code || cause.message}`));
    activeRequests.add(pending);
    void pending.finally(() => activeRequests.delete(pending));
  };
  const recoverInterruptedTasks = async project => {
    const config = configuredMemory?.projects?.[project.id]?.coordinator;
    if (!config?.enabled) return;
    const { store, principal } = interfaceProject(project);
    for (const id of Object.keys(config.bindings || {})) {
      const binding = await store.registeredBinding(principal, id);
      if (!binding) continue;
      const session = { id, generation: binding.generation };
      for (const task of await store.workflowTasks(principal, session)) {
        if (task.stage !== 'interrupted' || !task.busy) continue;
        const messageId = `auto-resume-startup:${digest(JSON.stringify([project.id, id, session.generation, task.id, task.version]))}`;
        await store.handle(principal, { v: 2, id: messageId, type: 'task.control', session,
          payload: { taskId: task.id, action: 'resume', expectedVersion: task.version,
            data: { reason: `Cloud 启动自动恢复中断任务：${task.interrupted?.reason || '未记录原因'}` } } }, { workflow: interfaceWorkflow });
      }
    }
  };
  const mapFile = id => path.join(mapsDir, `${id}.json`);
  const eventsFile = id => path.join(eventsDir, `${id}.jsonl`);
  const workFile = (id, workId) => path.join(worksDir, id, `${digest(workId)}.json`);
  const operationFile = (scope, operationId) => path.join(operationsDir, `${digest(`${scope}:${operationId}`)}.json`);
  const transactionFile = (scope, operationId) => path.join(transactionsDir, `${digest(`${scope}:${operationId}`)}.json`);
  const serial = (id, task) => {
    const next = (tails.get(id) || Promise.resolve()).then(task);
    tails.set(id, next.catch(() => {}));
    return next;
  };
  const mutateRegistry = task => {
    const next = registryTail.then(async () => {
      const result = await task();
      await atomicWrite(registryFile, json(registry));
      return result;
    });
    registryTail = next.catch(() => {});
    return next;
  };
  const updateRegistryProject = patch => mutateRegistry(() => {
    const project = projectById(patch.id);
    if (!project) throw new MapError('RECOVERY_REQUIRED', 'Transaction project is missing from the registry', 503);
    Object.assign(project, patch);
    return project;
  });
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  };
  const sendHtml = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...headers });
    res.end(body);
  };
  const redirect = (res, location, headers = {}) => { res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', ...headers }); res.end(); };
  const workbenchCookie = () => ({ 'Set-Cookie': `cg_workbench=${encodeURIComponent(browserToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${workbenchCookieMaxAge}${secureCookies ? '; Secure' : ''}` });
  const clearWorkbenchCookie = () => ({ 'Set-Cookie': `cg_workbench=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}` });
  const requestBody = async (req, limit = 16 * 1024 * 1024) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new MapError('CONTENT_TYPE', 'Use application/json', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw new MapError('BODY_TOO_LARGE', 'Request exceeds the size limit', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new MapError('INVALID_JSON', 'Malformed JSON', 400); }
  };
  const requestForm = async req => {
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) throw new MapError('CONTENT_TYPE', 'Use a form submission', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024) throw new MapError('BODY_TOO_LARGE', 'Login request is too large', 413); chunks.push(chunk); }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  };
  const bearer = req => req.headers.authorization?.replace(/^Bearer /, '') || '';
  const requireAdmin = req => {
    if (!adminToken || !safeEqual(bearer(req), adminToken)) throw new MapError('UNAUTHORIZED', 'An admin token is required', 401);
  };
  const requireProject = (req, _url, project) => {
    const credential = bearer(req);
    if (adminToken && safeEqual(credential, adminToken)) return;
    if (!project.tokenHash || !safeEqual(digest(credential), project.tokenHash)) throw new MapError('UNAUTHORIZED', 'A project sync token is required', 401);
  };
  const cookieValue = req => String(req.headers.cookie || '').split(';').map(item => item.trim()).find(item => item.startsWith('cg_workbench='))?.slice('cg_workbench='.length) || '';
  const decodedCookieValue = req => { try { return decodeURIComponent(cookieValue(req)); } catch { return ''; } };
  const hasWorkbenchAccess = req => {
    const credential = bearer(req) || decodedCookieValue(req);
    return !!browserToken && (safeEqual(credential, browserToken) || adminToken && safeEqual(credential, adminToken));
  };
  const requireWorkbench = (req, url) => {
    if (!hasWorkbenchAccess(req, url)) throw new MapError('UNAUTHORIZED', browserPasswordHash ? 'Sign in before editing the cloud workbench' : 'Open /auth?token=... before editing the cloud workbench', 401);
  };
  const requireHumanWorkbench = req => {
    if (!browserToken || !safeEqual(decodedCookieValue(req), browserToken)) throw new MapError('UNAUTHORIZED', 'Sign in to approve device connections', 401);
    if (req.headers.origin && req.headers.origin !== (allowedOrigin || `http://${req.headers.host}`)) throw new MapError('ORIGIN_REJECTED', 'Cross-origin request rejected', 403);
  };
  const deviceRepository = projectId => {
    const repositories = interfaceConfig?.repositories?.filter(item => item.projectId === projectId && /^\d+$/.test(item.repositoryId)) || [];
    if (!projectById(projectId) || !configuredMemory?.projects?.[projectId] || repositories.length !== 1) throw new MapError('NOT_FOUND', 'Device authorization project is unavailable', 404);
    return repositories[0];
  };
  const loginKey = req => String(req.socket.remoteAddress || 'unknown');
  const loginBlocked = req => {
    const entry = loginFailures.get(loginKey(req));
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) { loginFailures.delete(loginKey(req)); return false; }
    return entry.count >= 5;
  };
  const recordLoginFailure = req => {
    const key = loginKey(req), previous = loginFailures.get(key), current = previous?.resetAt > Date.now() ? previous : { count: 0, resetAt: Date.now() + 5 * 60_000 };
    current.count += 1; loginFailures.set(key, current);
  };
  const requirePrivateRead = (req, url) => { if (privateAccess) requireWorkbench(req, url); };
  const readEvents = id => readJsonLines(eventsFile(id));
  const currentSeq = async id => (await readEvents(id)).at(-1)?.seq || 0;
  const broadcastDirectory = (event, body) => {
    for (const res of directoryClients) {
      if (res.destroyed) { directoryClients.delete(res); continue; }
      res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
    }
  };
  const broadcastProject = event => {
    for (const res of projectClients.get(event.projectId) || []) {
      if (res.destroyed) { projectClients.get(event.projectId)?.delete(res); continue; }
      res.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
    }
  };
  const createEvent = async (id, input) => ({
    ...input,
    projectId: id,
    seq: (await currentSeq(id)) + 1,
    eventId: input.eventId || randomUUID(),
    at: input.at || now(),
  });
  const appendEventRecord = async event => {
    const events = await readEvents(event.projectId);
    const previous = events.find(item => item.eventId === event.eventId);
    if (previous) {
      if (digest(JSON.stringify(previous)) !== digest(JSON.stringify(event))) throw new MapError('RECOVERY_REQUIRED', 'Event identity has conflicting content', 503, { eventId: event.eventId });
      return previous;
    }
    const lastSeq = events.at(-1)?.seq || 0;
    if (lastSeq + 1 !== event.seq) throw new MapError('RECOVERY_REQUIRED', 'Event sequence cannot be recovered automatically', 503, { expectedSeq: lastSeq + 1, eventSeq: event.seq });
    await appendJsonLine(eventsFile(event.projectId), event);
    return event;
  };
  const broadcastEvent = event => {
    broadcastProject(event);
    broadcastDirectory('map', { projectId: event.projectId, seq: event.seq, version: event.version, type: event.type, at: event.at });
  };
  const recoverTransaction = async transaction => {
    if (transaction?.v !== 1 || !transaction.scope || !transaction.operationId || !transaction.event) {
      throw new MapError('RECOVERY_REQUIRED', 'Cloud transaction record is invalid', 503);
    }
    const file = transactionFile(transaction.scope, transaction.operationId);
    await appendEventRecord(transaction.event);
    await faultInjector('event-persisted', transaction);
    if (transaction.map) {
      const target = transaction.map.target === 'overview' ? overviewFile : mapFile(transaction.map.projectId);
      const stored = await readJson(target, null);
      if (stored?.version !== transaction.map.next.version) {
        if ((stored?.version ?? null) !== (transaction.map.previousVersion ?? null)) {
          throw new MapError('RECOVERY_REQUIRED', 'Map changed while a durable transaction was pending', 503, { projectId: transaction.event.projectId });
        }
        await atomicWrite(target, json(transaction.map.next));
      }
    }
    await faultInjector('map-persisted', transaction);
    if (transaction.registryProject) {
      await updateRegistryProject(transaction.registryProject);
    }
    if (transaction.work) {
      const target = workFile(transaction.work.projectId, transaction.work.workId);
      const stored = await readJson(target, null);
      const storedDigest = stored === null ? null : digest(JSON.stringify(stored));
      const nextDigest = digest(JSON.stringify(transaction.work.next));
      if (storedDigest !== nextDigest) {
        if (storedDigest !== (transaction.work.previousDigest ?? null)) {
          throw new MapError('RECOVERY_REQUIRED', 'Development window changed while a durable transaction was pending', 503, { workId: transaction.work.workId });
        }
        await atomicWrite(target, json(transaction.work.next));
      }
    }
    await faultInjector('work-persisted', transaction);
    if (transaction.receipt) {
      const target = operationFile(transaction.receipt.scope, transaction.operationId);
      const stored = await readJson(target, null);
      if (stored && stored.requestDigest !== transaction.receipt.value.requestDigest) {
        throw new MapError('RECOVERY_REQUIRED', 'Operation receipt conflicts with a pending transaction', 503);
      }
      if (!stored) await atomicWrite(target, json(transaction.receipt.value));
    }
    await faultInjector('receipt-persisted', transaction);
    await durableUnlink(file);
  };
  const recoverTransactions = async projectId => {
    const names = await fs.readdir(transactionsDir).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of names.filter(name => name.endsWith('.json')).sort()) {
      const file = path.join(transactionsDir, name), transaction = await readJson(file, null);
      if (!transaction || projectId && transaction.event?.projectId !== projectId) continue;
      await recoverTransaction(transaction);
    }
  };
  const persistTransaction = async transaction => {
    await atomicWrite(transactionFile(transaction.scope, transaction.operationId), json(transaction));
    await faultInjector('transaction-prepared', transaction);
    await recoverTransaction(transaction);
  };
  await recoverTransactions();
  const projectSnapshot = async project => {
    const events = await readEvents(project.id);
    const stored = await readJson(mapFile(project.id), null);
    return stored
      ? { ...stored, projectId: project.id, seq: events.at(-1)?.seq || stored.seq || 0, snapshotSeq: stored.seq || 0 }
      : { projectId: project.id, version: null, document: null, seq: events.at(-1)?.seq || 0, snapshotSeq: 0 };
  };
  const workbenchSnapshot = async (scope, project) => {
    if (scope === 'overview') {
      const stored = await readJson(overviewFile, null);
      const document = reconcileOverview(stored, registry.projects);
      return { projectId: 'overview', version: versionOf(document), document };
    }
    const snapshot = await projectSnapshot(project);
    const document = snapshot.document || emptyProjectDocument(project);
    return { projectId: project.id, version: snapshot.version || versionOf(document), document };
  };
  const overviewRequestDigest = (input, actor, project) => digest(JSON.stringify({ baseVersion: input.baseVersion, operations: input.operations,
    ...(project ? { projectId: project.id, actor } : {}) }));
  const readOverviewReceipt = (input, actor, project) => serial('overview', () => withFileLock(overviewFile + '.lock', async () => {
    await recoverTransactions('overview');
    const operationId = validateOperationId(input);
    if (project) await mapProjects.get(project.id);
    const previous = await readJson(operationFile('overview', operationId), null);
    if (!previous) return null;
    if (previous.requestDigest !== overviewRequestDigest(input, actor, project)) throw new MapError('ID_REUSED', 'operationId belongs to another request', 409);
    return previous.result;
  }));
  const commitOverview = async (input, actor = { kind: 'human', sessionId: 'cloud-workbench' }, project = null) => {
    const result = await serial('overview', () => withFileLock(overviewFile + '.lock', async () => {
      await recoverTransactions('overview');
      const operationId = validateOperationId(input), receiptPath = operationFile('overview', operationId);
      const requestDigest = overviewRequestDigest(input, actor, project);
      if (project) await mapProjects.get(project.id);
      const previous = await readJson(receiptPath, null);
      if (previous) { if (previous.requestDigest !== requestDigest) throw new MapError('ID_REUSED', 'operationId belongs to another request', 409); return previous.result; }
      const current = await workbenchSnapshot('overview', null);
      if (input.baseVersion !== current.version) throw new MapError('VERSION_CONFLICT', 'Map changed; reload before committing', 409, { currentVersion: current.version });
      if (project) {
        // Validate against the selected subtree first. The full commit then
        // preserves existing global validation, relations and delete cleanup.
        const scoped = (await mapProjects.read(project.id)).main.memory.map;
        if (!Array.isArray(input.operations) || input.operations.some(operation =>
          ['document', 'initialize'].includes(operation?.type) || operation?.type === 'attach-bug' && !entries(scoped.root).has(operation.id))) {
          throw new MapError('FORBIDDEN', '此对话只能修改当前项目的节点和事项', 403);
        }
        applyOperations(scoped, input.operations, actor);
      }
      const applied = applyOperations(current.document, input.operations, actor); validate(applied.doc);
      const stored = await readJson(overviewFile, null), version = versionOf(applied.doc);
      const event = await createEvent('overview', { type: 'map.committed', operationId, actor,
        baseVersion: current.version, version, operations: input.operations, scope: scopeOfOperations(input.operations) });
      const next = { projectId: 'overview', version, seq: event.seq, document: applied.doc, updatedAt: event.at };
      const saved = { committed: true, operationId, version, seq: event.seq, nodeIds: applied.resultIds, persistedAt: event.at,
        ...(project ? { projectId: project.id } : {}) };
      await persistTransaction({ v: 1, scope: 'overview', operationId, event,
        map: { target: 'overview', previousVersion: stored?.version ?? null, next },
        receipt: { scope: 'overview', value: { requestDigest, result: saved } } });
      broadcastEvent(event);
      return saved;
    }));
    await broadcastWorkbench('overview', null);
    return result;
  };
  const sessionSnapshot = async (project, viewId) => {
    if (!configuredMemory?.projects?.[project.id]) throw new MapError('UNKNOWN_VIEW', 'Private Session memory is not configured for this project', 404);
    const sessionId = viewId.slice('session:'.length);
    const snapshot = (await readMemoryProject(configuredMemory, project.id)).sessions[sessionId];
    if (!snapshot) throw new MapError('UNKNOWN_VIEW', 'Session memory is not available', 404);
    // Coordinator assignments are a read-only projection shared by Main and
    // Session views.  Session memory is intentionally left untouched, but the
    // selected Session must still show the current dispatch/status for items
    // that the Coordinator assigned to it.
    const document = await coordinatorAssignmentProjection(project, snapshot.memory.map);
    return { version: snapshot.version, document, source: { status: 'session', sessionId, sourceCommit: snapshot.sourceCommit, baseMainVersion: snapshot.baseMainVersion, updatedAt: snapshot.updatedAt || null } };
  };
  const mainMemorySnapshot = async project => {
    if (!configuredMemory?.projects?.[project.id]) return null;
    const snapshot = (await readMemoryProject(configuredMemory, project.id)).main;
    if (!snapshot) {
      const document = emptyProjectDocument(project);
      return { version: versionOf(document), document, source: { status: 'baseline-pending', mainSha: null, publishedAt: null } };
    }
    const document = await coordinatorAssignmentProjection(project, snapshot.memory.map);
    return { version: snapshot.version, document, source: { status: 'main', mainSha: snapshot.mainSha || null, publishedAt: snapshot.publishedAt || null } };
  };
  const scopedWorkbenchState = async (scope, project, viewId = 'main') => {
    const snapshot = viewId.startsWith('session:')
      ? await sessionSnapshot(project, viewId)
      : project && viewId === 'main'
        ? await mainMemorySnapshot(project) || await workbenchSnapshot(scope, project)
        : await workbenchSnapshot(scope, project);
    return { version: snapshot.version, doc: snapshot.document, viewId, source: snapshot.source || null, projection: { status: 'ready', sourceVersion: snapshot.version }, recovery: false, error: null };
  };
  const quark = attachmentProvider || (process.env.CONTEXT_GUARD_QUARK_CLI ? await createQuarkProvider({
    cliPath: process.env.CONTEXT_GUARD_QUARK_CLI, sha256: process.env.CONTEXT_GUARD_QUARK_SHA256,
    backend: process.env.CONTEXT_GUARD_QUARK_BACKEND || 'skill',
    uploadTimeoutMs: 30 * 60_000,
    cookieFile: process.env.CONTEXT_GUARD_QUARK_COOKIE_FILE,
    workDir: path.join(dataDir, 'quark-cli'),
  }) : null);
  const attachments = quark && new CloudAttachments({ directory: path.join(dataDir, 'attachments'), provider: quark,
    publish: async (job, file, options) => {
      const project = projectById(job.projectId);
      if (!project || !configuredMemory?.projects?.[project.id]) throw new MapError('NOT_FOUND', 'Attachment project is unavailable', 404);
      const scope = `project:${project.id}`;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const state = await scopedWorkbenchState(scope, project, job.viewId);
          if (job.viewId !== 'main') {
            const snapshot = (await readMemoryProject(configuredMemory, project.id)).sessions[job.viewId.slice(8)];
            if ((snapshot?.generation || 1) !== job.generation) throw new MapError('ATTACHMENT_OWNER_GONE', 'Attachment belongs to an earlier Session generation', 409);
          }
          const input = options?.create && job.creationRequest || { operationId: randomUUID(), baseVersion: state.version,
            operations: attachmentPatch(state.doc, job, file, options) };
          // Persist the exact request before creating a card. After a lost result,
          // replay its receipt rather than recreating a subsequently removed card.
          if (options?.create && !job.creationRequest) { job.creationRequest = input; await attachments.save(job); }
          await faultInjector('attachment-map-commit', job);
          if (job.viewId === 'main') await commitMainMemoryMap(configuredMemory, project.id, input);
          else await commitSessionMap(configuredMemory, project.id, job.viewId.slice(8), input);
          await faultInjector('attachment-map-committed', job);
          await broadcastWorkbench(scope, project, job.viewId); return;
        } catch (error) {
          const busy = error.code === 'STATE_BUSY' && error.message === 'Shared state is busy; preserve lock and retry';
          if ((!busy && error.code !== 'VERSION_CONFLICT') || attempt === 3) throw error;
          if (!busy && options?.create) { delete job.creationRequest; await attachments.save(job); }
          if (busy) await new Promise(resolve => setTimeout(resolve, 200 * (attempt + 1)));
        }
      }
    },
  });
  const coordinatorAssignmentProjection = async (project, document) => {
    const config = configuredMemory?.projects?.[project?.id]?.coordinator;
    if (!project || !config?.enabled || !document?.root) return document;
    const registry = await conversationsFor(project).state();
    const { store, principal } = interfaceProject(project);
    const assignments = new Map();
    for (const task of await store.projectTasks(principal)) {
      const owner = registry.items?.[task.conversationId] || (task.itemId && task.nodeId && task.kind
        ? { nodeId: task.nodeId, kind: task.kind, itemId: task.itemId } : null);
      const assignmentKey = coordinatorAssignmentKey(document, owner, task.taskId);
      if (!assignmentKey || ['brief', 'brief-rejected', 'dispatched', 'completed'].includes(task.stage)) continue;
      assignments.set(assignmentKey, { status: task.stage === 'failed' ? 'failed' : 'queued',
        task_id: task.taskId, at: task.updatedAt || task.createdAt, reason: task.error || task.stage });
    }
    for (const [rawKey, conversationId] of Object.entries(registry.tasks || {})) {
      let pair;
      try { pair = JSON.parse(rawKey); } catch { continue; }
      const [sessionId, taskId] = pair || [];
      const owner = registry.items?.[conversationId];
      const assignmentKey = coordinatorAssignmentKey(document, owner, taskId);
      if (!assignmentKey || !sessionId || !taskId) continue;
      const binding = await store.registeredBinding(principal, sessionId).catch(() => null);
      if (!binding) continue;
      const task = await store.taskRecord(principal, { id: sessionId, generation: binding.generation }, taskId).catch(() => null);
      if (!task) continue;
      const status = task.stage === 'finished' ? (task.result?.outcome === 'success' ? 'completed' : task.result?.outcome || 'failed')
        : task.stage === 'queued' ? 'queued' : task.stage;
      assignments.set(assignmentKey, { status, task_id: task.id, session_id: sessionId, at: task.updatedAt || task.startedAt || '' });
    }
    if (!assignments.size) return document;
    return applyCoordinatorAssignments(document, assignments);
  };
  const memorySessions = async project => {
    if (!configuredMemory?.projects?.[project.id]) return [];
    const state = await readMemoryProject(configuredMemory, project.id);
    const repository = interfaceConfig?.repositories?.find(item => item.projectId === project.id);
    const presence = new Map(repository ? [...interfacePresence.values()]
      .filter(item => item.repositoryId === repository.repositoryId)
      .map(item => [item.sessionId, item]) : []);
    const names = await fs.readdir(path.join(worksDir, project.id)).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
    const works = [];
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const work = await readJson(path.join(worksDir, project.id, name), null);
      if (work?.sessionId) works.push(work);
    }
    const sessions = Object.entries(state.sessions).map(([storedSessionId, snapshot]) => {
      const sessionId = snapshot.sessionId || storedSessionId;
      const latest = works.filter(work => work.sessionId === sessionId).sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')))[0];
      const events = String(snapshot.memory?.records?.['sessions.jsonl'] || '').split('\n').flatMap(line => {
        try { const event = JSON.parse(line); return event.session_id === sessionId ? [event] : []; } catch { return []; }
      }).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
      const named = events.filter(event => typeof event.thread_name === 'string' && event.thread_name.trim()).at(-1);
      const lifecycle = events.filter(event => ['session-start', 'user-prompt-submit', 'stop', 'stop-blocked', 'interrupt'].includes(event.event)).at(-1);
      const observed = presence.get(sessionId);
      const lastSeen = observed?.lastHeartbeatAt || snapshot.lastSync?.occurredAt || snapshot.updatedAt || latest?.startedAt || '';
      const connection = cloudSessionConnection(observed?.lastHeartbeatAt);
      const execution = connection.state === 'online' ? observed?.execution || { status: 'unknown', at: '' } : { status: 'unknown', at: '' };
      return { id: sessionId, name: observed?.name || snapshot.memory?.display?.name || named?.thread_name.trim().slice(0, 200) || '', platform: observed?.platform || snapshot.memory?.display?.platform || events.at(-1)?.platform || 'agent', status: connection.state, connection, lastSeen, lastHeartbeatAt: connection.lastHeartbeatAt, execution };
    });
    for (const observed of presence.values()) if (!state.sessions[observed.sessionId]) {
      const connection = cloudSessionConnection(observed.lastHeartbeatAt);
      sessions.push({
        id: observed.sessionId, name: observed.name || '', platform: observed.platform || 'agent', status: connection.state,
        connection, lastSeen: observed.lastHeartbeatAt, lastHeartbeatAt: observed.lastHeartbeatAt, bindingState: 'connected',
        execution: connection.state === 'online' ? observed.execution || { status: 'unknown', at: '' } : { status: 'unknown', at: '' },
      });
    }
    if (repository) {
      const principal = { repositoryId: repository.repositoryId, deviceId: 'cloud-browser', agentId: 'cloud-human', role: 'human' };
      const { store } = interfaceStorage(principal);
      for (const head of await store.queueHeads(principal)) {
        const binding = await store.registeredBinding(principal, head.session.id);
        const existing = sessions.find(item => item.id === head.session.id);
        if (existing) {
          existing.name ||= binding.name || '';
          existing.platform = binding.platform || existing.platform;
        } else sessions.push({ id: head.session.id, name: binding.name || '', platform: binding.platform || 'agent', status: 'offline', connection: cloudSessionConnection(''), lastSeen: '', lastHeartbeatAt: '', bindingState: 'bound' });
      }
    }
    return sessions.sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
  };
  const taskPublicationReady = async (project, sessionId, sourceCommit, generation) => {
    if (!interfaceConfig?.repositories?.some(item => item.projectId === project.id && /^\d+$/.test(item.repositoryId))) return true;
    const { principal, store } = interfaceProject(project);
    const binding = await store.registeredBinding(principal, sessionId);
    if (!binding) return generation === undefined;
    if (generation !== undefined && binding.generation !== generation) return false;
    const tasks = await store.workflowTasks(principal, { id: sessionId, generation: generation ?? binding.generation });
    return taskSessionPublicationReady(tasks, sourceCommit, configuredMemory.projects[project.id]);
  };
  if (configuredMemory) {
    const originalGate = configuredMemory.publicationGate;
    configuredMemory.publicationGate = async (projectId, session) => {
      const project = projectById(projectId);
      return !!project && (!originalGate || await originalGate(projectId, session)) &&
        await taskPublicationReady(project, session.sessionId, session.sourceCommit, session.generation || 1);
    };
    configuredMemory.commitPublication = async (projectId, session, write) => {
      const project = projectById(projectId);
      const commit = async () => {
        if (!await configuredMemory.publicationGate(projectId, session)) throw new MapError('TASK_SOURCE_PENDING', 'Task review changed during publication', 409);
        return write();
      };
      if (!interfaceConfig?.repositories?.some(item => item.projectId === projectId && /^\d+$/.test(item.repositoryId))) return commit();
      const { store } = interfaceProject(project);
      return withFileLock(`${store.file}.lock`, commit);
    };
  }
  const publicationState = async (project, viewId, options = {}) => {
    if (!project || !configuredMemory?.projects?.[project.id]) return { status: 'unavailable', reason: 'MEMORY_NOT_CONFIGURED' };
    if (viewId === 'main') {
      const state = await readMemoryProject(configuredMemory, project.id);
      return state.main
        ? { projectId: project.id, status: 'published', mainVersion: state.main.version, mainSha: state.main.mainSha || null, publishedAt: state.main.publishedAt || null }
        : { projectId: project.id, status: 'empty', mainVersion: null };
    }
    const status = await memoryPublicationStatus(configuredMemory, project.id, viewId.slice('session:'.length), options);
    return status.status === 'ready' && !await taskPublicationReady(project, status.sessionId, status.sourceCommit, status.generation)
      ? { ...status, status: 'waiting', reason: 'TASK_SOURCE_PENDING' } : status;
  };
  const broadcastWorkbench = async (scope, project, viewId = 'main') => {
    const state = await scopedWorkbenchState(scope, project, viewId);
    for (const client of workbenchClients) {
      if (client.res.destroyed) { workbenchClients.delete(client); continue; }
      if (client.scope === `${scope}|${viewId}`) client.res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    }
  };
  const broadcastWorkbenchAccess = project => {
    const prefix = `project:${project.id}|`;
    const payload = JSON.stringify({ projectId: project.id, at: new Date().toISOString() });
    for (const client of workbenchClients) {
      if (client.res.destroyed) { workbenchClients.delete(client); continue; }
      if (client.scope.startsWith(prefix)) client.res.write(`event: access\ndata: ${payload}\n\n`);
    }
  };
  const stopMemoryEvents = memoryHandler?.onEvent(event => {
    const project = projectById(event.projectId);
    if (!project) return;
    broadcastWorkbenchAccess(project);
    if (event.scope === 'main') broadcastWorkbench(`project:${project.id}`, project, 'main').catch(() => {});
    else if (event.scope?.startsWith('session:')) broadcastWorkbench(`project:${project.id}`, project, event.scope).catch(() => {});
  }) || (() => {});
  let automaticPublicationRunning = null;
  let stopping = false;
  const publishMergedSessions = async ({ afterCurrent = false } = {}) => {
    if (stopping || !configuredMemory) return;
    if (automaticPublicationRunning) {
      await automaticPublicationRunning;
      if (stopping || !afterCurrent) return;
    }
    const run = (async () => {
      try {
        for (const project of registry.projects) {
          if (!configuredMemory.projects?.[project.id]) continue;
          try {
            const size = (await fs.stat(projectMemoryFile(configuredMemory.dataDir, project.id))).size;
            if (size > automaticPublicationMaxBytes) {
              console.error(`[context-guard] automatic Main publication skipped for ${project.id}: memory history is ${size} bytes`);
              continue;
            }
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          const state = await readMemoryProject(configuredMemory, project.id);
          const sessions = Object.values(state.sessions || {})
            // Candidate filter only; status and the locked write still recheck every gate.
            .filter(sessionCompletionMatches)
            .sort((left, right) => String(left.updatedAt || '').localeCompare(String(right.updatedAt || '')));
          for (const session of sessions) {
            const status = await publicationState(project, `session:${session.sessionId}`, { refresh: true });
            if (status.status !== 'ready') continue;
            await publishSessionMemory(configuredMemory, project.id, {
              operationId: `automatic-main:${status.sessionId}:${status.generation}:${status.mainSha}`,
              baseVersion: status.baseVersion,
              sessionId: status.sessionId,
              sessionVersion: status.sessionVersion,
              expectedMainSha: status.mainSha,
            }, { kind: 'automation', sessionId: status.sessionId });
            break;
          }
        }
      } catch (error) {
        console.error(`[context-guard] automatic Main publication deferred: ${error.message}`);
      }
    })();
    automaticPublicationRunning = run;
    try { await run; }
    finally { if (automaticPublicationRunning === run) automaticPublicationRunning = null; }
  };
  const validateOperationId = input => {
    const operationId = String(input.operationId || '');
    if (!operationId || operationId.length > 160) throw new MapError('INVALID_OPERATION', 'operationId is required');
    return operationId;
  };
  const commitProject = (project, input, actor = { kind: 'human', sessionId: 'cloud-sync' }) => serial(project.id, async () => {
    const operationId = validateOperationId(input);
    await recoverTransactions(project.id);
    const receiptPath = operationFile(project.id, operationId);
    const requestDigest = digest(JSON.stringify({ baseVersion: input.baseVersion ?? null, operations: input.operations, actor }));
    const receipt = await readJson(receiptPath, null);
    if (receipt) {
      if (receipt.requestDigest !== requestDigest) throw new MapError('ID_REUSED', 'operationId belongs to another request', 409);
      return receipt.result;
    }
    const current = await projectSnapshot(project);
    if ((input.baseVersion ?? null) !== current.version) throw new MapError('VERSION_CONFLICT', 'Map changed; reload before committing', 409, { currentVersion: current.version, currentSeq: current.seq });
    const applied = applyOperations(current.document || emptyProjectDocument(project), input.operations, actor);
    validate(applied.doc);
    const version = versionOf(applied.doc);
    const event = await createEvent(project.id, {
      type: 'map.committed', operationId, actor, baseVersion: current.version, version,
      operations: input.operations, scope: scopeOfOperations(input.operations, input.scope),
    });
    const next = { projectId: project.id, version, seq: event.seq, document: applied.doc, updatedAt: event.at };
    const result = { committed: true, operationId, projectId: project.id, version, seq: event.seq, nodeIds: applied.resultIds, persistedAt: event.at };
    await persistTransaction({
      v: 1, scope: project.id, operationId, event,
      map: { target: 'project', projectId: project.id, previousVersion: current.version, next },
      registryProject: { id: project.id, status: 'connected', updatedAt: event.at },
      receipt: { scope: project.id, value: { requestDigest, result } },
    });
    broadcastEvent(event);
    await broadcastWorkbench(`project:${project.id}`, project);
    return result;
  });
  const saveSnapshot = (project, input) => serial(project.id, async () => {
    const operationId = validateOperationId(input);
    await recoverTransactions(project.id);
    const receiptPath = operationFile(`${project.id}:snapshot`, operationId);
    const requestDigest = digest(JSON.stringify({ baseVersion: input.baseVersion ?? null, document: input.document }));
    const receipt = await readJson(receiptPath, null);
    if (receipt) {
      if (receipt.requestDigest !== requestDigest) throw new MapError('ID_REUSED', 'operationId belongs to another request', 409);
      return receipt.result;
    }
    validate(input.document);
    const current = await projectSnapshot(project);
    if ((input.baseVersion ?? null) !== current.version) throw new MapError('VERSION_CONFLICT', 'Map changed; choose pull or push explicitly', 409, { currentVersion: current.version, currentSeq: current.seq });
    const version = versionOf(input.document);
    const event = await createEvent(project.id, { type: 'map.snapshot', operationId, actor: { kind: 'sync', sessionId: String(input.sessionId || '') }, baseVersion: current.version, version, operations: [], scope: normalizeScope({ wildcard: true }) });
    const next = { projectId: project.id, version, seq: event.seq, document: input.document, updatedAt: event.at };
    const result = { committed: true, operationId, projectId: project.id, version, seq: event.seq, snapshot: true, persistedAt: event.at };
    await persistTransaction({
      v: 1, scope: `${project.id}:snapshot`, operationId, event,
      map: { target: 'project', projectId: project.id, previousVersion: current.version, next },
      registryProject: { id: project.id, status: 'connected', updatedAt: event.at },
      receipt: { scope: `${project.id}:snapshot`, value: { requestDigest, result } },
    });
    broadcastEvent(event);
    await broadcastWorkbench(`project:${project.id}`, project);
    return result;
  });
  const impactsSince = async (project, baseSeq, scope, workId) => (await readEvents(project.id))
    .filter(event => event.seq > baseSeq && ['map.committed', 'map.snapshot', 'work.completed'].includes(event.type) && event.workId !== workId && scopesOverlap(scope, event.scope))
    .map(event => ({ seq: event.seq, eventId: event.eventId, type: event.type, actor: event.actor, scope: event.scope, version: event.version }));

  const receiveHeartbeat = async (principal, input) => {
    const { store } = interfaceStorage(principal);
    const reply = await store.handle(principal, input);
    if (input.payload.creationResults?.length) {
      reply.data.creationResults = [];
      for (const result of input.payload.creationResults) {
        try { await store.finishSessionCreation(principal, result); reply.data.creationResults.push({ ...result, accepted: true }); }
        catch (error) {
          if (['FORBIDDEN', 'ID_REUSED', 'INVALID_ARGUMENT'].includes(error.code)) reply.data.creationResults.push({ ...result, accepted: false, code: error.code });
          // Unknown storage failures are retried from the same durable local result.
        }
      }
    }
    const accepted = input.payload.sessions.filter(item => reply.data.sessions.some(session => session.id === item.id && session.generation === item.generation && item.ackedSeq <= session.ackedSeq));
    await store.rememberSessionNames(principal, accepted);
    const repository = interfaceConfig.repositories.find(item => item.repositoryId === principal.repositoryId);
    const lastHeartbeatAt = new Date().toISOString();
    let accessChanged = false;
    for (const session of accepted) {
      const key = presenceKey(principal.repositoryId, session.id), previous = interfacePresence.get(key);
      const name = session.name || previous?.name || '', platform = session.platform || previous?.platform || '';
      const execution = session.execution || { status: 'unknown', at: '' };
      if (!previous?.online || previous.name !== name || previous.platform !== platform || previous.execution?.status !== execution.status || previous.execution?.at !== execution.at) accessChanged = true;
      interfacePresence.set(key, { repositoryId: principal.repositoryId, projectId: repository?.projectId || '', sessionId: session.id,
        generation: session.generation, name, platform, lastHeartbeatAt, online: true, execution });
    }
    if (accessChanged && repository?.projectId) {
      const project = projectById(repository.projectId);
      if (project) broadcastWorkbenchAccess(project);
    }
    const heads = await interfaceMapHeads(principal);
    reply.data.sessions = reply.data.sessions.map(session => ({ ...session, ...(heads[session.id] || {}) }));
    return reply;
  };
  const activeRequests = new Set();
  const handleRequest = async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const route = url.pathname;
      const roleMcp = route.match(/^\/api\/workbench\/projects\/([a-z0-9-]{1,64})\/api\/cursor-role-mcp$/);
      if (roleMcp) {
        // Scoped native bearer authority only; do not apply browser cookie or
        // device pairing fallback before the purpose-built MCP authorization.
        const project = projectById(roleMcp[1]);
        if (!project) protocolFail('NOT_FOUND', 'Project is unavailable');
        // Native callbacks cannot initialize templates or acquire the store
        // initialization lock. The Coordinator scheduler owns that lifecycle.
        const hosted = initializedCursorRoles.get(project.id);
        if (!hosted) protocolFail('UNAVAILABLE', 'Cursor roles are not configured');
        return hosted.mcp(req, res);
      }
      if (route === '/api/v2/heartbeat') {
        if (!interfaceAuth) protocolFail('INVALID_ARGUMENT', 'Interface v2 is not configured');
        if (req.method !== 'POST') protocolFail('INVALID_ARGUMENT', 'Use POST');
        if (req.headers.origin) protocolFail('FORBIDDEN', 'Device heartbeat is not a browser endpoint');
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) protocolFail('INVALID_ARGUMENT', 'Expected JSON');
        const chunks = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > MAX_MESSAGE_BYTES) protocolFail('TOO_LARGE', 'Heartbeat exceeds 256 KiB'); chunks.push(chunk); }
        let batch;
        try { batch = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { protocolFail('INVALID_ARGUMENT', 'Invalid JSON'); }
        if (!Array.isArray(batch) || !batch.length || batch.length > 100) protocolFail('INVALID_ARGUMENT', 'Expected 1–100 project heartbeats');
        let sessions = 0;
        const ids = new Set();
        for (const item of batch) {
          if (!item || typeof item.credential !== 'string' || item.credential.length > 4096 || Object.keys(item).some(key => !['credential', 'message'].includes(key))) protocolFail('INVALID_ARGUMENT', 'Invalid project heartbeat');
          validateMessage(item.message);
          if (item.message.type !== 'sync.heartbeat' || ids.has(item.message.id)) protocolFail('INVALID_ARGUMENT', 'Expected distinct heartbeat messages');
          ids.add(item.message.id); sessions += item.message.payload.sessions.length;
        }
        if (sessions > 100) protocolFail('TOO_LARGE', 'Device heartbeat exceeds 100 Sessions');
        // Each project retains its own authorization. An expired credential may
        // reject its entry, never prevent another project's liveness update.
        const replies = await Promise.all(batch.map(async ({ credential, message }) => {
          try {
            const principal = await interfaceAuth.authenticate(credential);
            if (principal.role !== 'device') protocolFail('FORBIDDEN', 'Device credential required');
            const reply = await receiveHeartbeat(principal, message);
            const creations = await interfaceStorage(principal).store.pendingSessionCreations(principal);
            if (creations.length) reply.data.sessionCreations = creations;
            return reply;
          } catch (error) { return errorReply(message.id, error); }
        }));
        // Keep optional creation work from overflowing a multi-project device
        // heartbeat. Omitted requests remain durable and return on later beats.
        const creations = replies.map(reply => {
          const items = reply.data?.sessionCreations || [];
          if (reply.data) delete reply.data.sessionCreations;
          return items;
        });
        let remaining = MAX_MESSAGE_BYTES - Buffer.byteLength(JSON.stringify(replies)) - 64;
        for (let i = 0; i < replies.length; i++) {
          const selected = []; let bytes = 32;
          for (const item of creations[i]) {
            const size = Buffer.byteLength(JSON.stringify(item)) + 1;
            if (bytes + size > remaining) break;
            selected.push(item); bytes += size;
          }
          if (selected.length) { replies[i].data.sessionCreations = selected; remaining -= bytes; }
        }
        return send(res, 200, replies);
      }
      if (route === '/api/v2/events') {
        if (!interfaceAuth) protocolFail('INVALID_ARGUMENT', 'Interface v2 is not configured');
        if (req.method !== 'GET') protocolFail('INVALID_ARGUMENT', 'Use GET');
        if (req.headers.origin && req.headers.origin !== allowedOrigin) protocolFail('FORBIDDEN', 'Untrusted browser origin');
        const credential = bearer(req), principal = await interfaceAuth.authenticate(credential);
        const { store } = interfaceStorage(principal);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.write(': connected\n\n');
        let pending = false, dirty = false, closed = false;
        const heads = new Map();
        const notify = async () => {
          dirty = true;
          if (pending || closed) return;
          pending = true;
          try {
            while (dirty && !closed) {
              dirty = false;
              const current = await interfaceAuth.authenticate(credential);
              const mapHeads = await interfaceMapHeads(current);
              for (const head of await store.queueHeads(current)) {
                const key = `${head.session.id}:${head.session.generation}`;
                const version = `${head.latestSeq}:${mapHeads[head.session.id]?.mapVersion || ''}`;
                if (heads.get(key) === version) continue;
                heads.set(key, version);
                const message = { v: 2, id: randomUUID(), type: 'sync.event', session: head.session, payload: { latestSeq: head.latestSeq } };
                if (!res.write(`event: sync.event\ndata: ${JSON.stringify(message)}\n\n`)) { res.end(); break; }
              }
            }
          } catch { res.end(); } finally { pending = false; }
        };
        const timer = setInterval(() => {
          interfaceAuth.authenticate(credential).then(() => { if (!res.write(': heartbeat\n\n')) res.end(); }).catch(() => res.end());
        }, 10000); timer.unref();
        interfaceStreams.add(res); store.on('change', notify);
        const memoryEvents = configuredMemory ? memoryHub(configuredMemory) : null;
        const repository = interfaceConfig.repositories.find(item => item.repositoryId === principal.repositoryId);
        const memoryChanged = event => { if (event.projectId === repository?.projectId) notify(); };
        memoryEvents?.on('event', memoryChanged);
        res.on('close', () => { closed = true; clearInterval(timer); store.off('change', notify); memoryEvents?.off('event', memoryChanged); interfaceStreams.delete(res); });
        await notify(); return;
      }
      const binaryRoute = route.match(/^\/api\/v2\/blobs\/([a-f0-9]{64})$/);
      if (binaryRoute) {
        try {
          if (!interfaceAuth) protocolFail('INVALID_ARGUMENT', 'Interface v2 is not configured');
          if (req.headers.origin && req.headers.origin !== allowedOrigin) protocolFail('FORBIDDEN', 'Untrusted browser origin');
          const principal = await interfaceAuth.authenticate(bearer(req));
          const session = { id: req.headers['x-context-guard-session'], generation: Number(req.headers['x-context-guard-generation']) };
          const { store, blobs } = interfaceStorage(principal);
          await store.authorizeSession(principal, session);
          return await serveBlob(req, res, { blobs, principal, session, blobId: binaryRoute[1] });
        } catch (error) { return send(res, error.status || 503, errorReply('', error)); }
      }
      if (route === '/api/v2/coordinator-tools') {
        if (!interfaceAuth) protocolFail('INVALID_ARGUMENT', 'Interface v2 is not configured');
        if (req.method !== 'POST') protocolFail('INVALID_ARGUMENT', 'Use POST');
        if (req.headers.origin && req.headers.origin !== allowedOrigin) protocolFail('FORBIDDEN', 'Untrusted browser origin');
        const principal = await interfaceAuth.authenticate(bearer(req));
        if (principal.role !== 'device' && principal.role !== 'coordinator') protocolFail('FORBIDDEN', 'Coordinator tools use the same device or coordinator credential as the built-in Coordinator');
        const body = await requestBody(req, MAX_MESSAGE_BYTES);
        const fields = ['conversationId', 'name', 'input', 'operationId'];
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) protocolFail('INVALID_ARGUMENT', 'Provide name, input and operationId');
        if (typeof body.name !== 'string' || !body.name || body.name.length > 64) protocolFail('INVALID_ARGUMENT', 'Provide a Coordinator tool name');
        if (typeof body.operationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.operationId)) protocolFail('INVALID_ARGUMENT', 'Provide a stable operationId');
        if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) protocolFail('INVALID_ARGUMENT', 'Tool input must be an object');
        const conversationId = body.conversationId === undefined ? 'legacy' : body.conversationId;
        if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 180) protocolFail('INVALID_ARGUMENT', 'Unknown Coordinator conversation');
        const repository = interfaceConfig.repositories.find(item => item.repositoryId === principal.repositoryId);
        const project = repository?.projectId && projectById(repository.projectId);
        if (!project) protocolFail('NOT_FOUND', 'Project is not configured');
        if (conversationId.startsWith('session:') && !await interfaceStorage(principal).store.registeredBinding(principal, conversationId.slice(8))) {
          protocolFail('FORBIDDEN', 'This Session is not assigned to the caller');
        }
        const service = await coordinatorFor(project, conversationId);
        try {
          const data = await service.execute(body.name, body.input, { operationId: body.operationId, caller: principal });
          return send(res, 200, { ok: true, data });
        } catch (error) {
          if (error.status && error.code) throw error;
          protocolFail(error.code || 'UNAVAILABLE', error.message || 'Coordinator tool failed');
        }
      }
      if (route === '/api/v2/messages') {
        let id = '';
        try {
          if (!interfaceAuth) protocolFail('INVALID_ARGUMENT', 'Interface v2 requires configured repository and client registrations');
          if (req.method !== 'POST') protocolFail('INVALID_ARGUMENT', 'Use POST');
          if (req.headers.origin && req.headers.origin !== allowedOrigin) protocolFail('FORBIDDEN', 'Untrusted browser origin');
          if (!String(req.headers['content-type'] || '').startsWith('application/json')) protocolFail('INVALID_ARGUMENT', 'Expected JSON');
          const chunks = []; let size = 0;
          for await (const chunk of req) { size += chunk.length; if (size > MAX_MESSAGE_BYTES) protocolFail('TOO_LARGE', 'Message exceeds 256 KiB'); chunks.push(chunk); }
          let input;
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { protocolFail('INVALID_ARGUMENT', 'Invalid JSON'); }
          if (typeof input?.id === 'string' && input.id.length <= 128) id = input.id;
          validateMessage(input);
          const ciTaskHeader = req.headers['x-context-guard-ci-task'];
          const ciEvidenceHeader = req.headers['x-context-guard-ci-evidence'];
          if (ciTaskHeader !== undefined && (!req.headers['x-context-guard-ci-session'] ||
              !['object.read', 'object.put', 'ci.result'].includes(input.type))) protocolFail('FORBIDDEN', 'CI task expectation requires delegated CI');
          if (ciEvidenceHeader !== undefined && (ciTaskHeader === undefined || !req.headers['x-context-guard-ci-session'] ||
              input.type !== 'ci.result')) protocolFail('FORBIDDEN', 'Host evidence requires a scoped CI result');
          if (input.type === 'auth.open') {
            const opened = loginResult(await interfaceAuth.open(input, String(req.socket.remoteAddress)));
            return send(res, 200, { id, ok: true, data: opened.data }, { 'X-Context-Guard-Credential': opened.credential });
          }
          const credential = bearer(req);
          if (input.type === 'auth.close') return send(res, 200, { id, ok: true, data: await interfaceAuth.close(credential) });
          let principal;
          if (!credential && hasWorkbenchAccess(req, url)) {
            const repository = interfaceConfig.repositories?.find(item => item.projectId === url.searchParams.get('project'));
            if (!repository || !/^\d+$/.test(repository.repositoryId)) protocolFail('FORBIDDEN', 'Select an authorized project');
            principal = { repositoryId: repository.repositoryId, deviceId: 'cloud-browser', agentId: 'cloud-human', role: 'human' };
          } else principal = await interfaceAuth.authenticate(credential);
          if (req.headers['x-context-guard-ci-session']) {
            const repository = interfaceConfig.repositories.find(item => item.repositoryId === principal.repositoryId);
            principal = await authorizeCiReceiver({ principal, ciSessionId: req.headers['x-context-guard-ci-session'], message: input,
              templates: configuredMemory?.projects?.[repository?.projectId]?.coordinator?.sessionTemplates || [],
              receivers: configuredMemory?.projects?.[repository?.projectId]?.coordinator?.ciReceivers, store: interfaceStorage(principal).store });
            if (ciTaskHeader !== undefined) {
              const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-context-guard-ci-task').length;
              if (count !== 1) protocolFail('INVALID_ARGUMENT', 'Ambiguous CI task expectation');
              principal = { ...principal, ciTaskExpectation: parseCursorCiTaskHeader(ciTaskHeader) };
            }
            if (ciEvidenceHeader !== undefined) {
              const count = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-context-guard-ci-evidence').length;
              if (count !== 1 || typeof ciTaskHeader !== 'string' || typeof ciEvidenceHeader !== 'string' ||
                  ciEvidenceHeader.length + ciTaskHeader.length > 12288) protocolFail('INVALID_ARGUMENT', 'Ambiguous or oversized CI host evidence expectation');
              principal = { ...principal, ciHostEvidence: parseCursorCiEvidenceHeader(ciEvidenceHeader) };
            }
          }
          if (input.type === 'sync.heartbeat') return send(res, 200, await receiveHeartbeat(principal, input));
          if (input.type === 'main.structure.patch') {
            protocolFail('FORBIDDEN', 'Only Coordinator can write Main structure');
          }
          const { store, blobs, snapshots } = interfaceStorage(principal);
          if (input.type === 'workbench.patch') {
            await store.authorizeSession(principal, input.session);
            await verifyChangeReferences(input.payload.changes, {
              object: async (ref, version) => (await store.handle(principal, { v: 2, id: randomUUID(), type: 'object.read', session: input.session, payload: { ref, version } })).data,
              blob: blobId => blobs.metadata(principal, input.session, blobId),
            });
            const repository = interfaceConfig.repositories.find(item => item.repositoryId === principal.repositoryId);
            if (!repository?.projectId || !configuredMemory?.projects?.[repository.projectId]) protocolFail('NOT_FOUND', 'Private project memory is not configured');
            const actor = { kind: principal.role === 'human' ? 'human' : 'agent', sessionId: input.session.id };
            try {
              const data = await commitSessionMap(configuredMemory, repository.projectId, input.session.id,
                { operationId: `v2:${digest(JSON.stringify([principal.repositoryId, principal.deviceId, principal.agentId, input.session, input.id]))}`, baseVersion: input.payload.baseVersion, changes: input.payload.changes }, actor, {
                  authorize: async () => {
                    if (credential) principal = await interfaceAuth.authenticate(credential);
                    else if (!hasWorkbenchAccess(req, url)) protocolFail('UNAUTHORIZED', 'Workbench login expired');
                    await store.authorizeSession(principal, input.session);
                  },
                  grants: async doc => {
                    const all = doc?.root ? [...entries(doc.root).keys()] : [];
                    if (principal.role === 'human') return all;
                    const granted = Array.isArray(principal.nodeIds) ? all.filter(id => principal.nodeIds.includes(id)) : principal.role === 'device' ? all : [];
                    const binding = await store.registeredBinding(principal, input.session.id);
                    return filterNodeAccess(doc, granted, binding.agentId);
                  },
                });
              return send(res, 200, { id, ok: true, data });
            } catch (error) {
              if (error instanceof MapError) protocolFail(error.code === 'ID_REUSED' ? 'ID_REUSED' : ({ 400: 'INVALID_ARGUMENT', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' })[error.status] || 'UNAVAILABLE', error.message, error.details);
              throw error;
            }
          }
          const reply = await store.handle(principal, input, {
            blobs,
            authorize: authorizeCiTransaction,
            allowMigration: principal.role === 'device',
            workbenchRead: async (identity, message) => {
              const repository = interfaceConfig.repositories.find(item => item.repositoryId === identity.repositoryId);
              if (!repository?.projectId || !configuredMemory?.projects?.[repository.projectId]) protocolFail('NOT_FOUND', 'Private project memory is not configured');
              let source;
              const load = async () => {
                if (!source) {
                  const memory = await readMemoryProject(configuredMemory, repository.projectId);
                  const snapshot = message.payload.scope === 'main' ? memory.main : memory.sessions[message.session.id];
                  if (!snapshot?.memory?.map) protocolFail('NOT_FOUND', 'Requested workbench is unavailable');
                  source = { version: snapshot.version, doc: scopeDocumentToSession(snapshot.memory.map, message.session.id) };
                }
                return source;
              };
              return snapshots.read(identity, message, { load, capture: () => store.recoverySnapshot(identity, message.session, load), grants: async () => {
                const doc = (await load()).doc;
                const all = doc.root ? [...entries(doc.root).keys()] : [];
                if (identity.role === 'human') return all;
                const granted = Array.isArray(identity.nodeIds) ? all.filter(id => identity.nodeIds.includes(id)) : identity.role === 'executor' ? [] : all;
                const binding = await store.registeredBinding(identity, message.session.id);
                return filterNodeAccess(doc, granted, binding.agentId, 'read');
              } });
            },
            verifyBinding: (identity, payload) => identity.role === 'device' || identity.bindings?.[payload.sessionId] === payload.worktreeId,
            workflow: interfaceWorkflow,
          });
          return send(res, 200, reply, {
            ...(principal.ciTaskExpectation ? { 'X-Context-Guard-CI-Task-Authorized': digest(canonical(principal.ciTaskExpectation)) } : {}),
            ...(principal.ciHostEvidence ? { 'X-Context-Guard-CI-Evidence-Authorized': digest(canonical(principal.ciHostEvidence)) } : {}),
          });
        } catch (error) { return send(res, error.status || 503, errorReply(id, error)); }
      }
      const passwordLoginRequest = route === '/auth/login' && req.method === 'POST';
      if (!passwordLoginRequest && allowedOrigin && req.headers.origin && canonicalOrigin(req.headers.origin) !== allowedOrigin) throw new MapError('ORIGIN_REJECTED', 'Cross-origin request rejected', 403);
      if (route === '/api/auth/device/start' || route === '/api/auth/device/poll') {
        if (!deviceAuthorization) protocolFail('UNAVAILABLE', 'Browser device authorization requires an upgraded Cloud with private project memory');
        if (req.method !== 'POST' || req.headers.origin || !String(req.headers['content-type'] || '').startsWith('application/json')) protocolFail('FORBIDDEN', 'Use the CLI device authorization flow');
        const input = await requestBody(req, 4096);
        if (route.endsWith('/start')) {
          const data = await deviceAuthorization.start(input, String(req.socket.remoteAddress), req.headers['x-context-guard-device-grant'] === 'persistent-v1');
          return send(res, 200, { ok: true, data: { ...data, verificationPath: `/connect?code=${encodeURIComponent(data.userCode)}` } });
        }
        const result = await deviceAuthorization.poll(input);
        return send(res, 200, { ok: true, data: result.data }, result.credential ? { 'X-Context-Guard-Credential': result.credential } : {});
      }
      if (route === '/connect' && req.method === 'GET') {
        if (!deviceAuthorization) protocolFail('UNAVAILABLE', 'Device authorization is not configured');
        if (!browserToken || !safeEqual(decodedCookieValue(req), browserToken)) return redirect(res, `/login?next=${encodeURIComponent(route + url.search)}`);
        const grant = await deviceAuthorization.view(url.searchParams.get('code'), String(req.socket.remoteAddress));
        const repository = interfaceConfig.repositories.find(item => item.slug === grant.repository && item.repositoryId === grant.repositoryId);
        deviceRepository(repository?.projectId);
        const html = deviceAuthorizationPage(grant, repository.projectId);
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
        const scriptPolicy = script ? `; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; connect-src 'self'` : '';
        return sendHtml(res, 200, html, { 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'${scriptPolicy}` });
      }
      if (route === '/auth/device/decision' && req.method === 'POST') {
        requireHumanWorkbench(req);
        if (!deviceAuthorization) protocolFail('UNAVAILABLE', 'Device authorization is not configured');
        if (req.headers.origin !== (allowedOrigin || `http://${req.headers.host}`)) protocolFail('FORBIDDEN', 'Submit the authorization form from Cloud');
        const form = await requestForm(req);
        const repository = deviceRepository(form.get('projectId'));
        await deviceAuthorization.decide({ userCode: form.get('userCode'), csrf: form.get('csrf'), decision: form.get('decision'), repository: repository.slug, repositoryId: repository.repositoryId }, String(req.socket.remoteAddress));
        return redirect(res, `/connect?code=${encodeURIComponent(form.get('userCode'))}`);
      }
      const deviceListing = route.match(/^\/api\/workbench\/projects\/([^/]+)\/api\/device-authorizations(?:\/([A-Za-z0-9-]+))?$/);
      if (deviceListing && req.method === 'GET') {
        requireHumanWorkbench(req);
        if (!deviceAuthorization) protocolFail('UNAVAILABLE', 'Device authorization is not configured');
        const repository = deviceRepository(decodeURIComponent(deviceListing[1]));
        const data = deviceListing[2] ? await deviceAuthorization.detail(deviceListing[2], repository.slug, repository.repositoryId)
          : await deviceAuthorization.list(repository.slug, repository.repositoryId, url.searchParams.get('summary') === '1');
        return send(res, 200, data);
      }
      if (memoryHandler && await memoryHandler(req, res)) return;
      if (route === '/login' && req.method === 'GET') {
        if (!browserPasswordHash) throw new MapError('NOT_FOUND', 'Password login is not configured', 404);
        const next = validNext(url.searchParams.get('next') || '/');
        if (hasWorkbenchAccess(req, url)) return redirect(res, next);
        return sendHtml(res, 200, loginPage({ next }));
      }
      if (route === '/auth/login' && req.method === 'POST') {
        if (!browserPasswordHash) throw new MapError('NOT_FOUND', 'Password login is not configured', 404);
        const input = await requestForm(req), next = validNext(input.get('next') || '/');
        if (loginBlocked(req)) return sendHtml(res, 429, loginPage({ next, error: '尝试次数过多，请五分钟后再试' }), { 'Retry-After': '300' });
        if (!await verifyWorkbenchPassword(input.get('password'), browserPasswordHash)) {
          recordLoginFailure(req);
          return sendHtml(res, 401, loginPage({ next, error: '密码错误' }));
        }
        loginFailures.delete(loginKey(req));
        return redirect(res, next, workbenchCookie());
      }
      if (route === '/auth/logout' && req.method === 'POST') return redirect(res, '/login', clearWorkbenchCookie());
      if (route === '/auth' && req.method === 'GET') {
        if (!browserToken || !safeEqual(url.searchParams.get('token'), browserToken)) throw new MapError('UNAUTHORIZED', 'Invalid workbench token', 401);
        const next = validNext(url.searchParams.get('next') || '/');
        return redirect(res, next, workbenchCookie());
      }
      const workbench = route.match(/^\/api\/workbench\/(overview|projects\/([^/]+))(\/.*)$/);
      if (workbench) {
        const scope = workbench[1] === 'overview' ? 'overview' : `project:${decodeURIComponent(workbench[2])}`;
        const project = workbench[2] ? projectById(decodeURIComponent(workbench[2])) : null;
        if (workbench[2] && !project) throw new MapError('NOT_FOUND', 'Project is missing', 404);
        const viewId = String(url.searchParams.get('view') || 'main');
        // Keep the HTTP fallback for older clients. The current workbench sends
        // an explicit Main or Session conversation scope.
        const conversationId = url.searchParams.get('conversation') || 'legacy';
        if (viewId !== 'main' && (!project || !viewId.startsWith('session:'))) throw new MapError('UNKNOWN_VIEW', 'Select Main or a project Session', 404);
        const action = workbench[3];
        if (action === '/bootstrap' && req.method === 'GET') { requirePrivateRead(req, url); return send(res, 200, { root: project ? `cloud:${project.id}` : 'cloud:overview', protocol: 3, apiBase: route.slice(0, -'/bootstrap'.length), authenticated: !!cookieValue(req), interfaceCapabilities: { deviceAuthorization: !!project && !!deviceAuthorization && !!interfaceConfig?.repositories?.find(item => item.projectId === project.id), sessionCompletion: !!project && !!configuredMemory?.projects?.[project.id], attachments: !!project && !!configuredMemory?.projects?.[project.id] && !!attachments, taskDispatch: !!project && !!interfaceConfig, humanReview: !!project && !!interfaceConfig, coordinator: !!configuredMemory?.projects?.[project?.id]?.coordinator?.enabled } }); }
        requireWorkbench(req, url);
        if (action === '/api/cursor-chat') {
          if (!project) throw new MapError('PROJECT_REQUIRED', 'Select a project before opening Cursor', 409);
          if (req.headers.origin && req.headers.origin !== (allowedOrigin || `http://${req.headers.host}`)) throw new MapError('ORIGIN_REJECTED', 'Cross-origin Cursor request rejected', 403);
          if (req.method === 'GET' && !url.searchParams.get('session')) {
            const local = (await memorySessions(project)).filter(session => session.platform === 'cursor').map(session => ({ id: session.id, name: session.name || 'Cursor 本地', kind: 'local' }));
            const configured = !!cursorConfiguration?.projects?.[project.id];
            const cloud = configured ? await (await cursorFor(project)).list() : [];
            return send(res, 200, { sessions: [...local, ...cloud], canCreateCloud: configured });
          }
          const input = req.method === 'POST' ? await requestBody(req) : null;
          if (input && Object.keys(input).some(key => !['id', 'text', 'sessionId', 'action'].includes(key))) throw new MapError('INVALID_ARGUMENT', 'Use a Session, message ID and text');
          if (input?.action !== undefined && input.action !== 'create') throw new MapError('INVALID_ARGUMENT', 'Only explicit Cursor creation is supported');
          if (input?.action === 'create') return send(res, 202, await (await cursorFor(project)).create({ id: input.id, text: input.text }));
          const sessionId = input?.sessionId || url.searchParams.get('session');
          if (typeof sessionId !== 'string' || !sessionId) throw new MapError('SESSION_REQUIRED', 'Select a Cursor Session');
          if (sessionId.startsWith('cloud:')) {
            const service = await cursorFor(project), nativeSessionId = sessionId.slice(6);
            if (req.method === 'GET') return send(res, 200, await service.conversation(nativeSessionId));
            if (req.method === 'POST') return send(res, 202, await service.followUp(nativeSessionId, { id: input.id, text: input.text }));
            throw new MapError('INVALID_ARGUMENT', 'Use GET or POST');
          }
          const local = (await memorySessions(project)).find(session => session.id === sessionId && session.platform === 'cursor');
          if (!local) throw new MapError('FORBIDDEN', 'Select a bound Cursor receiver in this project', 403);
          const { store, principal } = interfaceProject(project), binding = await store.registeredBinding(principal, sessionId);
          if (!binding || typeof store.nativeConversation !== 'function') throw new MapError('CURSOR_UPGRADE_REQUIRED', '升级共享核心与本机 Skill 后再连接 Cursor', 503);
          const session = { id: sessionId, generation: binding.generation };
          if (req.method === 'GET') {
            const conversation = await store.nativeConversation(principal, session);
            const terminal = conversation.messages.at(-1)?.status;
            return send(res, 200, { ...conversation, configured: true, status: conversation.pending ? local.execution?.status || 'unknown' : ['failed', 'interrupted'].includes(terminal) ? terminal : 'stopped' });
          }
          if (req.method !== 'POST') throw new MapError('INVALID_ARGUMENT', 'Use GET or POST');
          return send(res, 202, (await store.handle(principal, { v: 2, id: input.id, type: 'native.prompt', session, payload: { text: input.text } })).data);
        }
        if (action.startsWith('/api/coordinator/attachments/') && project && req.method === 'GET') {
          if (!integrationAttachments) protocolFail('NOT_FOUND', 'Coordinator attachments are unavailable');
          const id = decodeURIComponent(action.slice('/api/coordinator/attachments/'.length));
          const attachment = await integrationAttachments.read({ teamId: integrations.teamId, projectId: project.id, id });
          const bytes = Buffer.from(attachment.base64, 'base64');
          res.writeHead(200, { 'Content-Type': attachment.mimeType, 'Content-Length': bytes.length,
            'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}` });
          return res.end(bytes);
        }
        if (action === '/api/attachments' || action.startsWith('/api/attachments/')) {
          if (!project || !configuredMemory?.projects?.[project.id]) throw new MapError('PROJECT_REQUIRED', 'Select a configured project', 409);
          if (!attachments) throw new MapError('QUARK_NOT_CONFIGURED', '服务器尚未配置夸克网盘，请管理员完成授权', 503);
          if (req.headers.origin && req.headers.origin !== (allowedOrigin || `http://${req.headers.host}`)) throw new MapError('ORIGIN_REJECTED', 'Cross-origin attachment request rejected', 403);
          if (action === '/api/attachments' && req.method === 'POST') {
            if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/octet-stream') throw new MapError('CONTENT_TYPE', 'Send the raw attachment as application/octet-stream', 415);
            if (Number(req.headers['content-length']) > attachments.maxFileBytes) throw new MapError('ATTACHMENT_TOO_LARGE', '附件最大为 256 MiB', 413);
            const header = key => typeof req.headers[key] === 'string' ? req.headers[key] : '';
            let name;
            try { name = decodeURIComponent(header('x-context-guard-file-name')); } catch { throw new MapError('INVALID_ATTACHMENT', 'Invalid encoded file name', 400); }
            const input = { uploadId: header('x-context-guard-upload-id'), name, target: {
              nodeId: header('x-context-guard-node-id'), kind: header('x-context-guard-owner-kind'), ownerId: header('x-context-guard-owner-id'),
            } };
            const parsed = attachmentInput(input);
            const state = await scopedWorkbenchState(scope, project, viewId);
            attachmentPatch(state.doc, { id: 'validate', target: parsed.target }, {}, { create: true });
            const generation = viewId === 'main' ? null : (await readMemoryProject(configuredMemory, project.id)).sessions[viewId.slice(8)]?.generation || 1;
            return send(res, 202, await attachments.stage(project.id, viewId, input, req, generation));
          }
          const match = action.match(/^\/api\/attachments\/([a-f0-9]{64})(\/retry)?$/);
          if (match && !match[2] && req.method === 'GET') return send(res, 200, attachments.public(await attachments.get(project.id, viewId, match[1])));
          if (match?.[2] && req.method === 'POST') return send(res, 202, await attachments.retry(project.id, viewId, match[1]));
          throw new MapError('NOT_FOUND', 'Attachment route not found', 404);
        }
        if (action === '/api/map/translations' && project) {
          requireHumanWorkbench(req);
          if(req.method!=='POST')protocolFail('INVALID_ARGUMENT','Use POST for Map translation');
          if(req.headers.origin && req.headers.origin!==(allowedOrigin||`http://${req.headers.host}`))protocolFail('FORBIDDEN','Untrusted translation origin');
          const input=translationInput(await requestBody(req));
          if(viewId.startsWith('session:'))await sessionSnapshot(project,viewId);
          const {providerId,version,model}=await (await modelSettingsFor(project)).selection({timeoutMs:30000});
          return send(res,200,await mapTranslations.translate(input,{providerId,model,scope:JSON.stringify([project.id,viewId,version])}));
        }
        if (action === '/api/coordinator/model' && project) {
          const settings = await modelSettingsFor(project);
          if (req.method === 'GET') return send(res, 200, await settings.state());
          if (req.method === 'POST') {
            if (req.headers.origin && req.headers.origin !== (allowedOrigin || `http://${req.headers.host}`)) protocolFail('FORBIDDEN', 'Untrusted model settings origin');
            return send(res, 200, await settings.select(await requestBody(req)));
          }
          protocolFail('INVALID_ARGUMENT', 'Use GET or POST for model settings');
        }
        if (action === '/api/coordinator/sessions' && project && req.method === 'POST') {
          const config = configuredMemory?.projects?.[project.id]?.coordinator;
          const input = await requestBody(req);
          if (!config?.enabled || !Array.isArray(config.sessionTemplates) || !config.sessionTemplates.includes(input.templateSessionId) ||
              !Object.hasOwn(config.bindings || {}, input.templateSessionId) || config.ciReceivers?.[input.templateSessionId]) protocolFail('FORBIDDEN', 'Select an explicitly configured developer template');
          const { store, principal } = interfaceProject(project);
          return send(res, 202, await store.requestSessionCreation(principal, input));
        }
        if (action === '/api/coordinator/conversations' && project && req.method === 'POST') {
          const input = await requestBody(req);
          if (!input || Object.keys(input).some(key => !['nodeId', 'kind', 'itemId'].includes(key))) protocolFail('INVALID_ARGUMENT', 'Select a Map item');
          const id = await itemConversation(project, input);
          await coordinatorFor(project, id);
          return send(res, 200, { id });
        }
        if (action === '/api/coordinator/conversations/new' && project && req.method === 'POST') {
          const input = await requestBody(req);
          if (!input || Object.keys(input).some(key => key !== 'id')) protocolFail('INVALID_ARGUMENT', 'Provide a stable conversation request');
          const conversations = conversationsFor(project), id = await conversations.createChat(input.id, {
            executionMode: browserToken && safeEqual(decodedCookieValue(req), browserToken) ? 'manual' : 'automatic',
          });
          await coordinatorFor(project, id);
          return send(res, 201, { id });
        }
        if (action === '/api/coordinator' && project) {
          const coordinator = await coordinatorFor(project, conversationId);
          if (req.method === 'GET') {
            if ((await conversationsFor(project).get(conversationId)).executionMode === 'manual') {
              const state = await coordinatorPublicState(project, conversationId);
              const memory = await readMemoryProject(configuredMemory, project.id);
              state.conversations = await conversationsFor(project).list();
              const allowedNodes = configuredMemory.projects[project.id].coordinator.nodeIds;
              state.nodeReferences = (memory.main?.memory?.map?.root ? [...entries(memory.main.memory.map.root).values()] : [])
                .map(entry => entry.node).filter(node => node.proposal !== 'cancelled' && (!allowedNodes || allowedNodes.includes(node.id)))
                .map(node => ({ id: node.id, title: node.title }));
              return send(res, 200, state);
            }
            await coordinator.refreshBindings();
            const state = await coordinatorPublicState(project, conversationId);
            state.conversationId = conversationId;
            state.conversations = await conversationsFor(project).list();
            const memory = await readMemoryProject(configuredMemory, project.id);
            const allowedNodes = configuredMemory.projects[project.id].coordinator.nodeIds;
            state.nodeReferences = (memory.main?.memory?.map?.root ? [...entries(memory.main.memory.map.root).values()] : [])
              .map(entry => entry.node).filter(node => node.proposal !== 'cancelled' && (!allowedNodes || allowedNodes.includes(node.id)))
              .map(node => ({ id: node.id, title: node.title }));
            state.eventError = coordinator.inbox.lastError;
            const { store, principal } = interfaceProject(project);
            state.sessionCreations = (await store.sessionCreations(principal)).slice(-100);
            state.projectTasks = (await store.projectTasks(principal)).filter(item => item.conversationId === conversationId);
            state.sessionTemplates = [];
            for (const id of configuredMemory.projects[project.id].coordinator.sessionTemplates || []) {
              if (!Object.hasOwn(coordinator.bindings, id)) continue;
              const binding = await store.registeredBinding(principal, id);
              if (binding) state.sessionTemplates.push({ id, name: binding.name || 'Claude 开发环境' });
            }
            state.acceptances = [];
            // Main is the human's general conversation. Keep item cards in their
            // owner conversation, but let an explicit chat verdict find a unique
            // pending review without making the human hunt for that conversation.
            if (conversationId === 'main') state.reviewCandidates = [];
            for (const sessionId of Object.keys(coordinator.bindings)) {
              const binding = await store.registeredBinding(principal, sessionId);
              if (!binding) continue;
              const session = { id: sessionId, generation: binding.generation };
              for (const task of await store.workflowTasks(principal, session)) {
                if (task.stage !== 'awaiting-merge' || task.ci?.verdict !== 'passed') continue;
                if (conversationId === 'main') state.reviewCandidates.push({ taskId: task.id, sessionId, ci: task.ci });
                if (await conversationsFor(project).owner(sessionId, task.id) !== conversationId) continue;
                const read = async ref => (await store.handle(principal, { v: 2, id: randomUUID(), type: 'object.read', session, payload: ref })).data.content;
                state.acceptances.push({ taskId: task.id, sessionId, sourceSha: task.sourceSha, ci: task.ci,
                  brief: await read(task.brief), result: await read({ ref: task.ci.ref, version: task.ci.version }) });
              }
            }
            for (const approval of state.approvals) {
              if (!approval.brief) continue;
              if (approval.projectTask) {
                const task = (await store.projectTasks(principal)).find(item => item.taskId === approval.taskId);
                approval.pending = task?.stage === 'brief' && task.brief.version === approval.brief.version;
                continue;
              }
              const binding = await store.registeredBinding(principal, approval.sessionId);
              const task = binding && await store.taskRecord(principal, { id: approval.sessionId, generation: binding.generation }, approval.taskId);
              approval.pending = !!task && task.stage === 'brief' && task.brief.ref === approval.brief.ref && task.brief.version === approval.brief.version;
            }
            return send(res, 200, state);
          }
          if (req.method === 'POST') return send(res, 202, await submitCoordinator(project, conversationId, await requestBody(req),
            browserToken && safeEqual(decodedCookieValue(req), browserToken) ? { source: 'human', actor: { kind: 'human', sessionId: 'browser-human' } } : {}));
        }
        if (action === '/api/coordinator/interrupt' && project && req.method === 'POST') {
          const input = await requestBody(req);
          if (!input || Object.keys(input).some(key => !['id', 'expectedTurnId'].includes(key))) protocolFail('INVALID_ARGUMENT', 'Provide a stable stop ID and active turn identity');
          return send(res, 202, await (await coordinatorFor(project, conversationId)).interrupt(input));
        }
        if (action === '/api/coordinator/mount-review' && project && req.method === 'POST') {
          requireHumanWorkbench(req);
          const coordinator = await coordinatorFor(project, conversationId), input = await requestBody(req);
          const result = await coordinator.reviewMount(input, (proposals, operationId) => commitMainMemoryMap(configuredMemory, project.id, {
            operationId, baseVersion: proposals[0].mainVersion,
            operations: proposals.map(proposal => ({ type: 'create', parentId: proposal.parentId,
              node: { id: `NCM${digest(proposal.id).slice(0, 20)}`, title: proposal.title, purpose: proposal.purpose,
                kind: 'module', state: 'untested', owns: proposal.owns, proposal: 'accepted' } })),
          }));
          void coordinator.inbox.pump();
          return send(res, 200, result);
        }
        if (action === '/api/coordinator/binding-review' && project && req.method === 'POST') {
          requireHumanWorkbench(req);
          const input = await requestBody(req);
          const result = await bindingsFor(project).review(input, { conversationId,
            actor: { kind: 'human', sessionId: 'browser-human' } });
          return send(res, 200, { ...result, notification: await notifyBindingReviews(project, conversationId, await coordinatorFor(project, conversationId)) });
        }
        if (action === '/api/coordinator/approval' && project && req.method === 'POST') {
          const input = await requestBody(req), coordinator = await coordinatorFor(project, conversationId);
          if ((await conversationsFor(project).get(conversationId)).executionMode === 'manual') {
            if (!input || Object.keys(input).some(key => !['id', 'proposalId', 'decision', 'reason', 'version'].includes(key))) protocolFail('INVALID_ARGUMENT', 'Unexpected approval fields');
            return send(res, 200, await reviewManualBrief(project, conversationId, input, { kind: 'human', sessionId: 'browser-human' }));
          }
          if (!input || Object.keys(input).some(key => !['id', 'proposalId', 'decision', 'reason'].includes(key))) protocolFail('INVALID_ARGUMENT', 'Unexpected approval fields');
          const proposal = (await coordinator.state()).approvals.find(value => value.id === input.proposalId && value.brief);
          if (!proposal) protocolFail('NOT_FOUND', 'Requirement approval is not available');
          const { store, principal } = interfaceProject(project);
          if (proposal.projectTask) {
            const result = await store.reviewProjectTask(principal, proposal.taskId, proposal.brief, input);
            kickTaskScheduler(project);
            return send(res, 200, result);
          }
          const binding = await store.registeredBinding(principal, proposal.sessionId);
          if (!binding) protocolFail('NOT_FOUND', 'Session is not registered');
          const message = validateMessage({ v: 2, id: input.id, type: 'review.result',
            session: { id: proposal.sessionId, generation: binding.generation },
            payload: { kind: 'brief', ref: proposal.brief.ref, version: proposal.brief.version, decision: input.decision,
              reason: (configuredMemory.projects[project.id].coordinator.simulated ? '[模拟人工确认] ' : '') + (input.reason || '') } });
          return send(res, 200, (await store.handle(principal, message)).data);
        }
        if (action === '/api/coordinator/acceptance' && project && req.method === 'POST') {
          const coordinator = await coordinatorFor(project, conversationId);
          await coordinator.refreshBindings();
          const input = await requestBody(req);
          if (!input || Object.keys(input).some(key => !['id', 'sessionId', 'taskId', 'ref', 'version', 'decision', 'reason'].includes(key)) ||
              !Object.hasOwn(coordinator.bindings, input.sessionId)) protocolFail('INVALID_ARGUMENT', 'Select an assigned task and exact CI result');
          const { store, principal } = interfaceProject(project), binding = await store.registeredBinding(principal, input.sessionId);
          if (!binding) protocolFail('NOT_FOUND', 'Session is not registered');
          const session = { id: input.sessionId, generation: binding.generation }, task = await store.taskRecord(principal, session, input.taskId);
          if (conversationId !== 'main' && await conversationsFor(project).owner(input.sessionId, input.taskId) !== conversationId)
            protocolFail('FORBIDDEN', 'Task belongs to another conversation');
          if (task.ci?.ref !== input.ref || task.ci?.version !== input.version || task.ci?.verdict !== 'passed') protocolFail('CONFLICT', 'Acceptance must reference the current passed CI result');
          if (typeof input.reason !== 'string' || !input.reason.trim()) protocolFail('INVALID_ARGUMENT', 'Record the human acceptance result or rejection reason');
          const message = validateMessage({ v: 2, id: input.id, type: 'review.result', session, payload: { kind: 'acceptance', ref: input.ref, version: input.version,
            decision: input.decision, reason: (configuredMemory.projects[project.id].coordinator.simulated ? '[模拟人工验收] ' : '') + input.reason } });
          const result = (await store.handle(principal, message)).data;
          // CI acceptance does not attest a Map version that the human has not reviewed.
          // Session completion is a separate, exact-version human action.
          return send(res, 200, result);
        }
        if (action === '/api/state' && req.method === 'GET') {
          const state = await scopedWorkbenchState(scope, project, viewId);
          return send(res, 200, { ...state, actor: { kind: 'human', sessionId: 'cloud-workbench' }, grants: state.doc?.root ? [...entries(state.doc.root).keys()] : [] }, workbenchCookie());
        }
        if (action === '/api/events' && req.method === 'GET') {
          const client = { scope: `${scope}|${viewId}`, res }; workbenchClients.add(client);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...workbenchCookie() });
          res.write(`retry: 1000\nevent: state\ndata: ${JSON.stringify(await scopedWorkbenchState(scope, project, viewId))}\n\n`);
          req.on('close', () => workbenchClients.delete(client)); return;
        }
        if (action === '/api/access' && req.method === 'GET') {
          if (!project) return send(res, 200, { sessions: [], grants: {}, currentSessionId: null });
          const sessions = await memorySessions(project), grants = {};
          const memory = configuredMemory?.projects?.[project.id] ? await readMemoryProject(configuredMemory, project.id) : null;
          for (const session of sessions) {
            const map = memory.sessions[session.id]?.memory?.map || memory.main?.memory?.map;
            grants[session.id] = { nodes: map?.root ? [...entries(map.root).keys()] : [] };
          }
          return send(res, 200, { sessions, grants, currentSessionId: null, project: { id: project.id, kind: 'git', main: { status: 'ready' } } });
        }
        if (action === '/api/access' && req.method === 'POST') {
          throw new MapError('ACCESS_EDIT_REQUIRED', 'Cloud permission changes must be made explicitly on the node; the Session is not auto-authorized', 409);
        }
        if (action === '/api/task-review' && req.method === 'POST') {
          if (!project || viewId !== 'main') throw new MapError('MAIN_REQUIRED', 'Review the task in the Main workbench', 409);
          const input = reviewInput(await requestBody(req));
          const { principal, store } = interfaceProject(project);
          const task = await store.humanTaskResult(principal, input.sessionId, input.taskId);
          for (let attempt = 0; ; attempt++) {
            const snapshot = await mainMemorySnapshot(project);
            if (!snapshot?.document?.root) throw new MapError('NOT_FOUND', 'Main is unavailable', 404);
            const result = reviewOperations(snapshot.document, input, task);
            if (!result.operations.length) return send(res, 200, { operationId: input.operationId, review: result.review });
            try {
              await commitMainMemoryMap(configuredMemory, project.id, { operationId: `task-review:${input.operationId}`, baseVersion: snapshot.version, operations: result.operations });
              await broadcastWorkbench(scope, project, viewId);
              return send(res, 200, { operationId: input.operationId, review: result.review });
            } catch (error) { if (error.code !== 'VERSION_CONFLICT' || attempt >= 2) throw error; }
          }
        }
        if (action === '/api/review-feedback' && req.method === 'GET') {
          if (!project || viewId !== 'main') throw new MapError('MAIN_REQUIRED', 'Feedback belongs to the project Main', 409);
          const snapshot = await mainMemorySnapshot(project);
          if (!snapshot?.document?.root) throw new MapError('NOT_FOUND', 'Main is unavailable', 404);
          return send(res, 200, { version: snapshot.version, items: pendingReviewFeedback(snapshot.document) });
        }
        if (action === '/api/task-status' && req.method === 'POST') {
          if (!project) throw new MapError('PROJECT_REQUIRED', 'Select a project before reading tasks', 409);
          const input = await requestBody(req);
          if (!Array.isArray(input.tasks) || input.tasks.length > 100) throw new MapError('INVALID_ARGUMENT', 'tasks must be an array of at most 100 items', 400);
          const { principal, store } = interfaceProject(project), tasks = [];
          for (const item of input.tasks) {
            const sessionId = compactText(item?.sessionId, 128), taskId = compactText(item?.taskId, 128);
            const binding = sessionId && await store.registeredBinding(principal, sessionId);
            if (!binding || !taskId) continue;
            try { tasks.push(await store.taskStatus(principal, { id: sessionId, generation: binding.generation }, taskId)); }
            catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
          }
          const projectTasks = viewId === 'main' ? await store.projectTaskStatuses(principal) : [];
          return send(res, 200, { tasks, projectTasks });
        }
        if (action === '/api/publication' && req.method === 'GET') {
          if (!project) return send(res, 200, { status: 'unavailable', reason: 'PROJECT_REQUIRED' });
          return send(res, 200, await publicationState(project, viewId));
        }
        if (action === '/api/publication' && req.method === 'POST') {
          if (!project || !viewId.startsWith('session:')) throw new MapError('SESSION_REQUIRED', 'Automatic publication requires a Session Map', 409);
          const status = await publicationState(project, viewId, { refresh: true });
          if (status.status !== 'ready') throw new MapError(status.reason || 'PUBLICATION_UNAVAILABLE', 'Session is not ready for automatic Main publication', 409);
          return send(res, 200, await publishSessionMemory(configuredMemory, project.id, {
            operationId: `automatic-main:${status.sessionId}:${status.generation}:${status.mainSha}`,
            baseVersion: status.baseVersion,
            sessionId: status.sessionId,
            sessionVersion: status.sessionVersion,
            expectedMainSha: status.mainSha,
          }, { kind: 'automation', sessionId: status.sessionId }));
        }
        if (action === '/api/session-completion' && req.method === 'POST') {
          if (!project || !viewId.startsWith('session:')) throw new MapError('SESSION_REQUIRED', 'Complete the reviewed Session Map', 409);
          const input = await requestBody(req);
          if (!input || Object.keys(input).some(key => !['operationId', 'sessionId', 'generation', 'sessionVersion', 'sourceCommit'].includes(key)) || input.sessionId !== viewId.slice('session:'.length)) throw new MapError('INVALID_COMPLETION', 'Completion must target the displayed Session', 400);
          return send(res, 200, await completeSessionMemory(configuredMemory, project.id, input, { kind: 'human', sessionId: 'cloud-workbench' }));
        }
        if (action === '/api/presence' && req.method === 'POST') {
          const input = await requestBody(req), state = await scopedWorkbenchState(scope, project, viewId);
          return send(res, 200, { version: state.version, synchronized: input.version === state.version && !input.dirty, error: null, recovery: false });
        }
        if (action === '/api/commit' && req.method === 'POST') {
          const input = await requestBody(req);
          if (viewId.startsWith('session:')) {
            const result = await commitSessionMap(configuredMemory, project.id, viewId.slice('session:'.length), input);
            await broadcastWorkbench(scope, project, viewId);
            return send(res, 200, result);
          }
          if (project) {
            // Persist intake's initial cursor without starting the model: a
            // provider failure must not prevent the human from saving work.
            if (configuredMemory?.projects?.[project.id]?.coordinator?.enabled) await mapIntakeFor(project).initialize();
            const result = await commitMainMemoryMap(configuredMemory, project.id, input, undefined, { preserveStoredDispatch: true });
            await broadcastWorkbench(scope, project, viewId);
            return send(res, 200, result);
          }
          return send(res, 200, await commitOverview(input));
        }
        if (action === '/api/projections' && req.method === 'POST') return send(res, 200, { status: 'ready', sourceVersion: (await scopedWorkbenchState(scope, project, viewId)).version });
        throw new MapError('NOT_FOUND', 'Unsupported cloud workbench route', 404);
      }
      if (route === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, service: 'context-guard-cloud', protocol: 3, release, ...(privateAccess ? {} : { projects: registry.projects.length }) });
      if (route === '/.codex/context/preferences.json' && req.method === 'GET') { requirePrivateRead(req, url); return send(res, 200, { display_language: 'zh' }); }
      if (route === '/.codex/context/map.json' && req.method === 'GET') {
        requirePrivateRead(req, url);
        const page = String(req.headers.referer || '').match(/\/projects\/([^/?#]+)/);
        if (!page) return send(res, 200, (await workbenchSnapshot('overview', null)).document);
        const project = projectById(decodeURIComponent(page[1]));
        if (!project) throw new MapError('NOT_FOUND', 'Project is missing', 404);
        const snapshot = await projectSnapshot(project);
        return send(res, 200, snapshot.document || placeholderProjectDocument(project));
      }
      if (route === '/api/events' && req.method === 'GET') {
        requirePrivateRead(req, url);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        directoryClients.add(res); res.write('retry: 1000\nevent: ready\ndata: {}\n\n'); req.on('close', () => directoryClients.delete(res)); return;
      }
      if (route === '/api/projects' && req.method === 'GET') { requirePrivateRead(req, url); return send(res, 200, { projects: registry.projects.map(publicProject) }); }
      if (route === '/api/projects' && req.method === 'POST') {
        requireAdmin(req, url);
        const rawToken = newToken(), project = compactProject(await requestBody(req), digest(rawToken));
        await mutateRegistry(() => {
          if (projectById(project.id)) throw new MapError('PROJECT_EXISTS', 'Project already exists', 409);
          registry.projects.push(project);
        });
        broadcastDirectory('projects', { projectId: project.id });
        return send(res, 201, { project: publicProject(project), syncToken: rawToken });
      }
      const projectRoute = route.match(/^\/api\/projects\/([^/]+)(?:\/(map|snapshot|commits|events|changes|enrollments|work\/prepare|work\/finish|work\/checkpoint))?$/);
      if (projectRoute) {
        const project = projectById(decodeURIComponent(projectRoute[1]));
        if (!project) throw new MapError('NOT_FOUND', 'Project is missing', 404);
        const action = projectRoute[2];
        if (!action && req.method === 'GET') { requirePrivateRead(req, url); return send(res, 200, { project: publicProject(project) }); }
        if (action === 'enrollments' && req.method === 'POST') {
          requireAdmin(req, url); const syncToken = newToken();
          await updateRegistryProject({ id: project.id, tokenHash: digest(syncToken), updatedAt: now() });
          return send(res, 201, { projectId: project.id, syncToken });
        }
        if (action === 'map' && req.method === 'GET') { if (privateAccess) { const credential = bearer(req); if (!(adminToken && safeEqual(credential, adminToken)) && !(project.tokenHash && safeEqual(digest(credential), project.tokenHash))) requirePrivateRead(req, url); } return send(res, 200, await projectSnapshot(project)); }
        requireProject(req, url, project);
        if (action === 'snapshot' && req.method === 'POST') return send(res, 200, await saveSnapshot(project, await requestBody(req)));
        if (action === 'commits' && req.method === 'POST') {
          const input = await requestBody(req);
          return send(res, 200, await commitProject(project, input, { kind: 'sync', sessionId: String(input.sessionId || '') }));
        }
        if (action === 'changes' && req.method === 'GET') {
          const after = Math.max(0, Number(url.searchParams.get('after') || 0));
          const events = (await readEvents(project.id)).filter(event => event.seq > after);
          return send(res, 200, { projectId: project.id, after, cursor: events.at(-1)?.seq || after, events });
        }
        if (action === 'events' && req.method === 'GET') {
          const after = Math.max(0, Number(url.searchParams.get('after') || req.headers['last-event-id'] || 0));
          // Register under the same queue as commits: no event may fall between
          // the historical read and the live subscription.
          await serial(project.id, async () => {
            const events = (await readEvents(project.id)).filter(event => event.seq > after);
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            res.write('retry: 1000\n\n'); for (const event of events) res.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`);
            const clients = projectClients.get(project.id) || new Set(); clients.add(res); projectClients.set(project.id, clients);
            res.on('close', () => clients.delete(res));
          });
          return;
        }
        if (action === 'work/prepare' && req.method === 'POST') {
          const input = await requestBody(req);
          const result = await serial(project.id, async () => {
            await recoverTransactions(project.id);
            const workId = String(input.workId || randomUUID());
            if (!/^[\w:.-]{8,160}$/.test(workId)) throw new MapError('INVALID_WORK_ID', 'Use a stable workId (8–160 characters)');
            const existing = await readJson(workFile(project.id, workId), null);
            if (existing) return existing;
            const snapshot = await projectSnapshot(project);
            const scope = normalizeScope(input.scope);
            if (!scope.nodeIds.length && !scope.paths.length) scope.wildcard = true;
            const event = await createEvent(project.id, { type: 'work.started', workId, actor: { kind: 'agent', sessionId: String(input.sessionId || '') }, version: snapshot.version, scope });
            const work = { workId, projectId: project.id, sessionId: String(input.sessionId || ''), status: 'working', baseSeq: event.seq, baseVersion: snapshot.version, scope, startedAt: event.at };
            await persistTransaction({
              v: 1, scope: `work:${project.id}`, operationId: workId, event,
              work: { projectId: project.id, workId, previousDigest: null, next: work },
            });
            broadcastEvent(event);
            return work;
          });
          return send(res, 200, result);
        }
        if ((action === 'work/checkpoint' || action === 'work/finish') && req.method === 'POST') {
          const input = await requestBody(req), workId = String(input.workId || '');
          const result = await serial(project.id, async () => {
            await recoverTransactions(project.id);
            const work = await readJson(workFile(project.id, workId), null);
            if (!work) throw new MapError('WORK_NOT_FOUND', 'Prepare this development window first', 404);
            if (work.status === 'completed') return work.result;
            const requestedScope = normalizeScope(input.scope);
            const scope = scopeOfOperations(input.operations || [], {
              nodeIds: [...work.scope.nodeIds, ...requestedScope.nodeIds],
              fields: requestedScope.fields,
              paths: [...work.scope.paths, ...requestedScope.paths],
              wildcard: work.scope.wildcard || requestedScope.wildcard,
            });
            const impacts = await impactsSince(project, work.baseSeq, scope, workId);
            if (action === 'work/checkpoint') return { workId, status: impacts.length ? 'conflict' : 'working', impacts, cursor: await currentSeq(project.id) };
            if (impacts.length) {
              work.status = 'conflict'; work.impacts = impacts; work.checkedAt = now(); await atomicWrite(workFile(project.id, workId), json(work));
              throw new MapError('WORK_IMPACT', 'Remote changes overlap this development window', 409, { workId, impacts });
            }
            const current = await projectSnapshot(project);
            let document = current.document, version = current.version, nodeIds = [];
            if (input.operations?.length) {
              const applied = applyOperations(current.document || emptyProjectDocument(project), input.operations, { kind: 'human', sessionId: work.sessionId });
              validate(applied.doc); document = applied.doc; version = versionOf(document); nodeIds = applied.resultIds;
            }
            const event = await createEvent(project.id, { type: 'work.completed', workId, operationId: input.operationId || `finish:${workId}`, actor: { kind: 'agent', sessionId: work.sessionId }, baseVersion: current.version, version, operations: input.operations || [], scope });
            const completed = { workId, projectId: project.id, status: 'completed', version, seq: event.seq, nodeIds, completedAt: event.at, rebased: current.version !== work.baseVersion };
            const nextWork = { ...work, status: 'completed', result: completed, completedAt: event.at };
            await persistTransaction({
              v: 1, scope: `work:${project.id}`, operationId: `finish:${workId}`, event,
              ...(document ? { map: { target: 'project', projectId: project.id, previousVersion: current.version, next: { projectId: project.id, version, seq: event.seq, document, updatedAt: event.at } } } : {}),
              work: { projectId: project.id, workId, previousDigest: digest(JSON.stringify(work)), next: nextWork },
              registryProject: { id: project.id, status: 'connected', updatedAt: event.at },
            });
            broadcastEvent(event);
            await broadcastWorkbench(`project:${project.id}`, project); return completed;
          });
          return send(res, 200, result);
        }
      }
      const assetMatch = req.method === 'GET' && /^\/assets\/([a-f0-9]{16})\/(.+)$/.exec(route);
      if (assetMatch) {
        requirePrivateRead(req, url);
        const asset = assetMatch[1] === assetVersion && workbenchAssets.get(assetMatch[2]);
        if (!asset) throw new MapError('NOT_FOUND', 'Unknown asset version or path', 404);
        res.writeHead(200, { 'Content-Type': asset.contentType, 'Cache-Control': 'private, max-age=31536000, immutable', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' });
        return res.end(asset.body);
      }
      if (req.method === 'GET' && /\/(map-model|map-graph-view|map-translations|workbench-sync|attachments|coordinator-markdown|coordinator-working-blot|marked)\.mjs$/.test(route)) {
        requirePrivateRead(req, url);
        const source = await fs.readFile(path.join(root, path.basename(route) === 'map-model.mjs' ? 'scripts/shared' : path.basename(route) === 'marked.mjs' ? 'prototype/vendor' : 'prototype', path.basename(route)));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(source);
      }
      if (req.method === 'GET' && /\/workbench-(?:app|data)\.js$/.test(route)) {
        requirePrivateRead(req, url);
        const source = await fs.readFile(path.join(root, 'prototype', path.basename(route)));
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(source);
      }
      if (req.method === 'GET' && /\/workbench\.css$/.test(route)) {
        requirePrivateRead(req, url);
        const source = await fs.readFile(path.join(root, 'prototype', path.basename(route)));
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(source);
      }
      if (req.method === 'GET' && /\/working-blot-atlas\.png$/.test(route)) {
        requirePrivateRead(req, url);
        const source = await fs.readFile(path.join(root, 'prototype/working-blot-atlas.png'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); return res.end(source);
      }
      if (req.method === 'GET' && (route === '/' || route === '/prototype/' || route === '/workbench.html' || /^\/projects\/[^/]+$/.test(route))) {
        if (privateAccess && browserPasswordHash && !hasWorkbenchAccess(req, url)) return redirect(res, `/login?next=${encodeURIComponent(`${route}${url.search}`)}`);
        requirePrivateRead(req, url);
        if (/^\/projects\//.test(route) && !projectById(decodeURIComponent(route.slice('/projects/'.length)))) throw new MapError('NOT_FOUND', 'Project is missing', 404);
        const projectId = /^\/projects\//.test(route) ? decodeURIComponent(route.slice('/projects/'.length)) : null;
        const scope = projectId ? `projects/${encodeURIComponent(projectId)}` : 'overview';
        const config = JSON.stringify({ root: `cloud:${projectId || 'overview'}`, protocol: 3, apiBase: `/api/workbench/${scope}`, interfaceCapabilities: { deviceAuthorization: !!projectId && !!deviceAuthorization && !!interfaceConfig?.repositories?.find(item => item.projectId === projectId), sessionCompletion: !!projectId && !!configuredMemory?.projects?.[projectId], attachments: !!projectId && !!configuredMemory?.projects?.[projectId] && !!attachments, taskDispatch: !!projectId && !!interfaceConfig, humanReview: !!projectId && !!interfaceConfig, mapTranslations: !!configuredMemory?.projects?.[projectId]?.coordinator?.enabled, coordinator: !!configuredMemory?.projects?.[projectId]?.coordinator?.enabled } }).replace(/</g, '\\u003c');
        const marker = `<script>window.__CG_SERVER=${config};</script>`;
        const html = workbenchHtml.replace('<!-- CG_SERVER_BOOT -->', marker);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
        return res.end(html);
      }
      throw new MapError('NOT_FOUND', 'Unknown route', 404);
    } catch (error) {
      if (!res.headersSent) send(res, error.status || 500, { error: { code: error.code || 'INTERNAL_ERROR', message: error.message, ...(error.details || {}) } }, req.complete ? {} : { Connection: 'close' }); else res.end();
    }
  };
  const server = http.createServer((req, res) => {
    if (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding']) {
      req.setTimeout(15_000, () => req.destroy());
      req.once('end', () => req.setTimeout(0));
    }
    if (stopping) return send(res, 503, { error: { code: 'SERVER_CLOSING', message: 'Server is shutting down' } });
    const pending = handleRequest(req, res);
    activeRequests.add(pending);
    pending.finally(() => activeRequests.delete(pending)).catch(() => {});
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.requestTimeout = 10 * 60_000;
  server.headersTimeout = 15_000;
  integrationGateway = await startIntegrationGateway({ config: integrations,
    stateDir: path.join(dataDir, 'integration-gateway'), command: integrationCommand,
    authorizeProject: authorizeIntegrationProject,
    logger: ({ code, idHash, phase, causeCode, durationMs }) => console.warn('Context Guard integration failure', { code, idHash, phase, causeCode, durationMs }),
    state: async (scope, { actor }) => {
      const project = await integrationProject(scope.projectId);
      await requireIntegrationConversation(project, scope.conversationId, actor);
      return integrationPublicState(project, scope.conversationId, actor);
    } });
  const heartbeat = setInterval(() => {
    for (const client of workbenchClients) if (!client.res.destroyed) client.res.write(': heartbeat\n\n');
    for (const set of projectClients.values()) for (const res of set) if (!res.destroyed) res.write(': heartbeat\n\n');
    for (const res of directoryClients) if (!res.destroyed) res.write(': heartbeat\n\n');
  }, 15_000); heartbeat.unref();
  const presenceExpiry = setInterval(() => {
    const changedProjects = new Set(), currentTime = Date.now();
    for (const item of interfacePresence.values()) {
      if (item.online && cloudSessionPresence(item.lastHeartbeatAt, currentTime) === 'offline') {
        item.online = false;
        if (item.projectId) changedProjects.add(item.projectId);
      }
    }
    for (const projectId of changedProjects) {
      const project = projectById(projectId);
      if (project) broadcastWorkbenchAccess(project);
    }
  }, 5000); presenceExpiry.unref();
  const publicationTimer = setInterval(publishMergedSessions, 30_000); publicationTimer.unref();
  const taskScheduler = setInterval(() => {
    for (const project of registry.projects) kickTaskScheduler(project);
  }, 5000); taskScheduler.unref();
  const initialPublication = setTimeout(publishMergedSessions, 0); initialPublication.unref();
  try {
    await attachments?.start();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  } catch (error) {
    stopping = true;
    clearInterval(heartbeat); clearInterval(presenceExpiry); clearInterval(publicationTimer); clearInterval(taskScheduler); clearTimeout(initialPublication);
    stopMemoryEvents();
    await integrationGateway?.close(); await attachments?.close();
    throw error;
  }
  for (const project of registry.projects) {
    if (configuredMemory?.projects?.[project.id]?.coordinator?.enabled) {
      void recoverInterruptedTasks(project).catch(cause => console.error(`[context-guard] interrupted-task recovery deferred: ${cause.message}`));
      void conversationsFor(project).list().then(async items => {
      const services = await Promise.all(items.map(item => coordinatorFor(project, item.id)));
      // Start the first inbox pump immediately. This is what discovers durable
      // interrupted tasks after a Cloud restart; the interval remains as the
      // liveness fallback for later events.
      await Promise.all(services.map(service => service.inbox.pump()));
      }).catch(cause => console.error(`[context-guard] coordinator startup deferred: ${cause.message}`));
    }
  }
  let closing;
  const close = () => closing ||= new Promise((resolve, reject) => {
    stopping = true;
    const integrationShutdown = integrationGateway?.close();
    integrationShutdown?.catch(() => {});
    clearInterval(heartbeat);
    clearInterval(presenceExpiry);
    clearInterval(publicationTimer);
    clearInterval(taskScheduler);
    clearTimeout(initialPublication);
    const coordinatorShutdown = (async () => {
      await integrationShutdown;
      await Promise.all([...cursorServices.values()].map(service => service.close()));
      await Promise.all([...coordinators.values()].map(async pending => {
        const service = await pending.catch(() => null);
        if (!service) return;
        await service.inbox.close(); await service.close({ stop: true });
      }));
    })();
    coordinatorShutdown.catch(() => {});
    stopMemoryEvents();
    for (const res of interfaceStreams) res.end();
    for (const res of directoryClients) res.end();
    for (const client of workbenchClients) client.res.end();
    for (const set of projectClients.values()) for (const res of set) res.end();
    server.close(error => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      // Closing sockets does not finish async handlers or their Git children.
      // Drain owned work before callers remove repositories and data files.
      else Promise.all([integrationShutdown, coordinatorShutdown, automaticPublicationRunning, ...activeRequests]).then(() => attachments?.close()).then(resolve, reject);
    });
    server.closeIdleConnections?.();
    const forceClose = setTimeout(() => {
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
    }, 250);
    forceClose.unref();
  });
  return { server, close, url: `http://${host}:${server.address().port}`, integrationUrl: integrationGateway?.url || null };
}

async function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url)); }
  catch { return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
}

if (await invokedDirectly()) {
  const instance = await startCloudServer();
  process.stdout.write(`Context Guard Cloud listening on ${instance.url}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await instance.close(); process.exit(0); });
}
