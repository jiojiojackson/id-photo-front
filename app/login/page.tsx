"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/Icon";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setLoading(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password }) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "登录失败"); }
      router.push("/");
    } catch (err) { setError(err instanceof Error ? err.message : "登录失败"); }
    finally { setLoading(false); }
  }

  return <main className="login-shell">
    <section className="login-card">
      <div className="login-brand"><span className="brand-mark"><Icon name="camera" size={24} /></span><div><strong>证件照工坊</strong><small>Portrait Studio</small></div></div>
      <div className="login-heading"><h1>欢迎回来。</h1><p>登录，继续制作你的证件照。</p></div>
      <form onSubmit={handleSubmit} className="login-form">
        <label htmlFor="username">账号<input id="username" type="text" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} placeholder="请输入账号" /></label>
        <label htmlFor="password">密码<input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button type="submit" className="primary-action login-action" disabled={loading}>{loading ? <><span className="button-spinner"></span>正在登录</> : <>登录<Icon name="arrow-right" size={18} /></>}</button>
      </form>
    </section>
    <p className="login-footnote">让每一张照片，刚刚好。</p>
  </main>;
}
