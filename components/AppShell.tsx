"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import Icon, { type IconName } from "./Icon";

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

  const nav: { href: string; label: string; icon: IconName }[] = [
    { href: "/create", label: "制作", icon: "plus" },
    { href: "/jobs", label: "任务", icon: "queue" },
    { href: "/results", label: "照片", icon: "photo" },
  ];
  const tabs = nav.map(({ href, label, icon }) => <Link key={href} href={href} className={pathname.startsWith(href) ? "nav-tab active" : "nav-tab"} aria-current={pathname.startsWith(href) ? "page" : undefined}><Icon name={icon}/><span>{label}</span></Link>);

  return <div className="app-shell">
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/create" className="brand-wrap" aria-label="证件照工坊首页">
          <span className="brand-mark"><Icon name="camera" width="23" height="23"/></span>
          <span><strong className="brand">证件照工坊</strong><small className="brand-sub">Portrait Studio</small></span>
        </Link>
        <nav className="nav-tabs" aria-label="主导航">
          {tabs}
        </nav>
        <button className="logout-button" onClick={logout} disabled={loggingOut} aria-label="退出登录"><Icon name="logout"/><span>{loggingOut ? "退出中" : "退出登录"}</span></button>
      </div>
    </header>
    <main className="page-content">{children}</main>
    <footer className="footer"><span>证件照工坊</span><span>让每一张照片，刚刚好。</span></footer>
    <nav className="mobile-tabs" aria-label="手机主导航">{tabs}</nav>
  </div>;
}
