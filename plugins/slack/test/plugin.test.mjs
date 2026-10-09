import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store, threadKey, digest } from '../src/store.mjs';
import { SlackPlugin, envelopeId } from '../src/plugin.mjs';
import { SlackIO, UncertainDelivery } from '../src/slack-io.mjs';
import { Gateway } from '../src/gateway.mjs';
import { homeView, formValues, messageBlocks, approvalBlocks, modelChoiceBlocks } from '../src/views.mjs';
import { plainText, plainChunks } from '../src/plain-text.mjs';
import { activeMentions, explicitlyAddressed } from '../src/mentions.mjs';
import { startIntegrationGateway, integrationActor } from '../../../scripts/cloud/integration-gateway.mjs';
import { CoordinatorService, publicMessages } from '../../../scripts/cloud/coordinator-service.mjs';
import { IntegrationAttachmentStore } from '../../../scripts/cloud/integration-attachments.mjs';
import { CoordinatorModelSettings } from '../../../scripts/cloud/coordinator-model-settings.mjs';
import { coordinatorStep } from '../../../scripts/cloud/coordinator-model.mjs';
import { coordinatorTools, createCoordinatorExecutor } from '../../../scripts/cloud/coordinator-tools.mjs';
import { hash } from '../../../scripts/shared/io.mjs';

const teamId = 'T0BRW7G4Q6P', user = 'U000001', channel = 'C000001', bot = 'U000BOT';
test('Home presents names and states without exposing internal identities', () => {
  const value = { id: 'private-project-id', name: '博客', version: 'a'.repeat(64),
    map: { id: 'internal-root', title: '博客', children: [{ id: 'internal-login', title: '登录',
      bugs: [{ id: 'internal-bug', title: '刷新失败', status: 'open' }], children: [] }] },
    sessions: [{ id: 'internal-session', name: '修复登录', status: 'running' }, { sessionId: 'internal-unnamed-session', status: 'done' }] };
  const view = homeView({ projects: [value], project: value, cloudOrigin: 'https://map.example.com', userId: 'internal-user' });
  const visible = view.blocks.flatMap(block => [block.text?.text, ...(block.elements || []).map(element => element.text?.text || element.text)]).filter(x => typeof x === 'string').join('\n');
  assert.match(visible, /登录/); assert.match(visible, /刷新失败 · open/); assert.match(visible, /修复登录 · running/);
  assert.match(visible, /未命名会话 · done/);
  assert.doesNotMatch(visible, /internal-(root|login|bug|session|unnamed-session|user)|a{64}/);
  const discuss = view.blocks.find(block => block.accessory?.action_id === 'open_item');
  assert.deepEqual(JSON.parse(discuss.accessory.value), { projectId: value.id, nodeId: 'internal-login', itemId: 'internal-bug', kind: 'bug' });
  const selector = view.blocks.find(block => block.type === 'actions').elements[0];
  assert.equal(selector.type, 'external_select');
  assert.equal(selector.initial_option.value, value.id);
  assert.equal(selector.min_query_length, 0);
});

test('Explicitly requested technical identities remain intact in Coordinator text and confirmation payloads', () => {
  const text = 'Bug ID 是 B399679682924，节点 ID 是 BLOG-ENG-SCRIPTS。';
  assert.equal(messageBlocks({ text }, 'thread')[0].text.text, text);
  const blocks = approvalBlocks({ id: 'proposal-internal', version: 'main-version', text: '修复刷新失败' }, 'thread');
  assert.deepEqual(JSON.parse(blocks.at(-1).elements[0].value), { key: 'thread', proposalId: 'proposal-internal', version: 'main-version' });
});

test('Map preview hides the Main hash but retains a version-specific block identity', async t => {
  const f = await fixture(t), version = 'b'.repeat(64), url = 'https://map.example.com/projects/lab';
  const original = f.gateway.command;
  f.gateway.command = async (type, args) => type === 'project.read' ? { ...structuredClone(project), version } : original(type, args);
  await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.unfurl('preview-event', { user, channel, message_ts: '1.0', links: [{ url }] });
  const block = f.sent.find(call => call.method === 'chat.unfurl').input.unfurls[url].blocks[0];
  assert.equal(block.text.text, '*Lab*\n2 个 Map 节点 · Main');
  assert.doesNotMatch(block.text.text, /b{64}/);
  assert.equal(block.block_id, `map-preview:${digest(['preview-event', channel, '1.0', url, version])}`);
  assert.ok(block.block_id.length <= 255);
  f.gateway.command = async (type, args) => type === 'project.read' ? { ...structuredClone(project), version: 'c'.repeat(64) } : original(type, args);
  await f.plugin.unfurl('preview-event-next', { user, channel, message_ts: '2.0', links: [{ url }] });
  assert.notEqual(f.sent.at(-1).input.unfurls[url].blocks[0].block_id, block.block_id);
});

test('native current mentions exclude inline code, code blocks and quoted history', () => {
  assert.deepEqual(activeMentions('> <@UOTHER> quoted\n`<@UINLINE>`\n```\n<@UFENCE>\n```\n<@UACTIVE>'), ['UACTIVE']);
  assert.equal(explicitlyAddressed({ type: 'app_mention', ts: '123.1', text: `> <@${bot}>` }, bot), false);
  assert.equal(explicitlyAddressed({ type: 'message', text: `<@${bot}|Coordinator> hi` }, bot), true);
});

test('Coordinator prose is plain text while links code and identifiers remain readable', () => {
  const source = '# 首页\n\n**定位**：`BLOG-READ-HOME`，_公开首页_。\n\n- [完整 Map](https://map.example.com/a?q=1&x=2)\n- ~~旧描述~~\n\n```js\nconst value = 2 ** 3; // _literal_\n```\n\n| 字段 | 值 |\n| --- | --- |\n| 状态 | 正常 |';
  const value = plainText(source);
  assert.match(value, /首页\n\n定位：BLOG-READ-HOME，公开首页/);
  assert.match(value, /完整 Map（https:\/\/map.example.com\/a\?q=1&x=2）/);
  assert.match(value, /const value = 2 \*\* 3; \/\/ _literal_/);
  assert.match(value, /字段：状态；值：正常/);
  assert.doesNotMatch(value, /```|\*\*定位|~~|\[完整 Map\]|^#/m);
  assert.equal(plainText('[不要打开](javascript:alert(1))'), '不要打开');
  assert.equal(plainText('<https://map.example.com/a|查看 Map>'), '查看 Map（https://map.example.com/a）');
  assert.equal(plainText('目录 foo_bar 和 2 * 3 保留'), '目录 foo_bar 和 2 * 3 保留');
  assert.equal(plainText('[接口规范](scripts/shared/references/design/design-interface-v1.2.1.md)'), '接口规范（scripts/shared/references/design/design-interface-v1.2.1.md）');
  assert.equal(plainText('[日志](file:///tmp/run.log)'), '日志（file:///tmp/run.log）');
  assert.equal(plainText('[邮箱](mailto:test@example.com)'), '邮箱（mailto:test@example.com）');
  assert.equal(plainText('`&lt;div&gt; &amp;`'), '&lt;div&gt; &amp;');
  const code = '{"link":"<https://example.com|标题>"}\npayload="""a\n\n\nb"""';
  assert.equal(plainText('```python\n' + code + '\n```'), code);
  assert.equal(plainText('`<https://example.com|标题>`'), '<https://example.com|标题>');
  assert.equal(plainText('| `字段` | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |'), '字段：a；值：1\n字段：b；值：2');
  assert.equal(plainText('[不要打开](java&#x09;script:alert(1))'), '不要打开');
  const blocks = messageBlocks({ text: source }, 'thread');
  assert.ok(blocks.every(block => block.type !== 'section' || block.text.type === 'plain_text'));
  assert.equal(blocks.map(block => block.text?.text || '').join(''), value);
});

test('Slack post and update disable markdown in fallback text and streamed output', async t => {
  const f = await fixture(t), calls = [];
  const io = new SlackIO({ store: f.store, botUserId: bot, wait: async () => {}, client: { async apiCall(method, args) { calls.push({ method, args }); return { ts: '1.0' }; } } });
  await io.post({ id: 'plain-message', channel, text: '**首页**：`BLOG-READ-HOME`' });
  await io.update(channel, '1.0', '**首页**：`BLOG-READ-HOME`');
  for (const call of calls) { assert.equal(call.args.mrkdwn, false); assert.equal(call.args.text, '首页：BLOG-READ-HOME'); }
  await io.update(channel, '1.0', '<@U000001> & 普通文字');
  assert.equal(calls.at(-1).args.text, '&lt;@U000001&gt; &amp; 普通文字');
  assert.equal(calls.at(-1).args.parse, 'none'); assert.equal(calls.at(-1).args.link_names, false);
});

test('Slack card fallback preserves separate paragraphs instead of joining header and model text', async t => {
  const f = await fixture(t), calls = [];
  const io = new SlackIO({ store: f.store, botUserId: bot, wait: async () => {}, client: { async apiCall(method, args) { calls.push({ method, args }); return { ts: '1.0' }; } } });
  const blocks = [
    { type: 'section', text: { type: 'plain_text', text: 'Coordinator 回复' } },
    { type: 'section', text: { type: 'plain_text', text: '当前模型：DeepSeek' } },
    { type: 'actions', elements: [{ type: 'button', action_id: 'open', text: { type: 'plain_text', text: '打开菜单' }, value: 'test' }] },
    { type: 'context', elements: [{ type: 'plain_text', text: '下一轮生效。' }] },
  ];
  await io.post({ id: 'card-spacing', channel, text: 'fallback', blocks });
  await io.update(channel, '1.0', 'fallback', blocks);
  for (const call of calls) {
    assert.equal(call.args.text, 'Coordinator 回复\n\n当前模型：DeepSeek\n\n下一轮生效。');
    assert.deepEqual(call.args.blocks, blocks);
  }
});

test('Slack card fallback renders typed block text once through single and multipart post and update', async t => {
  const literal = '*literal* _API_name_ `value` [path](./api) 2 * 3';
  const formatted = '*标题*：`2 ** 3; _code_`\n<https://example.com/api?v=2|接口>';
  const rendered = '标题：2 ** 3; _code_\n接口（https://example.com/api?v=2）';
  for (const multipart of [false, true]) {
    const f = await fixture(t), calls = [];
    const io = new SlackIO({ store: f.store, botUserId: bot, wait: async () => {}, client: { async apiCall(method, args) {
      calls.push({ method, args }); return { ts: `${calls.length}.0` };
    } } });
    const sections = [
      { type: 'section', text: { type: 'plain_text', text: literal } },
      { type: 'section', text: { type: 'mrkdwn', text: formatted } },
      ...(multipart ? Array.from({ length: 47 }, (_, index) => ({ type: 'section', text: { type: 'plain_text', text: `段落 ${index}` } })) : []),
    ];
    const context = { type: 'context', elements: [
      { type: 'plain_text', text: '*literal context* `API`' },
      { type: 'mrkdwn', text: '*提示*：`*code*`' }, { type: 'mrkdwn', text: '' },
      { type: 'image', image_url: 'https://example.com/image.png', alt_text: 'not message text' },
    ] };
    const blocks = [...sections, { type: 'actions', elements: [{ type: 'button', action_id: 'open', text: { type: 'plain_text', text: '打开' }, value: 'fixture' }] }, context];
    const expected = [literal, rendered, ...sections.slice(2).map(block => block.text.text)];
    const contextText = '*literal context* `API`\n提示：*code*';
    const ts = await io.post({ id: 'typed-fallback', channel, threadTs: '1.0', text: 'unused', blocks });
    const posts = calls.filter(call => call.method === 'chat.postMessage');
    assert.equal(posts.length, multipart ? 2 : 1);
    assert.deepEqual(posts.map(call => call.args.text), multipart ? [expected.join('\n\n'), contextText] : [[...expected, contextText].join('\n\n')]);
    assert.deepEqual(posts.flatMap(call => call.args.blocks), blocks, 'Native blocks and code are not rewritten');
    assert.deepEqual(posts.map(call => call.args.metadata.event_payload.id), multipart ? ['typed-fallback', 'typed-fallback:part:1'] : ['typed-fallback']);
    await io.post({ id: 'typed-fallback', channel, threadTs: '1.0', text: 'unused', blocks });
    assert.equal(calls.length, posts.length, 'Identical contents reuse the acknowledged original receipts');
    const changed = structuredClone(blocks); changed[0].text.text += ' 新值'; changed.at(-1).elements[0].text += ' 新值';
    await io.update(channel, ts, 'unused update', changed);
    const updates = calls.filter(call => call.method === 'chat.update');
    assert.equal(updates.length, multipart ? 2 : 1);
    const next = [literal + ' 新值', rendered, ...expected.slice(2)], nextContext = contextText.replace('*literal context* `API`', '*literal context* `API` 新值');
    assert.deepEqual(updates.map(call => call.args.text), multipart ? [next.join('\n\n'), nextContext] : [[...next, nextContext].join('\n\n')]);
    assert.deepEqual(updates.flatMap(call => call.args.blocks), changed);
    for (const call of calls) { assert.equal(call.args.mrkdwn, false); assert.equal(call.args.parse, 'none'); assert.equal(call.args.link_names, false); }
    assert.equal(f.store.data.outgoing['typed-fallback'].status, 'sent');
    if (multipart) assert.equal(f.store.data.outgoing['typed-fallback:part:1'].status, 'sent');
  }
});

test('Completed node presentations render plain Slack links from the trusted project binding', () => {
  const context = { cloudOrigin: 'https://map.example.com', projectId: 'test-project' };
  const blocks = messageBlocks({ text: '首页负责入口，文章页负责正文。', actions: [
    { kind: 'node-references', nodes: [{ id: 'HOME', title: '**首页**', url: 'https://attacker.example/' }] },
    { kind: 'node-navigation', node: { id: 'POST & 阅读', title: '文章页' } },
    { kind: 'node-tour', nodes: [{ id: 'HOME', title: '重复首页' }, { id: 'LOGIN', title: '<@U000001>' }] },
    { kind: 'node-read', node: { id: 'OTHER', title: '仅读取不展示' } },
  ] }, 'thread', context);
  assert.equal(blocks[0].text.type, 'plain_text');
  const buttons = blocks.filter(block => block.type === 'actions').flatMap(block => block.elements);
  assert.deepEqual(buttons.map(button => button.text.text), ['首页', '文章页', '<@U000001>']);
  assert.equal(new Set(buttons.map(button => button.action_id)).size, 3);
  assert.deepEqual(buttons.map(button => new URL(button.url).searchParams.get('relation')), ['HOME', 'POST & 阅读', 'LOGIN']);
  for (const button of buttons) {
    const url = new URL(button.url);
    assert.equal(url.origin, context.cloudOrigin); assert.equal(url.pathname, '/projects/test-project');
    assert.equal(button.text.type, 'plain_text'); assert.equal(button.value, undefined);
  }
  assert.doesNotMatch(JSON.stringify(blocks), /attacker/);
  const message = { text: '入口', actions: [{ kind: 'node-navigation', node: { id: 'HOME', title: '首页' } }] };
  for (const invalid of [undefined, { ...context, cloudOrigin: 'javascript:alert(1)' },
    { ...context, cloudOrigin: 'https://secret@map.example.com' }, { ...context, projectId: '..' }]) {
    assert.equal(messageBlocks(message, 'thread', invalid).some(block => block.type === 'actions'), false);
  }
  const many = messageBlocks({ text: '入口', actions: [{ kind: 'node-tour', nodes: Array.from({ length: 30 }, (_, index) => ({ id: `N${index}`, title: '标题'.repeat(100) })) }] }, 'thread', context);
  const links = many.filter(block => block.type === 'actions');
  assert.equal(links.flatMap(block => block.elements).length, 30, 'Do not silently omit valid nodes from a multi-tool presentation');
  assert.ok(links.every(block => block.elements.length <= 5));
  assert.ok(links.flatMap(block => block.elements).every(button => button.text.text.length <= 75));
  const overflow = messageBlocks({ text: '段'.repeat(110000), actions: [{ kind: 'node-tour', nodes: Array.from({ length: 70 }, (_, index) => ({ id: `N${index}`, title: `节点${index}` })) }] }, 'thread', context);
  assert.ok(overflow.length > 49, 'Transport splits long presentations instead of dropping their tail');
  assert.equal(overflow.filter(block => block.type === 'actions').flatMap(block => block.elements).filter(button => button.url.includes('relation=')).length, 60);
  assert.ok(overflow.some(block => block.elements?.some(element => element.type === 'plain_text' && element.text.includes('还有 10 个'))));
  assert.equal(overflow.find(block => block.type === 'actions' && block.elements[0].action_id === 'map_all').elements[0].url, 'https://map.example.com/projects/test-project');
});

test('plugin lockfile is portable outside the developer registry', async () => {
  const lock = JSON.parse(await fs.readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
  assert.equal(manifest.engines.node, '>=22.19.0');
  assert.equal(manifest.engines.npm, '>=9.6.4');
  const dependencies = Object.entries(lock.packages).filter(([name]) => name);
  assert.ok(dependencies.length > 0);
  for (const [name, entry] of dependencies) {
    const url = new URL(entry.resolved);
    assert.equal(url.protocol, 'https:', name);
    assert.equal(url.hostname, 'registry.npmjs.org', name);
    assert.equal(url.username + url.password + url.search + url.hash, '', name);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, name);
  }
});
const project = { id: 'lab', name: 'Lab', version: 'v1', map: { id: 'T0', title: 'Root', children: [{ id: 'login', title: '登录', todos: [{ id: 'TD1', title: 'refresh', status: 'pending' }], bugs: [], memories: [{ text: '现有记忆' }], children: [] }] }, sessions: [{ id: 'session-1', status: 'running' }] };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-slack-'));
  const store = await new Store(directory).open(), calls = [], sent = [];
  const receive = store.receive.bind(store);
  // Existing lifecycle cases flush immediately; collection timing has separate
  // tests using the real default deadlines and persisted journal below.
  store.receive = (id, envelope, options = { collectMs: 0, maxCollectMs: 0 }) => receive(id, envelope, options);
  const gateway = { async command(type, args) {
    calls.push({ type, ...args });
    if (type === 'project.list') return { projects: [{ id: 'lab', name: 'Lab' }] };
    if (type === 'project.read') return structuredClone(project);
    if (type === 'conversation.create') return { conversationId: `chat-${args.payload.operationId}` };
    if (type === 'conversation.bind') return { conversationId: args.payload.conversationId };
    if (type === 'conversation.state') return { status: 'idle', messages: [], approvals: [] };
    if (type === 'conversation.relevance') return { respond: true, reason: 'Controlled relevant message', mainVersion: 'v1' };
    if (type === 'attachment.upload') return { id: 'attachment-1' };
    if (type === 'prompt.read') return { text: 'execute login', filename: 'prompt.md' };
    return { accepted: true };
  } };
  const io = { async post(input) { sent.push(input); return String(100 + sent.length) + '.001'; }, async update(...args) { sent.push({ update: args }); }, async call(method, input) { if (['conversations.history', 'conversations.replies'].includes(method)) return { messages: [] }; sent.push({ method, input }); if (method === 'conversations.open') return { channel: { id: 'D000001' } }; if (method === 'conversations.info') return { channel: { user, id: input.channel } }; if (method === 'conversations.members') return { members: [user] }; if (method === 'users.info') return { user: { id: input.user, is_bot: false } }; return {}; },
    async download() { return { filename: 'screen.png', mimeType: 'image/png', base64: 'aGVsbG8=' }; }, async uploadPrompt(input) { sent.push({ export: input }); } };
  const plugin = new SlackPlugin({ store, gateway, io, teamId, cloudOrigin: 'https://map.example.com', botUserId: bot, collectMs: 0, maxCollectMs: 0, logger: { warn() {}, error() {} } });
  t.after(async () => { await plugin.stop(); await fs.rm(directory, { recursive: true, force: true }); });
  return { plugin, store, gateway, io, calls, sent, directory };
}
function event(overrides = {}) { return { type: 'message', user, channel, ts: '123.001', text: `<@${bot}> hello`, ...overrides }; }

test('项目菜单打开后实时搜索；新建、同名和删除选项不使用旧缓存', async t => {
  const f = await fixture(t);
  let projects = [{ id: 'old', name: '旧项目' }];
  f.gateway.command = async (type, args) => {
    assert.equal(type, 'project.list'); assert.equal(args.userId, user);
    assert.equal(args.timeoutMs, 2000); return { projects: structuredClone(projects) };
  };
  const query = { team: { id: teamId }, type: 'block_suggestion', action_id: 'select_project', user: { id: user }, view: { type: 'home' }, value: '' };
  const results = [];
  const receive = async body => f.plugin.receive({ type: 'interactive', body, envelope_id: 'options-request', ack: async value => results.push(value) });
  await receive(query);
  assert.deepEqual(results.at(-1).options.map(option => option.value), ['old']);
  projects = [{ id: 'new-a', name: '博客', description: '第一份博客' }, { id: 'new-b', name: '博客', description: '另一份博客' }];
  await receive({ ...query, value: '博客' });
  assert.deepEqual(results.at(-1).options.map(option => option.value), ['new-a', 'new-b']);
  assert.notEqual(results.at(-1).options[0].description.text, results.at(-1).options[1].description.text);
  projects.shift(); await receive(query);
  assert.deepEqual(results.at(-1).options.map(option => option.value), ['new-b']);
  assert.equal(Object.keys(f.store.data.inbox).length, 0, '查询不创建消息或对话');
});

test('原消息的动态菜单可选择后来新建的项目，但不能替其他人选择或覆盖旧关联', async t => {
  const f = await fixture(t), original = event({ channel: 'D000001', channel_type: 'im' });
  await f.plugin.chooseProject('original-choice', original);
  const entry = f.store.data.inbox['original-choice'], base = { type: 'block_suggestion', team: { id: teamId }, user: { id: user },
    channel: { id: original.channel }, message: { ts: entry.projectPromptTs }, block_id: 'projects:original-choice', action_id: 'connect_project_menu', value: '' };
  const current = f.gateway.command;
  f.gateway.command = (type, args) => type === 'project.list' ? Promise.resolve({ projects: [{ id: 'lab', name: 'Lab' }, { id: 'later', name: '后来新建', private: true }] }) : current(type, args);
  assert.equal((await f.plugin.suggestProjects(base, 'search-new')).length, 2);
  assert.deepEqual(await f.plugin.suggestProjects({ ...base, user: { id: 'UOTHER' } }, 'other-user'), []);
  const body = { ...base, type: 'block_actions', actions: [{ action_id: 'connect_project_menu', block_id: base.block_id, selected_option: { value: 'later' } }] };
  await f.plugin.process('select-later', { type: 'interactive', body });
  assert.equal(f.store.data.preferences[user], 'later');
  assert.equal(f.store.data.inbox['original-choice'].projectResume.projectId, 'later');
  assert.equal(f.store.data.inbox['original-choice'].projectResume.event.ts, original.ts);
  await assert.rejects(f.plugin.connectProject('overwrite', body, user, { requestId: 'original-choice', projectId: 'lab' }, { dynamic: true }),
    { code: 'CONFLICT' });
});

test('私有 Map 项目不在公共频道的按钮或搜索结果中展示，伪造选择也不绑定', async t => {
  const f = await fixture(t);
  f.gateway.command = async () => ({ projects: [{ id: 'lab', name: 'Lab' }, { id: 'private-map', name: '私有项目名称', private: true }] });
  await f.plugin.chooseProject('private-choices', event());
  assert.doesNotMatch(JSON.stringify(f.sent), /私有项目名称|private-map/);
  const query = { type: 'block_suggestion', user: { id: user }, channel: { id: channel }, message: { ts: f.store.data.inbox['private-choices'].projectPromptTs },
    block_id: 'projects:private-choices', action_id: 'connect_project_menu', value: '' };
  assert.deepEqual((await f.plugin.suggestProjects(query, 'public-query')).map(option => option.value), ['lab']);
  await assert.rejects(f.plugin.connectProject('forged-private', query, user, { requestId: 'private-choices', projectId: 'private-map' }, { dynamic: true }), { code: 'CONFLICT' });
  assert.equal(f.store.data.channels[channel], undefined);
});

test('Home 点击过期选项重新校验，不保存已经删除的项目偏好', async t => {
  const f = await fixture(t);
  await f.plugin.loadProjects(user, 'before-delete');
  f.gateway.command = async () => ({ projects: [] });
  await assert.rejects(f.plugin.process('stale-home', { type: 'interactive', body: { user: { id: user },
    actions: [{ action_id: 'select_project', selected_option: { value: 'lab' } }] } }), { code: 'NOT_FOUND' });
  assert.equal(f.store.data.preferences[user], undefined);
});

test('Map-only 项目的 Home 和节点按钮回到原 Map 分支，不生成不存在的仓库页面', () => {
  const value = { id: 'map-internal', name: '博客', mapNodeId: 'N-blog', map: { root: { id: 'N-blog', title: '博客' } } };
  const home = homeView({ projects: [value], project: value, cloudOrigin: 'https://map.example.com' });
  assert.match(JSON.stringify(home), /https:\/\/map.example.com\/\?relation=N-blog/);
  assert.doesNotMatch(JSON.stringify(home), /\/projects\/map-internal/);
  const blocks = messageBlocks({ text: '请查看登录模块', actions: [{ kind: 'node-navigation', node: { id: 'N-login', title: '登录模块' } }] }, 'key',
    { cloudOrigin: 'https://map.example.com', projectId: 'map-internal', mapNodeId: 'N-blog' });
  const link = blocks.find(block => block.type === 'actions').elements[0];
  assert.equal(link.url, 'https://map.example.com/?relation=N-login');
  assert.equal(link.text.text, '登录模块');
});

