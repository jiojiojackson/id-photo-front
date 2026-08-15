"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

const PRESETS = [
  { name: "标准 295×413", width: 295, height: 413 },
  { name: "600×800", width: 600, height: 800 },
  { name: "300×400", width: 300, height: 400 },
];
const MAX_IMAGE_DIMENSION = 2000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const FALLBACK_SECONDS_PER_JOB = 45;

type Size = { width: number; height: number };
type Job = { id: string; width: number; height: number; unit?: string; status: string; resultUrl: string | null; error?: string | null };
type TimedJob = Job & { processing_time_ms?: number };

function formatBytes(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }

async function compressImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width, height = bitmap.height;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
    width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale));
  }
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close(); throw new Error("浏览器不支持图片处理"); }
  ctx.drawImage(bitmap, 0, 0, width, height); bitmap.close();
  let quality = 0.85, blob: Blob | null = null;
  for (let i = 0; i < 6; i += 1) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob || blob.size <= MAX_UPLOAD_BYTES) break;
    quality -= 0.1;
  }
  if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error("照片压缩后仍然超过 2 MB");
  return new File([blob], "id-photo-upload.jpg", { type: "image/jpeg", lastModified: Date.now() });
}

function normalize(value: string, fallback: number) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(3000, Math.max(100, n)) : fallback;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [sizes, setSizes] = useState<Size[]>([
    { width: 295, height: 413 },
    { width: 600, height: 800 },
    { width: 300, height: 400 },
  ]);
  const [background, setBackground] = useState("#ffffff");
  const [dpi, setDpi] = useState(300);
  const [submitting, setSubmitting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [queued, setQueued] = useState(0);
  const [counts, setCounts] = useState({ queued: 0, processing: 0, completed: 0, failed: 0, total: 0 });
  const [workerStatus, setWorkerStatus] = useState("idle");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [avgSeconds, setAvgSeconds] = useState(FALLBACK_SECONDS_PER_JOB);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  // This is intentionally manual-only. /api/jobs/status may reconcile stale
  // Worker Runs in PostgreSQL, but it must never wake Lightning.
  async function refreshStatus() {
    setRefreshing(true);
    try {
      const response = await fetch("/api/jobs/status", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      setCounts(data.counts); setQueued(data.counts.queued); setWorkerStatus(data.worker?.status || "idle"); setJobs(data.jobs || []);
      const times: number[] = (data.jobs || [])
        .map((j: TimedJob) => j.processing_time_ms)
        .filter((n: number | undefined): n is number => typeof n === "number" && n > 0);
      if (times.length) setAvgSeconds(Math.max(5, times.reduce((a: number, b: number) => a + b, 0) / times.length / 1000));
    } catch { /* manual refresh can fail transiently */ }
    finally { setRefreshing(false); }
  }

  async function resetHistory() {
    if (resetting) return;
    const confirmed = window.confirm("确定清除当前所有任务和历史记录吗？\n\n这会删除当前 Job、请求记录和 Worker Run，无法恢复。\n如果 Lightning 正在处理任务，请先确认它已经停止。\n\n清除后会回到初始状态。" );
    if (!confirmed) return;
    setResetting(true); setError("");
    try {
      const response = await fetch("/api/jobs/reset", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `清除失败 (${response.status})`);
      setCounts({ queued: 0, processing: 0, completed: 0, failed: 0, total: 0 });
      setQueued(0); setWorkerStatus("idle"); setJobs([]);
    } catch (err) { setError(err instanceof Error ? err.message : "清除历史记录失败"); }
    finally { setResetting(false); }
  }

  function handleFile(selected: File) {
    if (preview) URL.revokeObjectURL(preview);
    setFile(selected); setPreview(URL.createObjectURL(selected)); setError("");
  }
  function onFileChange(e: ChangeEvent<HTMLInputElement>) { const selected = e.target.files?.[0]; if (selected) handleFile(selected); }
  function setSize(index: number, key: keyof Size, value: string) {
    setSizes((current) => current.map((s, i) => i === index ? { ...s, [key]: normalize(value, key === "width" ? s.width : s.height) } : s));
  }
  function applyPreset(index: number, preset: Size) { setSizes((current) => current.map((s, i) => i === index ? preset : s)); }

  async function submitJobs() {
    if (!file) { setError("请选择照片"); return; }
    setSubmitting(true); setError("");
    try {
      const compressed = await compressImage(file);
      const form = new FormData(); form.append("image", compressed); form.append("sizes", JSON.stringify(sizes)); form.append("dpi", String(dpi)); form.append("background", background);
      const response = await fetch("/api/jobs/submit", { method: "POST", body: form });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `提交失败 (${response.status})`);
      await refreshStatus();
    } catch (err) { setError(err instanceof Error ? err.message : "提交任务失败"); }
    finally { setSubmitting(false); }
  }

  async function startProcessing() {
    if (!queued || workerStatus !== "idle") return;
    setStarting(true); setError("");
    try {
      // Only this explicit Start action is allowed to reach /api/jobs/start,
      // whose server-side implementation is responsible for waking Lightning.
      const response = await fetch("/api/jobs/start", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `启动失败 (${response.status})`);
      await refreshStatus();
    } catch (err) {
      await refreshStatus();
      setError(err instanceof Error ? err.message : "启动处理失败");
    }
    finally { setStarting(false); }
  }

  async function handleLogout() { setLoggingOut(true); try { const response = await fetch("/api/auth/logout", { method: "POST" }); if (response.ok) router.push("/login"); } finally { setLoggingOut(false); } }

  const estimatedSeconds = Math.max(1, Math.ceil(queued * avgSeconds));
  const estimate = estimatedSeconds < 60 ? `约 ${estimatedSeconds} 秒` : `约 ${Math.ceil(estimatedSeconds / 60)} 分钟`;
  const canStart = queued > 0 && workerStatus === "idle" && !starting;

  return (
    <main className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <h1 style={{ margin: 0 }}>AI 证件照</h1>
        <button onClick={handleLogout} disabled={loggingOut} style={{ background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: 8, padding: "8px 16px", fontWeight: 600 }}>{loggingOut ? "正在退出..." : "退出登录"}</button>
      </div>
      <p className="subtitle">先提交任务，攒好任务后再启动 AI 处理，节省 Lightning GPU 运行时间。</p>

      <section className="card">
        <h2>1. 照片</h2>
        <button className="primary" onClick={() => fileInputRef.current?.click()}>{file ? "重新选择照片" : "选择照片"}</button>
        <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChange} />
        {preview && <div className="preview"><img src={preview} alt="原始照片" /></div>}
        {file && <div className="hint">原图：{formatBytes(file.size)}，提交时自动压缩到 2 MB 以内。</div>}
      </section>

      <section className="card">
        <h2>2. 一次生成 3 个尺寸</h2>
        {sizes.map((size, index) => (
          <div key={index} style={{ marginBottom: 14 }}>
            <div className="size-row">
              <label>尺寸 {index + 1}<input type="number" min="100" max="3000" value={size.width} onChange={(e) => setSize(index, "width", e.target.value)} /></label>
              <span>×</span>
              <label>高度<input type="number" min="100" max="3000" value={size.height} onChange={(e) => setSize(index, "height", e.target.value)} /></label>
            </div>
            <div className="preset-grid">{PRESETS.map((preset) => <button key={preset.name} className={size.width === preset.width && size.height === preset.height ? "preset active" : "preset"} onClick={() => applyPreset(index, preset)}>{preset.name}</button>)}</div>
          </div>
        ))}
        <div className="size-row"><label>DPI<input type="number" min="72" max="1200" value={dpi} onChange={(e) => setDpi(normalize(e.target.value, 300))} /></label><label>背景色<input type="text" value={background} onChange={(e) => setBackground(e.target.value)} /></label></div>
        <div className="hint">三个尺寸会创建 3 个独立 Job，可以分别成功、失败和重试。</div>
      </section>

      <section className="card">
        <h2>3. 任务队列</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, textAlign: "center", marginBottom: 14 }}>
          <div><strong style={{ fontSize: 24 }}>{counts.queued}</strong><div className="hint">待处理</div></div>
          <div><strong style={{ fontSize: 24 }}>{counts.processing}</strong><div className="hint">处理中</div></div>
          <div><strong style={{ fontSize: 24 }}>{counts.completed}</strong><div className="hint">已完成</div></div>
          <div><strong style={{ fontSize: 24 }}>{counts.failed}</strong><div className="hint">失败</div></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <button className="generate" onClick={submitJobs} disabled={!file || submitting}>{submitting ? "正在提交…" : "提交任务（加入队列）"}</button>
          <button className="generate" onClick={refreshStatus} disabled={refreshing}>{refreshing ? "正在刷新…" : "刷新任务状态"}</button>
        </div>
        <button className="generate" onClick={startProcessing} disabled={!canStart} style={{ marginTop: 10, opacity: canStart ? 1 : 0.55 }}>
          {starting || workerStatus === "starting" ? "正在唤醒 Lightning…" : workerStatus === "running" ? `处理中（${counts.processing} 个）` : queued ? `开始处理（${queued} 个任务）` : "开始处理（0 个任务）"}
        </button>
        <button onClick={resetHistory} disabled={resetting || starting} style={{ width: "100%", marginTop: 10, padding: "10px 14px", border: "1px solid #fecaca", borderRadius: 8, background: "#fff1f2", color: "#b91c1c", fontWeight: 600, cursor: resetting ? "wait" : "pointer" }}>
          {resetting ? "正在清除历史记录…" : "清除当前历史记录"}
        </button>
        <div className="hint" style={{ textAlign: "center", marginTop: 10 }}>{queued ? `根据历史处理速度，预计 ${estimate}。点击开始后才生成临时 R2 URL 并唤醒 Lightning。` : "任务状态不会自动轮询。点击“刷新任务状态”时才会查询状态；如果 Lightning 已停止，刷新后会将失联的 Worker Run 标记为失败。"}</div>
        {error && <div className="error">{error}</div>}
      </section>

      <section className="card">
        <h2>4. 结果</h2>
        {!jobs.length && <div className="hint">暂无任务。</div>}
        {jobs.map((job) => (
          <div key={job.id} style={{ borderTop: "1px solid #e5e7eb", padding: "12px 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><strong>{job.width} × {job.height}{job.unit ? ` ${job.unit}` : ""}</strong><span>{job.status === "queued" ? "等待中" : job.status === "processing" ? "处理中" : job.status === "completed" ? "✓ 完成" : "✕ 失败"}</span></div>
            {job.resultUrl && <img src={job.resultUrl} alt={`${job.width}×${job.height}`} style={{ maxWidth: 220, marginTop: 10, borderRadius: 8 }} />}
            {job.resultUrl && <div><a className="download" href={job.resultUrl} target="_blank" rel="noreferrer">查看 / 下载</a></div>}
            {job.error && <div className="error">{job.error}</div>}
          </div>
        ))}
      </section>
    </main>
  );
}
