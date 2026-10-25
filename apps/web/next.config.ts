import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// 静态导出：将来由 Cloudflare Worker static assets 托管，前后端同源。
// 工作区在静态导出下无法使用动态路由 /p/[id]，因此使用 /p?id=<projectId>&thread=<threadId>。
const nextConfig: NextConfig = {
  output: "export",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  images: { unoptimized: true },
  trailingSlash: false,
  devIndicators: false,
};

export default nextConfig;
