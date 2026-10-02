import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { test, after } from 'node:test';

let code=fs.readFileSync(new URL('../app/api/jobs/reset/route.ts',import.meta.url),'utf8');
code=code.replace(/^import .*;\n/gm,'');
code='const { NextResponse, sql, emptyBucket, getBackendHealth } = globalThis.__resetDependencies;\n'+code;
const compiled=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
after(()=>{delete globalThis.__resetDependencies;});
let version=0;
async function route({backend={reachable:true,workerRunId:null},state='idle',storageError=null}={}) {
  const operations=[];let storageCalls=0;
  const tx=async (strings)=>{const query=strings.join('?').trim();operations.push(query);if(query.startsWith('SELECT status'))return [{status:state}];if(query.startsWith('SELECT COUNT'))return [{count:0}];return [];};
  globalThis.__resetDependencies={
    NextResponse:{json:(body,options={})=>new Response(JSON.stringify(body),{status:options.status || 200})},
    sql:{begin:async callback=>callback(tx)},
    emptyBucket:async()=>{storageCalls++;if(storageError)throw storageError;return 2;},
    getBackendHealth:async()=>backend,
  };
  const module=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${version++}`);
  return {response:await module.POST(),operations,storageCalls};
}

test('busy backend blocks deletion without a storage request',async()=>{
  const result=await route({backend:{reachable:true,workerRunId:'active-run'}});
  assert.equal(result.response.status,409);assert.equal(result.storageCalls,0);assert.equal(result.operations.length,0);
});
test('busy database worker blocks deletion before touching R2',async()=>{
  const result=await route({state:'running'});
  assert.equal(result.response.status,409);assert.equal(result.storageCalls,0);
});
test('storage failure preserves database records',async()=>{
  const result=await route({storageError:new Error('R2 denied')});
  assert.equal(result.response.status,500);assert.equal(result.storageCalls,1);
  assert.ok(result.operations.every(q=>!q.startsWith('DELETE') && !q.startsWith('UPDATE')));
});
test('successful cleanup preserves the state row and avoids TRUNCATE',async()=>{
  const result=await route();assert.equal(result.response.status,200);
  assert.equal(result.storageCalls,1);
  assert.ok(result.operations[0].includes('FOR UPDATE'));
  assert.ok(result.operations.every(q=>!q.includes('TRUNCATE') && !q.includes('DELETE FROM photo_worker_state')));
  assert.deepEqual(result.operations.filter(q=>q.startsWith('DELETE')),['DELETE FROM photo_jobs','DELETE FROM photo_requests','DELETE FROM photo_worker_runs']);
});
