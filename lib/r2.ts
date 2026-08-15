const encoder = new TextEncoder();

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
  const canonicalQuery = Object.entries(query).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&");
  const canonicalHeaders = `host:${host}\n`;
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, await sha256Text(canonicalRequest)].join("\n");
  const signature = hex(await hmac(await signingKey(secretAccessKey, dateStamp, region, service), stringToSign));
  return `${endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
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
  });
  if (!response.ok) throw new Error(`R2 upload failed: ${response.status}`);
}

export function inputKey(requestId: string) { return `input/${requestId}/original.jpg`; }
export function outputKey(jobId: string) { return `output/${jobId}.png`; }
