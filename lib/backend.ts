export function backendConfig() {
  const base = process.env.PANGOLIN_API_URL;
  const tokenId = process.env.PANGOLIN_ACCESS_TOKEN_ID;
  const token = process.env.PANGOLIN_ACCESS_TOKEN;
  if (!base || !tokenId || !token) throw new Error("处理服务地址或访问凭证未配置");
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/process-queue\/?$/, "").replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return { url, headers: { "P-Access-Token-Id": tokenId, "P-Access-Token": token } };
}

export async function getBackendHealth() {
  try {
    const { url, headers } = backendConfig();
    url.pathname += "/health";
    const response = await fetch(url, { headers, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(5_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== "healthy") {
      return { reachable: false, workerRunId: null, error: `处理服务健康检查失败 (${response.status})` };
    }
    return { reachable: true, workerRunId: body.worker_run_id || null, error: null };
  } catch {
    return { reachable: false, workerRunId: null, error: "无法连接处理服务，请检查服务地址和网络" };
  }
}
