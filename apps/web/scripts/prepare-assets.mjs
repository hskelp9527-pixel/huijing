// 1) 构建 @loomic/shared（web 从 @loomic/shared/edge 导入契约，需要先有 dist）
// 2) 把 Excalidraw 字体复制到 public/，由同源静态资源提供，避免运行时去 CDN 取字体
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

const sharedDist = join(
  root,
  "packages",
  "shared",
  "dist",
  "edge-contracts.js",
);
const sharedSrc = join(root, "packages", "shared", "src", "edge-contracts.ts");
if (
  !existsSync(sharedDist) ||
  statSync(sharedSrc).mtimeMs > statSync(sharedDist).mtimeMs
) {
  console.log("[prepare] 构建 @loomic/shared …");
  const r = spawnSync("pnpm", ["--filter", "@loomic/shared", "build"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (process.argv.includes("--shared-only")) process.exit(0);

const pkgDir = join(here, "..", "node_modules", "@excalidraw", "excalidraw");
const fontsSrc = join(pkgDir, "dist", "prod", "fonts");
const dest = join(here, "..", "public", "excalidraw-assets", "fonts");
if (!existsSync(fontsSrc)) {
  console.warn("[prepare] 未找到 Excalidraw 字体目录，跳过：", fontsSrc);
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
// 只带界面里会用到的西文字体；中文走系统字体回退（Xiaolai 约 8MB，不带）。
for (const name of ["Excalifont", "Nunito", "Assistant"]) {
  if (existsSync(join(fontsSrc, name)))
    cpSync(join(fontsSrc, name), join(dest, name), { recursive: true });
}
console.log("[prepare] Excalidraw 字体已复制到", dest);
