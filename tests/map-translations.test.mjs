import '../.github/scripts/test-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorModelSettings } from '../scripts/cloud/coordinator-model-settings.mjs';
import { CoordinatorService } from '../scripts/cloud/coordinator-service.mjs';
import { startCloudServer } from '../scripts/cloud/server.mjs';
import { MapTranslations } from '../scripts/cloud/map-translations.mjs';

test('Map translations are validated atomically and share only scoped exact-source cache',async()=>{
  const service=new MapTranslations(),calls=[];
  const model={model:'synthetic',next:async request=>{calls.push(request);const input=JSON.parse(request.messages[0].content);return answer(JSON.stringify({translations:input.texts.map(source=>({source,text:'English '+source}))}));}};
  const route={scope:'project:main',providerId:'selected',model};
  assert.deepEqual(await service.translate({language:'en',texts:['名称','说明']},route),{language:'en',translations:[{source:'名称',text:'English 名称'},{source:'说明',text:'English 说明'}]});
  await service.translate({language:'en',texts:['说明','名称']},route);assert.equal(calls.length,1);
  assert.deepEqual(calls[0].tools,[]);assert.equal(calls[0].messages.length,1);assert.equal(calls[0].maxTokens,4096);
  await service.translate({language:'en',texts:['名称']},{...route,scope:'project:session:other'});assert.equal(calls.length,2);
  await service.translate({language:'en',texts:['新名称']},route);assert.equal(calls.length,3);
  for(const input of [{}, {language:'fr',texts:['x']},{language:'en',texts:['']},{language:'en',texts:['x'.repeat(2001)]},{language:'en',texts:Array(25).fill('x')},{language:'en',texts:['x'],token:'forbidden'}])await assert.rejects(service.translate(input,route),{code:'INVALID_TRANSLATION'});
  let attempts=0;const broken={...model,next:async()=>{attempts++;return answer(JSON.stringify({translations:[{source:'safe',text:'translated'},{source:'extra',text:'wrong'}]}));}};
  await assert.rejects(service.translate({language:'en',texts:['safe']},{...route,model:broken}),{code:'TRANSLATION_UNAVAILABLE'});
  await assert.rejects(service.translate({language:'en',texts:['safe']},{...route,model:broken}),{code:'TRANSLATION_UNAVAILABLE'});assert.equal(attempts,2);
});

test('Map translation HTTP is human-cookie only, rejects foreign origin and bad scopes, and never opens a conversation',async t=>{
  const f=await fixture(t),directory=path.join(f.directory,'translation-server'),root=path.join(f.directory,'checkout');await fs.mkdir(root);await fs.mkdir(directory);
  await fs.writeFile(path.join(directory,'projects.json'),JSON.stringify({v:2,projects:[{id:'lab',name:'Lab'}]}));
  const calls=[];
  const server=await startCloudServer({dataDir:directory,port:0,browserToken:'synthetic-browser',memoryConfig:{dataDir:path.join(f.directory,'memory'),adminToken:'synthetic-admin',projects:{lab:{root,token:'synthetic-project',coordinator:f.config}}},coordinatorModelFactory:config=>({model:config.model,next:async req=>{calls.push(req);return answer(JSON.stringify({translations:JSON.parse(req.messages[0].content).texts.map(source=>({source,text:'Translated module'}))}));}})});
  t.after(()=>server.close());const url=server.url+'/api/workbench/projects/lab/api/map/translations',body=JSON.stringify({language:'en',texts:['模块名称']});
  const headers={'Content-Type':'application/json',Cookie:'cg_workbench=synthetic-browser',Origin:server.url};
  for(const token of ['', 'synthetic-project','synthetic-browser'])assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body})).status,401);
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body})).status,403);
  assert.equal((await fetch(url+'?view=session:missing',{method:'POST',headers,body})).status,404);
  assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({language:'en',texts:['name'],baseUrl:'https://other.invalid'})})).status,400);
  const result=await fetch(url,{method:'POST',headers,body});assert.equal(result.status,200,await result.clone().text());
  assert.deepEqual(await result.json(),{language:'en',translations:[{source:'模块名称',text:'Translated module'}]});
  assert.equal((await fetch(url,{method:'POST',headers,body})).status,200);assert.equal(calls.length,1);
  assert.deepEqual(calls[0].tools,[]);assert.equal(calls[0].messages.length,1);
  assert.equal((await fs.readdir(path.join(directory,'coordinators','lab')).catch(()=>[])).length,0,'translation creates no conversation or model-settings records');
});

const answer = text => ({ content: [{ type: 'text', text }], stop: 'end_turn', usage: {} });
const factory = config => ({ model: config.model, next: async () => answer('synthetic') });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cg-model-settings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const providerFile = path.join(directory, 'glm-private.json'), ds = path.join(directory, 'ds-private.json');
  for (const [file, model] of [[providerFile, 'glm-5.3'], [ds, 'deepseek-flash']]) {
    await fs.writeFile(file, JSON.stringify({ model, token: 'synthetic-private-marker', baseUrl: 'https://provider.invalid', protocol: 'anthropic' }));
  }
  const config = { enabled: true, providerFile, modelProviders: {
    glm: { label: 'GLM 5.3', providerFile }, ds: { label: 'DeepSeek V4.1 Flash', providerFile: ds },
  }, defaultProviderId: 'glm', bindings: {} };
  const settings = await CoordinatorModelSettings.open({ directory, config, factory });
  return { directory, config, settings };
}
