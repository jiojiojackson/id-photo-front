"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

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
      <div className="login-brand"><span className="brand-mark">AI</span><div><strong>证件照工坊</strong><small>智能制作 · 即刻交付</small></div></div>
      <div className="login-heading"><span>欢迎回来</span><h1>登录工作台</h1><p>输入管理员账号，继续管理证件照任务。</p></div>
      <form onSubmit={handleSubmit} className="login-form">
        <label htmlFor="username">账号<input id="username" type="text" autoComplete="username" required value={username} onChange={e => setUsername(e.target.value)} placeholder="请输入账号" /></label>
        <label htmlFor="password">密码<input id="password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} placeholder="请输入密码" /></label>
        {error && <div className="error">{error}</div>}
        <button type="submit" className="primary-action login-action" disabled={loading}>{loading ? <><span className="button-spinner"></span>正在登录</> : "进入工作台 →"}</button>
      </form>
    </section>
    <p className="login-footnote">安全访问 · 图片仅用于任务处理</p>
  </main>;
}
