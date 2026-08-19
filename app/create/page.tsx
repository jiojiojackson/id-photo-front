"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";

const PRESETS = [
  { name: "标准 295×413", width: 295, height: 413 },
  { name: "600×800", width: 600, height: 800 },
  { name: "300×400", width: 300, height: 400 },
];
const MAX_IMAGE_DIMENSION = 2000;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

type SizeDraft = { width: string; height: string };

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

function parseDimension(value: string) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 3000 ? n : null;
}

export default function CreatePage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [sizes, setSizes] = useState<SizeDraft[]>([
    { width: "295", height: "413" },
    { width: "600", height: "800" },
    { width: "300", height: "400" },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function handleFile(selected: File) {
    if (!selected.type.startsWith("image/")) { setError("请选择 JPG、PNG 或其他常见图片格式"); return; }
    if (preview) URL.revokeObjectURL(preview);
    setFile(selected); setPreview(URL.createObjectURL(selected)); setError("");
  }
  function onFileChange(e: ChangeEvent<HTMLInputElement>) { const selected = e.target.files?.[0]; if (selected) handleFile(selected); }
  function onDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault(); setDragActive(false);
    const selected = e.dataTransfer.files?.[0]; if (selected) handleFile(selected);
  }
  function setSize(index: number, key: keyof SizeDraft, value: string) {
    setSizes(current => current.map((s, i) => i === index ? { ...s, [key]: value } : s));
  }
  function applyPreset(index: number, width: number, height: number) {
    setSizes(current => current.map((s, i) => i === index ? { width: String(width), height: String(height) } : s));
  }

  async function submitJobs() {
    if (!file) { setError("请先选择照片"); return; }
    const parsed = sizes.map(s => ({ width: parseDimension(s.width), height: parseDimension(s.height) }));
    if (parsed.some(s => s.width === null || s.height === null)) {
      setError("尺寸必须是 100～3000 的整数。输入框可以删除后重新输入，提交前必须填写有效数字。");
      return;
    }
    setSubmitting(true); setError("");
    try {
      const compressed = await compressImage(file);
      const form = new FormData();
      form.append("image", compressed);
      form.append("sizes", JSON.stringify(parsed));
      form.append("dpi", "300");
      const response = await fetch("/api/jobs/submit", { method: "POST", body: form });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `提交失败 (${response.status})`);
      router.push("/jobs");
    } catch (err) { setError(err instanceof Error ? err.message : "提交任务失败"); }
    finally { setSubmitting(false); }
  }

  return (
    <AppShell>
      <div className="hero">
        <div><div className="eyebrow">STEP 01 · CREATE</div><h1>制作你的证件照</h1><p>上传照片并设置尺寸。背景色在生成完成后再自由调整。</p></div>
        <div className="hero-badge">300 DPI</div>
      </div>
      <section className="editor-layout">
        <div className="panel upload-panel">
          <div className="section-title"><span>01</span><div><h2>选择照片</h2><p>支持 JPG、PNG 等常见图片格式</p></div></div>
          <button className={`upload-zone ${dragActive ? "drag-active" : ""} ${preview ? "has-preview" : ""}`} onClick={() => fileInputRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={onDrop}>
            {preview ? <><img src={preview} alt="照片预览" /><span className="upload-change">更换照片</span></> : <><span className="upload-icon">↑</span><strong>点击或拖入照片</strong><small>支持 JPG、PNG · 自动压缩至 2 MB 内</small></>}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChange} />
          {file && <div className="file-meta"><span><i>✓</i>{file.name}</span><strong>{formatBytes(file.size)}</strong></div>}
        </div>
        <div className="panel size-panel">
          <div className="section-title"><span>02</span><div><h2>选择照片尺寸</h2><p>可以直接输入任意 100～3000 px 的整数</p></div></div>
          <div className="size-list">
            {sizes.map((size, index) => (
              <div className="size-card" key={index}>
                <div className="size-card-head"><strong>尺寸 {index + 1}</strong><span>px</span></div>
                <div className="dimension-inputs">
                  <label>宽度<input type="number" min="100" max="3000" inputMode="numeric" value={size.width} onChange={e => setSize(index, "width", e.target.value)} placeholder="宽度" /></label>
                  <span>×</span>
                  <label>高度<input type="number" min="100" max="3000" inputMode="numeric" value={size.height} onChange={e => setSize(index, "height", e.target.value)} placeholder="高度" /></label>
                </div>
                <div className="preset-chips">{PRESETS.map(p => <button type="button" key={p.name} className={size.width === String(p.width) && size.height === String(p.height) ? "chip active" : "chip"} onClick={() => applyPreset(index, p.width, p.height)}>{p.name}</button>)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
      <div className="action-bar"><div><strong>准备好了吗？</strong><span>背景色将在生成完成后调整</span></div><button className="primary-action" onClick={submitJobs} disabled={!file || submitting}>{submitting ? "正在提交…" : "提交并进入任务队列 →"}</button></div>
      {error && <div className="error">{error}</div>}
    </AppShell>
  );
}
