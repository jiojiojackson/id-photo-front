"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AppShell from "@/components/AppShell";
import Icon from "@/components/Icon";
import Pagination, { emptyPagination, type PaginationData } from "@/components/Pagination";
import ConfirmDialog from "@/components/ConfirmDialog";

type Job = { id: string; width: number; height: number; status: string; created_at: string; error?: string | null };
type Counts = { queued: number; processing: number; completed: number; failed: number; total: number };
const FILTERS = [["", "全部"], ["queued", "等待中"], ["processing", "处理中"], ["completed", "已完成"], ["failed", "失败"]];
const LABELS: Record<string, string> = { queued: "等待中", processing: "处理中", completed: "已完成", failed: "处理失败" };
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

export default function JobsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [counts, setCounts] = useState<Counts>({ queued: 0, processing: 0, completed: 0, failed: 0, total: 0 });
  const [workerStatus, setWorkerStatus] = useState("idle");
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [backendError, setBackendError] = useState("");
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [pagination, setPagination] = useState<PaginationData>(emptyPagination(8));
  const [refreshKey, setRefreshKey] = useState(0);
  const busy = workerStatus !== "idle" || counts.processing > 0;
  const closeConfirm = useCallback(() => setConfirmClear(false), []);

  useEffect(() => {
    let stopped = false, inFlight = false;
    let timer: number;
    const controller = new AbortController();
    async function refresh(quiet = false) {
      if (stopped || inFlight) return;
      inFlight = true;
      window.clearTimeout(timer);
      if (!quiet) setLoading(true);
      let delay = 15000;
      try {
        const response = await fetch(`/api/jobs/status?page=${page}&pageSize=8&status=${filter}`, { cache: "no-store", signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error || "读取任务失败");
        if (stopped) return;
        setCounts(data.counts); setJobs(data.jobs || []); setPagination(data.pagination);
        setWorkerStatus(data.worker?.status || "idle"); setBackendError(data.backend?.error || ""); setError("");
        if (data.worker?.status !== "idle" || data.counts.processing > 0) delay = 3000;
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "读取任务失败");
      } finally {
        inFlight = false;
        if (!stopped) { setLoading(false); timer = window.setTimeout(poll, delay); }
      }
    }
    function poll() { if (document.visibilityState === "visible") void refresh(true); }
    function onVisible() { if (document.visibilityState === "visible") void refresh(true); else window.clearTimeout(timer); }
    void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopped = true; controller.abort(); window.clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [page, filter, refreshKey]);

  async function startProcessing() {
    if (!counts.queued || busy || starting) return;
    setStarting(true); setActionError(""); setNotice("");
    try {
      const response = await fetch("/api/jobs/start", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "启动处理失败");
      setNotice("已开始处理，照片完成后会出现在照片库。");
    } catch (err) { setActionError(err instanceof Error ? err.message : "启动处理失败"); }
    finally { setStarting(false); setRefreshKey(key => key + 1); }
  }
  async function clearHistory() {
    setClearing(true); setActionError(""); setNotice("");
    try {
      const response = await fetch("/api/jobs/reset", { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "清空记录失败");
      setConfirmClear(false); setPage(1); setNotice("任务记录和照片已清空。");
      setRefreshKey(key => key + 1);
    } catch (err) { setActionError(err instanceof Error ? err.message : "清空记录失败"); setConfirmClear(false); }
    finally { setClearing(false); }
  }

  return <AppShell>
    <div className="page-heading"><div><div className="eyebrow">YOUR WORKSPACE</div><h1>任务，一目了然。</h1><p>进度自动更新，完成后即可下载。</p></div><Link className="secondary-action" href="/create"><Icon name="plus" size={18} />新建任务</Link></div>
    <section className="stats-grid" aria-label="任务统计">
      {[["queued", "等待处理"], ["processing", "正在处理"], ["completed", "已完成"], ["failed", "处理失败"]].map(([key, label]) => <div className={`stat-card stat-${key}`} key={key}><span><i />{label}</span><strong>{counts[key as keyof Counts]}</strong></div>)}
    </section>
    <div className="processing-bar"><div><span className={`status-dot ${busy ? "active" : ""}`} /><div><strong>{busy ? "照片正在制作中" : counts.queued ? `${counts.queued} 张照片等待制作` : "所有任务已就绪"}</strong><span>{busy ? "进度会自动更新，稍等片刻" : counts.queued ? "准备好了，点击开始处理" : "添加新照片，或前往照片库"}</span></div></div><button className="primary-action" onClick={startProcessing} disabled={!counts.queued || busy || starting || loading}>{starting ? <><span className="button-spinner" />正在启动</> : busy ? "正在处理…" : <>开始处理<Icon name="arrow-right" size={18} /></>}</button></div>
    {notice && <div className="notice" role="status"><Icon name="check" size={18} />{notice}</div>}
    {(error || actionError) && <div className="error" role="alert">{error || actionError}</div>}
    {backendError && <div className="error" role="alert">{backendError}</div>}
    <section className="panel queue-panel" aria-busy={loading}>
      <div className="queue-head"><div><h2>任务记录</h2><span className="muted">{counts.total} 项任务</span></div><div className="queue-head-actions"><button className="icon-button" aria-label="刷新任务" title="刷新任务" onClick={() => setRefreshKey(key => key + 1)} disabled={loading}><Icon name="refresh" size={18} /></button><button className="quiet-button" onClick={() => setConfirmClear(true)} disabled={clearing || busy || !counts.total}><Icon name="trash" size={16} /><span>清空记录</span></button></div></div>
      <div className="filter-strip" role="group" aria-label="任务状态筛选">{FILTERS.map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => { setFilter(value); setPage(1); }}>{label}</button>)}</div>
      <div className="job-table-head"><span>照片尺寸</span><span>创建时间</span><span>状态</span><span>操作</span></div>
      {loading && !jobs.length ? <div className="empty-state"><div className="spinner" /><p>正在读取任务…</p></div> : !jobs.length ? <div className="empty-state"><div className="empty-icon"><Icon name="queue" size={28} /></div><h3>{filter ? "这里暂时没有任务" : "还没有开始的故事"}</h3><p>{filter ? "试试查看其他状态的任务。" : "上传一张照片，制作你的第一张证件照。"}</p>{!filter && <Link className="secondary-action" href="/create"><Icon name="plus" size={17} />开始制作</Link>}</div> : <div className="job-list">{jobs.map(job => <div className="job-row" key={job.id}>
        <div className="job-size"><span className="job-photo-icon"><Icon name="photo" size={21} /></span><div><strong>{job.width} × {job.height}<small> px</small></strong><span>高清证件照</span></div></div>
        <time dateTime={job.created_at}>{date(job.created_at)}</time>
        <span className={`job-status ${job.status}`}><i />{LABELS[job.status]}</span>
        <div className="job-row-action">{job.status === "completed" ? <Link className="text-action" href={`/results?job=${encodeURIComponent(job.id)}`}>查看照片<Icon name="chevron-right" size={16} /></Link> : <span className="muted">{job.status === "failed" ? "需重新制作" : "等待完成"}</span>}</div>
        {job.error && <p className="job-error">{job.error}</p>}
      </div>)}</div>}
      <Pagination data={pagination} onChange={setPage} disabled={loading} />
    </section>
    {confirmClear && <ConfirmDialog total={counts.total} busy={clearing} onClose={closeConfirm} onConfirm={clearHistory} />}
  </AppShell>;
}
