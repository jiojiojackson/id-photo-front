import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { test, after } from 'node:test';

let version=0;
after(()=>{delete globalThis.__workerLifecycle;});
async function invoke(routeName,body,{authenticated=true,validLease=true}={}) {
  const queries=[];
  const sql=async(strings,...values)=>{
    const query=strings.join('?').trim();queries.push({query,values});
    if(query.startsWith('UPDATE photo_worker_runs')) return [{id:'run-modal'}];
    if(query.startsWith('UPDATE photo_jobs') && query.includes('RETURNING'))return validLease ? [{lease_expires_at:'future'}] : [];
    if(query.startsWith('SELECT COUNT'))return [{count:0}];
    return [];
  };
  sql.begin=async callback=>callback(sql);
  globalThis.__workerLifecycle={sql,authenticateWorker:async()=>authenticated ? {id:'run-modal'} : null,NextResponse:{json:(body,options={})=>new Response(JSON.stringify(body),{status:options.status||200})}};
  const source=fs.readFileSync(new URL('../app/api/worker/' + routeName + '/route.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
  const compiled=ts.transpileModule('const {sql,authenticateWorker,NextResponse}=globalThis.__workerLifecycle;\n' + source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const route=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${version++}`);
  const response=await route.POST({json:async()=>body});
  return {status:response.status,body:await response.json(),queries};
}
test('run heartbeat can mark a cold GPU ready before any job is claimed',async()=>{
  const result=await invoke('heartbeat',{ready:true});
  assert.equal(result.status,200);assert.equal(result.body.ok,true);
  assert.ok(result.queries[0].query.includes('FOR UPDATE'));
  assert.ok(result.queries.some(q=>q.query.includes("SET status = 'running'") && q.values.includes('run-modal')));
  assert.ok(result.queries.every(q=>!q.query.startsWith('UPDATE photo_jobs')));
});
test('unauthenticated startup heartbeat cannot alter a run',async()=>{
  const result=await invoke('heartbeat',{ready:true},{authenticated:false});
  assert.equal(result.status,401);assert.equal(result.queries.length,0);
});
test('expired job lease still rejects job heartbeat',async()=>{
  const result=await invoke('heartbeat',{jobId:'old-job'},{validLease:false});
  assert.equal(result.status,409);
});
test('fatal GPU failure closes its run and only its processing jobs',async()=>{
  const result=await invoke('finish',{error:'GPU initialization failed'});
  assert.equal(result.status,200);assert.equal(result.body.status,'failed');
  const jobs=result.queries.find(q=>q.query.startsWith('UPDATE photo_jobs'));
  assert.ok(jobs.query.includes("WHERE worker_run_id = ? AND status = 'processing'"));
  assert.ok(jobs.values.includes('run-modal'));
  assert.ok(result.queries[0].query.includes('FOR UPDATE'));
  assert.ok(result.queries.every(q=>!q.query.startsWith('DELETE')));
});
