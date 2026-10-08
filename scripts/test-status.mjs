import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { test, after } from 'node:test';

let code = fs.readFileSync(new URL('../app/api/jobs/status/route.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
code = 'const { NextResponse, sql, getBackendHealth } = globalThis.__statusDependencies;\n' + code;
const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
after(() => { delete globalThis.__statusDependencies; });
let version = 0;

async function status(query = '', { counts = { queued: 2, processing: 0, completed: 27, failed: 1, total: 30 }, position = 0 } = {}) {
  const queries = [], healthCalls = [];
  const sql = async (strings, ...values) => {
    const statement = strings.join('?').trim();
    queries.push({ statement, values });
    if (statement.startsWith('SELECT\n          COUNT')) return [counts];
    if (statement.startsWith('SELECT COUNT(*)::int AS position')) return [{ position }];
    if (statement.startsWith('SELECT state.status')) return [{ status: 'idle', backend: null }];
    if (statement.startsWith('SELECT id, request_id')) return [{ id: 'test result', status: 'completed', width: 295, height: 413 }];
    return [];
  };
  sql.begin = async callback => callback(async () => []);
  globalThis.__statusDependencies = {
    sql, getBackendHealth: async (...args) => { healthCalls.push(args); return { location:'modal',configured:true,reachable:true }; },
    NextResponse: { json: (body, options = {}) => new Response(JSON.stringify(body), { status: options.status || 200 }) },
  };
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}#${version++}`);
  const response = await module.GET(new Request('https://example.test/api/jobs/status?' + query));
  return { response, body: await response.json(), queries, healthCalls };
}

test('completed library uses its own total and paginates in stable order', async () => {
  const result = await status('status=completed&page=2&pageSize=6');
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.pagination, { page: 2, pageSize: 6, total: 27, totalPages: 5 });
  const jobs = result.queries.find(q => q.statement.startsWith('SELECT id, request_id'));
  assert.ok(jobs.statement.includes('ORDER BY created_at DESC, id DESC'));
  assert.deepEqual(jobs.values, ['completed', 'completed', 6, 6]);
  assert.equal(result.body.jobs[0].resultUrl, '/api/jobs/image?jobId=test%20result');
});
test('out of range page clamps to last page', async () => {
  const result = await status('page=999&pageSize=8');
  assert.deepEqual(result.body.pagination, { page: 4, pageSize: 8, total: 30, totalPages: 4 });
  assert.deepEqual(result.queries.at(-1).values.slice(-2), [8, 24]);
});
test('invalid parameters fall back safely and page size is bounded', async () => {
  const result = await status('status=bad&page=-4&pageSize=10000');
  assert.deepEqual(result.body.pagination, { page: 1, pageSize: 50, total: 30, totalPages: 1 });
  assert.deepEqual(result.queries.at(-1).values, ['', '', 50, 0]);
});
test('an older selected photo opens its actual library page', async () => {
  const result = await status('status=completed&pageSize=6&jobId=old-photo', { position: 19 });
  assert.equal(result.body.pagination.page, 4);
  assert.deepEqual(result.queries.at(-1).values.slice(-2), [6, 18]);
});
test('empty filtered library remains on page one', async () => {
  const result = await status('status=processing&page=8');
  assert.deepEqual(result.body.pagination, { page: 1, pageSize: 8, total: 0, totalPages: 1 });
});
test('old backend query parameters cannot switch health checks away from Modal', async () => {
  const result = await status('backend=oracle');
  assert.equal(result.response.status,200);
  assert.equal(result.body.backend.location,'modal');
  assert.equal(result.body.backend.configured,true);
  assert.deepEqual(result.healthCalls,[[]]);
  assert.equal(result.body.backends,undefined);
});
