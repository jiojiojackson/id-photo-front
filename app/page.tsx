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

function formatBytes(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function compressImage(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    const scale = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height);
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("浏览器不支持图片处理");
  }

  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let quality = 0.85;
  let blob: Blob | null = null;
  for (let i = 0; i < 6; i += 1) {
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (!blob) throw new Error("图片压缩失败");
    if (blob.size <= MAX_UPLOAD_BYTES) break;
    quality -= 0.1;
  }

  if (!blob || blob.size > MAX_UPLOAD_BYTES) {
    throw new Error("照片压缩后仍然超过 2 MB，请选择尺寸较小的照片");
  }

  return new File([blob], "id-photo-upload.jpg", { type: "image/jpeg", lastModified: Date.now() });
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [originalPreview, setOriginalPreview] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [width, setWidth] = useState(295);
  const [height, setHeight] = useState(413);
  const [background, setBackground] = useState("#ffffff");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [resultSize, setResultSize] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);

  function handleFile(selected: File) {
    if (originalPreview) URL.revokeObjectURL(originalPreview);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setFile(selected);
    setError("");
    setResultUrl("");
    setResultSize("");
    setOriginalPreview(URL.createObjectURL(selected));
  }

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (selected) handleFile(selected);
  }

  async function generate() {
    if (!file) {
      setError("请选择照片");
      return;
    }

    setLoading(true);
    setError("");
    setResultUrl("");

    try {
      const compressedFile = await compressImage(file);
      const formData = new FormData();
      formData.append("image", compressedFile);
      formData.append("width", String(width));
      formData.append("height", String(height));

      const response = await fetch("/api/generate", { method: "POST", body: formData });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        if (response.status === 413) throw new Error("照片请求过大，请选择较小的照片后重试");
        throw new Error(data?.error || `生成失败 (${response.status})`);
      }

      const url = URL.createObjectURL(await response.blob());
      setResultUrl(url);
      const image = new Image();
      image.onload = () => setResultSize(`${image.naturalWidth} × ${image.naturalHeight}`);
      image.src = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "生成失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!resultUrl) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const image = new Image();
    image.onload = () => {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0);
    };
    image.src = resultUrl;
  }, [resultUrl, background]);

  function download() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `idphoto-${width}x${height}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) router.push("/login");
    } catch (err) {
      console.error("退出登录失败:", err);
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <main className="container">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <h1 style={{ margin: 0 }}>AI 证件照</h1>
        <button onClick={handleLogout} disabled={loggingOut} style={{ background: "#fee2e2", color: "#991b1b", border: "none", borderRadius: "8px", padding: "8px 16px", fontSize: "14px", fontWeight: "600", cursor: "pointer" }}>
          {loggingOut ? "正在退出..." : "退出登录"}
        </button>
      </div>
      <p className="subtitle">上传照片 → AI 生成高清证件照 → 设置背景色 → 下载</p>

      <section className="card">
        <button className="primary" onClick={() => fileInputRef.current?.click()}>{file ? "重新选择照片" : "选择照片"}</button>
        <input ref={fileInputRef} type="file" accept="image/*" capture="environment" hidden onChange={onFileChange} />
        {originalPreview && <div className="preview"><img src={originalPreview} alt="原始照片" /></div>}
        {file && <div className="hint">原图大小：{formatBytes(file.size)}，生成时会自动压缩至 2 MB 以内</div>}
      </section>

      <section className="card">
        <h2>照片尺寸</h2>
        <div className="preset-grid">
          {PRESETS.map((preset) => (
            <button key={preset.name} className={width === preset.width && height === preset.height ? "preset active" : "preset"} onClick={() => { setWidth(preset.width); setHeight(preset.height); }}>
              <strong>{preset.name}</strong>
            </button>
          ))}
        </div>
        <div className="size-row">
          <label>宽度<input type="number" min="100" max="3000" value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label>
          <span>×</span>
          <label>高度<input type="number" min="100" max="3000" value={height} onChange={(e) => setHeight(Number(e.target.value))} /></label>
        </div>
        <div className="hint">单位：像素</div>
      </section>

      <section className="card">
        <button className="generate" onClick={generate} disabled={!file || loading}>{loading ? "正在生成……" : "生成证件照"}</button>
        {error && <div className="error">{error}</div>}
      </section>

      {resultUrl && (
        <section className="card">
          <h2>处理结果</h2>
          {resultSize && <div className="hint">高清尺寸：{resultSize}</div>}
          <div className="result-preview"><canvas ref={canvasRef} /></div>
          <div className="background-row">
            <label>背景色</label><input type="color" value={background} onChange={(e) => setBackground(e.target.value)} /><span>{background}</span>
          </div>
          <div className="color-grid">
            {["#ffffff", "#438EDB", "#2A5CAA", "#F5F5F5", "#D32F2F", "#00A651"].map((color) => (
              <button key={color} className="color-button" style={{ backgroundColor: color }} aria-label={`背景色 ${color}`} onClick={() => setBackground(color)} />
            ))}
          </div>
          <button className="download" onClick={download}>下载证件照</button>
        </section>
      )}
    </main>
  );
}