async function reactionFixture(t, original = event()) {
  const f = await fixture(t), inboxId = envelopeId('events_api', { team_id: teamId, event: original });
  await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.store.receive(inboxId, { type: 'events_api', body: { team_id: teamId, event: original } });
  await f.plugin.runEntry(inboxId, f.store.data.inbox[inboxId]);
  const key = Object.keys(f.store.data.threads)[0], requestId = f.store.data.threads[key].ownRequests[0];
  const actor = { kind: 'human', integration: 'slack', teamId, userId: user, sessionId: `slack:${teamId}:${user}` };
  const input = { role: 'user', requestId, source: 'slack', actor, text: original.text };
  const message = { id: 'native-reaction-message', role: 'assistant', requestId, source: 'slack', actor, text: '',
    actions: [{ kind: 'slack-reaction', actionId: 'native-original-action', status: 'intent', requestId, actor, emoji: 'heart' }] };
  f.gateway.command = async type => type === 'conversation.state' ? { status: 'waiting-for-user', acceptedRequestIds: [requestId], messages: [input, message], approvals: [] } : {};
  f.sent.length = 0;
  return { ...f, key, requestId, input, message };
}
async function settleReactions(plugin) {
  await Promise.allSettled([...plugin.reactions]); await plugin.store.tail;
}
async function stageReactions(plugin, key, message, messages) {
  plugin.drainReactions(new Set(await plugin.queueReactions(key, message, messages)));
}
test('native Slack reaction adds only the chosen emoji and never posts a placeholder', async t => {
  const f = await reactionFixture(t); f.plugin.stopped = false;
  await f.plugin.mirror(f.key); await settleReactions(f.plugin);
  assert.deepEqual(f.sent, [{ method: 'reactions.add', input: { channel, timestamp: '123.001', name: 'heart' } }]);
  assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'sent');
  await f.plugin.mirror(f.key); await settleReactions(f.plugin); assert.equal(f.sent.length, 1);
});
test('native Slack reaction uses real publicMessages projection without inventing a delivery receipt', async t => {
  const f = await reactionFixture(t), state = { activeInput: { id: f.requestId, source: 'slack', actor: f.input.actor }, messages: [{ ...f.input, content: f.input.text }], toolReceipts: {} };
  await coordinatorStep({ turnId: 'trusted-projection', state, system: 'role', tools: coordinatorTools, execute: createCoordinatorExecutor({}), save: async () => {},
    model: { next: async () => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'react', name: 'react_to_user', input: { emoji: 'smile' } }] }) } });
  const projected = publicMessages(state); assert.equal(projected.filter(m => m.actions?.length).length, 1);
  f.gateway.command = async () => ({ status: state.status, acceptedRequestIds: [f.requestId], messages: projected, approvals: [] });
  f.plugin.stopped = false; await f.plugin.mirror(f.key); await settleReactions(f.plugin);
  assert.deepEqual(f.sent, [{ method: 'reactions.add', input: { channel, timestamp: '123.001', name: 'smile' } }]);
});
test('native Slack reaction contract enum stays aligned and necessary emoji text remains intact', async t => {
  const f = await reactionFixture(t); f.plugin.stopped = false;
  const emojis = coordinatorTools.find(tool => tool.name === 'react_to_user').input_schema.properties.emoji.enum;
  assert.deepEqual(emojis, ['thumbsup', 'heart', 'smile', 'clap', 'tada', 'raised_hands', 'thinking_face', 'muscle', 'wave', 'pray']);
  for (const emoji of emojis) {
    const message = structuredClone(f.message); message.actions[0].emoji = emoji; message.actions[0].actionId = emoji;
    await stageReactions(f.plugin, f.key, message, [f.input, message]);
    await settleReactions(f.plugin);
  }
  await settleReactions(f.plugin);
  assert.deepEqual(f.sent.map(call => call.input.name), emojis);
  assert.equal(f.sent.filter(call => call.text || call.update).length, 0, 'All ten reaction-only choices remain free of placeholder text');
  f.message.actions[0].emoji = 'clap';
  f.message.text = '👏 感谢反馈。\n\n仍需人工确认，表情不代表已完成。';
  await f.plugin.mirror(f.key); await settleReactions(f.plugin);
  const post = f.sent.find(call => call.text); assert.match(post.text, /👏 感谢反馈。\n\n仍需人工确认/);
  assert.equal(f.sent.filter(call => call.text || call.update).length, 1);
  assert.equal(f.sent.at(-1).input.name, 'clap', 'Text and a native reaction can coexist without dropping either');
});
test('native Slack reaction never borrows untrusted, other-user, synthetic or partial input', async t => {
  const f = await reactionFixture(t); f.plugin.stopped = false;
  for (const mutate of [m => { m.source = 'human'; }, m => { m.actions[0].actor.userId = 'UOTHER'; },
    m => { m.actions[0].requestId = 'old-request'; }, m => { m.actions[0].emoji = 'white_check_mark'; }, m => { m.partial = true; }]) {
    const message = structuredClone(f.message); mutate(message);
    await stageReactions(f.plugin, f.key, message, [f.input, message]);
  }
  await settleReactions(f.plugin); assert.equal(f.sent.length, 0); assert.equal(Object.keys(f.store.data.reactionOutbox || {}).length, 0);
  await f.store.update(state => { const id = state.reactionInputs[f.requestId].inboxId; state.inbox[id].envelope.body.event.ts = 'command-synthetic'; });
  await stageReactions(f.plugin, f.key, f.message, [f.input, f.message]); await settleReactions(f.plugin);
  assert.equal(f.sent.length, 0);
});
test('native Slack reaction refuses cross-project or thread mappings', async t => {
  const f = await reactionFixture(t); f.plugin.stopped = false;
  for (const [field, value] of [['projectId', 'another-project'], ['conversationId', 'another-chat'], ['key', 'another-thread']]) {
    const original = structuredClone(f.store.data.reactionInputs[f.requestId]);
    await f.store.update(state => { state.reactionInputs[f.requestId][field] = value; });
    await stageReactions(f.plugin, f.key, f.message, [f.input, f.message]); await settleReactions(f.plugin);
    await f.store.update(state => { state.reactionInputs[f.requestId] = original; });
  }
  assert.equal(f.sent.length, 0);
});
test('native Slack reaction in a real collected batch targets the actual first active input, not the final message', async t => {
  const f = await fixture(t), originals = [event(), event({ ts: '123.002', text: `<@${bot}> 补充说明` })];
  await f.store.update(state => { state.channels[channel] = 'lab'; });
  const ids = originals.map(original => envelopeId('events_api', { team_id: teamId, event: original }));
  for (const [index, original] of originals.entries()) await f.store.receive(ids[index], { type: 'events_api', body: { team_id: teamId, event: original } }, { collectMs: 1000, maxCollectMs: 2000 });
  await f.store.update(state => { state.messageBatches[ids[0]].readyAt = 0; });
  await f.plugin.runEntry(ids[0], f.store.data.inbox[ids[0]]);
  const key = Object.keys(f.store.data.threads)[0], requests = f.store.data.threads[key].ownRequests;
  assert.equal(requests.length, 2);
  const actor = { kind: 'human', integration: 'slack', teamId, userId: user, sessionId: `slack:${teamId}:${user}` };
  const inputs = requests.map(requestId => ({ role: 'user', requestId, source: 'slack', actor }));
  const message = { role: 'assistant', source: 'slack', actor, requestId: requests[0], actions: [{ kind: 'slack-reaction', actionId: 'batch-react', status: 'intent', requestId: requests[0], actor, emoji: 'thumbsup' }] };
  f.plugin.stopped = false; await stageReactions(f.plugin, key, message, [...inputs, message]); await settleReactions(f.plugin);
  assert.equal(f.sent.at(-1).input.timestamp, '123.001');
});
test('native Slack reaction persists original target and survives lost acknowledgement and restart', async t => {
  const f = await reactionFixture(t), attempts = []; f.plugin.stopped = false;
  f.io.call = async (method, input) => { attempts.push({ method, input }); throw Object.assign(new Error('may be applied'), { code: 'slack_webapi_platform_error', data: { error: 'internal_error' } }); };
  await f.plugin.mirror(f.key); await settleReactions(f.plugin);
  const [id, record] = Object.entries(f.store.data.reactionOutbox)[0]; assert.equal(record.status, 'unknown');
  await f.plugin.stop(); const reopened = await new Store(f.directory).open();
  const restarted = new SlackPlugin({ ...f.plugin, store: reopened, io: { ...f.io, call: async (method, input) => {
    attempts.push({ method, input }); throw Object.assign(new Error('exists'), { code: 'slack_webapi_platform_error', data: { error: 'already_reacted' } });
  } }, logger: { warn() {}, error() {} } });
  t.after(() => restarted.stop()); await reopened.update(state => { state.reactionOutbox[id].next = 0; }); restarted.stopped = false;
  restarted.drainReactions(); await settleReactions(restarted);
  assert.equal(reopened.data.reactionOutbox[id].status, 'sent'); assert.equal(reopened.data.reactionOutbox[id].attempts, 2);
  assert.deepEqual(attempts[1], attempts[0]); assert.equal(attempts[0].input.timestamp, '123.001');
  const changed = structuredClone(f.message); changed.actions[0].emoji = 'smile';
  await assert.rejects(stageReactions(restarted, f.key, changed, [f.input, changed]), { code: 'ID_REUSED' });
});
test('native Slack permanent rejection and exhausted rate limit stay recorded without blocking text', async t => {
  for (const error of [Object.assign(new Error('scope'), { code: 'slack_webapi_platform_error', data: { error: 'missing_scope' } }),
    Object.assign(new Error('rate exhausted'), { code: 'slack_webapi_rate_limited_error', retryAfter: 10 })]) {
    const f = await reactionFixture(t); f.plugin.stopped = false;
    let calls = 0; f.io.call = async () => { calls++; throw error; }; f.message.text = '请先修复权限；当前没有送达确认。';
    await f.plugin.mirror(f.key); await settleReactions(f.plugin);
    assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'failed');
    assert.ok(f.sent.some(call => call.text?.includes('当前没有送达确认'))); f.plugin.drainReactions(); await settleReactions(f.plugin); assert.equal(calls, 1);
  }
});
test('native Slack unknown outcomes remain bounded to original eight attempts', async t => {
  const f = await reactionFixture(t); f.plugin.stopped = false; let calls = 0;
  f.io.call = async () => { calls++; throw new Error('unknown'); };
  await stageReactions(f.plugin, f.key, f.message, [f.input, f.message]); await settleReactions(f.plugin);
  const id = Object.keys(f.store.data.reactionOutbox)[0];
  for (let attempt = 1; attempt < 10; attempt++) {
    await f.store.update(state => { state.reactionOutbox[id].next = 0; }); f.plugin.drainReactions(); await settleReactions(f.plugin);
  }
  assert.equal(calls, 8); assert.equal(f.store.data.reactionOutbox[id].status, 'attention');
});
test('native Slack eight occupied slots preserve pending intent, suppress superseded work and drain on stop', async t => {
  const f = await reactionFixture(t), releases = []; f.plugin.stopped = false;
  f.io.call = () => new Promise(resolve => releases.push(resolve));
  for (let index = 0; index < 8; index++) f.plugin.readReaction(event({ ts: `123.${index}` }));
  await Promise.resolve();
  await stageReactions(f.plugin, f.key, f.message, [f.input, f.message]);
  assert.equal(f.plugin.reactions.size, 8); assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'pending');
  const partial = { ...f.message, partial: true }; await stageReactions(f.plugin, f.key, partial, [f.input, partial]);
  assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'superseded');
  let finished = false; const stopping = f.plugin.stop().then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); f.plugin.drainReactions(); assert.equal(releases.length, 8);
  for (const release of releases) release({}); await stopping; assert.equal(finished, true);
});
test('native Slack pending intent resumes after saturation without delaying an unrelated text answer', async t => {
  const f = await reactionFixture(t), releases = []; f.plugin.stopped = false;
  f.io.call = (method, input) => input.name === 'eyes' ? new Promise(resolve => releases.push(resolve)) : (f.sent.push({ method, input }), Promise.resolve({}));
  for (let index = 0; index < 8; index++) f.plugin.readReaction(event({ ts: `123.${index}` }));
  f.message.text = '必要正文照常显示。';
  await f.plugin.mirror(f.key); assert.ok(f.sent.some(call => call.text?.includes('必要正文')));
  assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'pending');
  for (const release of releases) release({}); await settleReactions(f.plugin);
  await f.store.update(state => { state.threads[f.key].nextPoll = 0; }); await f.plugin.tick(); await settleReactions(f.plugin);
  assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'sent');
});
test('native Slack tick checks fresh partial state before starting an intent released from eight-slot saturation', async t => {
  const f = await reactionFixture(t), releases = []; f.plugin.stopped = false;
  f.io.call = (method, input) => input.name === 'eyes' ? new Promise(resolve => releases.push(resolve)) : (f.sent.push({ method, input }), Promise.resolve({}));
  for (let index = 0; index < 8; index++) f.plugin.readReaction(event({ ts: `123.${index}` }));
  await f.plugin.mirror(f.key); assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'pending');
  f.message.partial = true;
  for (const release of releases) release({}); await settleReactions(f.plugin);
  await f.store.update(state => { state.threads[f.key].nextPoll = 0; }); await f.plugin.tick(); await settleReactions(f.plugin);
  assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'superseded');
  assert.equal(f.sent.some(call => call.method === 'reactions.add'), false);
});
test('native Slack restart never sends a pending intent before its fresh authoritative state is read', async t => {
  const f = await reactionFixture(t);
  await f.plugin.queueReactions(f.key, f.message, [f.input, f.message]);
  const reopened = await new Store(f.directory).open(); let reads = 0;
  const restarted = new SlackPlugin({ ...f.plugin, store: reopened, io: { ...f.io, call: () => assert.fail('Superseded intent must never be sent') },
    gateway: { command: async type => { assert.equal(type, 'conversation.state'); reads++; return { status: 'waiting-for-user', acceptedRequestIds: [f.requestId], messages: [f.input, { ...f.message, partial: true }], approvals: [] }; } },
    logger: { warn() {}, error() {} } });
  t.after(() => restarted.stop()); restarted.stopped = false;
  restarted.drainReactions(); await settleReactions(restarted); assert.equal(reads, 0);
  await reopened.update(state => { state.threads[f.key].nextPoll = 0; }); await restarted.tick(); await settleReactions(restarted);
  assert.equal(reads, 1); assert.equal(Object.values(reopened.data.reactionOutbox)[0].status, 'superseded');
});
test('native Slack reaction journal-only failure does not block text or invent a receipt and later recovers', async t => {
  const f = await reactionFixture(t), warnings = [], update = f.store.update.bind(f.store); let failed = false;
  f.store.update = operation => update(async state => {
    const before = Object.keys(state.reactionOutbox || {}).length, result = await operation(state);
    if (!failed && Object.keys(state.reactionOutbox || {}).length > before) {
      failed = true; throw Object.assign(new Error('injected journal failure'), { code: 'EIO' });
    }
    return result;
  });
  f.message.text = '说明与风险仍正常显示。'; f.plugin.stopped = false; f.plugin.logger.warn = (message, details) => warnings.push(details);
  await f.plugin.mirror(f.key); await settleReactions(f.plugin);
  assert.equal(failed, true); assert.ok(f.sent.some(call => call.text?.includes('说明与风险')));
  assert.equal(f.sent.some(call => call.method === 'reactions.add'), false);
  assert.equal(Object.keys(f.store.data.reactionOutbox || {}).length, 0); assert.deepEqual(warnings, [{ code: 'EIO' }]);
  await f.plugin.mirror(f.key); await settleReactions(f.plugin);
  assert.equal(Object.values(f.store.data.reactionOutbox)[0].status, 'sent');
  assert.equal(f.sent.filter(call => call.text?.includes('说明与风险')).length, 1);
  assert.equal(f.sent.filter(call => call.method === 'reactions.add').length, 1);
});
function formBody(draftId, values) { return { type: 'view_submission', user: { id: user }, view: { private_metadata: draftId, state: { values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value: { value } }])) } } }; }

async function modelMenuFixture(t) {
  const f = await fixture(t), first = path.join(f.directory, 'first-provider.json'), second = path.join(f.directory, 'second-provider.json');
  await fs.writeFile(first, '{"model":"first-model"}'); await fs.writeFile(second, '{"model":"second-model"}');
  const settings = await CoordinatorModelSettings.open({ directory: path.join(f.directory, 'models'), config: {
    providerFile: first, defaultProviderId: 'first', modelProviders: { first: { label: '第一模型', providerFile: first }, second: { label: '第二模型', providerFile: second } },
  }, factory: provider => ({ model: provider.model, next: () => assert.fail('Model menus must not probe providers') }) });
  await f.store.update(state => { state.channels[channel] = 'lab'; state.preferences[user] = 'lab'; });
  const original = f.gateway.command; let lost = false;
  f.gateway.command = async (type, input) => {
    if (type === 'models.state') { f.calls.push({ type, ...input }); return settings.state(); }
    if (type === 'models.select') {
      f.calls.push({ type, ...input }); const result = await settings.select({ id: input.id, ...input.payload });
      if (lost) { lost = false; throw new TypeError('Selection committed but reply lost'); }
      return result;
    }
    return original(type, input);
  };
  return { ...f, settings, loseSelection: () => { lost = true; } };
}
const modelCommand = { command: '/cg', text: 'model', user_id: user, channel_id: channel };
function modelClick(menu, providerId, actor = user) {
  return { type: 'block_actions', user: { id: actor }, channel: { id: menu.channel }, message: { ts: menu.ts },
    actions: [{ action_id: 'model_select:0', value: JSON.stringify({ menuId: menu.id, providerId }) }] };
}
function modelOpenClick(menu, actor = user) {
  return { type: 'block_actions', user: { id: actor }, channel: { id: menu.channel },
    message: { ts: menu.ts, ...(menu.threadTs ? { thread_ts: menu.threadTs } : {}) },
    actions: [{ action_id: 'model_open', value: JSON.stringify({ menuId: menu.id }) }] };
}

test('Slack models explicit command opens only configured choices with one native confirmation and no model or classification', async t => {
  const f = await modelMenuFixture(t), before = await f.settings.state();
  await f.plugin.process('model-explicit', { type: 'slash_commands', body: modelCommand });
  const menu = Object.values(f.store.data.modelMenus)[0];
  assert.equal(menu.userId, user); assert.equal(menu.projectId, 'lab'); assert.equal(menu.version, before.version);
  assert.deepEqual(f.calls.map(call => call.type), ['models.state']);
  const choice = f.sent[0].blocks.find(block => block.type === 'actions').elements[0];
  assert.ok(choice.confirm); assert.equal(JSON.parse(choice.value).providerId, 'second');
  assert.match(blockText(f.sent[0].blocks), /下一文字轮次/); assert.match(blockText(f.sent[0].blocks), /图片模型不变/);
  assert.deepEqual(await f.settings.state(), before, 'Opening or canceling the native confirmation is not a selection');
  await f.plugin.process('human-confirm', { type: 'interactive', body: modelClick(menu, 'second') });
  assert.equal((await f.settings.state()).selectedId, 'second'); assert.equal(f.store.data.modelMenus[menu.id].status, 'applied');
  assert.equal(f.sent.at(-1).update[1], menu.ts);
});

test('Slack models unbound explicit command resumes its menu after project choice without starting a model conversation', async t => {
  const f = await modelMenuFixture(t); await f.store.update(state => { delete state.channels[channel]; delete state.preferences[user]; });
  await f.plugin.process('unbound-model', { type: 'slash_commands', body: modelCommand });
  await f.plugin.process('choose-model-project', { type: 'interactive', body: projectChoice(f, 'unbound-model') });
  await runPluginCycle(f.plugin);
  assert.equal(Object.values(f.store.data.modelMenus).length, 1);
  assert.equal(f.calls.some(call => ['conversation.create', 'conversation.submit', 'conversation.relevance'].includes(call.type)), false);
});

test('Slack models reject another user card destination project association and unknown provider before selection', async t => {
  const f = await modelMenuFixture(t); await f.plugin.process('model-scope', { type: 'slash_commands', body: modelCommand });
  const menu = Object.values(f.store.data.modelMenus)[0], before = await f.settings.state();
  const wrongMessage = modelClick(menu, 'second'); wrongMessage.message.ts = 'not-the-card';
  const wrongChannel = modelClick(menu, 'second'); wrongChannel.channel.id = 'C000002';
  for (const body of [modelClick(menu, 'second', 'UOTHER'), wrongMessage, wrongChannel, modelClick(menu, 'not-configured')]) {
    await assert.rejects(f.plugin.process('reject-model', { type: 'interactive', body }), error => ['FORBIDDEN', 'CONFLICT', 'INVALID_ARGUMENT'].includes(error.code));
  }
  await f.store.update(state => { state.channels[channel] = 'other'; });
  await assert.rejects(f.plugin.process('stale-project-model', { type: 'interactive', body: modelClick(menu, 'second') }), { code: 'CONFLICT' });
  assert.deepEqual(await f.settings.state(), before); assert.equal(f.calls.some(call => call.type === 'models.select'), false);
});

test('Slack models lost selection reply freezes the original operation across restart before same-current no-op', async t => {
  const f = await modelMenuFixture(t); await f.plugin.process('model-replay', { type: 'slash_commands', body: modelCommand });
  const menu = Object.values(f.store.data.modelMenus)[0]; f.loseSelection();
  await assert.rejects(f.plugin.process('lost-model-click', { type: 'interactive', body: modelClick(menu, 'second') }), /reply lost/);
  const selected = await f.settings.state(), saved = structuredClone(f.store.data.modelMenus[menu.id].selection);
  assert.equal(selected.selectedId, 'second'); assert.equal(f.store.data.modelMenus[menu.id].status, 'open');
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.process('retry-model-click', { type: 'interactive', body: modelClick(f.plugin.store.data.modelMenus[menu.id], 'second') });
  assert.deepEqual(await f.settings.state(), selected); assert.deepEqual(f.plugin.store.data.modelMenus[menu.id].selection, saved);
  const writes = f.calls.filter(call => call.type === 'models.select'); assert.deepEqual(writes[0], writes[1]);
  await f.plugin.process('same-receipt-click', { type: 'interactive', body: modelClick(f.plugin.store.data.modelMenus[menu.id], 'second') });
  assert.equal(f.calls.filter(call => call.type === 'models.select').length, 3, 'An existing receipt is replayed even when the menu now shows the selected ID');
  assert.deepEqual(await f.settings.state(), selected);
});

test('Slack models late acknowledgement replays historical choice without overwriting or claiming the newer default', async t => {
  const f = await modelMenuFixture(t); await f.plugin.process('late-model-receipt', { type: 'slash_commands', body: modelCommand });
  const menu = Object.values(f.store.data.modelMenus)[0], originalPosts = f.sent.length;
  assert.match(blockText(f.sent.at(-1).blocks), /下一文字轮次生效/);
  f.loseSelection();
  await assert.rejects(f.plugin.process('late-receipt-first-click', { type: 'interactive', body: modelClick(menu, 'second') }), /reply lost/);
  const originalSelection = structuredClone(f.store.data.modelMenus[menu.id].selection), savedA = await f.settings.state();
  assert.equal(savedA.selectedId, 'second');
  await f.settings.select({ id: 'other-human-newer-default', providerId: 'first', baseVersion: savedA.version });
  const newerB = await f.settings.state(), diskB = JSON.parse(await fs.readFile(f.settings.file, 'utf8'));
  assert.equal(newerB.selectedId, 'first'); assert.notEqual(newerB.version, savedA.version);
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.process('late-receipt-after-restart', { type: 'interactive', body: modelClick(f.plugin.store.data.modelMenus[menu.id], 'second') });
  assert.deepEqual(await f.settings.state(), newerB);
  assert.deepEqual(JSON.parse(await fs.readFile(f.settings.file, 'utf8')), diskB, 'Historical replay cannot increment revision or replace any stored receipt');
  assert.deepEqual(f.plugin.store.data.modelMenus[menu.id].selection, originalSelection);
  assert.equal(f.plugin.store.data.modelMenus[menu.id].selectedId, 'second', 'The original receipt records the old choice, not a fabricated current value');
  const writes = f.calls.filter(call => call.type === 'models.select'); assert.deepEqual(writes[0], writes[1]);
  const update = f.sent.at(-1).update; assert.equal(update[0], menu.channel); assert.equal(update[1], menu.ts);
  assert.equal(f.sent.filter(message => !message.update).length, originalPosts, 'The receipt updates the original message, never posts another selection');
  for (const text of [update[2], blockText(update[3])]) {
    assert.match(text, /历史回执/); assert.match(text, /不代表当前项目默认/); assert.doesNotMatch(text, /\/cg model/);
    assert.doesNotMatch(text, /下一文字轮次生效/);
  }
  assert.match(blockText(update[3]), /历史选择：第二模型/);
  assert.ok(update[3].some(block => block.elements?.some(element => element.action_id === 'model_open')));
});

test('Slack models fresh current choice is a read-only no-op and stale choices create a new observed version menu', async t => {
  const f = await modelMenuFixture(t); await f.plugin.process('model-noop', { type: 'slash_commands', body: modelCommand });
  const menu = Object.values(f.store.data.modelMenus)[0], before = await f.settings.state();
  await f.plugin.process('current-model-click', { type: 'interactive', body: modelClick(menu, 'first') });
  assert.deepEqual(await f.settings.state(), before); assert.equal(f.calls.some(call => call.type === 'models.select'), false);
  await f.plugin.process('model-conflict', { type: 'slash_commands', body: modelCommand });
  const stale = Object.values(f.store.data.modelMenus).find(item => item.id !== menu.id);
  await f.settings.select({ id: 'browser-model-change', providerId: 'second', baseVersion: before.version });
  await f.plugin.process('stale-model-click', { type: 'interactive', body: modelClick(stale, 'second') });
  const menus = Object.values(f.store.data.modelMenus); assert.equal(menus.length, 3);
  assert.equal(menus.at(-1).selectedId, 'second'); assert.equal(menus.at(-1).version, (await f.settings.state()).version);
  assert.equal(f.store.data.modelMenus[stale.id].selection.baseVersion, before.version);
});

test('Slack models native tool menu binds the actual accepted actor and preserves mirror receipts across restart', async t => {
  const f = await modelMenuFixture(t), key = threadKey(teamId, channel, '123.001');
  const service = new CoordinatorService({ directory: path.join(f.directory, 'native-model'), system: 'Test Coordinator', tools: coordinatorTools,
    execute: createCoordinatorExecutor({ modelSettings: async () => ({ ...(await f.settings.state()), currentRoute: (await service.state()).modelRoute }) }), model: { model: 'actual-pinned-native-model', next: async () => ({ stop: 'tool_use', content: [
      { type: 'tool_use', id: 'native-model-menu', name: 'show_model_menu', input: {} },
    ] }) } });
  try {
    await service.submit({ id: 'model-user-input', text: '更换项目默认文字模型' }, { source: 'slack', actor: { kind: 'human', teamId, userId: user } }); await service.close();
    const state = await service.state(); assert.equal(state.status, 'waiting-for-user'); assert.equal(state.messages.at(-1).actions[0].kind, 'model-selection');
    await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'native-model', userId: 'UOLDOWNER', ownRequests: ['model-user-input'] });
    const command = f.gateway.command;
    f.gateway.command = (type, input) => type === 'conversation.state' ? Promise.resolve(state) : command(type, input);
    const before = await f.settings.state(); await f.plugin.mirror(key);
    const menu = Object.values(f.store.data.modelMenus)[0]; assert.equal(menu.userId, user); assert.notEqual(menu.userId, 'UOLDOWNER');
    assert.deepEqual(menu.currentRoute, { kind: 'text', model: 'actual-pinned-native-model' });
    assert.match(blockText(f.sent.at(-1).blocks), /本轮模型未匹配目录（文字）/);
    assert.match(blockText(f.sent.at(-1).blocks), /默认文字模型：第一模型/);
    assert.doesNotMatch(blockText(f.sent.at(-1).blocks), /actual-pinned-native-model/);
    assert.deepEqual(await f.settings.state(), before);
    f.plugin.store = await new Store(f.directory).open(); const count = f.sent.length; await f.plugin.mirror(key); assert.equal(f.sent.length, count);
    await f.plugin.process('native-human-select', { type: 'interactive', body: modelClick(menu, 'second') });
    assert.equal((await f.settings.state()).selectedId, 'second');
  } finally { await service.close({ stop: true }); }
});

