import "./globals.css";

export const metadata = {
  title: "AI 证件照",
  description: "AI 在线证件照制作",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}