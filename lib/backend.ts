export function isBackendLocation(value: unknown): value is "modal" {
  return value === "modal";
}

export function backendConfig() {
  const base = process.env.MODAL_API_URL;
  const token = process.env.MODAL_BACKEND_TOKEN;
  if (!base || !token) throw new Error("Modal 处理服务尚未配置");
  const url = new URL(base);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".modal.run")) throw new Error("Modal 服务地址无效");
  url.pathname = url.pathname.replace(/\/process-queue\/?$/, "").replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return { url, headers: { Authorization: `Bearer ${token}` } as Record<string, string> };
}

export async function getBackendHealth() {
  const configured = Boolean(process.env.MODAL_API_URL && process.env.MODAL_BACKEND_TOKEN);
  try {
    const { url, headers } = backendConfig();
    url.pathname = url.pathname.replace(/\/$/, "") + "/health";
    const response = await fetch(url, { headers, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(5_000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== "healthy") {
      return { location: "modal", configured, reachable: false, workerRunId: null, error: `Modal 服务健康检查失败 (${response.status})` };
    }
    return { location: "modal", configured, reachable: true, workerRunId: body.worker_run_id || null, error: null };
  } catch {
    return { location: "modal", configured, reachable: false, workerRunId: null, error: "无法连接 Modal 处理服务，请检查服务地址和网络" };
  }
}