test('Slack models real image turn menu reports its pinned vision route separately from the default text catalog', async t => {
  const f = await modelMenuFixture(t), key = threadKey(teamId, channel, '124.001'), bytes = Buffer.from('synthetic image');
  const image = { id: 'model-menu-image', filename: 'screen.png', mimeType: 'image/png', size: bytes.length, hash: hash(bytes) };
  const service = new CoordinatorService({ directory: path.join(f.directory, 'vision-menu'), system: 'Test Coordinator', tools: coordinatorTools,
    model: { model: 'unrelated-text-model', next: async () => assert.fail('An image turn cannot use the default text route') },
    visionModel: { model: 'GLM-5.3-Flash', next: async ({ messages, tools }) => {
      assert.ok(messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'image')));
      if (!tools.length) return { stop: 'end_turn', content: [{ type: 'text', text: '合成截图中有一个按钮。' }] };
      return { stop: 'tool_use', content: [{ type: 'tool_use', id: 'vision-menu', name: 'show_model_menu', input: {} }] };
    } },
    resolveAttachment: async (id, context) => { assert.equal(id, image.id); return { ...image, ...(!context.metadataOnly ? { base64: bytes.toString('base64') } : {}) }; },
    execute: createCoordinatorExecutor({ modelSettings: async () => ({ ...(await f.settings.state()), currentRoute: (await service.state()).modelRoute }) }) });
  try {
    await service.submit({ id: 'image-model-query', text: '这轮使用什么模型？', attachments: [{ id: image.id }] }, { source: 'slack', actor: { kind: 'human', teamId, userId: user } }); await service.close();
    const state = await service.state(); assert.equal(state.status, 'waiting-for-user');
    assert.deepEqual(state.modelRoute, { kind: 'vision', model: 'GLM-5.3-Flash' });
    assert.equal(state.messages.find(message => message.role === 'user').attachments[0].id, image.id);
    await f.store.bind(key, { channel, threadTs: '124.001', projectId: 'lab', conversationId: 'vision-menu', ownRequests: ['image-model-query'] });
    const command = f.gateway.command; f.gateway.command = (type, input) => type === 'conversation.state' ? Promise.resolve(state) : command(type, input);
    await f.plugin.mirror(key);
    const menu = Object.values(f.store.data.modelMenus)[0], text = blockText(f.sent.at(-1).blocks);
    assert.deepEqual(menu.currentRoute, state.modelRoute); assert.match(text, /本轮模型未匹配目录（图片）/);
    assert.doesNotMatch(text, /GLM-5.3-Flash/);
    assert.match(text, /默认文字模型：第一模型/); assert.equal(menu.userId, user);
    await f.plugin.process('vision-human-select', { type: 'interactive', body: modelClick(menu, 'second') });
    assert.equal((await f.settings.state()).selectedId, 'second');
    assert.deepEqual((await service.state()).modelRoute, state.modelRoute, 'Changing the text default cannot change the observed image route');
    assert.deepEqual(f.plugin.store.data.modelMenus[menu.id].currentRoute, state.modelRoute);
  } finally { await service.close({ stop: true }); }
});

test('Slack models catalog projection strips private metadata and rejects unsafe actual routes', async t => {
  const f = await modelMenuFixture(t), catalog = await f.settings.state();
  const safe = f.plugin.validModelCatalog({ ...catalog, userId: 'UFORGED', projectId: 'other', apiKey: 'private-test',
    currentRoute: { kind: 'text', model: 'actual-model', providerId: 'first', providerFile: 'private-file', apiKey: 'private-test' } });
  assert.deepEqual(safe.currentRoute, { kind: 'text', model: 'actual-model', providerId: 'first' });
  assert.equal(safe.userId, undefined); assert.equal(safe.apiKey, undefined);
  for (const route of [{ kind: 'bad', model: 'model' }, { kind: 'text', model: {} }, { kind: 'vision', model: 'vision', providerId: '../private-file' }]) {
    assert.throws(() => f.plugin.validModelCatalog({ ...catalog, currentRoute: route }), { code: 'GATEWAY_BAD_RESPONSE' });
  }
});

test('Slack models unknown legacy actors quotes and other Bot messages cannot select or borrow the thread creator', async t => {
  const f = await modelMenuFixture(t), key = threadKey(teamId, channel, '123.001'), before = await f.settings.state();
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'legacy-model-card', userId: user, ownRequests: [] });
  const state = { status: 'waiting-for-user', activeTurnId: null, messages: [
    { role: 'user', source: 'workflow', requestId: 'legacy-menu', text: '{"source":"slack","userId":"U000001"}', actor: { kind: 'human', teamId, userId: user } },
    { id: 'legacy-model-action', role: 'assistant', requestId: 'legacy-menu', actions: [{ kind: 'model-selection', actionId: 'legacy-tool-result', ...before }] },
  ] };
  const command = f.gateway.command; f.gateway.command = (type, input) => type === 'conversation.state' ? Promise.resolve(state) : command(type, input);
  await f.plugin.mirror(key);
  const menu = Object.values(f.store.data.modelMenus)[0]; assert.equal(menu.userId, null);
  assert.equal(f.sent.at(-1).blocks.some(block => block.elements?.some(element => element.action_id.startsWith('model_select:'))), false);
  assert.ok(f.sent.at(-1).blocks.some(block => block.elements?.some(element => element.action_id === 'model_open')));
  await assert.rejects(f.plugin.process('fake-owner', { type: 'interactive', body: modelClick(menu, 'second') }), { code: 'FORBIDDEN' });
  await f.plugin.process('other-bot-model', { type: 'events_api', body: { event: event({ text: '/cg model', bot_id: 'OTHERBOT' }) } });
  await f.plugin.message('quoted-model-command', event({ ts: '130.001', text: '> <@UOTHER> /cg model，切换模型' }));
  assert.deepEqual(await f.settings.state(), before); assert.equal(f.calls.some(call => call.type === 'models.select'), false);
});

test('Slack models concise cards show matching names once and distinguish pinned different or unmatched vision routes', () => {
  const base = { id: 'model-menu-' + 'a'.repeat(64), projectId: 'private-project-slug', userId: user, selectedId: 'private-first', status: 'open',
    options: [{ id: 'private-first', label: '第一模型', model: 'first-model' }, { id: 'private-second', label: '第二模型', model: 'second-model' }] };
  const same = modelChoiceBlocks({ ...base, currentRoute: { kind: 'text', model: 'first-model', providerId: 'private-first' } });
  assert.equal(occurrences(blockText(same), '第一模型'), 1); assert.match(blockText(same), /默认与本轮文字模型：第一模型/);
  const different = modelChoiceBlocks({ ...base, currentRoute: { kind: 'text', model: 'second-model', providerId: 'private-second' } });
  assert.match(blockText(different), /默认文字模型：第一模型\n本轮文字模型：第二模型/);
  for (const route of [{ kind: 'vision', model: 'not-in-catalog' }, { kind: 'text', model: 'changed-in-place', providerId: 'private-first' }]) {
    const blocks = modelChoiceBlocks({ ...base, currentRoute: route });
    assert.match(blockText(blocks), /本轮模型未匹配目录/);
    assert.doesNotMatch(blockText(blocks), /默认与本轮/);
  }
  for (const blocks of [same, different, modelChoiceBlocks(base)]) {
    assert.doesNotMatch(blockText(blocks), /private-project-slug|private-first|private-second|已配置模型|\/cg model/);
    const choice = blocks.find(block => block.elements?.some(element => element.action_id.startsWith('model_select:'))).elements[0];
    assert.ok(choice.confirm); assert.match(choice.confirm.text.text, /当前轮次和失败重试不切换，图片模型不变/);
    assert.equal(JSON.parse(choice.value).providerId, 'private-second', 'Only visible prose is shorter; native routing values remain exact');
  }
});

test('Slack models thread opener binds its clicker to fresh catalog without rewriting old unknown owners or selecting', async t => {
  const f = await modelMenuFixture(t), key = threadKey(teamId, channel, '123.001'), before = await f.settings.state();
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'unknown-menu', userId: user, ownRequests: [] });
  const original = await f.plugin.saveModelMenu('model-menu-' + 'b'.repeat(64), before, { key, userId: null, projectId: 'lab', channel, threadTs: '123.001' });
  await f.store.update(state => { state.modelMenus[original.id].ts = '124.001'; });
  const old = structuredClone(f.store.data.modelMenus[original.id]), clicker = 'UOTHER';
  await f.settings.select({ id: 'synthetic-human-newer-default', providerId: 'second', baseVersion: before.version });
  const current = await f.settings.state(); assert.notEqual(current.version, old.version);
  const wrongChannel = modelOpenClick(old, clicker); wrongChannel.channel.id = 'C000002';
  const wrongMessage = modelOpenClick(old, clicker); wrongMessage.message.ts = '125.001';
  const wrongThread = modelOpenClick(old, clicker); wrongThread.message.thread_ts = '999.001';
  const extra = modelOpenClick(old, clicker); extra.actions[0].value = JSON.stringify({ menuId: old.id, userId: user, projectId: 'other' });
  for (const body of [wrongChannel, wrongMessage, wrongThread, extra]) await assert.rejects(f.plugin.process('bad-opener', { type: 'interactive', body }), { code: 'CONFLICT' });
  await f.store.update(state => { state.threads[key].projectId = 'other'; });
  await assert.rejects(f.plugin.process('changed-opener', { type: 'interactive', body: modelOpenClick(old, clicker) }), { code: 'CONFLICT' });
  await f.store.update(state => { state.threads[key].projectId = 'lab'; });
  const command = f.gateway.command;
  f.gateway.command = async () => { throw Object.assign(new Error('read action not enabled'), { code: 'FORBIDDEN', status: 403 }); };
  await assert.rejects(f.plugin.process('forbidden-opener', { type: 'interactive', body: modelOpenClick(old, clicker) }), { code: 'FORBIDDEN' });
  assert.equal(Object.keys(f.store.data.modelMenus).length, 1);
  f.gateway.command = command;
  await f.plugin.process('my-model-opener', { type: 'interactive', body: modelOpenClick(old, clicker) });
  const fresh = Object.values(f.store.data.modelMenus).find(menu => menu.id !== old.id);
  assert.equal(fresh.userId, clicker); assert.equal(fresh.threadTs, old.threadTs); assert.equal(fresh.version, current.version); assert.equal(fresh.selectedId, 'second');
  assert.equal(f.calls.filter(call => call.type === 'models.state').length, 1);
  assert.equal(f.calls.find(call => call.type === 'models.state').userId, clicker);
  assert.deepEqual(f.store.data.modelMenus[old.id], old); assert.deepEqual(await f.settings.state(), current);
  assert.equal(f.calls.some(call => call.type === 'models.select'), false);
  await assert.rejects(f.plugin.process('creator-cannot-borrow', { type: 'interactive', body: modelClick(fresh, 'second', user) }), { code: 'FORBIDDEN' });
  f.plugin.store = await new Store(f.directory).open();
  const posts = f.sent.length;
  await f.plugin.process('my-model-opener', { type: 'interactive', body: modelOpenClick(old, clicker) });
  assert.equal(Object.keys(f.plugin.store.data.modelMenus).length, 2);
  assert.equal(f.calls.filter(call => call.type === 'models.state').length, 1);
  assert.equal(f.sent.length, posts, 'Restart and repeated click reuse the original menu/card operation');
});

test('Slack models unknown original selection blocks a read-only opener until its original receipt recovers', async t => {
  const f = await modelMenuFixture(t); await f.plugin.process('pending-menu', { type: 'slash_commands', body: modelCommand });
  const menu = Object.values(f.store.data.modelMenus)[0]; f.loseSelection();
  await assert.rejects(f.plugin.process('pending-choice', { type: 'interactive', body: modelClick(menu, 'second') }), /reply lost/);
  const saved = JSON.parse(JSON.stringify(f.store.data.modelMenus[menu.id])), calls = f.calls.length, posts = f.sent.length;
  f.plugin.store = await new Store(f.directory).open();
  await assert.rejects(f.plugin.process('blocked-opener', { type: 'interactive', body: modelOpenClick(saved) }), { code: 'BUSY' });
  assert.deepEqual(f.plugin.store.data.modelMenus[menu.id], saved); assert.equal(f.calls.length, calls); assert.equal(f.sent.length, posts);
  await f.plugin.process('pending-choice-recovery', { type: 'interactive', body: modelClick(saved, 'second') });
  const receipt = structuredClone(f.plugin.store.data.modelMenus[menu.id]);
  await f.plugin.process('after-receipt-opener', { type: 'interactive', body: modelOpenClick(receipt) });
  assert.equal(f.calls.filter(call => call.type === 'models.select').length, 2, 'Opening never submits a new selection');
  assert.deepEqual(f.calls.filter(call => call.type === 'models.select')[0], f.calls.filter(call => call.type === 'models.select')[1]);
  assert.deepEqual(f.plugin.store.data.modelMenus[menu.id].selection, saved.selection);
  assert.equal(Object.values(f.plugin.store.data.modelMenus).at(-1).selectedId, 'second');
});

test('Slack models interleaved inputs bind the original trusted assistant actor rather than the preceding user or creator', async t => {
  const f = await modelMenuFixture(t), catalog = await f.settings.state(), key = threadKey(teamId, channel, '133.001');
  const actor = integrationActor({ teamId }, { teamId, userId: user }), secondActor = integrationActor({ teamId }, { teamId, userId: 'UOTHER' });
  const state = { activeTurnId: 'original-request', activeInput: { id: 'original-request', source: 'slack', actor }, messages: [
    { role: 'user', requestId: 'original-request', source: 'slack', actor, content: '读取模型菜单' },
    { role: 'user', requestId: 'later-request', source: 'slack', actor: secondActor, content: '后来的另一位用户输入' },
  ] };
  await coordinatorStep({ turnId: state.activeTurnId, state, system: 'Test', tools: coordinatorTools, save: async () => {},
    model: { next: async () => ({ stop: 'tool_use', content: [{ type: 'tool_use', id: 'interleaved-menu', name: 'show_model_menu', input: {} }] }) },
    execute: createCoordinatorExecutor({ modelSettings: async () => catalog }) });
  const projected = { status: 'waiting-for-user', messages: publicMessages(state), activeTurnId: null };
  assert.equal(projected.messages.at(-1).actor.userId, user, 'Actual server projection preserves the first accepted input metadata');
  await f.store.bind(key, { channel, threadTs: '133.001', projectId: 'lab', conversationId: 'interleaved', userId: 'UCREATOR', ownRequests: ['original-request', 'later-request'] });
  const command = f.gateway.command; f.gateway.command = (type, input) => type === 'conversation.state' ? Promise.resolve(projected) : command(type, input);
  await f.plugin.mirror(key);
  const menu = Object.values(f.store.data.modelMenus)[0]; assert.equal(menu.userId, user); assert.notEqual(menu.userId, secondActor.userId); assert.notEqual(menu.userId, 'UCREATOR');
  await assert.rejects(f.plugin.process('interleaved-cross-owner', { type: 'interactive', body: modelClick(menu, 'second', secondActor.userId) }), { code: 'FORBIDDEN' });
  const trustedMessage = structuredClone(projected.messages.at(-1));
  for (const [index, changed] of [{ source: 'workflow' }, { actor: { ...actor, teamId: 'TOTHER' } },
    { actor: { ...actor, integration: 'other' } }, { actor: { ...actor, sessionId: 'forged' } }, { requestId: 'not-owned' }].entries()) {
    projected.messages[projected.messages.length - 1] = { ...trustedMessage, ...changed, id: `untrusted-assistant-${index}` };
    await f.plugin.mirror(key);
    assert.equal(Object.values(f.store.data.modelMenus).at(-1).userId, null);
  }
  assert.equal(f.calls.some(call => call.type === 'models.select'), false);
});

function nativeQuestionProjection(questions, { text = '', answered = [], attachments = [], actions = [] } = {}) {
  const tools = questions.map((question, index) => ({ type: 'tool_use', id: `ask-${index}`, name: 'ask_user', input: question }));
  const state = { messages: [
    { role: 'assistant', requestId: 'question-turn', content: [...(text ? [{ type: 'text', text }] : []), ...tools], attachments, actions },
    { role: 'user', content: tools.map(tool => ({ type: 'tool_result', tool_use_id: tool.id, content: '{"nodes":[]}' })) },
  ], answers: {} };
  const initial = publicMessages(state).find(message => message.role === 'assistant');
  for (const index of answered) state.answers[initial.questions[index].id] = { text: `answer-${index}`, requestId: `answer-request-${index}` };
  return publicMessages(state).find(message => message.role === 'assistant');
}
const blockText = blocks => blocks.map(block => block.text?.text || '').join('\n\n');
const occurrences = (text, value) => text.split(value).length - 1;

test('Slack question-only render uses the real public ask_user projection without duplicated clarification', () => {
  const question = '下一步先验收哪个模块？';
  const message = nativeQuestionProjection([{ question, options: ['阅读模块', '编辑模块'] }]);
  assert.equal(message.questionOnly, true); assert.equal(message.text, question);
  const original = structuredClone(message), blocks = messageBlocks(message, 'thread');
  assert.equal(occurrences(blockText(blocks), question), 1);
  assert.match(blockText(blocks), /阅读模块/); assert.match(blockText(blocks), /编辑模块/);
  assert.match(blockText(blocks), /直接在这个线程回复/);
  assert.deepEqual(message, original, 'Rendering cannot alter the question ID, options or pending answer');
});

test('Slack question render preserves real multiple mixed and all-answered public histories with only open controls', () => {
  const questions = [{ question: '先验收哪个模块？', options: ['首页', '文章页'] }, { question: '用哪个设备？', options: ['手机', '桌面'] }];
  for (const answered of [[], [0], [0, 1]]) {
    const message = nativeQuestionProjection(questions, { answered }); assert.equal(message.questionOnly, true);
    const blocks = messageBlocks(message, 'thread'), text = blockText(blocks);
    for (const question of questions) assert.equal(occurrences(text, question.question), 1);
    assert.ok(text.indexOf(questions[0].question) < text.indexOf(questions[1].question));
    assert.equal(occurrences(text, '直接在这个线程回复'), questions.length - answered.length);
    assert.equal(text.includes('可参考：'), answered.length < questions.length);
    if (answered.length === 2) assert.equal(text, plainText(message.text), 'All answered history keeps the original joined body rather than empty blocks');
    if (!answered.length) assert.ok(text.indexOf('文章页') < text.indexOf(questions[1].question), 'Options stay attached to their question');
  }
});

test('Slack question render uses only strict whole-text equality and retains actual different prose and partial prefixes', () => {
  const question = '要先验收手机吗？';
  const same = nativeQuestionProjection([{ question, options: ['是', '否'] }], { text: question });
  assert.equal(same.questionOnly, undefined); assert.equal(occurrences(blockText(messageBlocks(same, 'thread')), question), 1);
  const distinct = nativeQuestionProjection([{ question }], { text: `背景里引用了“${question}”，当前范围尚未确定。` });
  const distinctText = blockText(messageBlocks(distinct, 'thread'));
  assert.ok(distinctText.includes(distinct.text)); assert.equal(occurrences(distinctText, question), 2, 'A substring or quote cannot suppress the actual question');
  const projected = nativeQuestionProjection([{ question }]);
  const partial = { ...projected, text: `部分回复（非最终答案）：\n${projected.text}`, partial: true };
  const text = blockText(messageBlocks(partial, 'thread'));
  assert.ok(text.includes(plainText(partial.text)), 'A prefixed stream is not the exact question-only projection');
  assert.equal(occurrences(text, question), 2, 'Retain genuine prefixed contents rather than applying fuzzy sentence deduplication');
});

test('Slack question render preserves attachment node links and approval controls without altering input metadata', () => {
  const context = { cloudOrigin: 'https://map.example.com', projectId: 'lab' };
  const message = nativeQuestionProjection([{ question: '选哪个模块？', options: ['A', 'B'] }], {
    attachments: [{ id: 'attachment-1', filename: 'evidence.txt' }], actions: [{ kind: 'node-navigation', node: { id: 'N1', title: '模块' } }],
  });
  const original = structuredClone(message), blocks = messageBlocks(message, 'thread', context);
  assert.equal(occurrences(blockText(blocks), message.text), 1);
  assert.ok(blocks.some(block => block.type === 'context' && block.elements[0].text.includes('evidence.txt')));
  assert.equal(blocks.find(block => block.type === 'actions').elements[0].url, 'https://map.example.com/projects/lab?relation=N1');
  assert.deepEqual(message, original);
  const approval = approvalBlocks({ id: 'p1', version: 'v1', text: '已对齐需求', acceptance: '可验收' }, 'thread');
  assert.deepEqual(approval.find(block => block.type === 'actions').elements.map(element => element.action_id), ['approve_brief', 'reject_brief']);
});

test('Slack question render finalizes the real public projection in the retained stream and preserves pending ID across restart', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001'), question = '下一步验收哪个模块？';
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'question-render', userId: user, ownRequests: ['question-turn'] });
  f.gateway.command = async () => ({ status: 'running', activeTurnId: 'question-turn', streamingText: '先确认验收范围。',
    messages: [{ role: 'user', requestId: 'question-turn', text: '请先澄清' }] });
  await f.plugin.mirror(key);
  const streamTs = f.sent[0].channel && f.store.data.threads[key].liveStream.ts;
  const message = nativeQuestionProjection([{ question, options: ['首页', '文章页'] }]);
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, acceptedRequestIds: ['question-turn'], messages: [message] });
  await f.plugin.mirror(key);
  const update = f.sent.find(item => item.update).update;
  assert.equal(update[1], streamTs); assert.equal(occurrences(blockText(update[3]), question), 1);
  assert.equal(f.store.data.threads[key].pendingQuestionId, message.questions[0].id);
  f.plugin.store = await new Store(f.directory).open(); await f.plugin.mirror(key);
  assert.equal(f.sent.length, 2, 'Restart does not duplicate the finalized clarification');
  assert.equal(f.plugin.store.data.threads[key].pendingQuestionId, message.questions[0].id);
});

test('Slack question cache migrates only a real public question projection in place and remains settled after restart', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  const context = { cloudOrigin: 'https://map.example.com', projectId: 'lab' };
  const question = nativeQuestionProjection([{ question: '下一步先验收哪个模块？', options: ['首页', '文章页'] }], {
    attachments: [{ id: 'evidence-1', filename: 'evidence.txt' }], actions: [{ kind: 'node-navigation', node: { id: 'N1', title: '模块' } }],
  });
  const ordinary = { id: 'ordinary-history', requestId: 'old-turn', role: 'assistant', text: '原普通历史回复。',
    actions: [{ kind: 'node-navigation', node: { id: 'N2', title: '另一个模块' } }] };
  const legacyHash = message => {
    const blocks = messageBlocks(message, key, context);
    return digest({ format: 'plain-text-v2', message,
      ...(blocks.some(block => block.type === 'actions') ? { nodeLinks: blocks.filter(block => block.type === 'actions') } : {}) });
  };
  const original = structuredClone(question), oldQuestionHash = legacyHash(question), oldOrdinaryHash = legacyHash(ordinary);
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'question-cache', userId: user, ownRequests: [] });
  await f.store.update(state => {
    state.threads[key].mirrored[question.id] = { ts: '8.0', hash: oldQuestionHash };
    state.threads[key].mirrored[ordinary.id] = { ts: '7.0', hash: oldOrdinaryHash };
    state.threads[key].pendingQuestionId = question.questions[0].id;
  });
  f.gateway.command = async (type, input) => {
    assert.equal(type, 'conversation.state'); assert.equal(input.conversationId, 'question-cache');
    return { status: 'waiting-for-user', activeTurnId: null, acceptedRequestIds: ['question-turn'], messages: [ordinary, question] };
  };
  f.io.post = async () => assert.fail('A known Slack timestamp must be updated, never posted again');
  await f.plugin.mirror(key);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].update[1], '8.0');
  assert.equal(occurrences(blockText(f.sent[0].update[3]), question.text), 1);
  assert.match(blockText(f.sent[0].update[3]), /首页/);
  assert.ok(f.sent[0].update[3].some(block => block.type === 'context' && block.elements[0].text.includes('evidence.txt')));
  assert.notEqual(f.store.data.threads[key].mirrored[question.id].hash, oldQuestionHash);
  assert.deepEqual(f.store.data.threads[key].mirrored[ordinary.id], { ts: '7.0', hash: oldOrdinaryHash });
  assert.equal(f.store.data.threads[key].pendingQuestionId, question.questions[0].id); assert.deepEqual(question, original);
  f.plugin.store = await new Store(f.directory).open(); await f.plugin.mirror(key); await f.plugin.mirror(key);
  assert.equal(f.sent.length, 1, 'The acknowledged rendering fingerprint remains stable across restart and repeated polls');
  assert.equal(f.plugin.store.data.threads[key].mirrored[question.id].ts, '8.0');
  assert.equal(f.plugin.store.data.threads[key].pendingQuestionId, question.questions[0].id);
});

test('Slack question cache retains the old fingerprint on lost update ACK and retries the same timestamp', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  const question = nativeQuestionProjection([{ question: '是否先验收手机？', options: ['是', '否'] }]);
  const oldHash = digest({ format: 'plain-text-v2', message: question });
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'question-cache-retry', userId: user, ownRequests: [] });
  await f.store.update(state => { state.threads[key].mirrored[question.id] = { ts: '9.0', hash: oldHash }; });
  f.gateway.command = async type => {
    assert.equal(type, 'conversation.state');
    return { status: 'waiting-for-user', activeTurnId: null, acceptedRequestIds: ['question-turn'], messages: [question] };
  };
  let attempts = 0;
  f.io.update = async (...args) => { f.sent.push({ update: args }); if (++attempts === 1) throw new TypeError('Slack update ACK lost after application'); };
  f.io.post = async () => assert.fail('Lost update ACK cannot allocate a replacement message');
  await assert.rejects(f.plugin.mirror(key), /ACK lost/);
  assert.deepEqual(f.store.data.threads[key].mirrored[question.id], { ts: '9.0', hash: oldHash });
  f.plugin.store = await new Store(f.directory).open(); await f.plugin.mirror(key);
  assert.equal(f.sent.length, 2); assert.deepEqual(f.sent[0].update, f.sent[1].update);
  assert.equal(f.sent[1].update[1], '9.0'); assert.notEqual(f.plugin.store.data.threads[key].mirrored[question.id].hash, oldHash);
  await f.plugin.mirror(key); assert.equal(f.sent.length, 2);
});

