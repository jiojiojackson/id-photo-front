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

function colorDistance(data: Uint8ClampedArray, offset: number, color: { r: number; g: number; b: number }) {
  const dr = data[offset] - color.r, dg = data[offset + 1] - color.g, db = data[offset + 2] - color.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function estimateBackground(data: Uint8ClampedArray, width: number, height: number) {
  const samples: Array<{ r: number; g: number; b: number }> = [];
  const stepX = Math.max(1, Math.floor(width / 40)), stepY = Math.max(1, Math.floor(height / 40));
  const add = (x: number, y: number) => {
    const offset = (y * width + x) * 4;
    if (data[offset + 3] > 245) samples.push({ r: data[offset], g: data[offset + 1], b: data[offset + 2] });
  };
  for (let x = 0; x < width; x += stepX) { add(x, 0); add(x, height - 1); }
  for (let y = 0; y < height; y += stepY) { add(0, y); add(width - 1, y); }
  if (!samples.length) return { r: 255, g: 255, b: 255 };
  const median = (channel: "r" | "g" | "b") => samples.map(sample => sample[channel]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  return { r: median("r"), g: median("g"), b: median("b") };
}

function buildBackgroundMask(data: Uint8ClampedArray, width: number, height: number, background: { r: number; g: number; b: number }) {
  const mask = new Uint8Array(width * height), queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  const tolerance = 48;
  const enqueue = (index: number) => {
    if (mask[index] || colorDistance(data, index * 4, background) > tolerance) return;
    mask[index] = 1; queue[tail++] = index;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const index = queue[head++], x = index % width;
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (index >= width) enqueue(index - width);
    if (index + width < mask.length) enqueue(index + width);
  }
  return mask;
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
    const data = pixels.data, target = hexToRgb(nextColor);
    let transparentPixels = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparentPixels++;
    const hasTransparentBackground = transparentPixels > original.width * original.height * 0.01;
    const background = estimateBackground(data, original.width, original.height);
    const mask = hasTransparentBackground ? null : buildBackgroundMask(data, original.width, original.height, background);
    for (let i = 0; i < data.length; i += 4) {
      if (hasTransparentBackground) {
        const alpha = data[i + 3] / 255;
        data[i] = Math.round(data[i] * alpha + target.r * (1 - alpha));
        data[i + 1] = Math.round(data[i + 1] * alpha + target.g * (1 - alpha));
        data[i + 2] = Math.round(data[i + 2] * alpha + target.b * (1 - alpha));
        data[i + 3] = 255;
      } else if (mask?.[i / 4]) {
        const distance = colorDistance(data, i, background);
        const originalWeight = Math.pow(Math.min(distance / 48, 1), 2);
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
            <div className="color-grid">{COLORS.map(([name, value]) => <button key={value} title={name} aria-label={name} className={color === value ? "color-swatch active" : "color-swatch"} onClick={() => applyColor(value)} disabled={previewLoading}><i style={{ background: value }}></i><span>{name}</span></button>)}</div>
            <label className="custom-color"><span>自定义颜色</span><input type="color" value={color} onChange={e => applyColor(e.target.value)} disabled={previewLoading} /><code>{color.toUpperCase()}</code></label>
            {editing && <p className="edit-note">只替换与图片边缘连通的背景区域，人物区域保持不变。</p>}
          </div>
          <button className="download-action" onClick={download}>↓ 下载当前图片</button>
        </>}
      </div>
    </section>}
  </AppShell>;
}
