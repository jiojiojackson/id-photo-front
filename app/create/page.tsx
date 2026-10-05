"use client";

import { ChangeEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import Icon from "@/components/Icon";

const PRESETS = [
  { name: "一寸 · 295 × 413", width: 295, height: 413 },
  { name: "高清 · 600 × 800", width: 600, height: 800 },
  { name: "标准 · 300 × 400", width: 300, height: 400 },
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
      <div className="page-heading">
        <div><div className="eyebrow">PORTRAIT STUDIO</div><h1>一张好照片，<br className="mobile-break" />从这里开始。</h1><p>上传人像，选择比例。其余的，交给我们。</p></div>
        <span className="quality-badge"><Icon name="sparkles" /> 高清输出</span>
      </div>
      <section className="create-layout">
        <div className="panel upload-panel">
          <div className="section-title"><span className="step-number">1</span><div><h2>选择照片</h2><p>正面人像，效果更好</p></div></div>
          <button type="button" aria-label={preview ? "更换照片" : "上传照片"} className={`upload-zone ${dragActive ? "drag-active" : ""} ${preview ? "has-preview" : ""}`} onClick={() => fileInputRef.current?.click()} onDragOver={e => { e.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={onDrop}>
            {preview ? <><img src={preview} alt="已选择的人像照片" /><span className="upload-change"><Icon name="refresh" size={16} />更换照片</span></> : <><div className="portrait-illustration" aria-hidden="true"><div className="portrait-card"><svg viewBox="0 0 120 150" fill="none"><rect width="120" height="150" rx="8" fill="#eaf2fb"/><circle cx="60" cy="52" r="22" fill="#b5cbe4"/><path d="M20 135v-18a40 40 0 0 1 80 0v18" fill="#b5cbe4"/><path d="M34 12h52" stroke="white" strokeWidth="3" strokeLinecap="round"/></svg></div><span className="illustration-plus"><Icon name="plus" size={22} /></span></div><strong>添加你的照片</strong><small>点击选择，或将照片拖到这里</small><span className="upload-formats">JPG、PNG 及常见图片格式</span></>}
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChange} />
          {file ? <div className="file-meta"><Icon name="check" size={16} /><span>{file.name}</span><small>{formatBytes(file.size)}</small></div> : <p className="photo-tip"><Icon name="photo" size={17} /> 建议光线均匀，露出完整头部和肩部。</p>}
        </div>
        <div className="panel size-panel">
          <div className="section-title"><span className="step-number">2</span><div><h2>设置尺寸比例</h2><p>一次上传，可生成多个尺寸</p></div></div>
          <div className="size-list">
            {sizes.map((size, index) => (
              <div className="size-card" key={index}>
                <div className="size-card-head"><strong>尺寸 {String(index + 1).padStart(2, "0")}</strong><div><select aria-label={`尺寸 ${index + 1} 预设`} value={PRESETS.some(p => String(p.width) === size.width && String(p.height) === size.height) ? `${size.width}x${size.height}` : "custom"} onChange={e => { const p = PRESETS.find(p => `${p.width}x${p.height}` === e.target.value); if (p) applyPreset(index, p.width, p.height); }}><option value="custom">自定义</option>{PRESETS.map(p => <option key={p.name} value={`${p.width}x${p.height}`}>{p.name}</option>)}</select><button type="button" className="icon-button remove-size" aria-label={`移除尺寸 ${index + 1}`} disabled={sizes.length === 1} onClick={() => setSizes(current => current.filter((_, i) => i !== index))}><Icon name="close" size={16} /></button></div></div>
                <div className="dimension-inputs">
                  <label>宽度 <span>px</span><input aria-label={`尺寸 ${index + 1} 宽度`} type="number" min="100" max="3000" inputMode="numeric" value={size.width} onChange={e => setSize(index, "width", e.target.value)} placeholder="宽度" /></label>
                  <span>×</span>
                  <label>高度 <span>px</span><input aria-label={`尺寸 ${index + 1} 高度`} type="number" min="100" max="3000" inputMode="numeric" value={size.height} onChange={e => setSize(index, "height", e.target.value)} placeholder="高度" /></label>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="add-size" disabled={sizes.length >= 10} onClick={() => setSizes(current => [...current, { width: "295", height: "413" }])}><Icon name="plus" size={17} />{sizes.length >= 10 ? "已添加 10 个尺寸" : "添加一个尺寸"}</button>
          <p className="field-note">输入 100–3000 px 的整数。按所选比例生成高清照片。</p>
        </div>
      </section>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="action-bar"><div><strong>{file ? `将生成 ${sizes.length} 张证件照` : "选择照片，即可开始"}</strong><span>生成后可自由调整背景颜色</span></div><button className="primary-action" onClick={submitJobs} disabled={!file || submitting}>{submitting ? <><span className="button-spinner" />正在提交…</> : <>创建照片 <Icon name="arrow-right" size={18} /></>}</button></div>
    </AppShell>
  );
}
