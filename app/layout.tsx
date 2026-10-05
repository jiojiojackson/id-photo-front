import "./globals.css";
import type { Viewport } from "next";

export const metadata = {
  title: "证件照工坊 · Portrait Studio",
  description: "AI 在线证件照制作",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#f5f5f7" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
