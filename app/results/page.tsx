"use client";

import { useEffect, useRef, useState } from "react";
import AppShell from "@/components/AppShell";

const COLORS = [
  ["纯白", "#ffffff"], ["浅灰", "#e5e7eb"], ["深灰", "#6b7280"],
  ["证件蓝", "#438edb"], ["浅蓝", "#9dd7f5"], ["深蓝", "#2563eb"],
  ["米白", "#f7f1e3"], ["淡粉", "#f5c6cb"],
];

type Job = { id: string; width: number; height: number; status: string; resultUrl: string | null; error?: string | null };

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return { r: parseInt(value.slice(0, 2), 16), g: parseInt(value.slice(2, 4), 16), b: parseInt(value.slice(4, 6), 16) };
}

export default function ResultsPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedId, setSelectedId] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [color, setColor] = useState("#ffffff");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");

  useEffect(() => {
    setSelectedId(new URLSearchParams(window.location.search).get("job") || "");
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true); setError("");
      try {
        const response = await fetch("/api/jobs/status", { cache: "no-store" });
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `读取结果失败 (${response.status})`);
        const completed = (data.jobs || []).filter((job: Job) => job.status === "completed" && job.resultUrl);
        setJobs(completed);
        setSelected(completed.find((job: Job) => job.id === selectedId) || completed[0] || null);
      } catch (err) { setError(err instanceof Error ? err.message : "读取结果失败"); }
      finally { setLoading(false); }
    }
    load();
  }, [selectedId]);

  useEffect(() => {
    if (!selected) return;
    setEditing(false); setDownloadUrl(""); setColor("#ffffff");
    const canvas = canvasRef.current;
    if (!canvas) return;
    const image = new Image();
    image.onload = () => {
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) ctx.drawImage(image, 0, 0);
    };
    image.src = `/api/jobs/image?jobId=${encodeURIComponent(selected.id)}`;
  }, [selected]);

  function applyColor(nextColor: string) {
    if (!selected || !canvasRef.current) return;
    setColor(nextColor); setEditing(true); setDownloadUrl("");
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = new Image();
    image.onload = () => {
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = pixels.data;
      const bg = { r: data[0], g: data[1], b: data[2] };
      const target = hexToRgb(nextColor);
      const tolerance = 62;
      for (let i = 0; i < data.length; i += 4) {
        const dr = data[i] - bg.r, dg = data[i + 1] - bg.g, db = data[i + 2] - bg.b;
        const distance = Math.sqrt(dr * dr + dg * dg + db * db);
        if (distance <= tolerance) {
          const alpha = Math.max(0, Math.min(1, distance / tolerance));
          data[i] = Math.round(target.r * (1 - alpha) + data[i] * alpha);
          data[i + 1] = Math.round(target.g * (1 - alpha) + data[i + 1] * alpha);
          data[i + 2] = Math.round(target.b * (1 - alpha) + data[i + 2] * alpha);
        }
      }
      ctx.putImageData(pixels, 0, 0);
    };
    image.src = `/api/jobs/image?jobId=${encodeURIComponent(selected.id)}&t=${Date.now()}`;
  }

  function download() {
    const canvas = canvasRef.current;
    if (!canvas || !selected) return;
    canvas.toBlob(blob => {
      if (!blob) return;
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
      const url = URL.createObjectURL(blob); setDownloadUrl(url);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `id-photo-${selected.width}x${selected.height}.png`; anchor.click();
    }, "image/png");
  }

  return <AppShell>
    <div className="hero compact-hero"><div><div className="eyebrow">STEP 03 · RESULTS</div><h1>调整并下载</h1><p>选择一个结果，然后调整背景色。下载的是当前画布上的最终图片。</p></div></div>
    {loading ? <div className="panel empty-state"><div className="spinner"></div><p>正在读取结果…</p></div> : error ? <div className="error">{error}</div> : !jobs.length ? <div className="panel empty-state"><div className="empty-icon">✦</div><h3>还没有生成完成的照片</h3><p>完成任务后，结果会出现在这里。</p></div> : <section className="results-layout">
      <aside className="panel result-selector"><h2>生成结果</h2><p className="muted">共 {jobs.length} 张</p>{jobs.map(job => <button key={job.id} className={selected?.id === job.id ? "result-item active" : "result-item"} onClick={() => setSelected(job)}><span>{job.width} × {job.height}</span><small>点击编辑</small></button>)}</aside>
      <div className="panel result-editor">
        {selected && <>
          <div className="editor-head"><div><h2>{selected.width} × {selected.height}</h2><p>背景色调整</p></div><span className="success-pill">✓ 已生成</span></div>
          <div className="canvas-stage"><canvas ref={canvasRef} /></div>
          <div className="color-tools">
            <div className="tool-title"><strong>选择背景色</strong><span>{color.toUpperCase()}</span></div>
            <div className="color-grid">{COLORS.map(([name, value]) => <button key={value} title={name} aria-label={name} className={color === value ? "color-swatch active" : "color-swatch"} style={{ background: value }} onClick={() => applyColor(value)} />)}</div>
            <label className="custom-color"><span>自定义颜色</span><input type="color" value={color} onChange={e => applyColor(e.target.value)} /><code>{color.toUpperCase()}</code></label>
            {editing && <p className="edit-note">已根据原背景自动替换颜色。人物边缘会保留平滑过渡。</p>}
          </div>
          <button className="download-action" onClick={download}>↓ 下载当前图片</button>
        </>}
      </div>
    </section>}
  </AppShell>;
}
