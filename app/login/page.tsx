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
    e.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "登录失败");
      }

      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container" style={{ display: "flex", flexDirection: "column", justifyContent: "center", minHeight: "80vh" }}>
      <div className="card" style={{ maxWidth: "420px", margin: "0 auto", width: "100%" }}>
        <h1 style={{ textAlign: "center", fontSize: "24px", marginBottom: "8px" }}>AI 证件照登录</h1>
        <p className="subtitle" style={{ textAlign: "center", marginBottom: "24px" }}>
          请输入管理员账号和密码以继续使用
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label htmlFor="username" style={{ fontWeight: 500, fontSize: "14px" }}>账号</label>
            <input
              id="username"
              type="text"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              style={{
                width: "100%",
                padding: "12px",
                border: "1px solid #ccc",
                borderRadius: "8px",
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label htmlFor="password" style={{ fontWeight: 500, fontSize: "14px" }}>密码</label>
            <input
              id="password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={{
                width: "100%",
                padding: "12px",
                border: "1px solid #ccc",
                borderRadius: "8px",
              }}
            />
          </div>

          {error && <div className="error" style={{ margin: "0" }}>{error}</div>}

          <button type="submit" className="generate" disabled={loading} style={{ marginTop: "8px" }}>
            {loading ? "正在登录……" : "登录"}
          </button>
        </form>
      </div>
    </main>
  );
}
