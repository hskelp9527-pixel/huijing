import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "../components/providers";
import { DemoBadge } from "../components/ui/app-chrome";

import "../styles/tokens.css";
import "../styles/base.css";
import "../styles/ui.css";
import "../styles/composer.css";
import "../styles/home.css";
import "../styles/workspace.css";
import "../styles/agent.css";
import "../styles/set-fonts.css";

export const metadata: Metadata = {
  title: "绘境 · 商品图一键出套图",
  description: "上传一张商品图，选一个模板，一键生成整套电商图。",
  icons: { icon: "/favicon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main">
          跳到主要内容
        </a>
        <Providers>
          {children}
          <DemoBadge />
        </Providers>
      </body>
    </html>
  );
}
