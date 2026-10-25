import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
// Entirely local bundle: no Cloudflare account access or deployment commands.
const out = resolve("dist");
await mkdir(out, { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: resolve(out, "index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
  plugins: [
    {
      name: "wasm",
      setup(b) {
        b.onResolve({ filter: /\.wasm$/ }, async (args) => {
          const source = resolve("node_modules", args.path),
            name = basename(source);
          await copyFile(source, resolve(out, name));
          return { path: `./${name}`, external: true };
        });
      },
    },
  ],
});
console.log("本地 Worker 构建完成（含 WASM）");
