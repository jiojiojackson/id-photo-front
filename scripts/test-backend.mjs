import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { test, after } from 'node:test';

const compile = code => ts.transpileModule(code, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const source = fs.readFileSync(new URL('../lib/backend.ts',import.meta.url),'utf8');
const backend = await import('data:text/javascript;base64,' + Buffer.from(compile(source)).toString('base64'));
const keys = ['PANGOLIN_API_URL','PANGOLIN_ACCESS_TOKEN_ID','PANGOLIN_ACCESS_TOKEN','MODAL_API_URL','MODAL_BACKEND_TOKEN'];
const original = Object.fromEntries(keys.map(key=>[key,process.env[key]]));
after(()=>{ for(const key of keys) { if(original[key] === undefined) delete process.env[key]; else process.env[key]=original[key]; } delete globalThis.__startDependencies; });
function configure() {
  Object.assign(process.env,{PANGOLIN_API_URL:'https://oracle.example/process-queue',PANGOLIN_ACCESS_TOKEN_ID:'oracle-id',PANGOLIN_ACCESS_TOKEN:'oracle-token',MODAL_API_URL:'https://example--id-photo.modal.run',MODAL_BACKEND_TOKEN:'modal-token'});
}
test('Oracle stays the default and receives only Pangolin credentials',()=>{
  configure();
  const config=backend.backendConfig();
  assert.equal(config.url.href,'https://oracle.example/');
  assert.deepEqual(config.headers,{'P-Access-Token-Id':'oracle-id','P-Access-Token':'oracle-token'});
});
test('Modal receives its dedicated token without Oracle credentials',()=>{
  configure();
  const config=backend.backendConfig('modal');
  assert.equal(config.url.hostname,'example--id-photo.modal.run');
  assert.deepEqual(config.headers,{Authorization:'Bearer modal-token'});
});
test('missing Modal configuration and arbitrary endpoint URLs are rejected',()=>{
  configure();delete process.env.MODAL_BACKEND_TOKEN;
  assert.throws(()=>backend.backendConfig('modal'),/尚未配置/);
  process.env.MODAL_BACKEND_TOKEN='test';process.env.MODAL_API_URL='http://localhost';
  assert.throws(()=>backend.backendConfig('modal'),/地址无效/);
  assert.equal(backend.isBackendLocation('https://elsewhere.example'),false);
});

let version=0;
const routeSource=fs.readFileSync(new URL('../app/api/jobs/start/route.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const routeCode=compile('const {NextResponse,sql,backendConfig,isBackendLocation,createWorkerCredential,hashWorkerCredential,credentialExpiryDate,fetch}=globalThis.__startDependencies;\n' + routeSource);
async function start(location, active=null) {
  const queries=[], wakes=[];
  const tx=async(strings,...values)=>{
    const query=strings.join('?').trim();queries.push({query,values});
    if(query.startsWith('SELECT status, active_run_id'))return [{status:active ? 'starting' : 'idle',active_run_id:active ? 'existing' : null}];
    if(query.startsWith('SELECT status, backend'))return active ? [active] : [];
    if(query.startsWith('SELECT COUNT'))return [{count:1}];
    return [];
  };
  const sql=async()=>[{avg_ms:0}];sql.begin=async callback=>callback(tx);
  globalThis.__startDependencies={
    sql,backendConfig:choice=>({url:new URL(choice === 'modal' ? 'https://test.modal.run' : 'https://oracle.example'),headers:{'X-Test-Backend':choice}}),
    isBackendLocation:backend.isBackendLocation,createWorkerCredential:()=> 'a'.repeat(64),hashWorkerCredential:async()=> 'hash',credentialExpiryDate:()=>new Date(Date.now()+3600000),
    NextResponse:{json:(body,options={})=>new Response(JSON.stringify(body),{status:options.status||200})},
    fetch:async(url,options)=>{const payload=JSON.parse(options.body);wakes.push({url:String(url),payload,headers:options.headers});return new Response(JSON.stringify({status:'started',worker_run_id:payload.worker_run_id}));},
  };
  const route=await import(`data:text/javascript;base64,${Buffer.from(routeCode).toString('base64')}#${version++}`);
  const response=await route.POST({json:async()=>location ? {backend:location} : {},nextUrl:new URL('https://front.example')});
  return {response,body:await response.json(),queries,wakes};
}
test('invalid backend selection never creates a run or contacts a backend',async()=>{
  const result=await start('unknown');
  assert.equal(result.response.status,400);assert.equal(result.queries.length,0);assert.equal(result.wakes.length,0);
});
test('Modal starts asynchronously and remains starting until a GPU heartbeat',async()=>{
  const result=await start('modal');
  assert.equal(result.response.status,200);assert.equal(result.body.backend,'modal');
  assert.equal(result.wakes[0].url,'https://test.modal.run/process-queue');
  assert.equal(result.wakes[0].payload.bridge_url,'https://front.example/api/worker');
  assert.ok(result.queries.some(q=>q.query.startsWith('INSERT INTO photo_worker_runs') && q.values.includes('modal')));
  assert.ok(result.queries.every(q=>!q.query.includes("SET status = 'running'")));
});
test('legacy start requests still use Oracle',async()=>{
  const result=await start();
  assert.equal(result.body.backend,'oracle');
  assert.equal(result.wakes[0].url,'https://oracle.example/process-queue');
});
test('Modal cold start is not reclaimed after only three minutes',async()=>{
  const result=await start('oracle',{backend:'modal',status:'starting',credential_expires_at:new Date(Date.now()+3600000),last_seen_at:new Date(Date.now()-180000)});
  assert.equal(result.body.status,'already_running');
  assert.equal(result.wakes.length,0);
});
