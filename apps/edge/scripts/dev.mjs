import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
const config = JSON.parse(
  readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
// Local storage names are identities, not deployment names. Never move existing data.
const legacyRoom = new URL("../.wrangler/state/v3/do/huijing-edge-ProjectRoom", import.meta.url);
const localName = process.env.LOCAL_WORKER_NAME || (existsSync(legacyRoom) ? "huijing-edge" : config.name);
const legacyBucket = new URL("../.wrangler/state/v3/r2/huijing-assets", import.meta.url);
const localBucket = process.env.LOCAL_R2_BUCKET || (existsSync(legacyBucket) ? "huijing-assets" : config.r2_buckets[0].bucket_name);
config.name = localName;
config.r2_buckets[0].bucket_name = localBucket;
if (config.env?.dev) {
  config.env.dev.name = localName;
  config.env.dev.r2_buckets[0].bucket_name = localBucket;
}
console.log(`本地数据命名空间：Worker=${localName}，R2=${localBucket}（未移动或删除数据）`);
config.assets.directory = existsSync(new URL("../../web/out", import.meta.url))
  ? "../../web/out"
  : "../public";
config.main = "../src/index.ts";
config.d1_databases[0].migrations_dir = "../migrations";
mkdirSync(new URL("../.local", import.meta.url), { recursive: true });
const path = new URL("../.local/wrangler.json", import.meta.url);
writeFileSync(path, JSON.stringify(config, null, 2));
// Wrangler resolves .dev.vars beside the effective configuration.
if (existsSync(new URL("../.dev.vars", import.meta.url)))
  writeFileSync(
    new URL("../.local/.dev.vars", import.meta.url),
    readFileSync(new URL("../.dev.vars", import.meta.url)),
  );
const child = spawn(
  process.execPath,
  [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    ".local/wrangler.json",
    "--persist-to",
    ".wrangler/state",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", windowsHide: true },
);
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else child.kill(signal);
    process.exit(0);
  });
