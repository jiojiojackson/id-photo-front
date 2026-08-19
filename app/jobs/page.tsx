"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";

type Job = { id: string; width: number; height: number; status: string; resultUrl: string | null; error?: string | null };
type Counts = { queued: number; processing: number; completed: number; failed: number; total: number };

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [counts, setCounts] = useState<Counts>({ queued: 0, processing: 0, completed: 0, failed: 0, total: 0 });
  const [workerStatus, setWorkerStatus] = useState("idle");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function refreshStatus() {
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/jobs/status", { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `刷新失败 (${response.status})`);
      setCounts(data.counts); setJobs(data.jobs || []); setWorkerStatus(data.worker?.status || "idle");
    } catch (err) { setError(err instanceof Error ? err.message : "刷新任务状态失败"); }
    finally { setLoading(false); }
  }

  useEffect(() => { refreshStatus(); }, []);

  async function startProcessing() {
    if (!counts.queued || workerStatus !== "idle") return;
    setStarting(true); setError("");
    try {
      const response = await fetch("/api/jobs/start", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `启动失败 (${response.status})`);
      await refreshStatus();
    } catch (err) { await refreshStatus(); setError(err instanceof Error ? err.message : "启动处理失败"); }
    finally { setStarting(false); }
  }

  async function clearHistory() {
    setClearing(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/jobs/reset", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `删除失败 (${response.status})`);
      await refreshStatus();
      setConfirmClear(false); setNotice("队列和历史数据已全部清空");
    } catch (err) { setError(err instanceof Error ? err.message : "删除历史记录失败"); }
    finally { setClearing(false); }
  }

  const estimate = useMemo(() => counts.queued ? `当前有 ${counts.queued} 个任务等待处理` : "没有待处理任务", [counts.queued]);
  const statusLabel = (status: string) => status === "queued" ? "等待中" : status === "processing" ? "处理中" : status === "completed" ? "已完成" : "处理失败";

  return <AppShell>
    <div className="hero compact-hero"><div><div className="eyebrow">STEP 02 · QUEUE</div><h1>任务队列</h1><p>提交只是排队，只有点击开始处理才会调用 Pangolin 后面的处理服务。</p></div><Link className="secondary-action" href="/create">＋ 新建任务</Link></div>
    <section className="stats-grid">
      {[["queued","待处理"],["processing","处理中"],["completed","已完成"],["failed","失败"]].map(([key,label]) => <div className="stat-card" key={key}><span>{label}</span><strong>{counts[key as keyof Counts]}</strong></div>)}
    </section>
    <section className="panel queue-panel">
      <div className="queue-head"><div><h2>当前任务</h2><p>{estimate}</p></div><div className="queue-head-actions"><button className="danger-button" onClick={() => setConfirmClear(true)} disabled={clearing || counts.total === 0}><span>⌫</span> 清空队列与历史</button><button className="outline-button" onClick={refreshStatus} disabled={loading}>{loading ? "刷新中…" : "↻ 刷新状态"}</button></div></div>
      <div className="worker-strip"><span className={`status-dot ${workerStatus}`}></span><span>Worker：{workerStatus === "running" ? "正在处理" : workerStatus === "starting" ? "正在启动" : "空闲"}</span><span className="worker-note">状态不会自动轮询</span></div>
      {jobs.length === 0 ? <div className="empty-state"><div className="empty-icon">◎</div><h3>还没有任务</h3><p>先创建一组尺寸，再回来启动处理。</p><Link className="primary-action inline" href="/create">开始制作</Link></div> : <div className="job-list">{jobs.map(job => <div className="job-row" key={job.id}><div className="job-size"><strong>{job.width} × {job.height}</strong><span>px</span></div><div className={`job-status ${job.status}`}>{statusLabel(job.status)}</div>{job.error && <span className="job-error">{job.error}</span>}{job.status === "completed" && <Link className="small-action" href={`/results?job=${encodeURIComponent(job.id)}`}>调整结果 →</Link>}</div>)}</div>}
      {notice && <div className="notice" role="status"><span>✓</span>{notice}</div>}
      {error && <div className="error">{error}</div>}
    </section>
    <div className="queue-action"><div><strong>{counts.queued ? "队列已准备好" : "队列为空"}</strong><span>{counts.queued ? "点击后才会启动后端 Worker" : "可以创建新的证件照任务"}</span></div><button className="primary-action" onClick={startProcessing} disabled={!counts.queued || workerStatus !== "idle" || starting}>{starting ? "正在启动处理服务…" : workerStatus === "running" ? "Worker 正在处理" : "开始处理 →"}</button></div>
    {confirmClear && <div className="modal-backdrop" role="presentation" onMouseDown={() => !clearing && setConfirmClear(false)}>
      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clear-title" onMouseDown={event => event.stopPropagation()}>
        <div className="confirm-icon">⌫</div>
        <h2 id="clear-title">清空队列与历史数据？</h2>
        <p>所有待处理、处理中、已完成和失败记录都会被永久删除，此操作无法撤销。</p>
        <div className="confirm-summary"><span>将删除</span><strong>{counts.total} 条任务记录</strong></div>
        <div className="dialog-actions"><button className="outline-button" onClick={() => setConfirmClear(false)} disabled={clearing}>取消</button><button className="danger-action" onClick={clearHistory} disabled={clearing}>{clearing ? "正在清空…" : "确认全部清空"}</button></div>
      </div>
    </div>}
  </AppShell>;
}
