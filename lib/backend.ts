export type BackendLocation = "oracle" | "modal";

export function isBackendLocation(value: unknown): value is BackendLocation {
  return value === "oracle" || value === "modal";
}

export function backendOptions() {
  return [
    { id: "oracle" as const, name: "Oracle", detail: "当前服务器 · CPU", configured: Boolean(process.env.PANGOLIN_API_URL && process.env.PANGOLIN_ACCESS_TOKEN_ID && process.env.PANGOLIN_ACCESS_TOKEN) },
    { id: "modal" as const, name: "Modal", detail: "L4 GPU · BiRefNet Lite + RetinaFace", configured: Boolean(process.env.MODAL_API_URL && process.env.MODAL_BACKEND_TOKEN) },
  ];
}

export function backendConfig(location: BackendLocation = "oracle") {
  if (location === "modal") {
    const base = process.env.MODAL_API_URL;
    const token = process.env.MODAL_BACKEND_TOKEN;
    if (!base || !token) throw new Error("Modal 处理服务尚未配置");
    const url = new URL(base);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".modal.run")) throw new Error("Modal 服务地址无效");
    url.pathname = url.pathname.replace(/\/process-queue\/?$/, "").replace(/\/$/, "");
    url.search = ""; url.hash = "";
    return { url, headers: { Authorization: `Bearer ${token}` } as Record<string, string> };
  }
  const base = process.env.PANGOLIN_API_URL;
  const tokenId = process.env.PANGOLIN_ACCESS_TOKEN_ID;
  const token = process.env.PANGOLIN_ACCESS_TOKEN;
  if (!base || !tokenId || !token) throw new Error("处理服务地址或访问凭证未配置");
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/process-queue\/?$/, "").replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return { url, headers: { "P-Access-Token-Id": tokenId, "P-Access-Token": token } as Record<string, string> };
}

export async function getBackendHealth(location: BackendLocation = "oracle") {
  try {
    const { url, headers } = backendConfig(location);
    url.pathname = url.pathname.replace(/\/$/, "") + "/health";
    const response = await fetch(url, { headers, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(5_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== "healthy") {
      return { location, reachable: false, workerRunId: null, error: `${location === "modal" ? "Modal" : "Oracle"} 服务健康检查失败 (${response.status})` };
    }
    return { location, reachable: true, workerRunId: body.worker_run_id || null, error: null };
  } catch {
    return { location, reachable: false, workerRunId: null, error: `无法连接 ${location === "modal" ? "Modal" : "Oracle"} 处理服务，请检查服务地址和网络` };
  }
}