test('durable collection merges other-bot request and unmentioned correction once across restart', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const options = { collectMs: 800, maxCollectMs: 2000 };
  const messages = [event({ ts: '300.001', text: '<@UOTHER> 修复登录', files: [{ id: 'F1' }] }),
    event({ ts: '300.002', text: 'Coordinator 帮我跟进，先只整理验收' })];
  for (const item of messages) await f.store.receive(envelopeId('events_api', { team_id: teamId, event: item }), { type: 'events_api', body: { team_id: teamId, event: item } }, options);
  const ids = Object.keys(f.store.data.inbox), batch = f.store.data.messageBatches[ids[0]];
  assert.deepEqual(batch.ids, ids); assert.ok(batch.readyAt <= batch.deadline); assert.equal(batch.deadline - batch.firstAt, 2000);
  f.plugin.stopped = false; f.plugin.kick = () => {};
  await f.plugin.tick(); assert.equal(f.calls.length, 0, 'Do not classify the first message before the correction window closes');
  const reopened = await new Store(f.directory).open(); f.plugin.store = reopened;
  await reopened.update(state => { state.messageBatches[ids[0]].readyAt = Date.now() - 1; });
  await f.plugin.tick();
  await Promise.all([...f.plugin.processing.values()]);
  const judgments = f.calls.filter(call => call.type === 'conversation.relevance'), submits = f.calls.filter(call => call.type === 'conversation.submit');
  assert.equal(judgments.length, 1); assert.deepEqual(judgments[0].payload.inputs.map(item => item.text), messages.map(item => item.text));
  assert.equal(submits.length, 1); assert.deepEqual(submits[0].payload.inputs.map(item => item.text), messages.map(item => item.text));
  assert.equal(submits[0].payload.inputs[0].attachments.length, 1); assert.equal(submits[0].payload.inputs[1].attachments, undefined);
  assert.ok(ids.every(id => reopened.data.inbox[id].status === 'done'));
  assert.equal(await reopened.receive(ids[0], { type: 'events_api', body: { team_id: teamId, event: messages[0] } }), false);
  await f.plugin.tick(); assert.equal(f.calls.filter(call => call.type === 'conversation.submit').length, 1);
  await f.plugin.stop();
});

test('collection keeps different senders receivers projects and explicit threads separate and caps batch size', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const add = async (id, extra) => f.store.receive(id, { type: 'events_api', body: { team_id: teamId, event: event({ ts: `400.${id}`, ...extra }) } }, { collectMs: 800, maxCollectMs: 2000 });
  await add('1', { text: '<@UOTHER> first' }); await add('2', { text: '<@UANOTHER> second' });
  await add('3', { text: 'ambiguous unmentioned' }); await add('4', { text: 'another user', user: 'U000002' });
  await add('5', { text: 'explicit thread', thread_ts: '399.001' });
  await f.store.update(state => { state.channels[channel] = 'other-project'; }); await add('6', { text: 'different project' });
  assert.equal(new Set(Object.values(f.store.data.inbox).map(item => item.batchId)).size, 6);
  for (let index = 0; index < 21; index++) await add(`x${index}`, { text: 'same receiver', thread_ts: '398.001' });
  const batches = Object.values(f.store.data.messageBatches).filter(batch => batch.rootTs === '398.001');
  assert.deepEqual(batches.map(batch => batch.ids.length), [20, 1]);
});

test('receive queued before freeze is included in the atomic snapshot and cannot remain stranded', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const envelope = text => ({ type: 'events_api', body: { team_id: teamId, event: event({ text }) } });
  const options = { collectMs: 800, maxCollectMs: 2000 };
  await f.store.receive('a', envelope('first'), options);
  let release; const held = new Promise(resolve => { release = resolve; });
  const write = f.store.update(async () => { await held; });
  const receiveB = f.store.receive('b', envelope('correction'), options);
  const running = f.plugin.runEntry('a', f.store.data.inbox.a);
  release(); await write; await receiveB; await running;
  const submit = f.calls.find(call => call.type === 'conversation.submit');
  assert.deepEqual(submit.payload.inputs.map(input => input.text), ['first', 'correction']);
  assert.equal(f.store.data.inbox.a.status, 'done'); assert.equal(f.store.data.inbox.b.status, 'done');
});

test('single plugin input crosses real HTTP gateway and Coordinator service with independent batch receipt', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const service = new CoordinatorService({ directory: path.join(f.directory, 'coordinator'), system: 'Test Coordinator', tools: [], execute: async () => {},
    model: { next: async () => ({ stop: 'end_turn', content: [{ type: 'text', text: '收到单条原文' }] }) } });
  const token = 'synthetic-plugin-http-test-credential-123456'; let submitted;
  const server = await startIntegrationGateway({ config: { host: '127.0.0.1', port: 0, token, teamId, projectIds: ['lab'] }, stateDir: path.join(f.directory, 'gateway'),
    state: async () => ({ ...(await service.state()), conversationId: 'chat-real-http' }),
    command: async (input, context) => {
      if (input.type === 'conversation.relevance') return { respond: true, mainVersion: 'v1' };
      if (input.type === 'conversation.create') return { conversationId: 'chat-real-http' };
      if (input.type === 'conversation.submit') { submitted = input; return service.submit({ ...input.payload, id: input.id }, { source: 'slack', actor: context.actor }); }
      if (input.type === 'conversation.state') return { ...(await service.state()), conversationId: 'chat-real-http' };
      if (input.type === 'project.list') return { projects: [{ id: 'lab', name: 'Lab' }] };
      return {};
    } });
  try {
    f.plugin.gateway = new Gateway({ url: server.url, token, teamId });
    await f.plugin.message('single-http', event({ text: '请原样记录我的输入' })); await service.close();
    assert.notEqual(submitted.id, submitted.payload.inputs[0].id);
    const state = await service.state(); assert.ok(state.acceptedRequestIds.includes(submitted.payload.inputs[0].id));
    const binding = Object.values(f.store.data.threads)[0]; assert.equal(binding.awaitingReplyId, submitted.payload.inputs[0].id);
    await f.plugin.mirror(Object.keys(f.store.data.threads)[0]); assert.equal(Object.values(f.store.data.threads)[0].awaitingReplyId, undefined);
  } finally { await server.close(); await service.close({ stop: true }); }
});

test('continuous arrivals do not extend collection beyond two seconds or cross its next window', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = Date.now; let now = original(); Date.now = () => now;
  try {
    const add = id => f.store.receive(id, { type: 'events_api', body: { team_id: teamId, event: event({ ts: `600.${id}`, text: 'more' }) } }, { collectMs: 800, maxCollectMs: 2000 });
    await add('first'); const deadline = f.store.data.messageBatches.first.deadline;
    now += 700; await add('second'); now += 700; await add('third'); now += 599; await add('fourth');
    assert.equal(f.store.data.messageBatches.first.readyAt, deadline); assert.equal(f.store.data.messageBatches.first.deadline, deadline);
    now += 1; await add('fifth'); assert.equal(f.store.data.inbox.fifth.batchId, 'fifth');
    assert.equal(f.store.data.messageBatches.fifth.rootTs, '600.fifth');
  } finally { Date.now = original; }
});

test('frozen batch replays the same original IDs and retains every member on lost reply', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  // Deliberately deliver the newer correction first; native timestamps determine
  // semantic order inside the frozen batch, not Socket delivery order.
  for (const [id, ts, text] of [['late', '700.002', 'new correction'], ['early', '700.001', 'original request']]) {
    await f.store.receive(id, { type: 'events_api', body: { team_id: teamId, event: event({ ts, text }) } }, { collectMs: 800, maxCollectMs: 2000 });
  }
  const command = f.gateway.command, submissions = []; let lost = true;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.submit') { submissions.push(structuredClone(input)); if (lost) { lost = false; throw new TypeError('reply lost'); } }
    return command(type, input);
  };
  await f.plugin.runEntry('late', f.store.data.inbox.late); assert.equal(f.store.data.inbox.late.status, 'pending'); assert.equal(f.store.data.inbox.early.status, 'pending');
  const reopened = await new Store(f.directory).open(); f.plugin.store = reopened;
  await f.plugin.runEntry('late', reopened.data.inbox.late);
  assert.deepEqual(submissions[0], submissions[1]);
  assert.deepEqual(submissions[1].payload.inputs.map(input => input.text), ['original request', 'new correction']);
  assert.equal(f.calls.filter(call => call.type === 'conversation.relevance').length, 1);
  assert.equal(reopened.data.inbox.early.status, 'done'); assert.equal(reopened.data.inbox.late.status, 'done');
});

test('a second top-level batch inherits only the original two-second conversation window', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = Date.now; let now = original(); Date.now = () => now;
  try {
    const add = id => f.store.receive(id, { type: 'events_api', body: { team_id: teamId, event: event({ ts: `800.${id}`, text: 'more' }) } }, { collectMs: 800, maxCollectMs: 2000 });
    await add('first'); const deadline = f.store.data.messageBatches.first.deadline;
    await f.store.update(state => { state.messageBatches.first.frozen = true; });
    now += 900; await add('second');
    assert.equal(f.store.data.messageBatches.second.rootTs, '800.first'); assert.equal(f.store.data.messageBatches.second.deadline, deadline);
    now += 1101; await add('third'); assert.equal(f.store.data.messageBatches.third.rootTs, '800.third');
  } finally { Date.now = original; }
});

test('slow identity lookup has one-second bounded wait eight real in-flight slots and shutdown cleanup', async t => {
  const f = await fixture(t); let release, calls = 0; const held = new Promise(resolve => { release = resolve; });
  f.io.identity = async id => { calls++; await held; return { user: { id, is_bot: true } }; };
  const started = Date.now();
  const routing = await f.plugin.mentionRoute('slow-identities', event({ text: Array.from({ length: 8 }, (_, index) => `<@UOTHER${index}>`).join(' ') }));
  assert.ok(Date.now() - started < 1800); assert.equal(calls, 8); assert.equal(f.plugin.identityTasks.size, 8);
  assert.ok(routing.mentionedUsers.every(user => user.isBot === null));
  await f.plugin.mentionRoute('capacity', event({ text: '<@UNEW> more' })); assert.equal(calls, 8);
  await f.plugin.mentionRoute('cached-null', event({ text: '<@UOTHER0> more' })); assert.equal(calls, 8);
  let stopped = false; const stopping = f.plugin.stop().then(() => { stopped = true; }); await Promise.resolve(); assert.equal(stopped, false);
  release(); await stopping; assert.equal(f.plugin.identityTasks.size, 0);
});

test('private top-level inputs reuse a durable current conversation and start-chat creates a new one', async t => {
  const f = await fixture(t); await f.store.update(state => { state.preferences[user] = 'lab'; });
  await f.plugin.message('dm1', event({ channel: 'D000001', ts: '500.001', text: 'first' }));
  await f.plugin.message('dm2', event({ channel: 'D000001', ts: '500.002', text: 'correction' }));
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
  const reopened = await new Store(f.directory).open(); f.plugin.store = reopened;
  await f.plugin.message('dm3', event({ channel: 'D000001', ts: '500.003', text: 'after restart' }));
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
  await f.plugin.message('new-chat', event({ channel: 'D000001', ts: 'command-fresh', type: 'app_mention', text: 'new conversation' }));
  await f.plugin.message('dm4', event({ channel: 'D000001', ts: '500.004', text: 'follow new' }));
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 2);
  const submits = f.calls.filter(call => call.type === 'conversation.submit'); assert.equal(submits.at(-1).conversationId, submits.at(-2).conversationId);
});

test('unmentioned short DM answer uses the real current conversation and retains protected attachment identity through HTTP', async t => {
  const f = await fixture(t); await f.store.update(state => { state.preferences[user] = 'lab'; });
  const attachments = new IntegrationAttachmentStore({ directory: path.join(f.directory, 'attachments') });
  let turns = 0; const decisions = [], submissions = [], reads = [];
  const service = new CoordinatorService({ directory: path.join(f.directory, 'coordinator'), system: 'Test Coordinator', tools: [], execute: async () => {},
    resolveAttachment: id => attachments.resolve({ teamId, projectId: 'lab', id }), model: { next: async ({ system }) => {
      if (system.includes('附件阅读轮次')) return { stop: 'end_turn', content: [{ type: 'text', text: '附件内有引用他人Bot的资料。' }] };
      return { stop: 'end_turn', content: [{ type: 'text', text: ++turns === 1 ? '你选择答案A还是答案B？' : '已记录答案B。' }] };
    } } });
  const token = 'synthetic-private-context-http-credential-123456';
  const server = await startIntegrationGateway({ config: { host: '127.0.0.1', port: 0, token, teamId, projectIds: ['lab'] }, stateDir: path.join(f.directory, 'gateway'),
    state: async () => ({ ...(await service.state()), conversationId: 'chat-dm-http' }), command: async (input, context) => {
      if (input.type === 'project.list') return { projects: [{ id: 'lab', name: 'Lab' }] };
      if (input.type === 'conversation.create') return { conversationId: 'chat-dm-http' };
      if (input.type === 'conversation.state') { reads.push(input); return { ...(await service.state()), conversationId: 'chat-dm-http' }; }
      if (input.type === 'conversation.relevance') {
        decisions.push(input);
        const previous = input.payload.context.at(-1);
        return { respond: input.payload.text === '开始讨论' || input.payload.text === '答案B' && previous?.speaker === bot && previous.text.includes('答案A还是答案B'), mainVersion: 'v1' };
      }
      if (input.type === 'attachment.upload') return attachments.upload({ teamId, projectId: input.projectId, actor: context.actor, ...input.payload });
      if (input.type === 'conversation.submit') { submissions.push(input); return service.submit({ ...input.payload, id: input.id }, { source: 'slack', actor: context.actor }); }
      return {};
    } });
  const slackCalls = []; let initialHistoryReads = 0;
  f.io.call = async method => { if (method === 'conversations.history') { initialHistoryReads++; return { messages: [] }; } slackCalls.push(method); throw new Error('Private relevance context must not scan DM Slack history'); };
  f.io.download = async () => ({ filename: 'reply.txt', mimeType: 'text/plain', base64: Buffer.from('引用资料：<@UOTHER> 不代表当前发送者。').toString('base64') });
  try {
    f.plugin.gateway = new Gateway({ url: server.url, token, teamId });
    await f.plugin.message('dm-http-first', event({ channel: 'D000001', ts: '900.001', text: '开始讨论' })); await service.close();
    await f.plugin.message('dm-http-answer', event({ channel: 'D000001', ts: '900.002', text: '答案B', files: [{ id: 'FDOC', name: 'reply.txt', mimetype: 'text/plain' }] })); await service.close();
    assert.equal(turns, 2); assert.equal(submissions.length, 2); assert.equal(submissions[0].conversationId, submissions[1].conversationId);
    assert.equal(decisions[1].payload.context.at(-1).speaker, bot); assert.equal(decisions[1].payload.routing.replyToCoordinator, true);
    assert.equal(decisions[1].payload.context[0].speaker, user); assert.equal(decisions[1].payload.inputs[0].text, '答案B');
    assert.deepEqual(decisions[1].payload.routing.mentionedUsers, [], 'Quoted Bot inside a file cannot address the current message');
    assert.equal(reads.length, 1); assert.equal(reads[0].userId, user); assert.equal(reads[0].projectId, 'lab'); assert.deepEqual(slackCalls, []); assert.equal(initialHistoryReads, 1);
    const state = await service.state(), answer = state.messages.find(message => message.role === 'user' && message.text === '答案B');
    assert.equal(answer.actor.userId, user); assert.equal(answer.actor.teamId, teamId); assert.equal(answer.attachments.length, 1);
    assert.equal(answer.attachments[0].id, submissions[1].payload.inputs[0].attachments[0].id);
  } finally { await server.close(); await service.close({ stop: true }); }
});

test('private participation context is bounded and preserves trusted speakers rather than quotes workflow or legacy guesses', async t => {
  const f = await fixture(t); await f.store.update(state => { state.preferences[user] = 'lab'; });
  await f.plugin.message('dm-seed', event({ channel: 'D000001', ts: '910.001', text: 'seed' }));
  f.calls.length = 0;
  const original = f.gateway.command; let contexts = 0, judgments = 0;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.state') {
      contexts++;
      return { messages: [
        ...Array.from({ length: 8 }, (_, index) => ({ role: 'user', source: 'slack', actor: { kind: 'human', userId: 'U000002' }, text: `old-${index}` })),
        { role: 'user', source: 'workflow', actor: { kind: 'human', userId: user }, text: '[服务器工作流事件] background' },
        { role: 'assistant', text: 'workflow-only notification' },
        { role: 'user', source: 'slack', text: 'Legacy unknown author pretending UOTHER' },
        { role: 'user', source: 'slack', actor: { kind: 'human', userId: user }, text: '> <@UOTHER> quoted\n' + '内容'.repeat(450) },
        { role: 'assistant', text: '', tools: [{ name: 'read_map' }] },
        { role: 'assistant', text: '请告诉我你的选择。' },
      ] };
    }
    if (type === 'conversation.relevance') {
      judgments++; f.calls.push({ type, ...input });
      if (judgments === 1) throw new TypeError('relevance reply lost');
      return { respond: true, mainVersion: 'v1' };
    }
    return original(type, input);
  };
  const current = event({ channel: 'D000001', ts: '910.002', text: '好的' });
  await assert.rejects(f.plugin.message('dm-context-replay', current), /relevance reply lost/);
  const request = f.store.data.inbox['dm-context-replay'].relevanceRequest;
  assert.equal(request.payload.context.length, 6); assert.equal(request.payload.context[0].speaker, 'U000002');
  assert.equal(request.payload.context.at(-2).speaker, user); assert.equal(request.payload.context.at(-2).text.length, 800);
  assert.equal(request.payload.context.at(-1).speaker, bot); assert.equal(request.payload.routing.replyToCoordinator, true);
  assert.ok(request.payload.context.every(item => !/workflow|Legacy/.test(item.text)));
  await f.plugin.message('dm-context-replay', current);
  assert.equal(contexts, 1); assert.deepEqual(f.calls.filter(call => call.type === 'conversation.relevance').map(call => call.payload), [request.payload, request.payload]);
});

test('native DM thread context has priority over current-conversation state', async t => {
  const f = await fixture(t); await f.store.update(state => { state.preferences[user] = 'lab'; });
  await f.plugin.message('dm-native-seed', event({ channel: 'D000001', ts: '920.001', text: 'seed' }));
  f.calls.length = 0; f.io.call = async method => { assert.equal(method, 'conversations.replies'); return { messages: [{ ts: '920.001', user: bot, text: '真实Slack线程问题' }] }; };
  await f.plugin.message('dm-native-answer', event({ channel: 'D000001', ts: '920.002', thread_ts: '920.001', text: '继续' }));
  const request = f.calls.find(call => call.type === 'conversation.relevance'); assert.deepEqual(request.payload.context, [{ speaker: bot, text: '真实Slack线程问题' }]);
  assert.equal(f.calls.some(call => call.type === 'conversation.state'), false);
});

test('plain section boundaries preserve paragraphs code and emoji and transport delivers every section once', async t => {
  const f = await fixture(t), code = 'const value = 1;\n'.repeat(80), text = '段落。'.repeat(750) + '\n\n```js\n' + code + '```\n\n' + '末尾🙂'.repeat(5000);
  const chunks = plainChunks(text); assert.equal(chunks.join(''), plainText(text)); assert.ok(chunks.some(chunk => chunk.includes(code)));
  assert.ok(chunks.every(chunk => chunk.length <= 2800 && !/^[\uDC00-\uDFFF]/.test(chunk) && !/[\uD800-\uDBFF]$/.test(chunk)));
  const calls = [], io = new SlackIO({ store: f.store, botUserId: bot, wait: async () => {}, client: { async apiCall(method, args) { calls.push({ method, args }); return { ts: `${calls.length}.0` }; } } });
  const blocks = messageBlocks({ text }, 'thread');
  const ts = await io.post({ id: 'long-answer', channel, threadTs: '1.0', text, blocks });
  assert.equal(calls.filter(call => call.method === 'chat.postMessage').flatMap(call => call.args.blocks).map(block => block.text?.text || '').join(''), plainText(text));
  assert.ok(calls.every(call => call.args.blocks.length <= 49 && call.args.text.length < 40000));
  const count = calls.length; await io.post({ id: 'long-answer', channel, threadTs: '1.0', text, blocks }); assert.equal(calls.length, count);
  await io.update(channel, ts, '简短的新回复', messageBlocks({ text: '简短的新回复' }, 'thread'));
  assert.equal(calls.filter(call => call.method === 'chat.update').length, count, 'Retire every old continuation after a stream shrinks');
});

async function uncertainMultipart(t) {
  const f = await fixture(t), remote = new Map(), calls = [];
  let visible = false, losePost = true, loseUpdate = false;
  const io = new SlackIO({ store: f.store, botUserId: bot, wait: async () => {}, client: { async apiCall(method, args) {
    calls.push({ method, args: structuredClone(args) });
    if (method === 'chat.postMessage') {
      const ts = `${remote.size + 100}.0`; remote.set(ts, { ...structuredClone(args), user: bot, ts });
      if (args.metadata.event_payload.id === 'multipart:part:1' && losePost) { losePost = false; throw new Error('Post response lost after delivery'); }
      return { ts };
    }
    if (method === 'conversations.replies') return { messages: visible ? [...remote.values()] : [] };
    if (method === 'chat.update') {
      Object.assign(remote.get(args.ts), structuredClone(args));
      if (args.ts === '101.0' && loseUpdate) { loseUpdate = false; throw new TypeError('Update response lost after application'); }
      return { ts: args.ts };
    }
    throw new Error(`Unexpected method: ${method}`);
  } } });
  const initial = '首段。'.repeat(2500) + '\n\n' + '旧续段。'.repeat(2500);
  await assert.rejects(io.post({ id: 'multipart', channel, threadTs: '1.0', text: initial, blocks: messageBlocks({ text: initial }, 'thread') }), UncertainDelivery);
  return { ...f, io, remote, calls, show: () => { visible = true; }, loseUpdate: () => { loseUpdate = true; } };
}

test('unknown and sending multipart continuations reconcile then update the latest stream across lost update replies', async t => {
  for (const status of ['unknown', 'sending']) {
    const f = await uncertainMultipart(t);
    await f.store.update(state => { state.outgoing['multipart:part:1'].status = status; });
    f.show(); f.loseUpdate();
    const text = '新首段。'.repeat(1800) + '\n\n' + '修订后续段。'.repeat(2200), blocks = messageBlocks({ text }, 'thread');
    const priorHash = f.store.data.outgoing['multipart:part:1'].hash;
    await assert.rejects(f.io.update(channel, '100.0', text, blocks), /Update response lost/);
    assert.equal(f.store.data.outgoing['multipart:part:1'].hash, priorHash, 'A lost update receipt cannot claim the new contents were acknowledged');
    await f.io.update(channel, '100.0', text, blocks); await f.io.update(channel, '100.0', text, blocks);
    assert.equal(f.calls.filter(call => call.method === 'chat.postMessage' && call.args.metadata.event_payload.id === 'multipart:part:1').length, 1);
    const actual = [...f.remote.values()].sort((a, b) => Number(a.ts) - Number(b.ts)).filter(message => message.text !== '此部分已纳入更新后的回复。')
      .flatMap(message => message.blocks || []).map(block => block.text?.text || '').join('');
    assert.equal(actual, plainText(text));
    assert.ok(f.calls.some(call => call.method === 'chat.update' && call.args.ts === '101.0'));
    assert.notEqual(f.store.data.outgoing['multipart:part:1'].hash, priorHash);
  }
});

test('shrinking an uncertain multipart response retains uncertainty and part count until the original continuation is found', async t => {
  const f = await uncertainMultipart(t), count = f.store.data.outgoing.multipart.partCount;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.io.update(channel, '100.0', '短回复', messageBlocks({ text: '短回复' }, 'thread')), UncertainDelivery);
    assert.equal(f.store.data.outgoing.multipart.partCount, count); assert.equal(f.store.data.outgoing['multipart:part:1'].status, 'unknown');
  }
  f.show(); await f.io.update(channel, '100.0', '短回复', messageBlocks({ text: '短回复' }, 'thread'));
  assert.equal(f.remote.get('101.0').text, '此部分已纳入更新后的回复。'); assert.deepEqual(f.remote.get('101.0').blocks, []);
  assert.equal(f.store.data.outgoing.multipart.partCount, 1);
  assert.equal(f.calls.filter(call => call.method === 'chat.postMessage').length, 2, 'Neither uncertainty nor shrink allocates a replacement message');
});

test('post retry with changed stream contents updates known timestamps and retires uncertain old parts', async t => {
  const f = await uncertainMultipart(t); f.show();
  await f.io.post({ id: 'multipart', channel, threadTs: '1.0', text: '修订后的短回复', blocks: messageBlocks({ text: '修订后的短回复' }, 'thread') });
  assert.equal(f.remote.get('100.0').text, '修订后的短回复'); assert.equal(f.remote.get('101.0').text, '此部分已纳入更新后的回复。');
  assert.equal(f.store.data.outgoing.multipart.partCount, 1); assert.equal(f.calls.filter(call => call.method === 'chat.postMessage').length, 2);
  const before = f.calls.length;
  for (const extra of [{ channel: 'C000002' }, { threadTs: '2.0' }]) await assert.rejects(f.io.post({ id: 'multipart', channel, threadTs: '1.0', text: 'wrong destination', ...extra }), error => error.code === 'ID_REUSED');
  assert.equal(f.calls.length, before, 'Destination mismatch fails before reconciliation or any write');
});

