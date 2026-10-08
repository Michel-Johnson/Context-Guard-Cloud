import { plainText, plainChunks } from './plain-text.mjs';

export const plain = (text, length = 2000) => ({ type: 'plain_text', text: String(text || '—').slice(0, length) });
export const escape = text => String(text || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const section = text => ({ type: 'section', text: { type: 'mrkdwn', text: String(text || '—').slice(0, 2900) } });
export const textSections = text => { const value = String(text || '—'); return Array.from({ length: Math.ceil(value.length / 2800) }, (_, index) => section(value.slice(index * 2800, (index + 1) * 2800))); };
export const plainSections = text => plainChunks(text).map(value => ({ type: 'section', text: plain(value, 2800) }));
export const button = (label, action, value, style) => ({ type: 'button', text: plain(label, 75), action_id: action, value: JSON.stringify(value), ...(style ? { style } : {}) });
export function modelChoiceBlocks(menu) {
  const selected = menu.options.find(option => option.id === menu.selectedId);
  const route = menu.currentRoute;
  const actual = route ? `\n本卡展示轮次的实际模型（${route.kind === 'vision' ? '图片' : '文字'}）：${route.model || '服务端未提供模型名称'}${route.providerId ? ` · ${route.providerId}` : ''}` :
    menu.status === 'applied' ? '\n本卡仅记录原操作回执，不推测当前轮次的实际模型。' : '\n此菜单仅展示项目默认设置，不推测当前轮次的实际模型。';
  const footer = menu.status === 'applied' ? '原选择已确认（历史回执），不代表当前项目默认。请用 /cg model 查看当前默认文字模型。' :
    '选择后从下一文字轮次生效；当前轮次和原失败重试保留固定模型路由，图片继续使用现有视觉模型。';
  const blocks = plainSections(`项目：${menu.projectName || menu.projectId}\n${menu.status === 'applied' ? '本次已确认的文字模型选择' : '项目默认文字模型'}：${selected?.label || menu.selectedId}${actual}\n已配置模型：${menu.options.map(option => option.label).join('、')}\n\n${footer}`);
  if (menu.status === 'applied') return blocks;
  if (menu.status === 'unchanged') return [...blocks, ...plainSections('当前模型未改变。')];
  if (menu.error) return [...blocks, ...plainSections(`此菜单的选择未确认（${menu.error}），请重新输入 /cg model。`)];
  if (menu.selection) return [...blocks, ...plainSections('正在确认原模型选择结果，请保留当前操作。')];
  if (!menu.userId) return [...blocks, ...plainSections('请由用户在 Slack 输入 /cg model 打开自己的选择菜单。')];
  const choices = menu.options.filter(option => option.id !== menu.selectedId);
  for (let index = 0; index < choices.length; index += 5) blocks.push({ type: 'actions', elements: choices.slice(index, index + 5).map((option, offset) => ({
    ...button(`切换到 ${option.label}`, `model_select:${index + offset}`, { menuId: menu.id, providerId: option.id }),
    confirm: { title: plain('更换项目默认文字模型', 100), text: plain(`确认选择 ${option.label}？当前轮次和失败重试不切换，图片模型不变。`, 250), confirm: plain('确认'), deny: plain('取消') },
  })) });
  if (!choices.length) blocks.push(...plainSections('当前项目只配置了这一种文字模型。'));
  return blocks;
}
export function projectChoiceBlocks(projects, requestId, direct) {
  const blocks = [section('你好，我可以帮你讨论项目、分析 Bug 和整理任务。先选择这次要聊的项目，选好后我会继续处理刚才的问题。')];
  if (!projects.length) return [...blocks, section('目前没有开放的项目，请管理员在插件配置中开放项目后再试。')];
  blocks.push(section(direct ? '选择后，这个项目将用于你的私聊。' : '选择后，当前频道将关联这个项目；已有关联的线程保持不变。'));
  for (let index = 0; index < projects.length; index += 5) blocks.push({ type: 'actions', elements: projects.slice(index, index + 5).map((project, offset) =>
    button(project.name || project.id, `connect_project:${index + offset}`, { requestId, projectId: project.id })) });
  return blocks;
}
export function nodesOf(map) {
  const nodes = [], seen = new Set();
  const visit = (node, depth = 0) => { if (!node || typeof node !== 'object' || seen.has(node.id)) return; seen.add(node.id); nodes.push({ ...node, depth }); for (const child of node.children || []) visit(child, depth + 1); };
  if (Array.isArray(map?.nodes)) for (const node of map.nodes) visit(node);
  else if (map?.root) visit(map.root);
  else if (map?.tree) visit(map.tree);
  else if (Array.isArray(map)) for (const node of map) visit(node);
  else visit(map);
  return nodes;
}
export function homeView({ projects, project, cloudOrigin, userId }) {
  const blocks = [{ type: 'header', text: plain('Context Guard · 项目 Coordinator') }, section('选择项目后可私聊，或将当前频道关联到一个项目。Main 是长期记忆，Slack 是协作入口。')];
  if (projects.length) blocks.push({ type: 'actions', elements: [{ type: 'static_select', action_id: 'select_project', placeholder: plain('选择项目'), options: projects.slice(0, 100).map(item => ({ text: plain(item.name || item.id, 75), value: item.id })),
    ...(project ? { initial_option: { text: plain(project.name || project.id, 75), value: project.id } } : {}) }] });
  else blocks.push(section('还没有开放的项目。请检查插件网关配置。'));
  if (project) {
    const url = `${cloudOrigin}/projects/${encodeURIComponent(project.id)}`;
    blocks.push(section(`*${escape(project.name || project.id)}*\n<${url}|打开完整 Map>`));
    blocks.push({ type: 'actions', elements: [button('开始对话', 'start_chat', { projectId: project.id, text: '你好，我想和你讨论项目。' }), button('讨论 TODO', 'open_item:todo', { projectId: project.id, kind: 'todo' }), button('讨论 Bug', 'open_item:bug', { projectId: project.id, kind: 'bug' }), button('修改记忆', 'open_memory', { projectId: project.id })] });
    const nodes = nodesOf(project.map);
    blocks.push(section('*节点导航*\n' + nodes.slice(0, 22).map(node => `${'　'.repeat(Math.min(node.depth, 4))}• ${escape(node.title)}`).join('\n')));
    if (nodes.length > 22) blocks.push(section(`还有 ${nodes.length - 22} 个节点，请打开完整 Map。`));
    const items = nodes.flatMap(node => ['todos', 'bugs'].flatMap(field => (node[field] || []).map(item => ({ ...item, nodeId: node.id, kind: field === 'bugs' ? 'bug' : 'todo' }))));
    blocks.push(section('*TODO / Bug*'));
    for (const item of items.slice(0, 12)) blocks.push({ ...section(`${item.kind === 'bug' ? '🐞' : '☐'} ${escape(item.title || item.text)} · ${escape(item.status || 'pending')}`), accessory: button('讨论', 'open_item', { projectId: project.id, nodeId: item.nodeId, itemId: item.id, kind: item.kind }) });
    blocks.push(section('*会话状态*\n' + (project.sessions || []).slice(0, 12).map(session => `${escape(session.name || session.title || '未命名会话')} · ${escape(session.status || session.state || 'unknown')}`).join('\n')));
  }
  blocks.push({ type: 'context', elements: [plain('自动派发暂缓 · 按钮按当前 Main 版本校验')] });
  return { type: 'home', blocks };
}
export function modal({ callback, draftId, title, fields, initial = {} }) {
  return { type: 'modal', callback_id: callback, private_metadata: draftId, title: plain(title, 24), submit: plain('保存'), close: plain('取消'), blocks: fields.map(field => ({ type: 'input', block_id: field.id, label: plain(field.label, 100), optional: !!field.optional,
    ...(field.id === 'project' ? { dispatch_action: true } : {}),
    element: field.options ? { type: 'static_select', action_id: field.id === 'project' ? 'form_project' : 'value', options: field.options.slice(0, 100).map(option => ({ text: plain(option.label, 75), value: option.value })), ...(initial[field.id] ? { initial_option: { text: plain(field.options.find(option => option.value === initial[field.id])?.label, 75), value: initial[field.id] } } : {}) } :
      { type: 'plain_text_input', action_id: 'value', ...(field.multiline ? { multiline: true } : {}), ...(initial[field.id] ? { initial_value: String(initial[field.id]).slice(0, 2900) } : {}), max_length: field.multiline ? 2900 : 500 } })) };
}
export function formValues(view) { return Object.fromEntries(Object.entries(view.state?.values || {}).map(([key, actions]) => [key, Object.values(actions)[0]?.value ?? Object.values(actions)[0]?.selected_option?.value ?? ''])); }
function nodeLinkBlocks(actions, { cloudOrigin, projectId } = {}) {
  let origin;
  try { origin = new URL(cloudOrigin); } catch { return []; }
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password ||
      typeof projectId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(projectId)) return [];
  const nodes = [], seen = new Set();
  for (const action of actions || []) {
    const candidates = action.kind === 'node-navigation' ? [action.node] :
      ['node-references', 'node-tour'].includes(action.kind) ? action.nodes || [] : [];
    for (const node of candidates) {
      if (typeof node?.id !== 'string' || !node.id.trim() || node.id.length > 256 || seen.has(node.id)) continue;
      seen.add(node.id);
      if (nodes.length < 60) nodes.push(node);
    }
  }
  const blocks = Array.from({ length: Math.ceil(nodes.length / 5) }, (_, group) => ({ type: 'actions',
    elements: nodes.slice(group * 5, group * 5 + 5).map((node, offset) => {
      // Use only the authenticated binding and server-resolved ID. Never use
      // a model-supplied URL, project, mrkdwn title or interaction payload.
      const url = new URL(`/projects/${encodeURIComponent(projectId)}`, origin.origin);
      url.searchParams.set('relation', node.id);
      return { type: 'button', text: plain(plainText(node.title) || '打开节点', 75),
        action_id: `map_node:${group * 5 + offset}`, url: url.href };
    }) }));
  if (seen.size > nodes.length) blocks.push({ type: 'context', elements: [plain(`还有 ${seen.size - nodes.length} 个节点入口未展开，请打开完整 Map 查看。`)] },
    { type: 'actions', elements: [{ type: 'button', text: plain('打开完整 Map'), action_id: 'map_all',
      url: new URL(`/projects/${encodeURIComponent(projectId)}`, origin.origin).href }] });
  return blocks;
}
export function messageBlocks(message, key, context) {
  const questions = message.questions || [], open = questions.filter(question => !question.answer);
  // Cloud's question-only projection already supplies the exact joined question
  // text. Render those questions with their own options once, preserving order
  // and answered history. A partial-prefix or genuine prose is not that projection.
  const projectedQuestions = message.questionOnly === true && open.length > 0 &&
    message.text === questions.map(question => question.text).join('\n\n');
  const body = plainText(message.text || '');
  const sameWholeQuestion = questions.length === 1 && body && body === plainText(questions[0].text);
  const blocks = projectedQuestions ? [] : plainSections(message.text || (message.attachments?.length ? '收到附件' : 'Coordinator 回复'));
  const questionControls = question => {
    if (question.options?.length) blocks.push(...plainSections('可参考：\n' + question.options.map(option => `• ${option}`).join('\n')));
    blocks.push(...plainSections('直接在这个线程回复即可，不需要填写表单。'));
  };
  if (projectedQuestions) for (const question of questions) {
    blocks.push(...plainSections(question.text));
    if (!question.answer) questionControls(question);
  }
  blocks.push(...nodeLinkBlocks(message.actions, context));
  for (const menu of context?.modelMenus || []) blocks.push(...modelChoiceBlocks(menu));
  for (const attachment of message.attachments || []) blocks.push({ type: 'context', elements: [plain(`附件：${attachment.filename || attachment.id}`)] });
  if (!projectedQuestions) for (const question of open) {
    if (!sameWholeQuestion) blocks.push(...plainSections(question.text));
    questionControls(question);
  }
  return blocks;
}
export function approvalBlocks(approval, key) {
  const version = approval.version || approval.brief?.version;
  return [...plainSections(`待确认 brief\n${approval.title || approval.text || approval.brief?.text || approval.brief?.summary || '请查看工作台中的 brief'}\n${Array.isArray(approval.acceptance) ? approval.acceptance.join('\n') : approval.acceptance || ''}`),
    { type: 'actions', elements: [button('确认并创建执行提示', 'approve_brief', { key, proposalId: approval.id, version }, 'primary'), button('退回修改', 'reject_brief', { key, proposalId: approval.id, version }, 'danger')] }];
}
