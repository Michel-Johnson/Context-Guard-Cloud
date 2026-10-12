import path from 'node:path';
import { atomicWrite, encode, hash, readJSON, withFileLock } from '../shared/io.mjs';
import { entries, MapError } from '../shared/map-model.mjs';
import { buildFilesystemV2 } from '../shared/filesystem-v2.mjs';
import { coordinatorNodePath, coordinatorPathText } from '../shared/coordinator-path.mjs';

export const MANUAL_DISABLED_TOOLS = Object.freeze(['dispatch_task', 'review_plan', 'request_ci', 'request_rework', 'resume_task', 'guide_task', 'complete_task']);
export const filterManualTools = tools => tools.filter(tool => !MANUAL_DISABLED_TOOLS.includes(tool.name)).map(tool => {
  if (tool.name === 'edit_map') {
    const result = { ...tool, description: '更新、移动或删除已存在的 Main 节点及 TODO/Bug。新节点必须先用 propose_mount 取得人类确认，不通过本工具直接创建。修改记忆前先用 read_map 读取目标原文，保留无关内容。' };
    const actions = tool.input_schema?.properties?.actions, item = actions?.items, memory = item?.properties?.memoryDocument;
    if (memory) result.input_schema = { ...tool.input_schema, properties: { ...tool.input_schema.properties,
      actions: { ...actions, items: { ...item, properties: { ...item.properties,
        memoryDocument: { ...memory, description: 'Full Markdown document: change only the requested sections and preserve all other sections verbatim. If there is no existing memory, write only applicable confirmed sections; do not fill six sections from guesses or task-local requirements. Use memoryDocument, not a filename such as memoryDocument.md.' },
      } } },
    } };
    return result;
  }
  if (tool.name !== 'prepare_task') return tool;
  const result = { ...tool, description: '整理 brief 供人类确认。新需求及复用旧事项都须已取得本对话主节点绑定确认，nodeIds 只填这个主节点；相关模块按需读取。成功后宿主显示完整审批卡并等待确认，不在聊天重复brief。确认 brief 后保存 Main TODO/Bug 和可粘贴执行提示，不自动派发。' };
  if (tool.input_schema?.properties) {
    const properties = { ...tool.input_schema.properties };
    for (const [field, description] of [
      ['taskId', 'Required task identifier; it does not set the saved Main item ID or title and does not associate an existing TODO/Bug. To reuse an item, provide itemId, nodeId and kind.'],
      ['text', 'For a new TODO, the first line becomes the Main item title (up to 200 characters). Put the user-requested title there, followed by the complete requirements on subsequent lines. An existing TODO/Bug keeps its current title; do not claim this brief renames it.'],
      ['itemId', 'To reuse an existing TODO/Bug, copy its exact Main item ID here and also provide nodeId and kind. Omit for a new TODO in a project conversation. An item-focused conversation may inherit its trusted item only when itemId, nodeId and kind are all omitted; partial routing is rejected.'],
      ['nodeId', 'For an existing item, copy its owning Main node ID and include it in nodeIds. This is required with itemId.'],
      ['kind', '事项类型：todo 或 bug。新事项使用人类已确认的主节点及类型；新 Bug 不必提供 itemId。修改已有 Bug 须提供 itemId 和 nodeId；kind=bug 不能创建 TODO。'],
    ]) if (properties[field]) properties[field] = { ...properties[field], description };
    result.input_schema = { ...tool.input_schema, properties };
  }
  return result;
});
export function coordinatorRolePrompt(source, { manual = false } = {}) {
  const markers = [...source.matchAll(/^## 人工对话模式[ \t]*(?=\r?$)/gm)];
  const heading = markers[0]?.index ?? -1;
  // Older installations/custom role guides retain the existing compatibility
  // behavior. A declared but empty/ambiguous profile is a configuration error.
  if (heading < 0) return source + (manual ? '\n本对话采用人工执行模式：讨论、读取和编辑 Map；prepare_task 只生成待人工确认的 brief。人确认后保存 Main TODO/Bug 和可粘贴执行提示，不创建、派发或恢复执行 Session。保持当前对话继续讨论。' : '');
  const profile = source.slice(heading + markers[0][0].length).trim();
  if (!profile || markers.length !== 1) {
    throw new MapError('INVALID_COORDINATOR_PROFILE', 'Coordinator manual role profile is empty or ambiguous', 503);
  }
  const boundary = heading - (source.slice(0, heading).endsWith('\r\n') ? 2 : heading ? 1 : 0);
  const common = source.slice(0, source.indexOf('## 开始工作') >= 0 ? source.indexOf('## 开始工作') : boundary).trim();
  return manual ? `${common}\n\n${profile}\n` : source.slice(0, boundary);
}
const fail = (code, message, status = 400) => { throw new MapError(code, message, status); };
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
const workItemIdentity = item => item.instanceId || item.createdAt || item.id;
const snapshotDocument = snapshot => snapshot.document || snapshot.map || snapshot.memory?.map;
const allowedActor = actor => actor && actor.kind === 'human' && typeof actor.sessionId === 'string' && actor.sessionId;
const publicProposal = proposal => ({ id: proposal.id, version: proposal.version, brief: { ref: `manual-brief:${proposal.id}`, version: proposal.version },
  taskId: proposal.itemId, nodeId: proposal.nodeId, itemId: proposal.itemId, kind: proposal.kind, text: proposal.text, acceptance: proposal.acceptance,
  nodeIds: proposal.nodeIds, mainVersion: proposal.mainVersion, requiresHumanApproval: true, manual: true, pending: !proposal.review,
  ...(proposal.pathText ? { pathText: proposal.pathText } : {}),
  ...(proposal.review ? { decision: proposal.review.decision, review: { ...proposal.review,
    result: Object.fromEntries(Object.entries(proposal.review.result).filter(([key]) => key !== 'prompt')) } } : {}) });

function verifiedBriefSource(snapshot, projectId, input) {
  const source = snapshot.source || null;
  if (source && (source.projectId !== projectId || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository || '') || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(source.commit || ''))) {
    fail('SOURCE_IDENTITY_INVALID', '服务器源码身份不完整，请先核对仓库及完整提交号。', 409);
  }
  const text = input.text + '\n' + input.acceptance;
  const claims = [...text.matchAll(/(?:sourceCommit|sourceSha|mainSha|源码提交|基线提交|代码提交|完整提交号|commit\s+SHA)\s*["'`]*\s*[:：=]\s*["'`]*([^\s"'`]+)/giu)];
  if (claims.some(match => !source || match[1] !== source.commit)) fail('SOURCE_IDENTITY_MISMATCH', 'Brief 的源码提交与服务器核验值不一致；请删除手抄值，由宿主填入完整源码身份。', 409);
  for (const [labels, expected] of [
    ['源码仓库|repository', source?.repository], ['项目标识|projectId', projectId], ['Main 版本|Map 版本|mainVersion', snapshot.version],
  ]) {
    const pattern = new RegExp('(?:' + labels + ')["\x27`]*\\s*[:：=]\\s*["\x27`]*([^\\s"\x27`]+)', 'giu');
    if ([...text.matchAll(pattern)].some(match => !expected || match[1] !== expected)) fail('SOURCE_IDENTITY_MISMATCH', 'Brief 的项目、仓库或 Map 版本与当前服务器身份不一致。', 409);
  }
  return source && structuredClone(source);
}

export function manualBriefInput(input, { allowNewBug = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.text !== 'string' || !input.text.trim() || input.text.length > 8000 ||
      typeof input.acceptance !== 'string' || !input.acceptance.trim() || input.acceptance.length > 4000 ||
      typeof input.mainVersion !== 'string' || !input.mainVersion || input.mainVersion.length > 128 ||
      !Array.isArray(input.nodeIds) || input.nodeIds.length !== 1 || input.nodeIds.some(id => !identifier(id)) ||
      new Set(input.nodeIds).size !== input.nodeIds.length || input.nodeId !== undefined && !identifier(input.nodeId) ||
      input.itemId !== undefined && !identifier(input.itemId) || input.kind !== undefined && !['todo', 'bug'].includes(input.kind)) fail('INVALID_ARGUMENT', 'Provide a brief, acceptance criteria, Main version and exact node IDs');
  if (input.itemId && (!input.nodeId || !input.kind)) fail('INVALID_ARGUMENT', 'An existing item requires its node and TODO/Bug kind');
  if (input.kind === 'bug' && !input.itemId && !allowNewBug) fail('INVALID_ARGUMENT', '新 Bug 必须先确认主节点；修改已有 Bug 须提供 itemId 和 nodeId，taskId 不能代替事项身份。');
  return { text: input.text.trim(), acceptance: input.acceptance.trim(), mainVersion: input.mainVersion, nodeIds: [...input.nodeIds],
    nodeId: input.nodeId || input.nodeIds[0], ...(input.itemId ? { itemId: input.itemId, kind: input.kind } : { kind: input.kind || 'todo' }) };
}

export function manualExecutionPrompt({ projectId, proposal, document, version, mapOnly = false }) {
  const index = entries(document.root);
  const projection = buildFilesystemV2({ version, memory: { map: document, records: {} } });
  const navigation = JSON.parse(projection.files.get('map.json'));
  const selected = proposal.nodeIds.map(id => {
    const node = index.get(id)?.node;
    if (!node) fail('VERSION_CONFLICT', 'Brief node is no longer available', 409);
    const nodeFile = navigation.nodes.find(item => item.id === id)?.path;
    const memoryPath = id === document.root.id ? 'memory.md' : nodeFile?.replace(/index\.md$/, 'memory.md');
    return [`### ${node.title} (${node.id})`, node.purpose || '',
      `节点阅读路径（Main scope）：${nodeFile}`, ...(projection.files.has(memoryPath) ? [`记忆阅读路径：${memoryPath}`, node.memoryDocument] : []),
      ...(node.owns?.length ? [`代码范围：${node.owns.join(', ')}`] : [])].filter(Boolean).join('\n\n');
  }).join('\n\n');
  const itemFile = navigation.nodes.find(node => node.id === proposal.nodeId)?.path.replace(/index\.md$/, `${proposal.kind === 'bug' ? 'bugs' : 'todos'}/${proposal.itemId}.md`);
  const connectionText = proposal.cloudOrigin ? `\n\n## Cloud 连接\n\nCloud 地址：${proposal.cloudOrigin}\nCloud 项目标识：${projectId}\n\n在实际代码仓库中，用宿主提供的真实 Session ID，按已安装 Skill 的 workbench connect --url ${proposal.cloudOrigin} --root <实际仓库根目录> --session <真实SessionID> --wait 流程申请连接，由用户打开验证地址并登录、授权。这里只提供公开入口，不包含账号、密码、设备令牌，也不代表已经授权；回读确认已连接的项目标识及 Main 版本后再开始开发。` : '\n\n## Cloud 连接\n\n服务器未配置公开连接地址。交给新会话前由用户确认 Cloud 地址并按 Skill 的正常连接流程完成授权；不猜地址、不索要密码，也不把本地空 Map 当作 Cloud 基线。';
  const sourceText = proposal.source ? `\n\n## 已核验源码\n\n源码仓库：${proposal.source.repository}\n源码提交：${proposal.source.commit}\n\n克隆 https://github.com/${proposal.source.repository}.git 后，先用 git cat-file -e ${proposal.source.commit}^{commit} 核对提交可用，再核对本地 HEAD。源码或 Map 基线不一致时停止准备，按现有基线确认流程由用户决定，不忽略差异、不覆盖未提交改动，也不自行发布分支。` : '\n\n## 源码准备\n\n当前没有已核验的源码提交。交给新 Agent 前先确认代码仓库、可获取的完整提交号及 Map 基线；确认前不把任何手抄提交号当作权威，不开始代码开发。';
  if (mapOnly) return `# 执行需求\n\n项目：${document.project}\n工作项：${proposal.kind.toUpperCase()} ${proposal.itemId}\nMap 版本：${version}\n\n## 目标\n\n${proposal.text}\n\n## 验收\n\n${proposal.acceptance}\n\n## Map 切片\n\n${selected}\n\n## 执行边界\n\n这是 Map 项目的需求交接，不代表已经关联代码仓库或执行 Session。以上格式路径仅说明切片结构，不能作为此项目已接通的 CLI/API 读取入口。请由用户确定实际代码仓库后，在该仓库使用已安装的 Skill 确认项目与 Session 绑定；绑定前不写入其他项目的 Session，不自动派发。收工时核对 Map 总览中此项目的最新内容。\n`;
  return `# 执行需求\n\n项目：${projectId}\n工作项：${proposal.kind.toUpperCase()} ${proposal.itemId}\nMain 版本：${version}${sourceText}${connectionText}\n\n## 目标\n\n${proposal.text}\n\n## 验收\n\n${proposal.acceptance}\n\n## Map 切片\n\n${selected}\n\n## 读写路径\n\n- 阅读 Main 的 map.json、上述节点 index.md，以及工作项 ${itemFile}。这些是 fs-v2.1 scope-relative 读取路径，通过 Context Guard 的按版本单文件读取入口使用，不能当作宿主的绝对磁盘路径。\n- 在用户当前打开的项目根目录调用已安装的 Context Guard Skill；Codex、Cursor、Claude 使用同一个工作项 ID。按现有绑定流程确认自己的 Session 身份及最新 Main 版本，不能把 Coordinator 对话 ID 当作执行 Session ID。\n- 若 Main 版本变化，刷新相关切片并核对需求；无法核对时报告冲突，不覆盖新内容。\n- 只把代码结果、attempt 结论、验收证据和受影响节点写入自己的 Session；使用现有 Skill/hooks 的 Session 写回入口，不直接覆盖 Main。\n- 执行结束后汇报工作项 ID、Session ID、改动和验收证据，交由用户在工作台审核后进入 Main。\n`;
}

// Proposals are conversational state, not a second Task system. Approval uses
// the same Main CAS callback as the workbench and never creates an Agent Session.
export class CoordinatorManualBriefs {
  constructor({ directory, projectId, readMain, commitMain, mapOnly = false, readBinding = null, readCommitReceipt = null, canReuseCancelledExecution = null, verifySource = null, cloudOrigin = null }) {
    if (!path.isAbsolute(directory || '') || !identifier(projectId) || typeof readMain !== 'function' || typeof commitMain !== 'function') throw new Error('Manual brief storage and Main services are required');
    if (canReuseCancelledExecution !== null && typeof canReuseCancelledExecution !== 'function') throw new Error('Execution verification must be a function');
    if (verifySource !== null && typeof verifySource !== 'function') throw new Error('Source verification must be a function');
    if (cloudOrigin !== null) {
      const url = new URL(cloudOrigin);
      if (url.origin !== cloudOrigin || url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Cloud handoff requires an exact HTTPS or loopback origin without credentials');
    }
    Object.assign(this, { projectId, readMain, commitMain, mapOnly, readBinding, readCommitReceipt, canReuseCancelledExecution, verifySource, cloudOrigin });
    this.file = path.join(directory, 'manual-briefs.json');
  }
  async state() { return readJSON(this.file, { proposals: {}, operations: {}, reviews: {} }); }
  async approvals(conversationId) {
    const binding = this.readBinding ? await this.readBinding(conversationId) : null;
    const snapshot = await this.readMain(), nodes = entries(snapshotDocument(snapshot).root);
    return Object.values((await this.state()).proposals).filter(proposal => proposal.conversationId === conversationId).map(proposal => {
      const value = publicProposal(proposal);
      const stale = proposal.bindingApproval && (proposal.bindingApproval !== binding?.bindingApproval ||
        proposal.nodeId !== binding?.nodeId || proposal.kind !== binding?.kind);
      const item = nodes.get(proposal.nodeId)?.node?.[proposal.kind === 'bug' ? 'bugs' : 'todos']?.find(item => item.id === proposal.itemId);
      const superseded = value.decision === 'approved' && (item?.approvedBrief?.proposalId !== proposal.id || item.approvedBrief.version !== proposal.version ||
        proposal.source && JSON.stringify(proposal.source) !== JSON.stringify(snapshot.source));
      return stale && value.pending || superseded ? { ...value, pending: false, stale: true } : value;
    });
  }
  async acknowledgeNotification(proposalId, conversationId) {
    return withFileLock(this.file + '.lock', async () => {
      const state = await this.state(), proposal = state.proposals[proposalId];
      if (!proposal || proposal.conversationId !== conversationId || !proposal.review) fail('NOT_FOUND', 'Reviewed brief is unavailable', 404);
      proposal.review.notified = true;
      await atomicWrite(this.file, encode(state));
    });
  }
  async assertReusable(item, routing) {
    if (item.status === 'processing') fail('ACTIVE_EXECUTION', '该事项正在执行，不能转入人工执行。', 409);
    if (['done', 'resolved', 'unfixable'].includes(item.status)) fail('CONFLICT', '该事项已结束，请先核对原事项状态。', 409);
    if (!item.dispatch?.session_id) return;
    if (!['cancelled', 'closed'].includes(item.dispatch.status)) fail('ACTIVE_EXECUTION', '该事项仍有执行任务，不能转入人工执行。', 409);
    // Map 中的结束标签不足以释放任务；可信服务须核对权威任务及执行槽。
    if (!this.canReuseCancelledExecution || await this.canReuseCancelledExecution(item, routing) !== true) {
      fail('EXECUTION_NOT_RELEASED', '尚不能确认旧执行任务已释放。', 409);
    }
  }
  async prepare(input, { operationId, conversationId, actor } = {}) {
    if (!identifier(operationId) || !identifier(conversationId)) fail('INVALID_ARGUMENT', 'Provide stable proposal and conversation IDs');
    const binding = this.readBinding ? await this.readBinding(conversationId) : null;
    const value = manualBriefInput(input, { allowNewBug: !!binding?.bindingApproval });
    if (this.readBinding && (!binding?.bindingApproval || binding.nodeId !== value.nodeId || binding.kind !== value.kind)) {
      fail('APPROVAL_REQUIRED', '先由人类确认本需求的唯一主节点和事项类型，再整理 brief。', 409);
    }
    const fingerprint = hash(JSON.stringify({ value, conversationId }));
    const id = `manual-${hash(JSON.stringify([this.projectId, conversationId, operationId]))}`;
    return withFileLock(this.file + '.lock', async () => {
      const state = await this.state(), previous = state.proposals[id];
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('ID_REUSED', 'Proposal ID belongs to a different brief', 409);
        return publicProposal(previous);
      }
      const snapshot = await this.readMain(), document = snapshotDocument(snapshot);
      if (snapshot.version !== value.mainVersion) fail('VERSION_CONFLICT', 'Main changed; refresh the brief before proposing', 409);
      const source = this.mapOnly ? null : verifiedBriefSource(snapshot, this.projectId, value);
      if (source && this.verifySource && await this.verifySource(source) !== true) fail('SOURCE_COMMIT_UNAVAILABLE', '源码提交无法从已配置远端取得；先由用户确认可获取的源码基线，再准备交接。', 409);
      const index = entries(document.root);
      if ([...value.nodeIds, value.nodeId].some(nodeId => !index.has(nodeId))) fail('NOT_FOUND', 'A brief node is missing', 404);
      if (!value.nodeIds.includes(value.nodeId)) fail('INVALID_ARGUMENT', 'The work-item node must be included in the brief scope');
      let identity = null;
      if (value.itemId) {
        const matches = (index.get(value.nodeId).node[value.kind === 'bug' ? 'bugs' : 'todos'] || []).filter(item => item.id === value.itemId);
        if (matches.length !== 1) fail('CONFLICT', 'The TODO/Bug is missing or ambiguous', 409);
        const item = matches[0];
        await this.assertReusable(item, value);
        identity = workItemIdentity(item);
      }
      const proposal = { id, fingerprint, projectId: this.projectId, conversationId, operationId, ...value,
        ...(source ? { source } : {}),
        ...(this.cloudOrigin ? { cloudOrigin: this.cloudOrigin } : {}),
        itemId: value.itemId || `${value.kind === 'bug' ? 'B' : 'TD'}${hash(id).slice(0, 24)}`, itemIdentity: identity,
        ...(binding ? { bindingApproval: binding.bindingApproval } : {}),
        pathText: coordinatorPathText(coordinatorNodePath(document.root, value.nodeId)),
        createdAt: new Date().toISOString(), ...(actor ? { actor: structuredClone(actor) } : {}) };
      proposal.version = hash(JSON.stringify({ ...value, itemId: proposal.itemId, itemIdentity: identity, bindingApproval: proposal.bindingApproval, ...(source ? { source } : {}), ...(proposal.cloudOrigin ? { cloudOrigin: proposal.cloudOrigin } : {}) }));
      state.proposals[id] = proposal;
      await atomicWrite(this.file, encode(state));
      return publicProposal(proposal);
    });
  }
  async review(input, { operationId, conversationId, actor } = {}) {
    if (!identifier(operationId) || !identifier(conversationId) || !allowedActor(actor) || !input ||
        !identifier(input.proposalId) || !['approved', 'rejected'].includes(input.decision) || typeof input.version !== 'string' ||
        typeof (input.reason ?? '') !== 'string' || (input.reason || '').length > 2000) fail('INVALID_ARGUMENT', 'Review the exact brief version with a verified human actor');
    const fingerprint = hash(JSON.stringify({ input: { proposalId: input.proposalId, version: input.version, decision: input.decision, reason: input.reason || '' }, conversationId, actor }));
    return withFileLock(this.file + '.lock', async () => {
      const state = await this.state(), proposal = state.proposals[input.proposalId];
      if (!proposal || proposal.conversationId !== conversationId) fail('NOT_FOUND', 'Brief is unavailable in this conversation', 404);
      if (proposal.version !== input.version) fail('VERSION_CONFLICT', 'Review references an old brief version', 409);
      if (state.reviews[operationId]) {
        if (state.reviews[operationId].fingerprint !== fingerprint) fail('ID_REUSED', 'Review ID belongs to another request', 409);
        return state.reviews[operationId].result;
      }
      if (proposal.review) {
        if (proposal.review.fingerprint !== fingerprint) fail('CONFLICT', 'Brief has already been reviewed differently', 409);
        return proposal.review.result;
      }
      if (proposal.intent && proposal.intent.fingerprint !== fingerprint) fail('CONFLICT', 'A different review is already being committed', 409);
      const approvedAt = proposal.intent?.at || new Date().toISOString();
      let receipt, prompt;
      if (input.decision === 'approved') {
        if (!proposal.intent) {
          if (proposal.bindingApproval) {
            const binding = await this.readBinding?.(conversationId);
            if (binding?.bindingApproval !== proposal.bindingApproval || binding.nodeId !== proposal.nodeId || binding.kind !== proposal.kind) {
              fail('VERSION_CONFLICT', '主节点已改绑，这份 brief 已过期；请按当前归属重新整理。', 409);
            }
          }
          const snapshot = await this.readMain(), document = snapshotDocument(snapshot);
          if (snapshot.version !== proposal.mainVersion) fail('VERSION_CONFLICT', 'Main changed after the brief; refresh before confirming', 409);
          if (!this.mapOnly) {
            const source = verifiedBriefSource(snapshot, this.projectId, proposal);
            if (JSON.stringify(source) !== JSON.stringify(proposal.source || null)) fail('VERSION_CONFLICT', '源码基线已变化，请重新整理并确认 brief。', 409);
            if (source && this.verifySource && await this.verifySource(source) !== true) fail('SOURCE_COMMIT_UNAVAILABLE', '源码提交已无法从远端取得，保留原提案并先确认基线。', 409);
          }
          const node = entries(document.root).get(proposal.nodeId)?.node;
          if (!node) fail('VERSION_CONFLICT', 'The brief node was removed', 409);
          const field = proposal.kind === 'bug' ? 'bugs' : 'todos', list = node[field] || [];
          const matches = list.filter(item => item.id === proposal.itemId);
          if (proposal.itemIdentity && (matches.length !== 1 || workItemIdentity(matches[0]) !== proposal.itemIdentity)) fail('VERSION_CONFLICT', 'Work item identity changed after the brief', 409);
          if (proposal.itemIdentity) await this.assertReusable(matches[0], proposal);
          if (!proposal.itemIdentity && matches.length) fail('CONFLICT', 'New TODO identity is already in use', 409);
          const approval = { proposalId: proposal.id, version: proposal.version, mainVersion: proposal.mainVersion,
            text: proposal.text, acceptance: proposal.acceptance, actor: structuredClone(actor), approvedAt, executionMode: 'manual', ready: true };
          const item = proposal.itemIdentity ? { ...matches[0], approvedBrief: approval, executionMode: 'manual' } : { id: proposal.itemId,
            title: proposal.text.split('\n')[0].slice(0, 200), description: proposal.text, status: proposal.kind === 'bug' ? 'open' : 'pending', createdAt: approvedAt, approvedBrief: approval };
          item.executionMode = 'manual';
          const operations = [{ type: 'update', id: node.id, fields: { [field]: proposal.itemIdentity
            ? list.map(value => value.id === proposal.itemId ? item : value) : [...list, item] } }];
          const projected = structuredClone(document);
          entries(projected.root).get(node.id).node[field] = operations[0].fields[field];
          proposal.intent = { fingerprint, at: approvedAt, actor, operationId: `manual-review:${hash(JSON.stringify([this.projectId, proposal.id]))}`,
            baseVersion: snapshot.version, operations, document: projected };
          // Persist before Main commit so retry after a crash reuses the exact
          // operation, actor and CAS version instead of creating another TODO.
          await atomicWrite(this.file, encode(state));
        }
        const intent = proposal.intent;
        const request = { operationId: intent.operationId, baseVersion: intent.baseVersion, operations: intent.operations };
        receipt = this.readCommitReceipt ? await this.readCommitReceipt(request, intent.actor) : null;
        if (!receipt && proposal.bindingApproval) {
          const binding = await this.readBinding?.(conversationId);
          if (binding?.bindingApproval !== proposal.bindingApproval || binding.nodeId !== proposal.nodeId || binding.kind !== proposal.kind) {
            fail('VERSION_CONFLICT', '主节点已改绑，原操作未确认提交；保留回执记录，不向旧节点写入。', 409);
          }
        }
        if (!receipt && proposal.itemIdentity) {
          const snapshot = await this.readMain();
          const node = entries(snapshotDocument(snapshot).root).get(proposal.nodeId)?.node;
          const item = node?.[proposal.kind === 'bug' ? 'bugs' : 'todos']?.find(value => value.id === proposal.itemId);
          if (!item || workItemIdentity(item) !== proposal.itemIdentity) fail('VERSION_CONFLICT', 'Work item identity changed before commit', 409);
          await this.assertReusable(item, proposal);
        }
        try {
          receipt ||= await this.commitMain(request, intent.actor);
        } catch (error) {
          if (error.code === 'VERSION_CONFLICT') { delete proposal.intent; await atomicWrite(this.file, encode(state)); }
          throw error;
        }
        prompt = manualExecutionPrompt({ projectId: this.projectId, proposal, document: intent.document, version: receipt.version, mapOnly: this.mapOnly });
      }
      const result = { decision: input.decision, proposalId: proposal.id, itemId: proposal.itemId, nodeId: proposal.nodeId,
        kind: proposal.kind, version: receipt?.version || proposal.mainVersion, ...(prompt ? { prompt } : {}), executionMode: 'manual',
        actor: structuredClone(actor), reviewedAt: approvedAt };
      proposal.review = { fingerprint, decision: input.decision, reason: input.reason || '', actor: structuredClone(actor), result };
      delete proposal.intent;
      state.reviews[operationId] = { fingerprint, result };
      await atomicWrite(this.file, encode(state));
      return result;
    });
  }
  async prompt(proposalId, conversationId) {
    const proposal = (await this.state()).proposals[proposalId];
    if (!proposal || proposal.conversationId !== conversationId) fail('NOT_FOUND', 'Brief is unavailable in this conversation', 404);
    if (proposal.review?.decision !== 'approved') fail('APPROVAL_REQUIRED', 'Confirm the current brief before exporting an execution prompt', 409);
    const snapshot = await this.readMain(), node = entries(snapshotDocument(snapshot).root).get(proposal.nodeId)?.node;
    const item = node?.[proposal.kind === 'bug' ? 'bugs' : 'todos']?.find(value => value.id === proposal.itemId);
    if (item?.approvedBrief?.proposalId !== proposal.id || item.approvedBrief.version !== proposal.version) fail('VERSION_CONFLICT', 'This execution prompt is no longer the current approved brief', 409);
    if (proposal.source) {
      if (JSON.stringify(proposal.source) !== JSON.stringify(snapshot.source)) fail('VERSION_CONFLICT', '源码基线已变化，旧执行提示保留为历史；请重新确认当前需求。', 409);
      if (this.verifySource && await this.verifySource(proposal.source) !== true) fail('SOURCE_COMMIT_UNAVAILABLE', '批准版本的源码提交已不可获取；先确认可获取的基线，原提示保持不变。', 409);
    }
    return { text: proposal.review.result.prompt, filename: `context-guard-${proposal.kind}-${proposal.itemId}.md` };
  }
}