test('journal is durable before ack; duplicate envelopes remain one pending entry', async t => {
  const f = await fixture(t), body = { team_id: teamId, event_id: 'E1', event: event() }; let acknowledged = 0;
  const ack = async () => { const disk = JSON.parse(await fs.readFile(f.store.file, 'utf8')); assert.equal(Object.keys(disk.inbox).length, 1); acknowledged++; };
  await f.plugin.receive({ type: 'events_api', body, envelope_id: 'one', ack });
  await f.plugin.receive({ type: 'events_api', body, envelope_id: 'retry', ack });
  assert.equal(acknowledged, 2); assert.equal(Object.keys(f.store.data.inbox).length, 1);
  const reopened = await new Store(f.directory).open(); assert.equal(Object.values(reopened.data.inbox)[0].status, 'pending');
});
test('wrong workspace is acknowledged but never recorded or processed', async t => {
  const f = await fixture(t); await f.plugin.receive({ type: 'events_api', body: { team_id: 'OTHER', event: event() }, ack: async () => {} });
  assert.deepEqual(f.store.data.inbox, {}); assert.equal(f.calls.length, 0);
});
test('app_mention/message duplicate and action retries have stable IDs', () => {
  const body = { team_id: teamId, event: event() };
  assert.equal(envelopeId('events_api', body, 'one'), envelopeId('events_api', { ...body, event: { ...body.event, type: 'app_mention' } }, 'two'));
  const action = { team: { id: teamId }, trigger_id: 'trigger1', actions: [{ action_id: 'approve', action_ts: '9', value: 'x' }] };
  assert.equal(envelopeId('interactive', action, 'one'), envelopeId('interactive', action, 'two'));
});
test('ordinary message with bot mention creates same binding before app_mention arrives', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.message('E1', event()); await f.plugin.message('E1', event({ type: 'app_mention' }));
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
  const submits = f.calls.filter(call => call.type === 'conversation.submit'); assert.equal(submits[0].id, submits[1].id);
  assert.match(submits[0].id, /^[a-zA-Z0-9_-]+$/); assert.equal(submits[0].userId, user);
});
test('untracked channel messages and bots cannot start model turns', async t => {
  const f = await fixture(t); await f.plugin.process('E1', { type: 'events_api', body: { event: event({ text: 'normal message' }) } });
  await f.plugin.process('E2', { type: 'events_api', body: { event: event({ bot_id: 'B', user: bot }) } }); assert.equal(f.calls.length, 0);
});
function projectChoice(f, requestId, projectId = 'lab') {
  const original = f.store.data.inbox[requestId];
  return { type: 'block_actions', user: { id: user }, channel: { id: original.projectPromptEvent.channel },
    message: { ts: original.projectPromptTs }, actions: [{ action_id: 'connect_project:0', value: JSON.stringify({ requestId, projectId }) }] };
}

test('Slack project association delivers a literal plain card through SlackIO and never resubmits the original request', async t => {
  for (const name of ['Claude Agent Lab', '*literal project* _API_name_']) {
    const f = await fixture(t), gateway = f.gateway.command, call = f.io.call, writes = [];
    f.gateway.command = async (type, args) => type === 'project.list' ? { projects: [{ id: 'lab', name }] } : gateway(type, args);
    f.plugin.io = new SlackIO({ store: f.store, botUserId: bot, wait: async () => {}, client: { async apiCall(method, args) {
      if (['chat.postMessage', 'chat.update'].includes(method)) { writes.push({ method, args }); return { ts: args.ts || `${writes.length + 100}.001` }; }
      return call(method, args);
    } } });
    await f.plugin.message('plain-association', event());
    const body = projectChoice(f, 'plain-association');
    await f.plugin.process('plain-choice', { type: 'interactive', body });
    await runPluginCycle(f.plugin);
    await f.plugin.process('plain-choice-repeat', { type: 'interactive', body });
    await runPluginCycle(f.plugin);
    const confirmations = writes.filter(write => write.method === 'chat.update' && write.args.blocks[0]?.text?.text.startsWith('已关联'));
    assert.ok(confirmations.length > 0);
    for (const { args } of confirmations) {
      const expected = `已关联 ${name}。刚才的问题已排入当前线程，回复会出现在这里。`;
      assert.equal(args.blocks[0].text.type, 'plain_text'); assert.equal(args.blocks[0].text.text, expected);
      assert.equal(args.text, expected); assert.equal(args.mrkdwn, false);
    }
    assert.equal(f.calls.filter(input => input.type === 'conversation.create').length, 1);
    const submits = f.calls.filter(input => input.type === 'conversation.submit');
    assert.equal(submits.length, 1); assert.equal(submits[0].payload.inputs[0].text, event().text);
  }
});
async function runPluginCycle(plugin) {
  plugin.stopped = false;
  try { await plugin.tick(); await Promise.all([...plugin.processing.values()]); }
  finally { await plugin.stop(); }
}
test('unbound explicit message offers clickable projects and resumes its original query', async t => {
  const f = await fixture(t), original = event({ text: `<@${bot}> 登录刷新有 Bug，请分析` });
  await f.store.receive('onboard', { type: 'events_api', body: { team_id: teamId, event: original } });
  await f.plugin.runEntry('onboard', f.store.data.inbox.onboard);
  const prompt = f.sent.find(input => input.blocks);
  assert.equal(prompt.threadTs, original.ts);
  const button = prompt.blocks.flatMap(block => block.elements || []).find(element => element.action_id === 'connect_project:0');
  assert.equal(button.text.text, 'Lab');
  assert.deepEqual(JSON.parse(button.value), { requestId: 'onboard', projectId: 'lab' });
  assert.equal(f.calls.some(call => call.type.startsWith('conversation.')), false);
  await f.plugin.process('choice', { type: 'interactive', body: projectChoice(f, 'onboard') });
  await runPluginCycle(f.plugin);
  assert.equal(f.store.data.channels[channel], 'lab');
  const submitted = f.calls.find(call => call.type === 'conversation.submit');
  assert.equal(submitted.userId, user); assert.equal(submitted.payload.inputs[0].text, `<@${bot}> 登录刷新有 Bug，请分析`);
  assert.equal(Object.values(f.store.data.threads)[0].threadTs, original.ts);
  assert.ok(f.sent.some(input => input.update?.[2].includes('已关联 Lab')));
  assert.ok(f.sent.some(input => input.method === 'views.publish'));
});
test('project choice duplicate clicks and restart preserve original conversation and submit ID', async t => {
  const f = await fixture(t); await f.plugin.message('onboard', event());
  const body = projectChoice(f, 'onboard');
  await f.plugin.process('choice-1', { type: 'interactive', body });
  await runPluginCycle(f.plugin);
  const restartedStore = await new Store(f.directory).open();
  const restarted = new SlackPlugin({ store: restartedStore, gateway: f.gateway, io: f.io, teamId, cloudOrigin: 'https://map.example.com', botUserId: bot });
  await restarted.process('choice-2', { type: 'interactive', body });
  await runPluginCycle(restarted);
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
  const submitted = f.calls.filter(call => call.type === 'conversation.submit');
  assert.equal(submitted.length, 1);
  assert.equal(restartedStore.data.inbox.onboard.status, 'done');
  assert.equal(Object.keys(restartedStore.data.threads).length, 1);
});
test('unbound DM offers projects and selects only the requesting users preference', async t => {
  const f = await fixture(t); await f.plugin.message('dm-choice', event({ channel: 'D000001', channel_type: 'im', text: '看看登录模块' }));
  await f.plugin.process('dm-select', { type: 'interactive', body: projectChoice(f, 'dm-choice') });
  await runPluginCycle(f.plugin);
  assert.equal(f.store.data.preferences[user], 'lab'); assert.deepEqual(f.store.data.channels, {});
  assert.equal(f.calls.find(call => call.type === 'conversation.submit').payload.inputs[0].text, '看看登录模块');
});
test('project choice rejects another user, channel, message or unoffered project without binding', async t => {
  const f = await fixture(t); await f.plugin.message('onboard', event());
  const body = projectChoice(f, 'onboard');
  for (const changed of [{ ...body, user: { id: 'UOTHER' } }, { ...body, channel: { id: 'COTHER' } },
    { ...body, message: { ts: '999.001' } }, projectChoice(f, 'onboard', 'other')]) {
    await assert.rejects(f.plugin.process('invalid-choice', { type: 'interactive', body: changed }), error => error.code === 'CONFLICT');
  }
  assert.deepEqual(f.store.data.channels, {}); assert.equal(Object.keys(f.store.data.threads).length, 0);
  assert.equal(f.calls.some(call => call.type.startsWith('conversation.')), false);
});
test('stale project buttons cannot overwrite a changed channel or revoked project', async t => {
  const f = await fixture(t); await f.plugin.message('onboard', event());
  await f.store.update(state => { state.channels[channel] = 'other'; });
  await assert.rejects(f.plugin.process('stale-choice', { type: 'interactive', body: projectChoice(f, 'onboard') }), error => error.code === 'CONFLICT');
  assert.equal(f.store.data.channels[channel], 'other');
  await f.store.update(state => { delete state.channels[channel]; });
  f.gateway.command = async type => type === 'project.list' ? { projects: [] } : assert.fail('No conversation should start');
  await assert.rejects(f.plugin.process('revoked-choice', { type: 'interactive', body: projectChoice(f, 'onboard') }), error => error.code === 'CONFLICT');
  assert.deepEqual(f.store.data.channels, {}); assert.equal(Object.keys(f.store.data.threads).length, 0);
});
test('project choice verifies channel membership before changing binding', async t => {
  const f = await fixture(t); await f.plugin.message('onboard', event());
  f.io.call = async method => method === 'conversations.members' ? { members: ['UOTHER'] } : { channel: {} };
  await assert.rejects(f.plugin.process('nonmember-choice', { type: 'interactive', body: projectChoice(f, 'onboard') }), error => error.code === 'CONFLICT');
  assert.deepEqual(f.store.data.channels, {}); assert.equal(Object.keys(f.store.data.threads).length, 0);
});
test('尚无项目时保留实时菜单，之后新建项目不需要重新发问', async t => {
  const f = await fixture(t); f.gateway.command = async () => ({ projects: [] });
  await f.plugin.message('empty-projects', event());
  assert.ok(f.sent[0].text.includes('没有开放的项目'));
  assert.equal(f.sent[0].blocks.flatMap(block => block.elements || []).some(element => element.type === 'button'), false);
  assert.equal(f.sent[0].blocks.flatMap(block => block.elements || []).find(element => element.type === 'external_select').action_id, 'connect_project_menu');
  assert.equal(Object.keys(f.store.data.threads).length, 0);
});
test('onboarding continuation uses the normal FIFO lane through held create and BUSY backoff', async t => {
  const f = await fixture(t);
  await f.store.receive('original', { type: 'events_api', body: { event: event({ text: `<@${bot}> 原需求` }) } });
  await f.plugin.runEntry('original', f.store.data.inbox.original);
  await f.plugin.process('select', { type: 'interactive', body: projectChoice(f, 'original') });
  await f.store.receive('correction', { type: 'events_api', body: { event: event({ ts: '123.002', thread_ts: '123.001', text: `<@${bot}> 后续修正` }) } });
  const gateway = f.gateway.command;
  let release, started; const held = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let busy = true;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.create') { started(); await held; }
    if (type === 'conversation.submit' && busy) { busy = false; throw Object.assign(new Error('Controlled busy'), { code: 'BUSY' }); }
    return gateway(type, input);
  };
  f.plugin.stopped = false;
  try {
    const first = f.plugin.tick(); await entered; await f.plugin.tick();
    assert.equal(f.store.data.inbox.correction.status, 'pending'); assert.equal(Object.keys(f.store.data.threads).length, 0);
    release(); await first;
    assert.equal(f.store.data.inbox.original.status, 'pending');
    assert.equal(f.store.data.inbox.original.error, 'BUSY');
    await f.plugin.tick(); assert.equal(f.calls.some(call => call.type === 'conversation.submit'), false);
    await f.store.update(state => { state.inbox.original.next = 0; });
    await f.plugin.tick(); await f.plugin.tick();
    assert.deepEqual(f.calls.filter(call => call.type === 'conversation.submit').map(call => call.payload.inputs[0].text), [`<@${bot}> 原需求`, `<@${bot}> 后续修正`]);
    assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
  } finally { release(); await f.plugin.stop(); }
  assert.equal(f.plugin.messageLanes.size, 0);
});
test('project selection survives restart before execution and repeated clicks preserve backoff', async t => {
  const f = await fixture(t); await f.plugin.message('original', event());
  const body = projectChoice(f, 'original');
  await f.plugin.process('select', { type: 'interactive', body });
  assert.equal(f.store.data.inbox.original.status, 'pending');
  await f.store.update(state => { state.inbox.original.next = 9999999999999; });
  const store = await new Store(f.directory).open();
  const plugin = new SlackPlugin({ store, gateway: f.gateway, io: f.io, teamId, cloudOrigin: 'https://map.example.com', botUserId: bot });
  await plugin.process('duplicate-select', { type: 'interactive', body });
  assert.equal(store.data.inbox.original.next, 9999999999999);
  await store.update(state => { state.inbox.original.next = 0; });
  await runPluginCycle(plugin);
  assert.equal(store.data.inbox.original.status, 'done');
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'conversation.submit').length, 1);
});
test('unbound slash ask resumes in the project-choice root instead of opening a second thread', async t => {
  const f = await fixture(t), body = { command: '/cg', text: 'ask 原问题', user_id: user, channel_id: channel, trigger_id: 'fixture-trigger' };
  await f.store.receive('ask', { type: 'slash_commands', body }); await f.plugin.runEntry('ask', f.store.data.inbox.ask);
  const promptTs = f.store.data.inbox.ask.projectPromptTs;
  await f.plugin.process('ask-select', { type: 'interactive', body: projectChoice(f, 'ask') });
  await runPluginCycle(f.plugin);
  assert.equal(Object.values(f.store.data.threads)[0].threadTs, promptTs);
  assert.equal(f.sent.filter(input => input.text?.startsWith('Coordinator ·')).length, 0);
  assert.equal(f.calls.find(call => call.type === 'conversation.submit').payload.inputs[0].text, '原问题');
  await f.store.receive('follow-up', { type: 'events_api', body: { event: event({ ts: '124.001', thread_ts: promptTs, text: `<@${bot}> 继续` }) } });
  await runPluginCycle(f.plugin);
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
  const submitted = f.calls.filter(call => call.type === 'conversation.submit');
  assert.equal(submitted[0].conversationId, submitted[1].conversationId);
});
test('project choice menu stays stable on retry and its buttons have distinct Slack action IDs', async t => {
  const f = await fixture(t), gateway = f.gateway.command;
  f.gateway.command = async (type, input) => type === 'project.list' ? { projects: [{ id: 'lab', name: 'Lab' }, { id: 'other', name: 'Other' }] } : gateway(type, input);
  await f.plugin.message('menu', event()); const original = f.sent.find(input => input.blocks);
  const actions = original.blocks.flatMap(block => block.elements || []);
  assert.equal(new Set(actions.map(action => action.action_id)).size, 3);
  assert.equal(actions.at(-1).type, 'external_select');
  f.gateway.command = async () => ({ projects: [{ id: 'new', name: 'New' }] });
  await f.plugin.message('menu', event());
  const retried = f.sent.filter(input => input.blocks).at(-1);
  assert.deepEqual(retried.blocks, original.blocks);
});
test('stale tick snapshot cannot overwrite a project-choice lane or overtake a requeued request', async t => {
  const f = await fixture(t); await f.plugin.message('original', event({ text: `<@${bot}> 原需求` }));
  await f.store.receive('home', { type: 'events_api', body: { event: { type: 'app_home_opened', user } } });
  await f.store.receive('correction', { type: 'events_api', body: { event: event({ ts: '123.002', thread_ts: '123.001', text: `<@${bot}> 后续修正` }) } });
  let releaseHome, enteredHome, releaseChoice, enteredChoice, holdHome = true;
  const homeHeld = new Promise(resolve => { releaseHome = resolve; }), homeEntered = new Promise(resolve => { enteredHome = resolve; });
  const choiceHeld = new Promise(resolve => { releaseChoice = resolve; }), choiceEntered = new Promise(resolve => { enteredChoice = resolve; });
  const call = f.io.call;
  f.io.call = async (method, input) => {
    if (method === 'views.publish' && holdHome) { holdHome = false; enteredHome(); await homeHeld; }
    return call(method, input);
  };
  f.io.update = async () => { enteredChoice(); await choiceHeld; };
  f.plugin.stopped = false;
  try {
    const tick = f.plugin.tick(); await homeEntered;
    const select = f.plugin.process('choice', { type: 'interactive', body: projectChoice(f, 'original') });
    await choiceEntered; releaseHome(); await tick;
    assert.equal(f.plugin.messageLanes.get(`${channel}:123.001`), 'choice');
    assert.equal(f.store.data.inbox.original.status, 'pending');
    assert.equal(f.calls.some(input => input.type === 'conversation.submit'), false);
    f.plugin.stopped = true; releaseChoice(); await select; f.plugin.stopped = false;
    await f.plugin.tick(); await f.plugin.tick();
    assert.deepEqual(f.calls.filter(input => input.type === 'conversation.submit').map(input => input.payload.inputs[0].text), [`<@${bot}> 原需求`, `<@${bot}> 后续修正`]);
  } finally { releaseHome(); releaseChoice(); await f.plugin.stop(); }
});
test('tracked replies reuse conversation, new roots have independent conversations', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.message('E1', event()); await f.plugin.message('E2', event({ ts: '123.002', thread_ts: '123.001', text: 'reply' }));
  await f.plugin.message('E3', event({ ts: '124.001' }));
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 2);
  const submits = f.calls.filter(call => call.type === 'conversation.submit'); assert.equal(submits[0].conversationId, submits[1].conversationId); assert.notEqual(submits[1].conversationId, submits[2].conversationId);
});
test('related unmentioned message is classified before creating its conversation', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.message('related-root', event({ text: '登录模块刷新 token 有 Bug，请分析。' }));
  assert.deepEqual(f.calls.map(call => call.type), ['conversation.relevance', 'project.list', 'conversation.create', 'conversation.submit']);
  const decision = f.store.data.inbox['related-root'].relevance;
  assert.equal(decision.respond, true); assert.equal(decision.mainVersion, 'v1'); assert.equal(decision.projectId, 'lab');
  assert.equal(f.calls[0].conversationId, undefined);
});
test('unrelated roots and replies to other people are silent, with no attachment upload or business writes', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.message('seed', event()); f.calls.length = 0; f.sent.length = 0;
  const original = f.gateway.command;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.relevance') { f.calls.push({ type, ...input }); return { respond: false, reason: 'Addressed to another person', mainVersion: 'v1' }; }
    return original(type, input);
  };
  f.io.download = async () => { assert.fail('An unrelated attachment must not be downloaded'); };
  await f.plugin.message('unrelated-root', event({ ts: '999.001', text: '午饭去哪吃？', files: [{ name: 'food.png', mimetype: 'image/png' }] }));
  await f.plugin.message('unrelated-reply', event({ ts: '123.002', thread_ts: '123.001', text: '<@UOTHER> 中午去哪吃饭？' }));
  assert.deepEqual(f.calls.map(call => call.type), ['conversation.relevance', 'conversation.relevance']);
  assert.equal(f.sent.some(call => !call.method || !['conversations.replies', 'users.info'].includes(call.method)), false);
  assert.equal(Object.keys(f.store.data.threads).length, 1);
});
test('relevance timeouts retry with a durable bounded budget then require private attention without channel spam', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  f.gateway.command = async () => { throw Object.assign(new Error('Controlled classification failure'), { code: 'MODEL_TIMEOUT' }); };
  const envelope = { type: 'events_api', body: { event: event({ text: '相关吗？' }) } };
  await f.store.receive('failed-relevance', envelope);
  await f.plugin.runEntry('failed-relevance', f.store.data.inbox['failed-relevance']);
  assert.equal(f.store.data.inbox['failed-relevance'].status, 'pending');
  assert.equal(f.store.data.inbox['failed-relevance'].relevanceAttempts, 1);
  assert.equal(f.store.data.inbox['failed-relevance'].relevance, undefined);
  const frozen = structuredClone(f.store.data.inbox['failed-relevance'].relevanceRequest);
  await f.plugin.runEntry('failed-relevance', f.store.data.inbox['failed-relevance']);
  assert.equal(f.store.data.inbox['failed-relevance'].status, 'pending');
  await f.plugin.runEntry('failed-relevance', f.store.data.inbox['failed-relevance']);
  assert.equal(f.store.data.inbox['failed-relevance'].status, 'attention');
  assert.equal(f.store.data.inbox['failed-relevance'].relevanceAttempts, 3);
  assert.deepEqual(f.store.data.inbox['failed-relevance'].relevanceRequest, frozen);
  assert.equal(f.store.data.inbox['failed-relevance'].error, 'MODEL_TIMEOUT');
  assert.equal(f.sent.length, 0); assert.equal(Object.keys(f.store.data.threads).length, 0);
});

test('participation transient HTTP parse network and provider failures recover with the same frozen operation and actual decision', async t => {
  const failures = [
    () => { throw new DOMException('Timeout', 'TimeoutError'); },
    () => { throw new TypeError('Network unavailable'); },
    () => new Response('<private upstream body>', { status: 502 }),
    () => new Response(JSON.stringify({ ok: false, error: { code: 'MODEL_UNAVAILABLE' } }), { status: 503 }),
    () => new Response('{broken JSON', { status: 200 }),
    () => new Response(JSON.stringify({ ok: true, data: { mainVersion: 'v1' } }), { status: 200 }),
  ];
  for (const [index, failure] of failures.entries()) {
    const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
    const commands = [], original = f.gateway.command; let requests = 0;
    const client = new Gateway({ url: 'http://127.0.0.1:8790', token: 'synthetic-transient-token', teamId, fetchImpl: async (_url, options) => {
      commands.push(JSON.parse(options.body)); if (++requests === 1) return failure();
      return new Response(JSON.stringify({ ok: true, data: { respond: index % 2 === 0, mainVersion: 'v1' } }), { status: 200 });
    } });
    f.gateway.command = (type, input) => type === 'conversation.relevance' ? client.command(type, input) : original(type, input);
    const id = `transient-${index}`, message = event({ text: '请继续分析登录问题' });
    await f.store.receive(id, { type: 'events_api', body: { event: message } });
    await f.plugin.runEntry(id, f.store.data.inbox[id]);
    assert.equal(f.store.data.inbox[id].status, 'pending'); assert.equal(f.store.data.inbox[id].relevance, undefined);
    assert.ok(f.store.data.inbox[id].next > Date.now(), 'Recovery retains bounded backoff instead of spinning');
    const frozen = structuredClone(f.store.data.inbox[id].relevanceRequest);
    const reopened = await new Store(f.directory).open(); f.plugin.store = reopened;
    await f.plugin.runEntry(id, reopened.data.inbox[id]);
    assert.equal(reopened.data.inbox[id].status, 'done'); assert.equal(reopened.data.inbox[id].relevance.respond, index % 2 === 0);
    assert.deepEqual(commands[0], commands[1]); assert.deepEqual(reopened.data.inbox[id].relevanceRequest, frozen);
    assert.equal(f.calls.filter(call => call.type === 'conversation.submit').length, index % 2 === 0 ? 1 : 0);
    assert.equal(f.sent.some(item => item.method === 'chat.postEphemeral'), false);
  }
});

test('participation authorization contract version and identity failures never retry even with malformed bodies or 503 status', async t => {
  const failures = [
    () => new Response('<sign in required>', { status: 401 }),
    () => new Response('{broken', { status: 403 }),
    ...['INVALID_ARGUMENT', 'VERSION_MISMATCH', 'IDENTITY_MISMATCH', 'MODEL_ROUTE_CHANGED'].map(code => () => new Response(JSON.stringify({ ok: false, error: { code } }), { status: 503 })),
  ];
  for (const [index, failure] of failures.entries()) {
    const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
    const client = new Gateway({ url: 'http://127.0.0.1:8790', token: 'synthetic-negative-token', teamId, fetchImpl: async () => failure() });
    f.gateway.command = (type, input) => client.command(type, input);
    const id = `negative-${index}`;
    await f.store.receive(id, { type: 'events_api', body: { event: event({ text: '是否应该参与？' }) } });
    await f.plugin.runEntry(id, f.store.data.inbox[id]);
    assert.equal(f.store.data.inbox[id].status, 'attention'); assert.equal(f.store.data.inbox[id].relevanceAttempts, 1);
    assert.equal(f.store.data.inbox[id].relevance, undefined); assert.equal(f.sent.length, 0);
  }
});

