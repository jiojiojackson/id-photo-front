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
  const originalPixelsRef = useRef<ImageData | null>(null);
  const loadVersionRef = useRef(0);
  const [selectedId, setSelectedId] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [color, setColor] = useState("#ffffff");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

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
    const loadVersion = ++loadVersionRef.current;
    setEditing(false); setDownloadUrl(""); setColor("#ffffff");
    setPreviewLoading(true); originalPixelsRef.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = 0; canvas.height = 0;
    const image = new Image();
    image.onload = () => {
      if (loadVersion !== loadVersionRef.current) return;
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) { ctx.drawImage(image, 0, 0); originalPixelsRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height); }
      setPreviewLoading(false);
    };
    image.onerror = () => { if (loadVersion === loadVersionRef.current) { setPreviewLoading(false); setError("结果图片加载失败，请重试"); } };
    image.src = `/api/jobs/image?jobId=${encodeURIComponent(selected.id)}`;
  }, [selected]);

  function selectResult(job: Job) {
    if (job.id === selected?.id) return;
    setPreviewLoading(true);
    setSelected(job);
  }

  function applyColor(nextColor: string) {
    if (!selected || !canvasRef.current || !originalPixelsRef.current) return;
    setColor(nextColor); setEditing(true); setDownloadUrl("");
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;
    const original = originalPixelsRef.current;
    const pixels = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
    const data = pixels.data;
    const offsets = [0, (original.width - 1) * 4, (original.height - 1) * original.width * 4, (original.width * original.height - 1) * 4];
    const samples = offsets.filter(offset => data[offset + 3] > 0);
    const bgSamples = samples.length ? samples : [0];
    const bg = bgSamples.reduce((sum, offset) => ({ r: sum.r + data[offset], g: sum.g + data[offset + 1], b: sum.b + data[offset + 2] }), { r: 0, g: 0, b: 0 });
    bg.r /= bgSamples.length; bg.g /= bgSamples.length; bg.b /= bgSamples.length;
    const target = hexToRgb(nextColor), tolerance = 90;
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - bg.r, dg = data[i + 1] - bg.g, db = data[i + 2] - bg.b;
      const distance = Math.sqrt(dr * dr + dg * dg + db * db);
      if (distance < tolerance) {
        const originalWeight = Math.pow(distance / tolerance, 2);
        data[i] = Math.round(target.r * (1 - originalWeight) + data[i] * originalWeight);
        data[i + 1] = Math.round(target.g * (1 - originalWeight) + data[i + 1] * originalWeight);
        data[i + 2] = Math.round(target.b * (1 - originalWeight) + data[i + 2] * originalWeight);
      }
    }
    ctx.putImageData(pixels, 0, 0);
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
      <aside className="panel result-selector"><h2>生成结果</h2><p className="muted">共 {jobs.length} 张</p>{jobs.map(job => <button key={job.id} className={selected?.id === job.id ? "result-item active" : "result-item"} onClick={() => selectResult(job)}><span>{job.width} × {job.height}</span><small>点击编辑</small></button>)}</aside>
      <div className="panel result-editor">
        {selected && <>
          <div className="editor-head"><div><h2>{selected.width} × {selected.height}</h2><p>背景色调整</p></div><span className="success-pill">✓ 已生成</span></div>
          <div className={`canvas-stage ${previewLoading ? "loading" : "ready"}`}>
            {previewLoading && <div className="preview-loading"><div className="spinner"></div><span>正在切换预览…</span></div>}
            <canvas ref={canvasRef} />
          </div>
          <div className="color-tools">
            <div className="tool-title"><strong>选择背景色</strong><span>{color.toUpperCase()}</span></div>
            <div className="color-grid">{COLORS.map(([name, value]) => <button key={value} title={name} aria-label={name} className={color === value ? "color-swatch active" : "color-swatch"} style={{ background: value }} onClick={() => applyColor(value)} disabled={previewLoading} />)}</div>
            <label className="custom-color"><span>自定义颜色</span><input type="color" value={color} onChange={e => applyColor(e.target.value)} disabled={previewLoading} /><code>{color.toUpperCase()}</code></label>
            {editing && <p className="edit-note">已根据原背景自动替换颜色。人物边缘会保留平滑过渡。</p>}
          </div>
          <button className="download-action" onClick={download}>↓ 下载当前图片</button>
        </>}
      </div>
    </section>}
  </AppShell>;
}
