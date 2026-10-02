import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import { test, after } from "node:test";

const code = fs.readFileSync(new URL("../lib/r2.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const r2 = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const originalFetch = globalThis.fetch;
const originalInfo = console.info;
console.info = () => {};
Object.assign(process.env, { R2_ACCOUNT_ID: "test", R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret", R2_BUCKET_NAME: "test-bucket" });
after(() => { globalThis.fetch = originalFetch; console.info = originalInfo; });

function mockResponses(responses) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    assert.ok(options.signal, "storage operations must have a timeout");
    const response = responses.shift();
    assert.ok(response, "cleanup made unexpected additional requests");
    return response;
  };
  return calls;
}
const list = keys => new Response(`<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`);
const deleted = () => new Response("<DeleteResult></DeleteResult>");

test("successful cleanup stops once the bucket is empty", async () => {
  const calls = mockResponses([list(["input/one.jpg", "output/one.png"]), deleted(), list([])]);
  assert.equal(await r2.emptyBucket(), 2);
  assert.deepEqual(calls.map(c => c.method), ["GET", "POST", "GET"]);
});

test("a deletion with no progress stops instead of repeatedly deleting", async () => {
  const calls = mockResponses([list(["one.png"]), deleted(), list(["one.png"])]);
  await assert.rejects(r2.emptyBucket(), /no progress/);
  assert.equal(calls.length, 3);
});

test("a 200 HTML page is not accepted as an empty bucket", async () => {
  const calls = mockResponses([new Response("<html>challenge</html>")]);
  await assert.rejects(r2.emptyBucket(), /InvalidResponse/);
  assert.equal(calls.length, 1);
});

test("object-level deletion errors stop the cleanup", async () => {
  const calls = mockResponses([list(["one.png"]), new Response("<DeleteResult><Error><Code>AccessDenied</Code></Error></DeleteResult>")]);
  await assert.rejects(r2.emptyBucket(), /AccessDenied/);
  assert.equal(calls.length, 2);
});

test("continually changing pages still have a fixed request limit", async () => {
  const responses = [];
  for (let i = 0; i < 100; i++) responses.push(list([`file-${i}.png`]), deleted());
  responses.push(list(["file-100.png"]));
  const calls = mockResponses(responses);
  await assert.rejects(r2.emptyBucket(), /batch limit/);
  assert.equal(calls.length, 201);
});

test("upload rate limit reports a safe diagnostic and does not retry", async () => {
  const calls = mockResponses([new Response("<Error><Code>SlowDown</Code></Error>", { status: 429, headers: { "cf-ray": "test-ray" } })]);
  await assert.rejects(r2.putObject("input/test.jpg", new Uint8Array([1, 2]), "image/jpeg"), error => error instanceof r2.R2Error && error.status === 429 && error.code === "SlowDown" && error.requestId === "test-ray");
  assert.equal(calls.length, 1);
});
