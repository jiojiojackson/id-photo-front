import { createHash } from "node:crypto";

const encoder = new TextEncoder();

const STORAGE_TIMEOUT_MS = 30_000;
const MAX_DELETE_BATCHES = 100;

export class R2Error extends Error {
  constructor(operation: string, public status: number, public code: string, public requestId: string | null) {
    super(`R2 ${operation} failed: HTTP ${status} (${code})`);
    this.name = "R2Error";
  }
}

async function readStorageResponse(response: Response, operation: string, root?: string) {
  const body = await response.text();
  const code = body.match(/<Code>([^<]+)<\/Code>/)?.[1];
  const requestId = response.headers.get("cf-ray") || response.headers.get("x-amz-request-id");
  if (!response.ok || code || (root && !new RegExp(`<${root}(?:\\s|>)`).test(body))) {
    const error = new R2Error(operation, response.status, code || (response.ok ? "InvalidResponse" : "HTTPError"), requestId);
    console.error("[R2]", { operation, status: error.status, code: error.code, requestId });
    throw error;
  }
  console.info("[R2]", { operation, status: response.status, requestId });
  return body;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const keyBytes = key instanceof ArrayBuffer ? new Uint8Array(key) : key;
  const keyBuffer = new ArrayBuffer(keyBytes.byteLength);
  new Uint8Array(keyBuffer).set(keyBytes);
  const cryptoKey = await crypto.subtle.importKey("raw", keyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

async function sha256Bytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Text(data: string) {
  return sha256Bytes(encoder.encode(data));
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function encode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(params: Record<string, string>) {
  return Object.entries(params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
}

function getConfig() {
  const accountId = required("R2_ACCOUNT_ID");
  return {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    bucket: required("R2_BUCKET_NAME"),
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

async function signingKey(secretAccessKey: string, dateStamp: string, region = "auto", service = "s3") {
  const kDate = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

async function signedBucketRequest(
  method: "GET" | "POST",
  query: Record<string, string>,
  body?: string,
  additionalHeaders: Record<string, string> = {},
) {
  const { accessKeyId, secretAccessKey, bucket, endpoint } = getConfig();
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const canonicalUri = `/${encode(bucket)}`;
  const host = new URL(endpoint).host;
  const payloadHash = await sha256Text(body || "");
  const headers: Record<string, string> = {
    ...additionalHeaders,
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const canonicalHeaderEntries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  const canonicalHeaders = canonicalHeaderEntries.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = canonicalHeaderEntries.map(([name]) => name).join(";");
  const queryString = canonicalQuery(query);
  const canonicalRequest = [method, canonicalUri, queryString, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Text(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(secretAccessKey, dateStamp, region, service), stringToSign));

  return fetch(`${endpoint}${canonicalUri}?${queryString}`, {
    method,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
}

function decodeListedKey(value: string) {
  const xmlDecoded = value
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return decodeURIComponent(xmlDecoded);
}

async function listObjectKeys() {
  const response = await signedBucketRequest("GET", {
    "encoding-type": "url",
    "list-type": "2",
    "max-keys": "1000",
  });
  const xml = await readStorageResponse(response, "list", "ListBucketResult");

  return [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => decodeListedKey(match[1]));
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function deleteObjects(keys: string[]) {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Delete>${keys
    .map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`)
    .join("")}<Quiet>true</Quiet></Delete>`;
  const response = await signedBucketRequest("POST", { delete: "" }, body, {
    "content-md5": createHash("md5").update(body).digest("base64"),
    "content-type": "application/xml",
  });
  await readStorageResponse(response, "delete", "DeleteResult");
}

/** Removes every object currently stored in the configured R2 bucket. */
export async function emptyBucket() {
  let deleted = 0;
  let previousPage = "";

  for (let batch = 0; batch <= MAX_DELETE_BATCHES; batch++) {
    const keys = await listObjectKeys();
    if (keys.length === 0) return deleted;
    if (batch === MAX_DELETE_BATCHES) throw new Error("R2 cleanup batch limit reached; retry to continue");
    const page = JSON.stringify(keys);
    if (page === previousPage) throw new Error("R2 cleanup made no progress; stopped repeated delete requests");
    previousPage = page;
    await deleteObjects(keys);
    deleted += keys.length;
  }
  return deleted;
}

export async function createPresignedUrl(method: "GET" | "PUT", key: string, expiresInSeconds = 1800): Promise<string> {
  const { accessKeyId, secretAccessKey, bucket, endpoint } = getConfig();
  const region = "auto";
  const service = "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const canonicalUri = `/${encode(bucket)}/${key.split("/").map(encode).join("/")}`;
  const host = new URL(endpoint).host;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.min(expiresInSeconds, 604800))),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQueryString = canonicalQuery(query);
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [method, canonicalUri, canonicalQueryString, canonicalHeaders, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Text(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(secretAccessKey, dateStamp, region, service), stringToSign));
  return `${endpoint}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

/** Direct SigV4 upload. Submission never creates a presigned URL. */
export async function putObject(key: string, body: ArrayBuffer | Uint8Array, contentType: string) {
  const { accessKeyId, secretAccessKey, bucket, endpoint } = getConfig();
  const region = "auto";
  const service = "s3";
  const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
  const payloadHash = await sha256Bytes(bytes);
  const bodyBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(bodyBuffer).set(bytes);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${credentialScope}`;
  const canonicalUri = `/${encode(bucket)}/${key.split("/").map(encode).join("/")}`;
  const host = new URL(endpoint).host;
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Text(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(secretAccessKey, dateStamp, region, service), stringToSign));
  const response = await fetch(`${endpoint}${canonicalUri}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Host": host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: bodyBuffer,
    cache: "no-store",
    signal: AbortSignal.timeout(STORAGE_TIMEOUT_MS),
  });
  await readStorageResponse(response, "upload");
}

export function inputKey(requestId: string) { return `input/${requestId}/original.jpg`; }
export function outputKey(jobId: string) { return `output/${jobId}.png`; }
