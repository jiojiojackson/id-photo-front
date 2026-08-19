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
    } finally { setLoggingOut(false); }
  }

  const nav = [["/create", "制作"], ["/jobs", "任务"], ["/results", "结果"]];

  return <div className="app-shell">
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/create" className="brand-wrap" aria-label="AI 证件照首页">
          <span className="brand-mark">AI</span>
          <span><strong className="brand">证件照工坊</strong><small className="brand-sub">智能制作 · 即刻交付</small></span>
        </Link>
        <nav className="nav-tabs" aria-label="主导航">
          {nav.map(([href, label], index) => <Link key={href} href={href} className={pathname.startsWith(href) ? "nav-tab active" : "nav-tab"}><span>{index + 1}</span>{label}</Link>)}
        </nav>
        <button className="logout-button" onClick={logout} disabled={loggingOut} aria-label="退出登录"><span>↗</span>{loggingOut ? "退出中" : "退出"}</button>
      </div>
    </header>
    <main className="page-content">{children}</main>
    <footer className="footer"><span>AI 证件照工坊</span><i></i><span>图片仅用于当前任务处理</span></footer>
  </div>;
}
