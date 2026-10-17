// Account and workspace boundaries. Provider identity comes only from Feishu's
// server-side user_info response; browser-supplied identity fields are ignored.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

const AUTH_COOKIE = 'cgdash_session';
const STATE_COOKIE = 'cgdash_oauth_state';
const STATE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const TOKEN_SCOPE = 'dashboard:report';
const RESERVED = new Set(['jerry','api','auth','assets','web','skills','map','board','data','workspaces','favicon','robots','mcp','ui-gallery','guide-assets']);
const hash = x => createHash('sha256').update(String(x)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
function problem(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function cookies(req) {
  const out = {};
  for (const p of String(req.headers?.cookie || '').split(';')) {
    const i = p.indexOf('='); if (i < 1) continue;
    try { out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim()); } catch { /* malformed cookie is unauthenticated */ }
  }
  return out;
}
function respond(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}
async function bodyJson(req) {
  let size = 0, chunks = [];
  for await (const chunk of req) { const b = Buffer.from(chunk); size += b.length; if (size > 8192) throw problem(413,'BODY_TOO_LARGE','请求过大'); chunks.push(b); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw problem(400,'INVALID_JSON','JSON 无效'); }
}
function validSlug(slug) { return typeof slug === 'string' && /^[a-z][a-z0-9-]{2,47}$/.test(slug) && !RESERVED.has(slug); }
function createEmptyData(dir, title) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const put = (name, data) => {
    const file = join(dir,name);
    try { writeFileSync(file, JSON.stringify(data)+'\n', { mode:0o600, flag:'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  };
  put('learning-map.json', { version:0, tree:{ title: `${title}的技能树`, kind:'category', status:'todo', children:[] } });
  put('feishu-todos-sync.json', { source:'feishu', items:[], syncedAt:new Date().toISOString(), syncStatus:'disabled', lastAttemptAt:null, error:null });
  put('project-map-sources.json', { version:1, projects:{} });
}

export function createWorkspaceService(config, { fetch: fetcher = globalThis.fetch, now = Date.now } = {}) {
  if (!config?.dataDir || !config.ownerKey) throw problem(500,'WORKSPACE_CONFIG_REQUIRED','工作空间配置无效');
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive:true });
  const databaseFile = join(dataDir,'accounts.sqlite');
  const db = new DatabaseSync(databaseFile);
  chmodSync(databaseFile,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS workspace_accounts (
      id TEXT PRIMARY KEY, subject_id TEXT NOT NULL UNIQUE,
      app_id TEXT NOT NULL, tenant_key TEXT NOT NULL, open_id TEXT NOT NULL,
      name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(app_id,tenant_key,open_id));
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      owner_account_id TEXT UNIQUE REFERENCES workspace_accounts(id),
      server_key TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_oauth_states (
      state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, return_path TEXT,
      expires_at INTEGER NOT NULL, consumed_at INTEGER);
    CREATE TABLE IF NOT EXISTS workspace_sessions (
      token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES workspace_accounts(id),
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_tokens (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id), account_id TEXT NOT NULL REFERENCES workspace_accounts(id),
      name TEXT NOT NULL, scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
  `);
  if(!db.prepare('PRAGMA table_info(workspace_accounts)').all().some(c=>c.name==='avatar_url'))db.exec('ALTER TABLE workspace_accounts ADD COLUMN avatar_url TEXT');
  db.prepare('INSERT OR IGNORE INTO workspaces(id,slug,name,server_key,created_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run('jerry','jerry',config.workspaceName || 'Jerry 的工作台',secret(),now(),now());
  const publicUrl = (() => { try { return new URL(config.publicBaseUrl); } catch { return null; } })();
  const secure = publicUrl?.protocol === 'https:';
  const login = config.feishuLogin || null;
  const activeLogin = Boolean(login?.appId && login?.appSecret && login?.redirectUri && publicUrl);
  const sessionKey = db.prepare('SELECT server_key FROM workspaces WHERE id=?').get('jerry').server_key;
  const sessionMs = Math.max(60*60*1000,Math.min(30*24*60*60*1000,Number(config.workspaceSessionTtlMs)||SESSION_TTL));
  function cookie(name, value, seconds, path = '/') {
    return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure ? '; Secure' : ''}`;
  }
  function setCookies(res, values) { res.setHeader('set-cookie',values); }
  function rowToSpace(row) {
    if (!row) return null;
    const isDefault = row.id === 'jerry';
    const dir = isDefault ? dataDir : join(dataDir,'workspaces',row.id);
    if (!isDefault) createEmptyData(dir,row.name);
    return { workspaceId:row.id, id:row.id, slug:row.slug, name:row.name,
      ownerAccountId:row.owner_account_id || null,
      config:{ ...config, dataDir:dir, workspaceId:row.id, workspaceSlug:row.slug,
        ownerKey:isDefault ? config.ownerKey : row.server_key,
        guestKey:isDefault ? config.guestKey : null,
        mapContext:isDefault ? config.mapContext : null,
        feishuCli:isDefault ? config.feishuCli : '',
        publicBaseUrl:publicUrl ? `${publicUrl.origin}/${row.slug}` : null,
        // The account service is owned by the outer router, not recursively inherited.
        feishuLogin:null }
    };
  }
  function getBySlug(slug) {
    if (slug !== 'jerry' && !validSlug(slug)) return null;
    return rowToSpace(db.prepare('SELECT * FROM workspaces WHERE slug=?').get(slug));
  }
  function getById(id) { return rowToSpace(db.prepare('SELECT * FROM workspaces WHERE id=?').get(id)); }
  function session(req) {
    const raw = cookies(req)[AUTH_COOKIE];
    if (!raw || raw.length > 256) return null;
    const found = db.prepare(`SELECT s.account_id,s.expires_at,a.subject_id,a.name,a.avatar_url FROM workspace_sessions s
      JOIN workspace_accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>?`).get(hash(raw),now());
    return found ? { ...found, raw } : null;
  }
  function csrf(raw) { return createHmac('sha256',sessionKey).update(`csrf:${raw}`).digest('base64url'); }
  function sameOrigin(req) {
    const origin = req.headers?.origin;
    return !origin || (publicUrl && origin === publicUrl.origin);
  }
  function resolveIdentity(req, space) {
    if (!space?.workspaceId) return null;
    const bearer = String(req.headers?.authorization || '');
    if (bearer) {
      if (!bearer.startsWith('Bearer dbr_') || bearer.length > 512) return null;
      const row = db.prepare(`SELECT t.*,a.subject_id,a.name AS account_name FROM workspace_tokens t
        JOIN workspace_accounts a ON a.id=t.account_id WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? AND workspace_id=?`)
        .get(hash(bearer.slice(7)),now(),space.workspaceId);
      if (!row || space.ownerAccountId !== row.account_id) return null;
      return { id:row.subject_id, accountId:row.account_id, workspaceId:space.workspaceId,
        name:row.account_name, role:'reporter', via:'workspace-token', scopes:[TOKEN_SCOPE], tokenId:row.id };
    }
    const s = session(req);
    if (!s || s.account_id !== space.ownerAccountId) return null;
    return { id:s.subject_id, accountId:s.account_id, workspaceId:space.workspaceId,
      name:s.name, role:'owner', via:'workspace-session', scopes:['workspace:owner'] };
  }
  function resolveSender(req) {
    // A report-only PAT is not a messages.send credential, even in a browser.
    if (req.headers?.authorization) return null;
    const s = session(req);
    return s ? { accountId:s.account_id,id:s.subject_id,name:s.name } : null;
  }
  function verifySessionCsrf(req) {
    const s = session(req);
    return Boolean(s && !req.headers?.authorization && sameOrigin(req)
      && equal(req.headers?.['x-csrf-token'],csrf(s.raw)));
  }
  function verifyCsrf(req, space) {
    const identity = resolveIdentity(req,space);
    return Boolean(identity?.via === 'workspace-session' && verifySessionCsrf(req));
  }
  function requireSession(req, targetSpace, write = false) {
    const s = session(req);
    if (!s) throw problem(401,'LOGIN_REQUIRED','请先登录');
    const row = targetSpace ? db.prepare('SELECT * FROM workspaces WHERE id=?').get(targetSpace.workspaceId)
      : db.prepare('SELECT * FROM workspaces WHERE owner_account_id=?').get(s.account_id);
    if (!row || row.owner_account_id !== s.account_id) throw problem(403,'WORKSPACE_FORBIDDEN','无权操作此工作空间');
    const space = rowToSpace(row);
    if (write && !verifyCsrf(req,space)) throw problem(403,'CSRF_REQUIRED','请刷新登录状态后重试');
    return { s,space };
  }
  function safeReturn(value) {
    if (typeof value !== 'string' || value.length > 500 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || /[\r\n]/.test(value)) return null;
    try { const u = new URL(value,publicUrl); return u.origin === publicUrl.origin && !u.pathname.startsWith('/auth/') ? u.pathname+u.search+u.hash : null; }
    catch { return null; }
  }
  function loginConfigCheck() {
    if (!activeLogin) throw problem(503,'FEISHU_LOGIN_NOT_CONFIGURED','飞书登录尚未配置');
    const redirect = new URL(login.redirectUri);
    if (redirect.origin !== publicUrl.origin || redirect.pathname !== '/auth/feishu/callback' || redirect.search || redirect.hash)
      throw problem(503,'FEISHU_CALLBACK_INVALID','飞书回调配置无效');
    if (!['https:','http:'].includes(publicUrl.protocol)) throw problem(503,'PUBLIC_URL_INVALID','工作台地址配置无效');
  }
  async function providerJson(url, options) {
    let r;
    try { r = await fetcher(url,{ ...options, redirect:'error',signal:AbortSignal.timeout(10000) }); }
    catch { throw problem(502,'FEISHU_UNAVAILABLE','飞书登录暂时不可用'); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.error || (j.code !== undefined && j.code !== 0)) throw problem(502,'FEISHU_REJECTED','飞书未能完成身份验证');
    return j;
  }
  async function callback(req,res,url) {
    loginConfigCheck();
    const state = url.searchParams.get('state') || '', browser = cookies(req)[STATE_COOKIE] || '';
    // Consume a matching state before any network request; failures require a new flow.
    const found = state.length <= 256 && browser.length <= 256 ? db.prepare(`UPDATE workspace_oauth_states SET consumed_at=?
      WHERE state_hash=? AND browser_hash=? AND consumed_at IS NULL AND expires_at>? RETURNING return_path`).get(now(),hash(state),hash(browser),now()) : null;
    if (!found) throw problem(400,'OAUTH_STATE_INVALID','登录状态已失效，请重新登录');
    setCookies(res,[cookie(STATE_COOKIE,'',0,'/auth/feishu/callback')]);
    if (url.searchParams.has('error')) throw problem(400,'FEISHU_LOGIN_CANCELLED','已取消飞书登录');
    const code = url.searchParams.get('code');
    if (!code || code.length > 4096) throw problem(400,'OAUTH_CODE_INVALID','登录授权码无效');
    const token = await providerJson('https://open.feishu.cn/open-apis/authen/v2/oauth/token',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant_type:'authorization_code',
        client_id:login.appId,client_secret:login.appSecret,code,redirect_uri:login.redirectUri}) });
    if (typeof token.access_token !== 'string' || !token.access_token) throw problem(502,'FEISHU_TOKEN_INVALID','飞书登录响应无效');
    const info = await providerJson('https://open.feishu.cn/open-apis/authen/v1/user_info',{
      method:'GET',headers:{authorization:`Bearer ${token.access_token}`} });
    const user = info.data;
    if (typeof user?.open_id !== 'string' || !user.open_id || user.open_id.length>200 || typeof user.tenant_key !== 'string' || !user.tenant_key || user.tenant_key.length>200)
      throw problem(502,'FEISHU_IDENTITY_INVALID','飞书未返回完整用户身份');
    const subject = 'feishu:'+hash(JSON.stringify([login.appId,user.tenant_key,user.open_id]));
    const name = typeof user.name === 'string' && user.name.trim() ? user.name.trim().slice(0,80) : '用户';
    let avatarUrl=null;
    for(const value of [user.avatar_url,user.avatar_big,user.avatar_middle,user.avatar_thumb]){
      if(typeof value!=='string'||value.length>2048)continue;
      try{const u=new URL(value);if(u.protocol==='https:'&&!u.username&&!u.password){avatarUrl=u.href;break;}}catch{}
    }
    const owner = login.ownerIdentity;
    const isJerryOwner = owner && owner.appId === login.appId && owner.tenantKey === user.tenant_key && owner.openId === user.open_id;
    let account, space;
    db.exec('BEGIN IMMEDIATE');
    try {
      account = db.prepare('SELECT * FROM workspace_accounts WHERE subject_id=?').get(subject);
      if (!account) {
        const id = randomUUID();
        db.prepare('INSERT INTO workspace_accounts(id,subject_id,app_id,tenant_key,open_id,name,created_at,updated_at,avatar_url) VALUES(?,?,?,?,?,?,?,?,?)').run(id,subject,login.appId,user.tenant_key,user.open_id,name,now(),now(),avatarUrl);
        account = db.prepare('SELECT * FROM workspace_accounts WHERE id=?').get(id);
      } else db.prepare('UPDATE workspace_accounts SET name=?,avatar_url=?,updated_at=? WHERE id=?').run(name,avatarUrl,now(),account.id);
      let row = db.prepare('SELECT * FROM workspaces WHERE owner_account_id=?').get(account.id);
      if (isJerryOwner) {
        const jerry = db.prepare('SELECT * FROM workspaces WHERE id=?').get('jerry');
        if (jerry.owner_account_id && jerry.owner_account_id !== account.id) throw problem(409,'OWNER_MAPPING_CONFLICT','现有工作台所有者映射冲突');
        if (row && row.id !== 'jerry') throw problem(409,'OWNER_MAPPING_REQUIRES_MIGRATION','账号已有独立空间，请由原工作台所有者确认迁移');
        db.prepare('UPDATE workspaces SET owner_account_id=?,updated_at=? WHERE id=?').run(account.id,now(),'jerry');
        row = db.prepare('SELECT * FROM workspaces WHERE id=?').get('jerry');
      } else if (!row) {
        const id = randomUUID(), slug = 'u-'+randomBytes(6).toString('hex');
        db.prepare('INSERT INTO workspaces VALUES(?,?,?,?,?,?,?)').run(id,slug,`${name}的工作台`,account.id,secret(),now(),now());
        row = db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
      }
      space = rowToSpace(row);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    const sessionToken = secret();
    db.prepare('DELETE FROM workspace_sessions WHERE expires_at<=?').run(now());
    db.prepare('INSERT INTO workspace_sessions VALUES(?,?,?,?)').run(hash(sessionToken),account.id,now()+sessionMs,now());
    setCookies(res,[cookie(STATE_COOKIE,'',0,'/auth/feishu/callback'),cookie(AUTH_COOKIE,sessionToken,Math.floor(sessionMs/1000))]);
    res.writeHead(302,{location:safeReturn(found.return_path)||`/${space.slug}/`,'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();
  }
  async function handleAuth(req,res,url) {
    if (!url.pathname.startsWith('/auth/')) return false;
    try {
      const path = url.pathname, method = req.method || 'GET';
      if (path === '/auth/feishu/start' && method === 'GET') {
        loginConfigCheck();
        const state = secret(), browser = secret();
        db.prepare('DELETE FROM workspace_oauth_states WHERE expires_at<?').run(now());
        db.prepare('INSERT INTO workspace_oauth_states VALUES(?,?,?,?,NULL)').run(hash(state),hash(browser),safeReturn(url.searchParams.get('returnTo')),now()+STATE_TTL);
        const target = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
        target.search = new URLSearchParams({client_id:login.appId,response_type:'code',redirect_uri:login.redirectUri,state,scope:login.scope || ''}).toString();
        setCookies(res,[cookie(STATE_COOKIE,browser,600,'/auth/feishu/callback')]);
        res.writeHead(302,{location:target.href,'cache-control':'no-store','referrer-policy':'no-referrer'});res.end();return true;
      }
      if (path === '/auth/feishu/callback' && method === 'GET') { await callback(req,res,url);return true; }
      if (path === '/auth/session' && method === 'GET') {
        const s = session(req), requested = getBySlug(url.searchParams.get('workspace') || 'jerry');
        const own = s ? rowToSpace(db.prepare('SELECT * FROM workspaces WHERE owner_account_id=?').get(s.account_id)) : null;
        const isOwner = Boolean(s && requested?.ownerAccountId === s.account_id);
        respond(res,200,{ authenticated:Boolean(s), loginAvailable:activeLogin, feishuEnabled:activeLogin, canEdit:isOwner,
          user:s ? {id:s.subject_id,name:s.name,avatarUrl:s.avatar_url||null,workspaceSlug:own?.slug || null} : null,
          account:s ? { id:s.account_id,subjectId:s.subject_id,name:s.name } : null,
          workspace:requested ? {workspaceId:requested.workspaceId,slug:requested.slug,name:requested.name,role:isOwner?'owner':'guest'} : null,
          ownWorkspace:own ? {workspaceId:own.workspaceId,slug:own.slug,name:own.name} : null,
          csrfToken:s ? csrf(s.raw) : null });return true;
      }
      if (path === '/auth/logout' && method === 'POST') {
        const s = session(req);
        if (s && (!sameOrigin(req) || !equal(req.headers?.['x-csrf-token'],csrf(s.raw)))) throw problem(403,'CSRF_REQUIRED','请刷新登录状态后重试');
        if (s) db.prepare('DELETE FROM workspace_sessions WHERE token_hash=?').run(hash(s.raw));
        setCookies(res,[cookie(AUTH_COOKIE,'',0)]);respond(res,200,{ok:true});return true;
      }
      if (path === '/auth/workspace' && method === 'PATCH') {
        const {space} = requireSession(req,null,true), body = await bodyJson(req);
        const name = body.name === undefined ? space.name : typeof body.name === 'string' ? body.name.trim() : '';
        const slug = body.slug === undefined ? space.slug : body.slug;
        if (!name || name.length>80 || (slug !== space.slug && (!validSlug(slug) || space.workspaceId === 'jerry'))) throw problem(400,'INVALID_WORKSPACE','名称或地址无效');
        if (db.prepare('SELECT id FROM workspaces WHERE slug=? AND id<>?').get(slug,space.workspaceId)) throw problem(409,'SLUG_TAKEN','此地址已被使用');
        db.prepare('UPDATE workspaces SET name=?,slug=?,updated_at=? WHERE id=?').run(name,slug,now(),space.workspaceId);
        respond(res,200,{ok:true,workspace:{workspaceId:space.workspaceId,slug,name}});return true;
      }
      if (path === '/auth/tokens' && method === 'POST') {
        const {s,space} = requireSession(req,null,true), body = await bodyJson(req);
        if (body.scopes && (!Array.isArray(body.scopes) || body.scopes.length!==1 || body.scopes[0]!==TOKEN_SCOPE)) throw problem(400,'INVALID_SCOPES','仅支持 dashboard:report 权限');
        const name = typeof body.name === 'string' ? body.name.trim() : 'Dashboard Skill';
        if (!name || name.length>80) throw problem(400,'INVALID_TOKEN_NAME','令牌名称无效');
        const days = body.expiresInDays === undefined ? 90 : body.expiresInDays;
        if (!Number.isInteger(days) || days<1 || days>365) throw problem(400,'INVALID_TOKEN_EXPIRY','有效期须为 1–365 天');
        const count = db.prepare('SELECT count(*) AS n FROM workspace_tokens WHERE workspace_id=? AND revoked_at IS NULL AND expires_at>?').get(space.workspaceId,now()).n;
        if (count >= 20) throw problem(409,'TOKEN_LIMIT','请先撤销不再使用的令牌');
        const id = randomUUID(), token = 'dbr_'+secret(), expiresAt = now()+days*86400000;
        db.prepare('INSERT INTO workspace_tokens VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(id,hash(token),token.slice(0,12),space.workspaceId,s.account_id,name,JSON.stringify([TOKEN_SCOPE]),now(),expiresAt);
        respond(res,201,{ok:true,id,token,workspaceId:space.workspaceId,workspaceSlug:space.slug,scopes:[TOKEN_SCOPE],expiresAt:new Date(expiresAt).toISOString()});return true;
      }
      if (path === '/auth/tokens' && method === 'GET') {
        const {space} = requireSession(req,null,false);
        const items = db.prepare('SELECT id,prefix,name,scopes_json,created_at,expires_at,revoked_at FROM workspace_tokens WHERE workspace_id=? ORDER BY created_at DESC').all(space.workspaceId)
          .map(x => ({id:x.id,prefix:x.prefix,name:x.name,scopes:JSON.parse(x.scopes_json),createdAt:new Date(x.created_at).toISOString(),expiresAt:new Date(x.expires_at).toISOString(),revoked:Boolean(x.revoked_at)}));
        respond(res,200,{items});return true;
      }
      if ((path === '/auth/tokens' || path.startsWith('/auth/tokens/')) && method === 'DELETE') {
        const {space} = requireSession(req,null,true), id = path === '/auth/tokens' ? url.searchParams.get('id') : path.slice('/auth/tokens/'.length);
        const changed = db.prepare('UPDATE workspace_tokens SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL').run(now(),id || '',space.workspaceId).changes;
        if (!changed) throw problem(404,'TOKEN_NOT_FOUND','令牌不存在或已撤销');
        respond(res,200,{ok:true});return true;
      }
      respond(res,404,{error:'AUTH_ROUTE_NOT_FOUND'});return true;
    } catch (e) {
      if (res.headersSent) { res.end();return true; }
      respond(res,e.status || 500,{error:e.code || 'AUTH_INTERNAL',detail:e.status && e.status<500 ? e.message : '登录服务暂时不可用'});return true;
    }
  }
  return {getBySlug,getById,getConfig(slug){return getBySlug(slug)?.config || null;},resolveIdentity,resolveSender,verifyCsrf,verifySessionCsrf,handleAuth,
    close(){db.close();},
    // Read-only safe public workspace metadata. Never expose server_key or owner ids.
    describe(space){return space ? {workspaceId:space.workspaceId,slug:space.slug,name:space.name} : null;}
  };
}