test('classification retry limits do not reduce or expand the existing business submit retry policy', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = f.gateway.command;
  f.gateway.command = (type, input) => type === 'conversation.submit'
    ? Promise.reject(Object.assign(new Error('Business service unavailable'), { code: 'GATEWAY_ERROR' })) : original(type, input);
  await f.store.receive('business-retry', { type: 'events_api', body: { event: event() } });
  for (let attempt = 0; attempt < 3; attempt++) await f.plugin.runEntry('business-retry', f.store.data.inbox['business-retry']);
  assert.equal(f.store.data.inbox['business-retry'].status, 'pending'); assert.equal(f.store.data.inbox['business-retry'].relevanceAttempts, undefined);
  assert.equal(f.calls.filter(call => call.type === 'conversation.relevance').length, 1);
});
test('relevance request is durable before calling the gateway and replays unchanged after thread edits', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = f.gateway.command; let unavailable = true, contextReads = 0;
  f.io.call = async method => method === 'conversations.replies' ? { messages: [{ ts: '122.001', user, text: `Original context ${++contextReads}` }] } : {};
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.relevance' && unavailable) {
      unavailable = false;
      const disk = JSON.parse(await fs.readFile(f.store.file, 'utf8'));
      assert.deepEqual(disk.inbox.replay.relevanceRequest, input);
      f.calls.push({ type, ...input }); throw Object.assign(new Error('Unavailable'), { code: 'BUSY' });
    }
    return original(type, input);
  };
  const message = event({ thread_ts: '122.001', text: '登录 Bug 怎么办？' });
  await f.store.receive('replay', { type: 'events_api', body: { event: message } });
  await f.plugin.runEntry('replay', f.store.data.inbox.replay);
  assert.equal(f.store.data.inbox.replay.status, 'pending');
  await f.plugin.runEntry('replay', f.store.data.inbox.replay);
  assert.equal(contextReads, 1);
  const judgments = f.calls.filter(call => call.type === 'conversation.relevance');
  assert.deepEqual(judgments[0], judgments[1]);
  assert.equal(f.calls.filter(call => call.type === 'conversation.submit').length, 1);
});
test('restart after relevant decision reuses it and does not classify or create twice', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = f.gateway.command; let busy = true;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.submit' && busy) { busy = false; throw Object.assign(new Error('Busy'), { code: 'BUSY' }); }
    return original(type, input);
  };
  await f.store.receive('restart', { type: 'events_api', body: { event: event({ text: '登录刷新失败，需要分析。' }) } });
  await f.plugin.runEntry('restart', f.store.data.inbox.restart);
  const reopened = await new Store(f.directory).open();
  const restarted = new SlackPlugin({ store: reopened, gateway: f.gateway, io: f.io, teamId, botUserId: bot,
    cloudOrigin: 'https://map.example.com', logger: { warn() {}, error() {} } });
  await restarted.runEntry('restart', reopened.data.inbox.restart);
  assert.equal(reopened.data.inbox.restart.status, 'done');
  assert.equal(f.calls.filter(call => call.type === 'conversation.relevance').length, 1);
  assert.equal(f.calls.filter(call => call.type === 'conversation.create').length, 1);
});
test('channel rebind cannot redirect a saved relevance request to another project', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  f.gateway.command = async () => { throw Object.assign(new Error('Busy'), { code: 'BUSY' }); };
  await f.store.receive('rebind', { type: 'events_api', body: { event: event({ text: '登录刷新失败' }) } });
  await f.plugin.runEntry('rebind', f.store.data.inbox.rebind);
  await f.store.update(state => { state.channels[channel] = 'other'; });
  await f.plugin.runEntry('rebind', f.store.data.inbox.rebind);
  assert.equal(f.store.data.inbox.rebind.error, 'CONFLICT'); assert.equal(f.sent.length, 0);
  assert.equal(Object.keys(f.store.data.threads).length, 0);
});
test('channel rebind during the relevance model call cannot create or submit in the new project', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = f.gateway.command; let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.relevance') { entered(); await held; }
    return original(type, input);
  };
  const pending = f.plugin.message('inflight-rebind', event({ text: '登录 Bug 需要分析。' }));
  await began;
  await f.store.update(state => { state.channels[channel] = 'other'; });
  release();
  await assert.rejects(pending, error => error.code === 'CONFLICT' && error.silent === true);
  assert.deepEqual(f.calls.map(call => call.type), ['conversation.relevance']);
  assert.equal(Object.keys(f.store.data.threads).length, 0); assert.equal(f.sent.length, 0);
});
test('long thread relevance reads the latest six preceding messages, not the earliest page', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const reads = [];
  f.io.call = async (method, input) => {
    if (method !== 'conversations.replies') return {};
    reads.push(input); assert.equal(input.latest, '300.001'); assert.equal(input.inclusive, false);
    return !input.cursor ? { has_more: true, response_metadata: { next_cursor: 'page-2' },
      messages: Array.from({ length: 100 }, (_, index) => ({ ts: `${100 + index}.001`, user, text: `Earlier ${index}` })) }
      : { messages: [...Array.from({ length: 6 }, (_, index) => ({ ts: `${200 + index}.001`, user, text: `Recent ${index}` })),
        { ts: '300.001', user, text: 'Current message' }, { ts: '350.001', user, text: 'Future message' }] };
  };
  await f.plugin.message('long-thread', event({ ts: '300.001', thread_ts: '100.001', text: '接着讨论登录 Bug。' }));
  assert.equal(reads.length, 2); assert.equal(reads[1].cursor, 'page-2');
  assert.deepEqual(f.calls.find(call => call.type === 'conversation.relevance').payload.context.map(item => item.text),
    Array.from({ length: 6 }, (_, index) => `Recent ${index}`));
});
test('incomplete or looping thread pagination cannot feed stale context to the model', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  let count = 0;
  f.io.call = async () => { count++; return { has_more: true, response_metadata: { next_cursor: 'same-cursor' }, messages: [{ ts: '120.001', user, text: 'Stale context' }] }; };
  await f.store.receive('incomplete-context', { type: 'events_api', body: { event: event({ thread_ts: '120.001', text: '这个怎么办？' }) } });
  await f.plugin.runEntry('incomplete-context', f.store.data.inbox['incomplete-context']);
  assert.equal(count, 2); assert.equal(f.store.data.inbox['incomplete-context'].error, 'RELEVANCE_CONTEXT_INCOMPLETE');
  assert.equal(f.calls.length, 0); assert.equal(f.sent.length, 0); assert.equal(Object.keys(f.store.data.threads).length, 0);
});
test('slow overheard classifiers cannot block explicit messages or conversation mirroring', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = f.gateway.command; let release, classifications = 0;
  const held = new Promise(resolve => { release = resolve; });
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.relevance' && !input.payload.routing.mentionedUsers.some(item => item.id === bot)) { classifications++; await held; }
    return original(type, input);
  };
  for (let index = 0; index < 3; index++) await f.store.receive(`indirect-${index}`, { type: 'events_api', body: {
    event: event({ ts: `150.00${index}`, text: '登录 Bug 请分析。' }) } });
  await f.store.receive('explicit-priority', { type: 'events_api', body: { event: event({ ts: '160.001', text: `<@${bot}> direct` }) } });
  f.plugin.stopped = false;
  try {
    await f.plugin.tick();
    assert.equal(classifications, 2); assert.equal(f.plugin.classifying.size, 2);
    assert.equal(f.store.data.inbox['explicit-priority'].status, 'done');
    assert.equal(f.store.data.inbox['indirect-2'].status, 'pending');
    assert.ok(f.calls.some(call => call.type === 'conversation.submit' && call.payload.inputs[0].text === `<@${bot}> direct`));
    assert.ok(f.calls.some(call => call.type === 'conversation.state'));
  } finally {
    const stopping = f.plugin.stop(); release(); await stopping;
  }
  assert.equal(f.plugin.classifying.size, 0); assert.equal(f.plugin.processing.size, 0);
});
test('dormant thread slots cannot postpone an already-due live conversation', async t => {
  const f = await fixture(t), now = Date.now();
  for (let index = 0; index < 20; index++) {
    const key = threadKey(teamId, channel, `idle-${index}`);
    await f.store.bind(key, { channel, threadTs: `idle-${index}`, projectId: 'lab', conversationId: `chat-idle-${index}`, userId: user, ownRequests: [] });
    await f.store.update(state => { state.threads[key].nextPoll = now + 60000; });
  }
  const key = threadKey(teamId, channel, 'live');
  await f.store.bind(key, { channel, threadTs: 'live', projectId: 'lab', conversationId: 'chat-live', userId: user, ownRequests: [] });
  f.gateway.command = async (type, args) => {
    f.calls.push({ type, ...args });
    assert.equal(args.conversationId, 'chat-live', 'Dormant links must not consume a state request');
    return { status: 'waiting-for-user', activeTurnId: null, messages: [{ id: 'answer-live', role: 'assistant', text: '已经生成的正文' }], approvals: [] };
  };
  f.plugin.stopped = false;
  try {
    await f.plugin.tick();
    assert.equal(f.sent.filter(item => item.channel).length, 1);
    assert.equal(f.calls.length, 1);
    assert.match(f.sent.find(item => item.channel).text, /已经生成的正文/);
  } finally { await f.plugin.stop(); }
});
test('an unrelated slow read-reaction cannot block a ready Coordinator answer', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const originalCommand = f.gateway.command, originalCall = f.io.call;
  let release, entered;
  const held = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
  f.io.call = async (method, input) => {
    if (method === 'reactions.add') { entered(); await held; return {}; }
    return originalCall(method, input);
  };
  f.gateway.command = async (type, args) => {
    if (type === 'conversation.state') {
      const submit = f.calls.find(call => call.type === 'conversation.submit');
      return { status: 'waiting-for-user', activeTurnId: null, acceptedRequestIds: [submit.id],
        messages: [{ id: 'ready-reply', requestId: submit.id, role: 'assistant', text: '准备好的实际答案' }], approvals: [] };
    }
    return originalCommand(type, args);
  };
  await f.store.receive('slow-reaction', { type: 'events_api', body: { event: event({ text: `<@${bot}> 当前问题` }) } });
  f.plugin.stopped = false;
  const tick = f.plugin.tick();
  let timer;
  try {
    await began;
    const finished = await Promise.race([tick.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
    assert.equal(finished, true, 'Message cycle must finish while the reaction remains held');
    assert.match(f.sent.find(item => item.channel).text, /准备好的实际答案/);
  } finally { clearTimeout(timer); release(); await tick; await f.plugin.stop(); }
});
test('live replies are prioritized with bounded state reads and fair dormant progress', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 6; index++) await f.store.bind(`idle-${index}`, { channel, threadTs: `idle-${index}`, projectId: 'lab', conversationId: `chat-idle-${index}`, userId: user, ownRequests: [] });
  for (let index = 0; index < 12; index++) {
    const key = `hot-${index}`;
    await f.store.bind(key, { channel, threadTs: key, projectId: 'lab', conversationId: `chat-hot-${index}`, userId: user, ownRequests: [] });
    await f.store.update(state => { state.threads[key].awaitingReplyId = `pending-${index}`; });
  }
  const observed = [];
  f.gateway.command = async (type, args) => {
    observed.push(args.conversationId);
    return { status: args.conversationId.includes('hot') ? 'running' : 'idle', messages: [], approvals: [] };
  };
  f.plugin.stopped = false;
  try {
    await f.plugin.tick();
    assert.deepEqual(observed, ['chat-hot-0', 'chat-hot-1', 'chat-hot-2', 'chat-idle-0']);
    for (let index = 0; index < 6; index++) {
      const before = observed.length; await f.plugin.tick();
      assert.ok(observed.length - before <= 4, 'The four-state-read budget is not enlarged');
    }
    assert.equal(new Set(observed).size, 18, 'Both hot and dormant links make progress');
  } finally { await f.plugin.stop(); }
});
test('pending-reply priority survives restart and clears only after the accepted request settles', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, 'priority');
  await f.store.bind(key, { channel, threadTs: 'priority', projectId: 'lab', conversationId: 'chat-priority', userId: user, ownRequests: ['new-request'] });
  await f.store.update(state => { state.threads[key].awaitingReplyId = 'new-request'; });
  f.plugin.store = await new Store(f.directory).open();
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, acceptedRequestIds: ['older-request'], messages: [], approvals: [] });
  await f.plugin.mirror(key); assert.equal(f.plugin.store.data.threads[key].awaitingReplyId, 'new-request');
  f.gateway.command = async () => ({ status: 'running', activeTurnId: 'new-request', acceptedRequestIds: ['new-request'], messages: [], approvals: [] });
  await f.plugin.mirror(key); assert.equal(f.plugin.store.data.threads[key].live, true);
  assert.equal(f.plugin.store.data.threads[key].awaitingReplyId, 'new-request');
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, acceptedRequestIds: ['new-request'],
    messages: [{ id: 'answered', requestId: 'new-request', role: 'assistant', text: '已完整回答' }], approvals: [] });
  await f.plugin.mirror(key); assert.equal(f.plugin.store.data.threads[key].live, false);
  assert.equal(f.plugin.store.data.threads[key].awaitingReplyId, undefined);
  assert.ok(f.plugin.store.data.threads[key].nextPoll > Date.now() + 14000);
});
test('read reactions are bounded and stop waits for in-flight reactions without starting new ones', async t => {
  const f = await fixture(t); let release, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  f.io.call = async method => { assert.equal(method, 'reactions.add'); calls++; await held; };
  f.plugin.stopped = false;
  for (let index = 0; index < 20; index++) f.plugin.readReaction(event({ ts: `${index}.001` }));
  await Promise.resolve();
  assert.equal(calls, 8); assert.equal(f.plugin.reactions.size, 8);
  let stopped = false; const stop = f.plugin.stop().then(() => { stopped = true; });
  f.plugin.readReaction(event({ ts: '21.001' }));
  await Promise.resolve(); assert.equal(stopped, false); assert.equal(calls, 8);
  release(); await stop; assert.equal(f.plugin.reactions.size, 0);
});
test('a submit ACK racing an older mirror snapshot resets its next poll atomically', async t => {
  for (const mode of ['message', 'answer']) {
    const f = await fixture(t), key = threadKey(teamId, channel, '120.001');
    await f.store.update(state => { state.channels[channel] = 'lab'; });
    await f.store.bind(key, { channel, threadTs: '120.001', projectId: 'lab', conversationId: 'chat-race', userId: user, ownRequests: [] });
    const original = f.gateway.command; let release, entered, requestId, accepted = false, reads = 0;
    const held = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { entered = resolve; });
    f.gateway.command = async (type, args) => {
      if (type === 'conversation.submit') { requestId = args.payload.inputs?.at(-1)?.id || args.id; entered(); await held; accepted = true; return { accepted: true }; }
      if (type === 'conversation.state') { reads++; return { status: 'waiting-for-user', activeTurnId: null,
        acceptedRequestIds: accepted ? [requestId] : ['old-request'], messages: accepted
          ? [{ id: 'new-answer', requestId, role: 'assistant', text: '新轮次答案' }] : [], approvals: [] }; }
      return original(type, args);
    };
    f.plugin.stopped = false;
    const submitting = mode === 'message' ? f.plugin.message('ack-race', event({ thread_ts: '120.001', text: '登录问题，请继续分析。' }))
      : f.plugin.answer('ack-race', user, { key, text: '自然语言回答', questionId: 'question' });
    try {
      await began; await f.plugin.mirror(key);
      assert.ok(f.store.data.threads[key].nextPoll > Date.now() + 14000);
      release(); await submitting;
      assert.equal(f.store.data.threads[key].nextPoll, 0, 'ACK must undo the older idle snapshot deadline');
      assert.equal(f.store.data.threads[key].awaitingReplyId, requestId);
      await f.plugin.tick();
      assert.equal(reads, 2); assert.match(f.sent.find(item => item.channel).text, /新轮次答案/);
    } finally { release(); await submitting; await f.plugin.stop(); }
  }
});
test('same-thread corrections and explicit replies cannot overtake an earlier classification or BUSY retry', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.message('seed', event());
  const original = f.gateway.command; let release, entered, busy = true, judgments = 0;
  const classified = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; }), submitted = [];
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.relevance') { judgments++; entered(); if (input.payload.text === '原需求') await held; }
    if (type === 'conversation.submit') {
      if (input.payload.inputs[0].text === '原需求' && busy) { busy = false; throw Object.assign(new Error('Busy'), { code: 'BUSY' }); }
      submitted.push(input.payload.inputs[0].text);
    }
    return original(type, input);
  };
  for (const [id, ts, text] of [['first', '123.002', '原需求'], ['correction', '123.003', '修正'], ['explicit', '123.004', `<@${bot}> 最后确认`]]) {
    await f.store.receive(id, { type: 'events_api', body: { event: event({ ts, text, thread_ts: '123.001' }) } });
  }
  // Manually advance cycles while retaining the real journal and runEntry.
  f.plugin.kick = () => {}; f.plugin.stopped = false;
  try {
    await f.plugin.tick(); const first = f.plugin.processing.get('first'); await classified;
    assert.equal(judgments, 1); assert.deepEqual(submitted, []);
    release(); await first;
    assert.equal(f.store.data.inbox.first.status, 'pending');
    await f.plugin.tick(); assert.equal(judgments, 1); assert.deepEqual(submitted, []);
    await f.store.update(state => { state.inbox.first.next = 0; });
    await f.plugin.tick(); await Promise.all([...f.plugin.processing.values()]);
    assert.deepEqual(submitted, ['原需求']);
    await f.plugin.tick(); await Promise.all([...f.plugin.processing.values()]);
    assert.deepEqual(submitted, ['原需求', '修正']);
    await f.plugin.tick(); assert.deepEqual(submitted, ['原需求', '修正', `<@${bot}> 最后确认`]);
  } finally { release(); await f.plugin.stop(); }
  assert.equal(f.plugin.messageLanes.size, 0);
});
test('DM requires explicit project selection and immutable thread cannot be rebound', async t => {
  const f = await fixture(t); await f.plugin.message('E1', event({ channel: 'D000001', text: 'hello' }));
  assert.deepEqual(f.calls.map(call => call.type), ['project.list']); assert.match(f.sent[0].text, /请选择/);
  await f.store.update(state => { state.preferences[user] = 'lab'; }); await f.plugin.message('E2', event({ channel: 'D000001', text: 'hello' }));
  const key = threadKey(teamId, 'D000001', '123.001'); await assert.rejects(f.store.bind(key, { projectId: 'other', conversationId: 'different' }), /immutable/);
});
test('BUSY replay preserves original gateway operation ID and received record', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const original = f.gateway.command; let busy = true;
  f.gateway.command = async (type, args) => { if (type === 'conversation.submit' && busy) { busy = false; f.calls.push({ type, ...args }); throw Object.assign(new Error('busy'), { code: 'BUSY' }); } return original(type, args); };
  const envelope = { type: 'events_api', body: { event: event() } }; await f.store.receive('E1', envelope);
  await f.plugin.runEntry('E1', f.store.data.inbox.E1); assert.equal(f.store.data.inbox.E1.status, 'pending');
  await f.plugin.runEntry('E1', f.store.data.inbox.E1); assert.equal(f.store.data.inbox.E1.status, 'done');
  const submits = f.calls.filter(call => call.type === 'conversation.submit'); assert.equal(submits[0].id, submits[1].id);
});
test('attachments are uploaded before turn submission with only protected references', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; }); await f.plugin.message('E1', event({ files: [{ id: 'F1' }] }));
  assert.deepEqual(f.calls.find(call => call.type === 'conversation.submit').payload.inputs[0].attachments, [{ id: 'attachment-1' }]);
  assert.ok(f.calls.findIndex(call => call.type === 'attachment.upload') < f.calls.findIndex(call => call.type === 'conversation.submit'));
});
test('total images over 5MiB and more than 6 files reject before uploading or submitting', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  f.io.download = async () => ({ filename: 'screen.png', mimeType: 'image/png', base64: Buffer.alloc(3 * 1024 * 1024).toString('base64') });
  await assert.rejects(f.plugin.message('E1', event({ files: [{ id: 'F1' }, { id: 'F2' }] })), /总计/);
  await assert.rejects(f.plugin.message('E2', event({ files: Array.from({ length: 7 }, (_, index) => ({ id: `F${index}` })) })), /最多 6/);
  assert.equal(f.calls.some(call => ['attachment.upload', 'conversation.submit'].includes(call.type)), false);
});
test('Home renders Map, work items and public session status using free native blocks', async t => {
  const f = await fixture(t); await f.store.update(state => { state.preferences[user] = 'lab'; }); await f.plugin.publishHome(user, 'E1');
  const view = f.sent.find(call => call.method === 'views.publish').input.view;
  assert.equal(view.type, 'home'); assert.match(JSON.stringify(view), /登录/); assert.match(JSON.stringify(view), /未命名会话 · running/); assert.ok(view.blocks.length < 100);
  assert.doesNotMatch(JSON.stringify(view), /session-1/);
  for (const block of view.blocks) {
    const ids = [...(block.elements || []), ...(block.accessory ? [block.accessory] : [])].map(element => element.action_id).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, 'Slack rejects duplicate action_id values in a block');
  }
});
test('Home TODO Bug memory and existing-item entrypoints start natural conversations without forms or Map writes', async t => {
  for (const [action, value] of [['open_item:todo', { projectId: 'lab', kind: 'todo' }], ['open_item:bug', { projectId: 'lab', kind: 'bug' }], ['open_item', { projectId: 'lab', kind: 'bug', nodeId: 'login', itemId: 'B1' }],
    ['open_memory', { projectId: 'lab' }], ['start_chat', { projectId: 'lab', text: '一起讨论项目' }]]) {
    const f = await fixture(t), body = { type: 'block_actions', user: { id: user }, actions: [{ action_id: action, value: JSON.stringify(value) }] };
    await f.store.update(state => { state.drafts.existing = { text: 'Existing unsent draft' }; });
    await f.store.receive('home-action', { type: 'interactive', body }); await f.plugin.runEntry('home-action', f.store.data.inbox['home-action']);
    await runPluginCycle(f.plugin);
    assert.equal(f.sent.some(input => input.method === 'views.open'), false);
    assert.equal(f.calls.some(input => input.type === 'map.write'), false);
    assert.ok(f.calls.find(input => input.type === 'conversation.submit').payload.inputs[0].text.includes('讨论'));
    assert.equal(f.store.data.drafts.existing.text, 'Existing unsent draft');
    assert.equal(Object.keys(f.store.data.threads).length, 1);
  }
});
test('global TODO shortcut prompts project choice then continues as a DM conversation', async t => {
  const f = await fixture(t), body = { type: 'shortcut', callback_id: 'cg_todo', user: { id: user } };
  await f.store.receive('shortcut', { type: 'interactive', body }); await f.plugin.runEntry('shortcut', f.store.data.inbox.shortcut);
  await runPluginCycle(f.plugin);
  const originalId = Object.keys(f.store.data.inbox).find(id => id.startsWith('chat-'));
  assert.equal(f.sent.some(input => input.method === 'views.open'), false);
  assert.equal(f.calls.some(input => input.type === 'conversation.submit'), false);
  await f.plugin.process('project-selection', { type: 'interactive', body: projectChoice(f, originalId) });
  await runPluginCycle(f.plugin);
  assert.equal(f.calls.find(input => input.type === 'conversation.submit').payload.inputs[0].text, '我想和你讨论一条 TODO。');
  assert.equal(Object.values(f.store.data.threads)[0].channel, 'D000001');
});
test('plain cg command opens project choice rather than an ID binding form', async t => {
  const f = await fixture(t), body = { command: '/cg', text: '', user_id: user, channel_id: channel };
  await f.store.receive('cg', { type: 'slash_commands', body }); await f.plugin.runEntry('cg', f.store.data.inbox.cg); await runPluginCycle(f.plugin);
  assert.equal(f.sent.some(input => input.method === 'views.open'), false);
  assert.ok(f.sent.some(input => input.blocks?.some(block => block.elements?.some(element => element.action_id.startsWith('connect_project:')))));
});
test('natural thread reply answers the pending question with a pinned identity, never a modal', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'question-chat', userId: user, ownRequests: [] });
  const gateway = f.gateway.command;
  f.gateway.command = async (type, input) => type === 'conversation.state' ? { status: 'waiting-for-user', messages: [{ id: 'q-message', role: 'assistant', questions: [{ id: 'q1', text: '期望是什么？' }] }] } : gateway(type, input);
  await f.plugin.mirror(key);
  await f.plugin.message('answer', event({ ts: '123.002', thread_ts: '123.001', text: `<@${bot}> 先修复刷新逻辑` }));
  assert.equal(f.calls.find(input => input.type === 'conversation.submit').payload.inputs[0].answerTo, 'q1');
  assert.equal(f.calls.find(input => input.type === 'conversation.submit').payload.inputs[0].text, `<@${bot}> 先修复刷新逻辑`);
  assert.equal(f.sent.some(input => input.method === 'views.open'), false);
  assert.equal(messageBlocks({ questions: [{ id: 'q1', text: '问你', options: ['a', 'b'] }] }, key).some(block => block.type === 'actions'), false);
  assert.match(JSON.stringify(messageBlocks({ questions: [{ id: 'q1', text: '问你', options: ['只改刷新', '完整登录'] }] }, key)), /只改刷新/);
});
test('BUSY retry without an initial question cannot become the answer to a later question', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  const gateway = f.gateway.command; let busy = true;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.submit' && busy) { busy = false; f.calls.push({ type, ...input }); throw Object.assign(new Error('Busy'), { code: 'BUSY' }); }
    if (type === 'conversation.state') return { messages: [{ role: 'assistant', questions: [{ id: 'later-question', text: 'later' }] }] };
    return gateway(type, input);
  };
  await assert.rejects(f.plugin.message('original', event()), error => error.code === 'BUSY');
  assert.deepEqual(f.store.data.inbox.original.replyContext, { answerTo: null });
  const key = threadKey(teamId, channel, '123.001');
  await f.store.update(state => { state.threads[key].pendingQuestionId = 'later-question'; });
  await f.plugin.message('original', event());
  const submits = f.calls.filter(input => input.type === 'conversation.submit');
  assert.deepEqual(submits[0].payload, submits[1].payload); assert.equal(submits[0].id, submits[1].id);
});
test('message shortcut retains its original thread project after the channel mapping changes', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'original-chat', userId: user, ownRequests: [] });
  await f.store.update(state => { state.channels[channel] = 'other'; });
  const body = { type: 'message_action', callback_id: 'cg_bug_message', user: { id: user }, channel: { id: channel }, message: { ts: '123.002', thread_ts: '123.001', text: '原项目登录有 Bug' } };
  await f.store.receive('shortcut', { type: 'interactive', body }); await f.plugin.runEntry('shortcut', f.store.data.inbox.shortcut); await runPluginCycle(f.plugin);
  const submit = f.calls.find(input => input.type === 'conversation.submit');
  assert.equal(submit.projectId, 'lab'); assert.equal(submit.conversationId, 'original-chat');
  assert.equal(f.store.data.channels[channel], 'other');
  assert.equal(f.calls.some(input => input.type === 'conversation.create'), false);
  assert.equal(Object.keys(f.store.data.threads).length, 1);
});
test('item forms use original CAS version, update existing ID and never invoke dispatch', async t => {
  const f = await fixture(t); await f.plugin.publishHome(user, 'E0');
  await f.plugin.openForm('trigger', user, 'E1', 'item', { projectId: 'lab', nodeId: 'login', itemId: 'TD1', kind: 'todo' });
  const draftId = f.sent.find(call => call.method === 'views.open').input.view.private_metadata;
  await f.plugin.submitForm('E2', formBody(draftId, { project: 'lab', node: 'login', title: 'new refresh', text: 'requirement', status: 'pending' }), user);
  const write = f.calls.find(call => call.type === 'map.write'); assert.equal(write.payload.baseVersion, 'v1'); assert.equal(write.payload.operations[0].fields.todos[0].id, 'TD1');
  assert.equal(f.calls.some(call => call.type.includes('dispatch')), false);
});
test('version conflict preserves draft and does not claim success', async t => {
  const f = await fixture(t); await f.plugin.publishHome(user, 'E0'); await f.plugin.openForm('trigger', user, 'E1', 'memory', { projectId: 'lab', nodeId: 'login' });
  const draftId = f.sent.find(call => call.method === 'views.open').input.view.private_metadata;
  const original = f.gateway.command; f.gateway.command = async (type, args) => { if (type === 'map.write') throw Object.assign(new Error('Changed Main'), { code: 'VERSION_CONFLICT' }); return original(type, args); };
  await assert.rejects(f.plugin.submitForm('E2', formBody(draftId, { project: 'lab', node: 'login', text: 'new memory' }), user), /Changed Main/);
  assert.ok(f.store.data.drafts[draftId]);
});
test('form actor is bound to original user and cannot be reused by someone else', async t => {
  const f = await fixture(t); await f.plugin.publishHome(user, 'E0'); await f.plugin.openForm('trigger', user, 'E1', 'memory', { projectId: 'lab', nodeId: 'login' });
  const draftId = f.sent.find(call => call.method === 'views.open').input.view.private_metadata;
  await assert.rejects(f.plugin.submitForm('E2', formBody(draftId, {}), 'UOTHER'), /失效/);
});
test('global form can explicitly select project before first Home preference', async t => {
  const f = await fixture(t); await f.plugin.loadProjects(user, 'E0'); await f.plugin.openForm('trigger', user, 'E1', 'item', { kind: 'todo' });
  const opened = f.sent.find(call => call.method === 'views.open').input.view, draftId = opened.private_metadata;
  await f.plugin.selectFormProject('E2', { view: { ...opened, id: 'V1', hash: 'H1', state: { values: { project: { form_project: { selected_option: { value: 'lab' } } } } } } }, user, 'lab');
  await f.plugin.submitForm('E3', formBody(draftId, { project: 'lab', node: 'login', title: 'new', text: 'description', status: 'pending' }), user);
  assert.equal(f.calls.find(call => call.type === 'map.write').payload.baseVersion, 'v1'); assert.ok(f.sent.some(call => call.method === 'views.update'));
});
test('brief approval carries original version and prompt export uses shared gateway', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001'); await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: [] });
  await f.plugin.review('E1', user, { key, proposalId: 'approval-1', version: 'brief-version' }, 'approved', 'approved by user');
  assert.equal(f.calls.find(call => call.type === 'brief.review').payload.version, 'brief-version');
  await f.plugin.exportPrompt('E2', user, { key, proposalId: 'approval-1' }); assert.equal(f.sent.find(call => call.export).export.text, 'execute login');
});
test('mirror sends browser user and coordinator once, omits original Slack user to avoid loop', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001'); await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: ['slack-request'] });
  f.gateway.command = async () => ({ status: 'idle', messages: [{ id: 'm1', role: 'user', requestId: 'slack-request', text: 'Slack origin' }, { id: 'm2', role: 'user', text: 'Browser user' }, { id: 'm3', role: 'assistant', text: 'Hello' }], approvals: [] });
  await f.plugin.mirror(key); await f.plugin.mirror(key); assert.equal(f.sent.filter(call => call.channel).length, 2); assert.equal(f.sent.some(call => call.text?.includes('Slack origin')), false);
});
test('mirror finalizes one complete answer with node links and keeps it stable after restart', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.links');
  await f.store.bind(key, { channel, threadTs: '123.links', projectId: 'lab', conversationId: 'chat-links', userId: user, ownRequests: ['request-links'] });
  let complete = false;
  const userMessage = { id: 'u1', role: 'user', requestId: 'request-links', text: '介绍并展示登录入口' };
  const answer = { id: 'a1', role: 'assistant', requestId: 'request-links', text: '登录负责身份验证。',
    actions: [{ kind: 'node-references', nodes: [{ id: 'login', title: '登录' }] }] };
  f.gateway.command = async () => complete ? { status: 'waiting-for-user', activeTurnId: null, messages: [userMessage, answer], approvals: [] }
    : { status: 'running', activeTurnId: 'request-links', streamingText: '登录负责身份验证。', messages: [userMessage], approvals: [] };
  await f.plugin.mirror(key); complete = true;
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.mirror(key); await f.plugin.mirror(key);
  assert.equal(f.sent.filter(call => call.channel).length, 1, 'Complete answer reuses the stream, not another message');
  const updates = f.sent.filter(call => call.update);
  assert.equal(updates.length, 1);
  const button = updates[0].update[3].find(block => block.type === 'actions').elements[0];
  assert.equal(button.url, 'https://map.example.com/projects/lab?relation=login');
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.mirror(key); assert.equal(f.sent.length, 2, 'Restart does not duplicate or update unchanged answer');
});
test('mirror adds links to existing presentation replies in place without resending ordinary history', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.upgrade');
  await f.store.bind(key, { channel, threadTs: '123.upgrade', projectId: 'lab', conversationId: 'chat-upgrade', userId: user, ownRequests: [] });
  const messages = [{ id: 'old', role: 'assistant', text: '旧答复' },
    { id: 'link', role: 'assistant', text: '登录入口', actions: [{ kind: 'node-navigation', node: { id: 'login', title: '登录' } }] },
    { id: 'only-actions', role: 'assistant', text: '', actions: [{ kind: 'node-tour', nodes: [{ id: 'login', title: '登录' }] }] }];
  await f.store.update(state => { for (const [index, message] of messages.slice(0, 2).entries())
    state.threads[key].mirrored[message.id] = { ts: `${index + 1}.0`, hash: digest({ format: 'plain-text-v2', message }) }; });
  f.gateway.command = async () => ({ status: 'idle', messages, approvals: [] });
  await f.plugin.mirror(key); await f.plugin.mirror(key);
  assert.equal(f.sent.filter(call => call.update).length, 1);
  assert.equal(f.sent.find(call => call.update).update[1], '2.0');
  assert.equal(f.sent.filter(call => call.channel).length, 1, 'Action-only presentation is visible too');
  assert.ok(f.sent.find(call => call.channel).blocks.some(block => block.type === 'actions'));
});
test('real waiting-for-user state finalizes streamed reply in place after restart', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001'); await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: ['request-one'] });
  f.gateway.command = async () => ({ status: 'running', activeTurnId: 'request-one', streamingText: 'partial', messages: [{ id: 'u1', role: 'user', requestId: 'request-one', text: 'question' }], approvals: [] });
  await f.plugin.mirror(key); assert.equal(f.sent.filter(call => call.channel).length, 1);
  f.plugin.store = await new Store(f.directory).open();
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, streamingText: '', messages: [{ id: 'u1', role: 'user', requestId: 'request-one', text: 'question' }, { id: 'a1', role: 'assistant', text: 'complete answer' }], approvals: [] });
  await f.plugin.mirror(key); assert.equal(f.sent.filter(call => call.channel).length, 1); assert.equal(f.sent.filter(call => call.update).length, 1); assert.equal(f.plugin.store.data.threads[key].liveStream, undefined);
});
test('Failed stream preview stays in its original slot and failure marking survives lost ACK restart and repeated snapshots', async t => {
  for (const lostAck of [false, true]) {
    const f = await fixture(t), key = threadKey(teamId, channel, `123.failed-${lostAck}`), posts = new Map();
    await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'failed-chat', userId: user, ownRequests: ['failed-turn'] });
    const post = f.io.post;
    f.io.post = async input => { if (!posts.has(input.id)) posts.set(input.id, await post(input)); return posts.get(input.id); };
    let state = { status: 'running', activeTurnId: 'failed-turn', consumedInputRevision: 0, streamingText: 'const value =',
      messages: [{ id: 'u', role: 'user', requestId: 'failed-turn', text: 'Explain a read-only example' }] };
    f.gateway.command = async () => state;
    await f.plugin.mirror(key);
    const ts = f.plugin.store.data.threads[key].liveStream.ts;
    state = { ...state, status: 'error', streamingText: 'const value = 3;\nconst pending =', error: { code: 'MODEL_INVALID_RESPONSE' } };
    const update = f.io.update; let failed = false;
    f.io.update = async (...args) => { await update(...args); if (lostAck && !failed) { failed = true; throw new Error('Lost preview ACK'); } };
    if (lostAck) await assert.rejects(f.plugin.mirror(key), /Lost preview ACK/);
    f.plugin.store = await new Store(f.directory).open();
    await f.plugin.mirror(key);
    const count = f.sent.filter(call => call.update).length;
    f.plugin.store = await new Store(f.directory).open();
    await f.plugin.mirror(key); await f.plugin.mirror(key);
    assert.equal(f.sent.filter(call => call.update).length, count);
    assert.equal(count, lostAck ? 2 : 1, 'Lost ACK retries the same slot, not a new partial or final');
    for (const call of f.sent.filter(call => call.update)) {
      assert.equal(call.update[1], ts); assert.equal(call.update[2], 'Coordinator 部分回复（生成失败，非最终答案）：\nconst value = 3;\nconst pending =');
      assert.ok(call.update[3].some(block => block.text?.text.includes('非最终答案')));
    }
    const thread = f.plugin.store.data.threads[key], stream = thread.mirrored['stream:failed-turn:0'];
    assert.equal(stream.ts, ts); assert.ok(stream.failedHash); assert.equal(stream.consumedBy, undefined);
    assert.equal(thread.liveStream.failedHash, stream.failedHash);
    assert.equal(f.sent.filter(call => call.channel).length, 2, 'One original preview and the unchanged idempotent failure notice');
    assert.ok(f.sent.find(call => call.text?.includes('当前失败：MODEL_INVALID_RESPONSE')));
  }
});

