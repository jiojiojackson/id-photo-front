"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (response.ok) router.push("/login");
    } finally {
      setLoggingOut(false);
    }
  }

  const nav = [
    ["/create", "制作"],
    ["/jobs", "任务"],
    ["/results", "结果"],
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-wrap">
          <Link href="/create" className="brand">AI 证件照</Link>
          <span className="brand-sub">简单 · 快速 · 专业</span>
        </div>
        <nav className="nav-tabs" aria-label="主导航">
          {nav.map(([href, label]) => (
            <Link key={href} href={href} className={pathname.startsWith(href) ? "nav-tab active" : "nav-tab"}>{label}</Link>
          ))}
        </nav>
        <button className="logout-button" onClick={logout} disabled={loggingOut}>{loggingOut ? "退出中" : "退出"}</button>
      </header>
      <main className="page-content">{children}</main>
      <footer className="footer">AI 证件照 · 结果仅在你的任务空间内处理</footer>
    </div>
  );
}
