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
const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [0, 5_000, 10_000];

function formatBytes(bytes: number) { return `${(bytes / 1024 / 1024).toFixed(2)} MB`; }

async function compressImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width, height = bitmap.height;
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) { bitmap.close(); throw new Error("浏览器不支持图片处理"); }
  ctx.drawImage(bitmap, 0, 0, width, height); bitmap.close();
  let quality = 0.85, blob: Blob | null = null;
  for (let i = 0; i < 6; i += 1) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("图片压缩失败");
    if (blob.size <= MAX_UPLOAD_BYTES) break;
    quality -= 0.1;
  }
  if (!blob || blob.size > MAX_UPLOAD_BYTES) throw new Error("照片压缩后仍然超过 2 MB，请选择尺寸较小的照片");
  return new File([blob], "id-photo-upload.jpg", { type: "image/jpeg", lastModified: Date.now() });
}

function normalizeDimension(value: string, fallback: number) {
  if (!value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(3000, Math.max(100, parsed));
}

async function wait(ms: number) { if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms)); }

async function requestGenerate(formData: FormData, onRetry: (message: string) => void) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    await wait(RETRY_DELAYS_MS[attempt]);
    if (attempt > 0) onRetry(`服务器正在启动，正在重试（${attempt + 1}/${RETRY_DELAYS_MS.length}）…`);
    const controller = new AbortController(); const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/generate", { method: "POST", body: formData, signal: controller.signal });
      clearTimeout(timer);
      if (response.status === 413) return response;
      if ([502, 503, 504].includes(response.status) && attempt < RETRY_DELAYS_MS.length - 1) { lastError = new Error(`服务器暂时不可用 (${response.status})`); continue; }
      return response;
    } catch (error) {
      clearTimeout(timer); lastError = error;
      if (attempt < RETRY_DELAYS_MS.length - 1) continue;
      break;
    }
  }
  if (lastError instanceof DOMException && lastError.name === "AbortError") throw new Error("服务器响应超时，请稍后再试。首次生成可能需要较长时间唤醒服务器。");
  throw new Error("服务器暂时无法连接，请稍后再试。");
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const colorInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [originalPreview, setOriginalPreview] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [widthInput, setWidthInput] = useState("295");
  const [heightInput, setHeightInput] = useState("413");
  const [background, setBackground] = useState("#ffffff");
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [error, setError] = useState("");
  const [resultSize, setResultSize] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const width = normalizeDimension(widthInput, 295), height = normalizeDimension(heightInput, 413);

  function handleFile(selected: File) {
    if (originalPreview) URL.revokeObjectURL(originalPreview);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setFile(selected); setError(""); setResultUrl(""); setResultSize(""); setOriginalPreview(URL.createObjectURL(selected));
  }
  function onFileChange(e: ChangeEvent<HTMLInputElement>) { const selected = e.target.files?.[0]; if (selected) handleFile(selected); }
  function selectPreset(w: number, h: number) { setWidthInput(String(w)); setHeightInput(String(h)); setError(""); }
  function commitWidth() { if (widthInput.trim()) setWidthInput(String(normalizeDimension(widthInput, 295))); }
  function commitHeight() { if (heightInput.trim()) setHeightInput(String(normalizeDimension(heightInput, 413))); }

  async function generate() {
    if (!file) { setError("请选择照片"); return; }
    const finalWidth = normalizeDimension(widthInput, 295), finalHeight = normalizeDimension(heightInput, 413);
    setWidthInput(String(finalWidth)); setHeightInput(String(finalHeight)); setLoading(true); setLoadingMessage("正在连接服务器…"); setError(""); setResultUrl("");
    try {
      const compressedFile = await compressImage(file);
      const formData = new FormData(); formData.append("image", compressedFile); formData.append("width", String(finalWidth)); formData.append("height", String(finalHeight));
      setLoadingMessage("正在生成证件照，首次生成可能需要唤醒服务器…");
      const response = await requestGenerate(formData, setLoadingMessage);
      if (!response.ok) { const data = await response.json().catch(() => null); if (response.status === 413) throw new Error("照片请求过大，请选择较小的照片后重试"); throw new Error(data?.error || `生成失败 (${response.status})`); }
      const url = URL.createObjectURL(await response.blob()); setResultUrl(url);
      const image = new Image(); image.onload = () => setResultSize(`${image.naturalWidth} × ${image.naturalHeight}`); image.src = url;
    } catch (err) { setError(err instanceof Error ? err.message : "生成失败"); }
    finally { setLoading(false); setLoadingMessage(""); }
  }

  useEffect(() => {
    if (!resultUrl) return; const canvas = canvasRef.current; if (!canvas) return; const ctx = canvas.getContext("2d"); if (!ctx) return;
    const image = new Image(); image.onload = () => { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0); }; image.src = resultUrl;
  }, [resultUrl, background]);

  function download() {
    const canvas = canvasRef.current; if (!canvas) return;
    canvas.toBlob((blob) => { if (!blob) return; const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `idphoto-${width}x${height}.png`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url); }, "image/png");
  }
  async function handleLogout() { setLoggingOut(true); try { const response = await fetch("/api/auth/logout", { method: "POST" }); if (response.ok) router.push("/login"); } catch (err) { console.error("退出登录失败:", err); } finally { setLoggingOut(false); } }

  return (
    <main className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}><h1 style={{ margin: 0 }}>AI 证件照</h1><button onClick={handleLogout} disabled={loggingOut} style={{ background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: "8px", padding: "8px 16px", fontSize: "14px", fontWeight: "600", cursor: "pointer" }}>{loggingOut ? "正在退出..." : "退出登录"}</button></div>
      <p className="subtitle">上传照片 → AI 生成高清证件照 → 设置背景色 → 下载</p>
      <section className="card"><button className="primary" onClick={() => fileInputRef.current?.click()}>{file ? "重新选择照片" : "选择照片"}</button><input ref={fileInputRef} type="file" accept="image/*" hidden onChange={onFileChange} />{originalPreview && <div className="preview"><img src={originalPreview} alt="原始照片" /></div>}{file && <div className="hint">原图大小：{formatBytes(file.size)}，生成时会自动压缩至 2 MB 以内</div>}</section>
      <section className="card"><h2>照片尺寸</h2><div className="preset-grid">{PRESETS.map((preset) => <button key={preset.name} className={width === preset.width && height === preset.height ? "preset active" : "preset"} onClick={() => selectPreset(preset.width, preset.height)}><strong>{preset.name}</strong></button>)}</div><div className="size-row"><label>宽度<input type="number" min="100" max="3000" inputMode="numeric" value={widthInput} onChange={(e) => setWidthInput(e.target.value.replace(/[^0-9]/g, ""))} onBlur={commitWidth} /></label><span>×</span><label>高度<input type="number" min="100" max="3000" inputMode="numeric" value={heightInput} onChange={(e) => setHeightInput(e.target.value.replace(/[^0-9]/g, ""))} onBlur={commitHeight} /></label></div><div className="hint">单位：像素（100–3000）</div></section>
      <section className="card"><button className="generate" onClick={generate} disabled={!file || loading}>{loading ? (loadingMessage || "正在生成……") : "生成证件照"}</button>{loading && <div className="hint" style={{ marginTop: "10px", textAlign: "center" }}>首次生成可能需要等待几十秒，请不要关闭页面。</div>}{error && <div className="error">{error}</div>}</section>
      {resultUrl && <section className="card"><h2>处理结果</h2>{resultSize && <div className="hint">高清尺寸：{resultSize}</div>}<div className="result-preview"><canvas ref={canvasRef} /></div><div className="background-row"><label>背景色</label><span>{background}</span></div><div className="color-grid">{["#ffffff", "#438EDB", "#2A5CAA", "#F5F5F5", "#D32F2F", "#00A651"].map((color) => <button key={color} type="button" className="color-button" style={{ backgroundColor: color }} aria-label={`背景色 ${color}`} onClick={() => setBackground(color)} />)}<label className="color-button custom-color" style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)", position: "relative", overflow: "hidden", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }} aria-label="自定义背景色"><span style={{ pointerEvents: "none", position: "relative", zIndex: 1, fontSize: "22px", color: "white", textShadow: "0 1px 3px #000" }}>＋</span><input ref={colorInputRef} type="color" value={background} onChange={(e) => setBackground(e.target.value)} aria-label="打开调色盘" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0, cursor: "pointer", border: 0, padding: 0 }} /></label></div><div className="hint">点击彩色“＋”直接打开调色盘，自由选择任意背景色。</div><button className="download" onClick={download}>下载证件照</button></section>}
    </main>
  );
}