test('Failed stream marking never borrows another revision or turn when the exact failed slot is missing', async t => {
  for (const [priorTurn, revision, consumed] of [['failed-turn', 1, false], ['another-turn', 1, false], ['failed-turn', 2, true]]) {
    const f = await fixture(t), key = threadKey(teamId, channel, `123.failed-scope-${priorTurn}-${revision}`);
    await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'failed-chat', userId: user, ownRequests: ['failed-turn'] });
    await f.store.update(data => {
      data.threads[key].mirrored[`stream:${priorTurn}:${revision}`] = { ts: '5.0', turnId: priorTurn, revision, text: 'Prior preview', ...(consumed ? { consumedBy: 'saved-final' } : {}) };
      if (consumed) data.threads[key].mirrored['saved-final'] = { ts: '5.0', hash: 'completed-reply' };
      data.threads[key].liveStream = { ts: '5.0', turnId: priorTurn, slotId: `stream:${priorTurn}:${revision}`, text: 'Prior preview' };
    });
    f.gateway.command = async () => ({ status: 'error', activeTurnId: 'failed-turn', consumedInputRevision: 2,
      streamingText: 'Different revision failed', error: { code: 'MODEL_INVALID_RESPONSE' },
      messages: [{ id: 'u', role: 'user', requestId: 'failed-turn', text: 'Ask' }] });
    await f.plugin.mirror(key);
    f.plugin.store = await new Store(f.directory).open(); await f.plugin.mirror(key);
    assert.equal(f.sent.filter(call => call.update).length, 0);
    const slot = f.plugin.store.data.threads[key].mirrored[`stream:${priorTurn}:${revision}`];
    assert.equal(slot.text, 'Prior preview'); assert.equal(slot.failedHash, undefined); assert.equal(slot.consumedBy, consumed ? 'saved-final' : undefined);
  }
});

test('Failed legacy stream with no revision is marked only through its persisted same-turn pointer', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.failed-legacy');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'legacy-chat', userId: user, ownRequests: ['legacy-turn'] });
  await f.store.update(data => { data.threads[key].liveStream = { ts: '7.0', turnId: 'legacy-turn', text: 'Legacy preview' }; });
  f.gateway.command = async () => ({ status: 'error', activeTurnId: 'legacy-turn', streamingText: 'Legacy visible partial',
    error: { code: 'MODEL_INVALID_RESPONSE' }, messages: [{ id: 'u', role: 'user', requestId: 'legacy-turn', text: 'Ask' }] });
  await f.plugin.mirror(key); f.plugin.store = await new Store(f.directory).open(); await f.plugin.mirror(key);
  assert.deepEqual(f.sent.filter(call => call.update).map(call => call.update[1]), ['7.0']);
  assert.ok(f.plugin.store.data.threads[key].mirrored['stream:legacy-turn'].failedHash);
  assert.equal(f.plugin.store.data.threads[key].mirrored['stream:legacy-turn'].consumedBy, undefined);
});

test('overlapping turn previews finalize in their own slots after restart without reposting old replies', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.overlap');
  await f.store.bind(key, { channel, threadTs: '123.overlap', projectId: 'lab', conversationId: 'chat-overlap', userId: user, ownRequests: ['request-one', 'request-two'] });
  const firstUser = { id: 'u1', role: 'user', requestId: 'request-one', text: 'First request' };
  const secondUser = { id: 'u2', role: 'user', requestId: 'request-two', text: 'Current correction' };
  const first = { id: 'a1', role: 'assistant', requestId: 'request-one', text: 'First complete reply' };
  const second = { id: 'a2', role: 'assistant', requestId: 'request-two', text: 'Corrected complete reply' };
  let state = { status: 'running', activeTurnId: 'request-one', consumedInputRevision: 1, streamingText: 'First preview', messages: [firstUser] };
  f.gateway.command = async () => state;
  await f.plugin.mirror(key);
  const firstTs = f.store.data.threads[key].mirrored['stream:request-one:1'].ts;
  state = { status: 'running', activeTurnId: 'request-two', consumedInputRevision: 1, streamingText: 'Corrected preview', messages: [firstUser, secondUser] };
  await f.plugin.mirror(key);
  const secondTs = f.store.data.threads[key].mirrored['stream:request-two:1'].ts;
  assert.notEqual(firstTs, secondTs);
  f.plugin.store = await new Store(f.directory).open();
  state = { status: 'waiting-for-user', activeTurnId: null, consumedInputRevision: 1, messages: [firstUser, first, secondUser, second] };
  await f.plugin.mirror(key); await f.plugin.mirror(key);
  assert.equal(f.sent.filter(call => call.channel).length, 2, 'Both finals reuse the two persisted previews');
  assert.deepEqual(['a1', 'a2'].map(id => f.plugin.store.data.threads[key].mirrored[id].ts), [firstTs, secondTs]);
  assert.deepEqual(f.sent.filter(call => call.update).map(call => [call.update[1], call.update[2]]),
    [[firstTs, 'Coordinator：First complete reply'], [secondTs, 'Coordinator：Corrected complete reply']]);
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.mirror(key);
  const delivered = f.sent.length;
  state = { status: 'running', activeTurnId: 'request-one', consumedInputRevision: 1, streamingText: 'First preview', messages: [firstUser, secondUser] };
  await f.plugin.mirror(key);
  assert.equal(f.sent.length, delivered, 'A delayed consumed stream snapshot cannot replace a final');
});

test('legacy stream ledger recovers an older turn without claiming an already finalized newer slot', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.legacy-overlap');
  await f.store.bind(key, { channel, threadTs: '123.legacy-overlap', projectId: 'lab', conversationId: 'chat-overlap', userId: user, ownRequests: ['request-one', 'request-two'] });
  const first = { id: 'a1', role: 'assistant', requestId: 'request-one', text: 'First complete reply' };
  const second = { id: 'a2', role: 'assistant', requestId: 'request-two', text: 'Current complete reply' };
  await f.store.update(data => {
    const thread = data.threads[key];
    thread.mirrored['stream:request-one:1'] = { ts: '5.0', hash: 'old-preview' };
    thread.mirrored['stream:request-two:1'] = { ts: '6.0', hash: 'current-preview' };
    thread.mirrored.a2 = { ts: '6.0', hash: digest({ format: 'plain-text-v2', message: second }) };
  });
  f.plugin.store = await new Store(f.directory).open();
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, messages: [first, second] });
  const update = f.io.update; let attempted = false;
  f.io.update = async (...args) => { if (!attempted) { attempted = true; throw new Error('Temporary update failure'); } return update(...args); };
  await assert.rejects(f.plugin.mirror(key), /Temporary update failure/);
  f.plugin.store = await new Store(f.directory).open(); f.io.update = update;
  await f.plugin.mirror(key);
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.mirror(key);
  assert.equal(f.sent.filter(call => call.channel).length, 0);
  assert.deepEqual(f.sent.filter(call => call.update).map(call => call.update[1]), ['5.0']);
  assert.deepEqual(['a1', 'a2'].map(id => f.plugin.store.data.threads[key].mirrored[id].ts), ['5.0', '6.0']);
});

test('a retained stream finalizes the first pending reply so multiple model steps remain chronological', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.ordered');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: ['request-one'] });
  await f.store.update(state => { state.threads[key].liveStream = { ts: '5.0', turnId: 'request-one' }; });
  const messages = [
    { id: 'u1', role: 'user', requestId: 'request-one', text: 'question' },
    { id: 'a1', role: 'assistant', requestId: 'request-one', text: 'First: module introduction' },
    { id: 'a2', role: 'assistant', requestId: 'request-one', text: 'Second: follow-up invitation' },
  ];
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: 'request-one', messages, approvals: [] });
  await f.plugin.mirror(key);
  assert.equal(f.sent.length, 0, 'intermediate snapshot cannot post a final before the retained stream');
  f.plugin.store = await new Store(f.directory).open();
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, messages, approvals: [] });
  await f.plugin.mirror(key); await f.plugin.mirror(key);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].update[2], /First: module introduction/);
  assert.equal(f.sent[0].update[1], '5.0');
  assert.match(f.sent[1].text, /Second: follow-up invitation/);
  assert.equal(f.plugin.store.data.threads[key].liveStream, undefined);
});
test('legacy reply slots before or after a stream retain chronology without duplicate posts', async t => {
  for (const priorTs of ['4.0', '6.0']) {
    const f = await fixture(t), key = threadKey(teamId, channel, `123.legacy-${priorTs}`);
    await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: ['request-one'] });
    const first = { id: 'a1', role: 'assistant', requestId: 'request-one', text: 'First introduction' };
    await f.store.update(state => {
      state.threads[key].liveStream = { ts: '5.0', turnId: 'request-one' };
      state.threads[key].mirrored.a1 = { ts: priorTs, hash: digest({ format: 'plain-text-v2', message: first }) };
    });
    f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, messages: [
      { id: 'u1', role: 'user', requestId: 'request-one', text: 'question' }, first,
      { id: 'a2', role: 'assistant', requestId: 'request-one', text: 'Second invitation' },
    ], approvals: [] });
    await f.plugin.mirror(key);
    f.plugin.store = await new Store(f.directory).open();
    await f.plugin.mirror(key);
    const thread = f.plugin.store.data.threads[key];
    assert.ok(Number(thread.mirrored.a1.ts) < Number(thread.mirrored.a2.ts));
    assert.equal(f.sent.filter(x => x.channel).length, 0, 'existing slots are updated, not duplicated');
    assert.equal(f.sent.filter(x => x.update).length, priorTs === '4.0' ? 1 : 2);
    assert.equal(thread.liveStream, undefined);
  }
});
test('interrupted legacy stream slot rotation resumes in order without affecting earlier turns', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.rotate-restart');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: ['previous', 'request-one'] });
  const old = { id: 'old', role: 'assistant', requestId: 'previous', text: 'Previous turn' };
  const first = { id: 'a1', role: 'assistant', requestId: 'request-one', text: 'First' };
  const second = { id: 'a2', role: 'assistant', requestId: 'request-one', text: 'Second' };
  await f.store.update(state => {
    state.threads[key].liveStream = { ts: '5.0', turnId: 'request-one' };
    for (const [message, ts] of [[old, '3.0'], [first, '6.0'], [second, '7.0']]) {
      state.threads[key].mirrored[message.id] = { ts, hash: digest({ format: 'plain-text-v2', message }) };
    }
  });
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, messages: [old,
    { id: 'u1', role: 'user', requestId: 'request-one', text: 'question' }, first, second,
    { id: 'a3', role: 'assistant', requestId: 'request-one', text: 'Third' },
  ], approvals: [] });
  const update = f.io.update;
  let count = 0;
  f.io.update = async (...args) => { if (++count === 2) throw new Error('Interrupted second slot'); return update(...args); };
  await assert.rejects(f.plugin.mirror(key), /Interrupted second slot/);
  f.plugin.store = await new Store(f.directory).open();
  f.io.update = update;
  await f.plugin.mirror(key); await f.plugin.mirror(key);
  const thread = f.plugin.store.data.threads[key];
  assert.deepEqual(['old', 'a1', 'a2', 'a3'].map(id => thread.mirrored[id].ts), ['3.0', '5.0', '6.0', '7.0']);
  assert.equal(f.sent.filter(x => x.channel).length, 0);
  assert.equal(f.sent.filter(x => x.update).length, 3);
  assert.equal(thread.liveStream, undefined);
});
test('active or different turn cannot overwrite a retained stream as a finalized reply', async t => {
  for (const [suffix, activeTurnId, requestId] of [['active', 'request-one', 'request-one'], ['different', null, 'request-two']]) {
    const f = await fixture(t), key = threadKey(teamId, channel, `123.${suffix}`);
    await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: [requestId] });
    await f.store.update(state => { state.threads[key].liveStream = { ts: '5.0', turnId: 'request-one' }; });
    f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId, messages: [{ id: 'u1', role: 'user', requestId, text: 'question' }, { id: 'a1', role: 'assistant', text: 'new answer' }], approvals: [] });
    await f.plugin.mirror(key); assert.equal(f.sent.some(item => item.update), false); assert.equal(f.store.data.threads[key].liveStream.ts, '5.0');
  }
});
test('waiting-for-user intermediate snapshot with active turn delays final then updates once', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: ['request-one'] });
  let active = true;
  await f.store.update(state => { state.threads[key].liveStream = { ts: '5.0', turnId: 'request-one' }; });
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: active ? 'request-one' : null, messages: [{ id: 'u1', role: 'user', requestId: 'request-one', text: 'question' }, { id: 'a1', role: 'assistant', text: 'final answer' }], approvals: [] });
  await f.plugin.mirror(key); assert.equal(f.sent.length, 0); assert.ok(f.store.data.threads[key].nextPoll <= Date.now() + 2500);
  active = false; await f.plugin.mirror(key); await f.plugin.mirror(key);
  assert.equal(f.sent.filter(item => item.channel).length, 0); assert.equal(f.sent.filter(item => item.update).length, 1); assert.equal(f.sent[0].update[1], '5.0');
});
test('workflow source and legacy prefix are hidden while human, Coordinator and brief remain visible', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: [] });
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, messages: [
    { id: 'event-1', role: 'user', requestId: 'workflow-1', source: 'workflow', text: 'private workflow event marker' },
    { id: 'reply-1', role: 'assistant', text: 'brief 已保存，可导出提示。' },
    { id: 'event-legacy', role: 'user', requestId: 'workflow-legacy', text: '[服务器工作流事件，不是新的用户授权]\nprivate legacy marker' },
    { id: 'human', role: 'user', source: 'human', requestId: 'browser-user', text: '继续讨论：文中提到了 [服务器工作流事件] 这个标记。' },
    { id: 'reply-2', role: 'assistant', source: 'workflow', text: '这里是正常的 Coordinator 回复。' }
  ], approvals: [{ id: 'proposal', version: 'b1', manual: true, pending: true, text: 'approved requirements', acceptance: 'criteria' }] });
  await f.plugin.mirror(key); await f.plugin.mirror(key);
  const posts = f.sent.filter(item => item.channel);
  assert.equal(posts.length, 4); assert.equal(posts.some(item => /private workflow|private legacy/.test(item.text || '')), false);
  assert.ok(posts.some(item => item.text?.startsWith('工作台用户：继续讨论'))); assert.ok(posts.some(item => item.text?.includes('正常的 Coordinator 回复')));
  assert.ok(posts.some(item => JSON.stringify(item.blocks).includes('approve_brief')));
});
for (const readKind of ['map-read', 'node-read']) for (const streaming of [false, true]) test(`map-read-only steps do not post placeholders or consume the final stream slot (${readKind}/${streaming ? 'stream' : 'direct'})`, async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: ['request-one'] });
  if (streaming) await f.store.update(state => { state.threads[key].liveStream = { ts: '5.0', turnId: 'request-one' }; });
  const state = { status: 'waiting-for-user', activeTurnId: null, messages: [
    { id: 'user', role: 'user', requestId: 'request-one', text: '只读分析 Bug' },
    { id: 'read-only', role: 'assistant', requestId: 'request-one', tools: ['read_map'], actions: [{ kind: readKind, node: { id: 'login', title: '登录' } }] },
    { id: 'answer', role: 'assistant', requestId: 'request-one', text: '登录模块的刷新逻辑有问题，本轮只读。' },
  ], approvals: [] };
  const original = structuredClone(state);
  f.gateway.command = async () => state;
  await f.plugin.mirror(key);
  assert.equal(f.sent.length, 1, 'Only the actual answer is sent/updated');
  assert.equal(f.store.data.threads[key].mirrored['read-only'], undefined);
  assert.ok(f.store.data.threads[key].mirrored.answer);
  if (streaming) {
    assert.equal(f.sent[0].update[1], '5.0');
    assert.match(f.sent[0].update[2], /登录模块/);
    assert.equal(f.store.data.threads[key].liveStream, undefined);
  } else assert.match(f.sent[0].text, /登录模块/);
  assert.deepEqual(state, original, 'Do not remove Cloud tool pairs or their public read actions');
  f.plugin.store = await new Store(f.directory).open();
  await f.plugin.mirror(key);
  assert.equal(f.sent.length, 1, 'Restart preserves deduplication without replaying the hidden read step');
});
test('map-read metadata does not hide accompanying text, clarification, attachment or visible node links', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: [] });
  const read = { kind: 'node-read', node: { id: 'login', title: '登录' } };
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, messages: [
    { id: 'text', role: 'assistant', text: '这是实际说明。', actions: [read] },
    { id: 'question', role: 'assistant', questions: [{ id: 'q', text: '是否只影响旧 token？' }], actions: [read] },
    { id: 'attachment', role: 'assistant', attachments: [{ id: 'file', filename: 'result.txt' }], actions: [read] },
    { id: 'links', role: 'assistant', actions: [read, { kind: 'node-navigation', node: { id: 'login', title: '登录' } }] },
  ], approvals: [] });
  await f.plugin.mirror(key);
  assert.equal(f.sent.length, 4);
  assert.ok(JSON.stringify(f.sent[1].blocks).includes('是否只影响旧 token'));
  assert.ok(JSON.stringify(f.sent[2].blocks).includes('result.txt'));
  assert.equal(f.sent[3].blocks.find(block => block.type === 'actions').elements[0].url, 'https://map.example.com/projects/lab?relation=login');
});
test('new Bug uses native status and manual mode, memory writes preserve legacy memories', async t => {
  const f = await fixture(t); await f.plugin.publishHome(user, 'E0'); await f.plugin.openForm('trigger', user, 'E1', 'item', { projectId: 'lab', nodeId: 'login', kind: 'bug' });
  const draftId = f.sent.find(call => call.method === 'views.open').input.view.private_metadata;
  await f.plugin.submitForm('E2', formBody(draftId, { project: 'lab', node: 'login', title: 'Bug', text: 'broken refresh', status: 'open' }), user);
  const bug = f.calls.find(call => call.type === 'map.write').payload.operations[0].fields.bugs[0]; assert.equal(bug.executionMode, 'manual'); assert.equal(bug.status, 'open');
  await f.plugin.openForm('trigger', user, 'E3', 'memory', { projectId: 'lab', nodeId: 'login' });
  const memoryDraft = f.sent.filter(call => call.method === 'views.open').at(-1).input.view.private_metadata;
  await f.plugin.submitForm('E4', formBody(memoryDraft, { project: 'lab', node: 'login', text: '# 登录\n\n记忆' }), user);
  assert.deepEqual(f.calls.filter(call => call.type === 'map.write').at(-1).payload.operations[0].fields, { memoryDocument: '# 登录\n\n记忆' });
});
test('approved cards lose approval buttons and tracked Main status updates only linked thread', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001'); await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: [] });
  let pending = true; const original = f.gateway.command;
  f.gateway.command = async (type, args) => type === 'conversation.state' ? { status: 'idle', messages: [], approvals: [{ id: 'proposal', version: 'b1', manual: true, pending, decision: pending ? undefined : 'approved', itemId: 'TD1', nodeId: 'login', kind: 'todo', text: 'fix', acceptance: 'works' }] } : original(type, args);
  await f.plugin.mirror(key); pending = false; await f.plugin.mirror(key);
  const update = f.sent.find(item => item.update).update; assert.equal(JSON.stringify(update).includes('approve_brief'), false); assert.match(JSON.stringify(update), /export_prompt/);
  await f.store.update(state => { state.threads[key].nextItemPoll = 0; });
  f.gateway.command = async (type, args) => type === 'project.read' ? { ...structuredClone(project), version: 'v2', map: { ...project.map, children: [{ ...project.map.children[0], todos: [{ id: 'TD1', title: 'refresh', status: 'done' }] }] } } : original(type, args);
  await f.plugin.notifyItemChanges(key); const notification = f.sent.find(item => item.text?.includes('pending → done')); assert.equal(notification.threadTs, '123.001'); assert.equal(notification.channel, channel);
  assert.equal(notification.text, 'refresh：pending → done'); assert.doesNotMatch(notification.text, /TD1/);
});
test('only configured-origin and selected-project links are unfolded', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.unfurl('E1', { user, channel, message_ts: '1.0', links: [{ url: 'https://evil.example/projects/lab' }, { url: 'https://map.example.com/projects/private' }, { url: 'https://map.example.com/projects/lab' }] });
  assert.deepEqual(Object.keys(f.sent.find(call => call.method === 'chat.unfurl').input.unfurls), ['https://map.example.com/projects/lab']);
});
test('linked thread unfurls retain their immutable project after channel or user selection changes', async t => {
  const f = await fixture(t), root = '120.001';
  await f.store.bind(threadKey(teamId, channel, root), { channel, threadTs: root, projectId: 'lab', conversationId: 'original-chat', userId: user });
  await f.store.update(state => { state.channels[channel] = 'other-project'; state.preferences[user] = 'other-project'; });
  const saved = structuredClone(f.store.data);
  const original = 'https://map.example.com/projects/lab?relation=login';
  await f.store.receive('unfurl-bound-thread', { type: 'events_api', body: { team_id: teamId, event: {
    type: 'link_shared', user, channel, thread_ts: root, message_ts: '130.001', links: [
      { url: original }, { url: 'https://map.example.com/projects/other-project' },
      { url: 'https://evil.example/projects/lab' },
    ],
  } } });
  await f.plugin.runEntry('unfurl-bound-thread', f.store.data.inbox['unfurl-bound-thread']);
  const unfurl = f.sent.find(call => call.method === 'chat.unfurl');
  assert.ok(unfurl, 'the original linked project still has a preview');
  assert.equal(unfurl.input.channel, channel); assert.equal(unfurl.input.ts, '130.001');
  assert.deepEqual(Object.keys(unfurl.input.unfurls), [original]);
  assert.deepEqual(f.calls.map(call => [call.type, call.projectId, call.userId]), [['project.read', 'lab', user]]);
  assert.deepEqual(f.store.data.threads, saved.threads);
  assert.deepEqual(f.store.data.channels, saved.channels); assert.deepEqual(f.store.data.preferences, saved.preferences);
  assert.equal(f.store.data.inbox['unfurl-bound-thread'].status, 'done');
});
test('linked root and direct-message previews do not require a new project preference', async t => {
  for (const channelId of [channel, 'D000001']) {
    const f = await fixture(t), root = '140.001';
    await f.store.bind(threadKey(teamId, channelId, root), { channel: channelId, threadTs: root, projectId: 'lab', conversationId: 'original-chat', userId: user });
    await f.plugin.unfurl('bound-root', { user, channel: channelId, message_ts: root, links: [{ url: 'https://map.example.com/projects/lab' }] });
    assert.equal(f.sent.filter(call => call.method === 'chat.unfurl').length, 1);
    assert.deepEqual(f.calls.map(call => [call.type, call.projectId]), [['project.read', 'lab']]);
    assert.deepEqual(f.store.data.channels, {}); assert.deepEqual(f.store.data.preferences, {});
  }
});
test('unlinked preview keeps current selection and never borrows a binding from another thread or channel', async t => {
  const f = await fixture(t);
  await f.store.bind(threadKey(teamId, channel, '150.001'), { channel, threadTs: '150.001', projectId: 'private', conversationId: 'unrelated-chat', userId: user });
  await f.store.bind(threadKey(teamId, 'COTHER', '160.001'), { channel: 'COTHER', threadTs: '160.001', projectId: 'private', conversationId: 'other-channel-chat', userId: user });
  await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.unfurl('unlinked', { user, channel, thread_ts: '160.001', message_ts: '170.001', links: [
    { url: 'https://map.example.com/projects/private' }, { url: 'https://map.example.com/projects/lab' },
  ] });
  assert.deepEqual(f.calls.map(call => [call.type, call.projectId]), [['project.read', 'lab']]);
  assert.deepEqual(Object.keys(f.sent.find(call => call.method === 'chat.unfurl').input.unfurls), ['https://map.example.com/projects/lab']);
  f.calls.length = 0; f.sent.length = 0;
  await f.store.update(state => { delete state.channels[channel]; });
  await f.plugin.unfurl('not-selected', { user, channel, message_ts: '180.001', links: [{ url: 'https://map.example.com/projects/private' }] });
  assert.deepEqual(f.calls, []); assert.deepEqual(f.sent, []);
});
test('gateway forbids remote hosts and passes actor without role escalation', async () => {
  assert.throws(() => new Gateway({ url: 'https://example.com', token: 'test', teamId }), /loopback/);
  let payload; const gateway = new Gateway({ url: 'http://127.0.0.1:8790', token: 'test-only', teamId, fetchImpl: async (_, options) => { payload = JSON.parse(options.body); return { ok: true, async json() { return { ok: true, data: { accepted: true } }; } }; } });
  await gateway.command('conversation.submit', { id: 'op', userId: user, projectId: 'lab', payload: { text: 'Hello' } }); assert.equal(payload.userId, user); assert.equal(payload.role, undefined);
});
test('unknown send is reconciled through own bot metadata instead of sent twice', async t => {
  const f = await fixture(t); let sends = 0;
  const client = { async apiCall(method, args) { if (method === 'chat.postMessage') { sends++; throw new Error('network timeout'); } if (method === 'conversations.replies') return { messages: [{ user: bot, ts: '2.0', metadata: { event_type: 'context_guard', event_payload: { id: 'send-1' } } }] }; return {}; } };
  const io = new SlackIO({ client, store: f.store, botUserId: bot, wait: async () => {} });
  const input = { id: 'send-1', channel, threadTs: '1.0', text: 'Hi' }; assert.equal(await io.post(input), '2.0'); assert.equal(await io.post(input), '2.0'); assert.equal(sends, 1);
});
test('unknown send missing from history is held for attention, never blindly retried', async t => {
  const f = await fixture(t); let sends = 0;
  const io = new SlackIO({ client: { async apiCall(method) { if (method === 'chat.postMessage') { sends++; throw new Error('network'); } return { messages: [] }; } }, store: f.store, botUserId: bot, wait: async () => {} });
  const input = { id: 'send-1', channel, threadTs: '1.0', text: 'Hi' }; await assert.rejects(io.post(input), UncertainDelivery); await assert.rejects(io.post(input), UncertainDelivery); assert.equal(sends, 1);
});
test('unknown top-level send reconciles channel history instead of invalid replies timestamp', async t => {
  const f = await fixture(t), methods = [];
  const io = new SlackIO({ client: { async apiCall(method) { methods.push(method); if (method === 'chat.postMessage') throw new Error('timeout'); return { messages: [{ user: bot, ts: '4.0', metadata: { event_type: 'context_guard', event_payload: { id: 'root' } } }] }; } }, store: f.store, botUserId: bot, wait: async () => {} });
  assert.equal(await io.post({ id: 'root', channel, text: 'root' }), '4.0'); assert.deepEqual(methods, ['chat.postMessage', 'conversations.history']);
});
test('Slack rate limits are bounded and honor Retry-After', async t => {
  const f = await fixture(t), waits = []; let calls = 0;
  const io = new SlackIO({ client: { async apiCall() { calls++; throw Object.assign(new Error('rate'), { code: 'slack_webapi_rate_limited_error', retryAfter: 3 }); } }, store: f.store, wait: async ms => waits.push(ms) });
  await assert.rejects(io.call('views.publish', {}), /rate/); assert.equal(calls, 3); assert.deepEqual(waits, [3000, 3000]);
});
test('long Retry-After is persisted without blocking or retrying earlier', async t => {
  const f = await fixture(t), envelope = { type: 'events_api', body: { event: { type: 'app_home_opened', user } } };
  f.gateway.command = async () => { throw Object.assign(new Error('rate'), { code: 'slack_webapi_rate_limited_error', retryAfter: 120 }); };
  await f.store.receive('E1', envelope); const before = Date.now(); await f.plugin.runEntry('E1', f.store.data.inbox.E1);
  assert.equal(f.store.data.inbox.E1.status, 'pending'); assert.ok(f.store.data.inbox.E1.next >= before + 120000);
});
test('file export persists stages, honors upload Retry-After and publishes same file once', async t => {
  const f = await fixture(t), calls = [], waits = []; let uploads = 0;
  const io = new SlackIO({ store: f.store, botUserId: bot, wait: async ms => waits.push(ms), client: { async apiCall(method, args) { calls.push({ method, args }); if (method === 'files.getUploadURLExternal') return { file_id: 'F1', upload_url: 'https://files.slack.com/upload/F1' }; return { files: [{ id: 'F1' }] }; } }, fetchImpl: async () => { uploads++; return uploads === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '2' } }) : new Response('ok', { status: 200 }); } });
  const input = { id: 'export', channel, threadTs: '1.0', text: 'prompt', filename: 'prompt.md' };
  await io.uploadPrompt(input); await io.uploadPrompt(input);
  assert.deepEqual(waits, [2000]); assert.equal(uploads, 2); assert.equal(calls.filter(call => call.method === 'files.getUploadURLExternal').length, 1);
  assert.equal(calls.filter(call => call.method === 'files.completeUploadExternal').length, 1); assert.equal(f.store.data.outgoing.export.status, 'sent'); assert.equal(f.store.data.outgoing.export.uploadUrl, undefined);
  await assert.rejects(io.uploadPrompt({ ...input, text: 'different' }), /already used/);
});
test('known file completion rejection retries original file without another upload or allocation', async t => {
  const f = await fixture(t), calls = []; let completes = 0, uploads = 0;
  const io = new SlackIO({ store: f.store, botUserId: bot, wait: async () => {}, client: { async apiCall(method, args) { calls.push({ method, args }); if (method === 'files.getUploadURLExternal') return { file_id: 'F1', upload_url: 'https://files.slack.com/upload/F1' }; if (method === 'files.completeUploadExternal' && ++completes === 1) throw Object.assign(new Error('known platform rejection'), { code: 'slack_webapi_platform_error' }); return { files: [{ id: 'F1' }] }; } }, fetchImpl: async () => { uploads++; return new Response('ok'); } });
  const input = { id: 'export', channel, threadTs: '1.0', text: 'prompt', filename: 'prompt.md' };
  await assert.rejects(io.uploadPrompt(input), /known platform/); assert.equal(f.store.data.outgoing.export.status, 'failed'); assert.equal(f.store.data.outgoing.export.phase, 'complete');
  await io.uploadPrompt(input); assert.equal(uploads, 1); assert.equal(calls.filter(call => call.method === 'files.getUploadURLExternal').length, 1); assert.equal(completes, 2);
});
test('unknown file completion reconciles exact original file ID after restart without publishing twice', async t => {
  const f = await fixture(t); let allocated = 0, completed = 0;
  const client = { async apiCall(method) { if (method === 'files.getUploadURLExternal') { allocated++; return { file_id: 'F1', upload_url: 'https://files.slack.com/upload/F1' }; } if (method === 'files.completeUploadExternal') { completed++; throw new Error('connection lost'); } if (method === 'conversations.replies') return { messages: [{ user: bot, ts: '3.0', files: [{ id: 'F1', name: 'server-renamed-file.md' }] }] }; return {}; } };
  const io = new SlackIO({ client, store: f.store, botUserId: bot, wait: async () => {}, fetchImpl: async () => new Response('ok') });
  const input = { id: 'export', channel, threadTs: '1.0', text: 'prompt', filename: 'prompt.md' };
  await io.uploadPrompt(input); io.store = await new Store(f.directory).open(); await io.uploadPrompt(input);
  assert.equal(allocated, 1); assert.equal(completed, 1); assert.equal(io.store.data.outgoing.export.status, 'sent');
});
test('unknown file completion absent from Slack remains unknown and never reallocates', async t => {
  const f = await fixture(t); let allocated = 0, completed = 0;
  const client = { async apiCall(method) { if (method === 'files.getUploadURLExternal') { allocated++; return { file_id: 'F1', upload_url: 'https://files.slack.com/upload/F1' }; } if (method === 'files.completeUploadExternal') { completed++; throw new Error('network'); } return { messages: [] }; } };
  const io = new SlackIO({ client, store: f.store, botUserId: bot, wait: async () => {}, fetchImpl: async () => new Response('ok') });
  const input = { id: 'export', channel, threadTs: '1.0', text: 'prompt', filename: 'prompt.md' };
  await assert.rejects(io.uploadPrompt(input), UncertainDelivery); await assert.rejects(io.uploadPrompt(input), UncertainDelivery);
  assert.equal(allocated, 1); assert.equal(completed, 1); assert.equal(f.store.data.outgoing.export.status, 'unknown');
});
test('unsupported attachment and redirects to a non-Slack host never forward bot token', async t => {
  const f = await fixture(t); let requests = 0;
  const io = new SlackIO({ client: {}, store: f.store, botToken: 'test-only', fetchImpl: async () => { requests++; return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }); } });
  await assert.rejects(io.download({ name: 'screen.png', mimetype: 'image/png', url_private: 'https://files.slack.com/file' }), /Untrusted/); assert.equal(requests, 1);
  await assert.rejects(io.download({ name: 'huge.txt', mimetype: 'text/plain', size: 300000, url_private: 'https://files.slack.com/file' }), /太大/);
});
test('Block Kit shows literal user text without mentions and emits versioned brief controls', () => {
  const blocks = messageBlocks({ text: '<@everyone>', questions: [{ id: 'q', text: 'Choose', options: ['one'] }] }, 'thread');
  assert.equal(blocks[0].text.type, 'plain_text');
  assert.equal(blocks[0].text.text, '<@everyone>');
  assert.equal(JSON.parse(approvalBlocks({ id: 'a', brief: { version: 'v' } }, 'thread')[1].elements[0].value).version, 'v');
  assert.deepEqual(formValues({ state: { values: { p: { v: { selected_option: { value: 'lab' } } } } } }), { p: 'lab' });
});

test('other bot routing metadata is semantic input; a silent decision downloads no attachments', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  await f.plugin.message('seed', event()); f.calls.length = 0; f.sent.length = 0;
  let identityCalls = 0;
  f.io.call = async method => { if (method === 'conversations.replies') return { messages: [] }; assert.equal(method, 'users.info'); identityCalls++; return { user: { id: 'UOTHER', is_bot: true } }; };
  const command = f.gateway.command;
  f.gateway.command = async (type, input) => type === 'conversation.relevance' ? (f.calls.push({ type, ...input }), { respond: false, mainVersion: 'v1' }) : command(type, input);
  f.io.download = async () => assert.fail('misaddressed message cannot download files');
  for (let i = 0; i < 2; i++) await f.plugin.message(`other-${i}`, event({ thread_ts: '123.001', ts: `124.00${i}`, text: '<@UOTHER> fix it', files: [{ id: 'F1' }] }));
  assert.equal(identityCalls, 1); assert.equal(f.calls.length, 2); assert.deepEqual(f.sent, []);
  assert.deepEqual(f.calls[0].payload.routing.mentionedUsers, [{ id: 'UOTHER', isBot: true }]);
  const reopened = await new Store(f.directory).open(); assert.equal(reopened.data.inbox['other-1'].relevance.respond, false);
});

test('own native mention and unknown bot identities still use semantic intent; no permanent hard silence', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  let lookups = 0;
  f.io.call = async method => { if (['conversations.history', 'conversations.replies'].includes(method)) return { messages: [] }; lookups++; throw new Error('lookup unavailable'); };
  await f.plugin.message('both', event({ text: `<@UOTHER> <@${bot}> help` }));
  assert.equal(lookups, 1); assert.equal(f.calls.filter(call => call.type === 'conversation.submit').length, 1);
  f.calls.length = 0;
  await f.plugin.message('unknown', event({ text: '<@UUNKNOWN> help', ts: '200.001' }));
  await f.plugin.message('unknown-again', event({ text: '<@UUNKNOWN> help', ts: '201.001' }));
  assert.equal(lookups, 2); assert.equal(f.calls.filter(call => call.type === 'conversation.relevance').length, 2);
  assert.deepEqual(f.store.data.inbox.unknown.routingMetadata.mentionedUsers, [{ id: 'UUNKNOWN', isBot: null }]);
});

test('identity cache is bounded and quoted own mention still uses relevance', async t => {
  const f = await fixture(t); await f.store.update(state => { state.channels[channel] = 'lab'; });
  for (let i = 0; i < 257; i++) await f.plugin.mentionRoute(`identity-${i}`, event({ text: `<@U${i}>` }));
  assert.equal(f.plugin.userIdentities.size, 256);
  await f.plugin.message('quoted', event({ type: 'app_mention', text: `> <@${bot}> historical request\nnow discuss login` }));
  assert.equal(f.calls[0].type, 'conversation.relevance');
  const submitted = f.calls.find(call => call.type === 'conversation.submit');
  assert.equal(submitted.payload.followup, 'steer'); assert.equal(submitted.payload.expectedTurnId, undefined);
});

test('stop freezes the target turn before delivery and never retargets on retry', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: [], live: true });
  const original = f.gateway.command; let calls = 0;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.state') return { status: 'running', activeTurnId: calls ? 'new-turn' : 'original-turn' };
    if (type === 'conversation.interrupt') {
      f.calls.push({ type, ...input }); calls++;
      const disk = JSON.parse(await fs.readFile(f.store.file, 'utf8'));
      assert.equal(disk.inbox.stop.interruptTarget.expectedTurnId, 'original-turn');
      if (calls === 1) throw Object.assign(new Error('network'), { code: 'GATEWAY_ERROR' });
      return { status: 'interrupted' };
    }
    return original(type, input);
  };
  const body = { command: '/cg', text: 'stop', channel_id: channel, user_id: user };
  await assert.rejects(f.plugin.process('stop', { type: 'slash_commands', body }), error => error.code === 'GATEWAY_ERROR');
  await f.plugin.process('stop', { type: 'slash_commands', body });
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.calls[1].payload.expectedTurnId, 'original-turn');
});

test('stop with multiple threads or another actor never guesses the target', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 2; i++) await f.store.bind(threadKey(teamId, channel, `${i}.1`), { channel, threadTs: `${i}.1`, projectId: 'lab', conversationId: `chat-${i}`, userId: user, ownRequests: [], live: true });
  await assert.rejects(f.plugin.stopChat('ambiguous', { channel_id: channel, text: 'stop' }, user), error => error.code === 'AMBIGUOUS_CONVERSATION');
  await assert.rejects(f.plugin.stopChat('other-actor', { channel_id: channel, text: 'stop chat-0' }, 'UOTHER'), error => error.code === 'AMBIGUOUS_CONVERSATION');
  assert.deepEqual(f.calls, []);
});

test('interrupted stream remains partial, does not finalize and does not resume polling', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat', userId: user, ownRequests: [], live: true, awaitingReplyId: 'turn' });
  await f.store.update(data => { data.threads[key].liveStream = { ts: '55.1', turnId: 'turn', text: 'partial' }; });
  f.gateway.command = async () => ({ status: 'interrupted', activeTurnId: 'turn', inputRevision: 2, consumedInputRevision: 1, pendingInputCount: 1,
    messages: [{ role: 'user', requestId: 'turn', text: 'ask' }, { role: 'assistant', requestId: 'turn', text: 'partial' }], acceptedRequestIds: ['turn'] });
  await f.plugin.mirror(key);
  assert.equal(f.store.data.threads[key].live, false); assert.equal(f.store.data.threads[key].awaitingReplyId, undefined);
  assert.equal(f.store.data.threads[key].liveStream.interrupted, true);
  assert.ok(f.sent.some(item => item.update?.[2].includes('部分回复，非最终答案')));
  assert.equal(f.store.data.threads[key].pendingInputCount, 1);
  const firstCount = f.sent.length; await f.plugin.mirror(key); assert.equal(f.sent.length, firstCount);
});

test('pending input is accepted but not complete, and old revision cannot roll mirror back', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat', userId: user, ownRequests: [], awaitingReplyId: 'followup' });
  let state = { status: 'running', activeTurnId: 'first', inputRevision: 3, consumedInputRevision: 1, pendingInputCount: 2, acceptedRequestIds: ['first', 'followup'], messages: [] };
  f.gateway.command = async () => state;
  await f.plugin.mirror(key);
  assert.equal(f.store.data.threads[key].awaitingReplyId, 'followup');
  assert.ok(f.sent.some(item => item.text?.includes('等待纳入')));
  const sent = f.sent.length;
  state = { ...state, inputRevision: 2, consumedInputRevision: 1, pendingInputCount: 0, status: 'idle', activeTurnId: null };
  await f.plugin.mirror(key); assert.equal(f.sent.length, sent); assert.equal(f.store.data.threads[key].inputRevision, 3);
  state = { ...state, inputRevision: 3, consumedInputRevision: 3, status: 'running', activeTurnId: 'first' };
  await f.plugin.mirror(key); assert.ok(f.sent.some(item => item.update?.[2].includes('补充已纳入')));
});

test('resume freezes the original turn and uses a new transport receipt without copying actor or text', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat-one', userId: user, ownRequests: [], status: 'interrupted' });
  const original = f.gateway.command; let attempts = 0;
  f.gateway.command = async (type, input) => {
    if (type === 'conversation.state') return { status: 'interrupted', retryInput: { id: 'original-turn', text: 'original task', actor: { userId: user }, source: 'slack' } };
    if (type === 'conversation.submit') {
      f.calls.push({ type, ...input }); attempts++;
      assert.notEqual(input.id, 'original-turn');
      assert.deepEqual(input.payload, { retry: true, expectedTurnId: 'original-turn' });
      const disk = JSON.parse(await fs.readFile(f.store.file, 'utf8'));
      assert.equal(disk.inbox.resume.resumeTarget.expectedTurnId, 'original-turn');
      if (attempts === 1) throw Object.assign(new Error('Unavailable'), { code: 'GATEWAY_ERROR' });
      return { accepted: true };
    }
    return original(type, input);
  };
  const body = { command: '/cg', text: 'resume', channel_id: channel, user_id: user };
  await assert.rejects(f.plugin.process('resume', { type: 'slash_commands', body }), error => error.code === 'GATEWAY_ERROR');
  await f.plugin.process('resume', { type: 'slash_commands', body });
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.store.data.threads[key].awaitingReplyId, 'original-turn');
});

test('Steer partial output retains its slot and the corrected stream uses a new revision slot', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat', userId: user, ownRequests: ['turn'] });
  await f.store.update(data => { data.threads[key].liveStream = { ts: '55.1', turnId: 'turn', text: 'old partial' };
    data.threads[key].mirrored['stream:turn:1'] = { ts: '55.1', hash: 'old' }; });
  f.gateway.command = async () => ({ status: 'running', activeTurnId: 'turn', streamingText: 'corrected partial', inputRevision: 2, consumedInputRevision: 2, pendingInputCount: 0,
    messages: [{ id: 'u', role: 'user', requestId: 'turn', text: 'ask' }, { id: 'a', role: 'assistant', requestId: 'turn', text: 'old partial', partial: true }] });
  await f.plugin.mirror(key);
  assert.equal(f.store.data.threads[key].mirrored.a.ts, '55.1');
  assert.ok(f.sent.some(item => item.update?.[2].includes('非最终答案')));
  assert.notEqual(f.store.data.threads[key].liveStream.ts, '55.1');
  const oldSlotUpdates = f.sent.filter(item => item.update?.[1] === '55.1').length;
  await f.plugin.mirror(key);
  assert.equal(f.sent.filter(item => item.update?.[1] === '55.1').length, oldSlotUpdates);
  const correctedTs = f.store.data.threads[key].liveStream.ts;
  f.plugin.store = await new Store(f.directory).open();
  f.gateway.command = async () => ({ status: 'waiting-for-user', activeTurnId: null, inputRevision: 2, consumedInputRevision: 2, pendingInputCount: 0,
    messages: [{ id: 'u', role: 'user', requestId: 'turn', text: 'ask' },
      { id: 'a', role: 'assistant', requestId: 'turn', text: 'old partial', partial: true },
      { id: 'corrected', role: 'assistant', requestId: 'turn', text: 'Corrected complete answer' }] });
  await f.plugin.mirror(key); await f.plugin.mirror(key);
  assert.equal(f.plugin.store.data.threads[key].mirrored.a.ts, '55.1');
  assert.equal(f.plugin.store.data.threads[key].mirrored.corrected.ts, correctedTs);
  assert.equal(f.sent.filter(item => item.update?.[1] === '55.1').length, oldSlotUpdates, 'The consumed old revision remains partial');
  assert.equal(f.sent.filter(item => item.channel).length, 1, 'The corrected final reuses its revision preview');
  assert.equal(f.plugin.store.data.threads[key].liveStream, undefined);
});

test('control revision prevents late running snapshot from reviving an interrupted turn', async t => {
  const f = await fixture(t), key = threadKey(teamId, channel, '123.001');
  await f.store.bind(key, { channel, threadTs: '123.001', projectId: 'lab', conversationId: 'chat', userId: user, ownRequests: [], live: true });
  let state = { status: 'interrupted', activeTurnId: 'turn', controlRevision: 1, inputRevision: 2, consumedInputRevision: 2, pendingInputCount: 0, messages: [] };
  f.gateway.command = async () => state;
  await f.plugin.mirror(key); const sent = f.sent.length;
  state = { ...state, status: 'running', controlRevision: 0, streamingText: 'late old partial' };
  await f.plugin.mirror(key); assert.equal(f.sent.length, sent); assert.equal(f.store.data.threads[key].live, false);
  state = { ...state, controlRevision: 2, streamingText: 'explicitly resumed' };
  await f.plugin.mirror(key); assert.equal(f.store.data.threads[key].live, true);
  assert.equal(f.store.data.threads[key].controlRevision, 2);
});
