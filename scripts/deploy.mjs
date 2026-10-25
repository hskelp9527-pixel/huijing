import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const edge = join(root, "apps/edge");
const local = join(edge, ".deploy");
const wrangler = join(edge, "node_modules/wrangler/bin/wrangler.js");

export function parseEnv(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name, raw] = match;
    if (raw.startsWith("'") || raw.startsWith('"')) {
      const end = raw.indexOf(raw[0], 1);
      if (end < 0) throw new Error(`私有配置 ${name} 引号未闭合`);
      values[name] = raw.slice(1, end);
    } else values[name] = raw.replace(/\s+#.*$/, "").trim();
  }
  return values;
}

export function redactor(values) {
  const patterns = [...new Set(values.filter(Boolean).flatMap((v) => [
    v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1), Buffer.from(v).toString("base64"),
  ]))].sort((a, b) => b.length - a.length);
  return (value) => {
    let output = String(value);
    for (const pattern of patterns) output = output.split(pattern).join("[REDACTED]");
    return output.replace(/((?:authorization|x-goog-api-key|api[_-]?token|secret[_-]?key|password)\s*[=:]\s*)([^\s,}]+)/gi, "$1[REDACTED]");
  };
}

export async function runChild(args, { cwd = root, env = {}, input, redact = String, log = console.log, quiet = false } = {}) {
  // No shell: secrets cannot become shell syntax or appear in command arguments.
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, {
      cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", failed = false;
    const collect = (kind) => (chunk) => {
      if (kind === "stdout") stdout += chunk; else stderr += chunk;
      if (stdout.length + stderr.length > 32 * 1024 * 1024) { failed = true; child.kill(); }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("子进程启动失败")));
    child.on("close", (code) => {
      if (!quiet && stdout.trim()) log(redact(stdout.trim()));
      if (!quiet && stderr.trim()) log(redact(stderr.trim()));
      if (code !== 0 || failed) reject(new Error(`子进程失败，退出码 ${code}`));
      else accept(stdout);
    });
    child.stdin.end(input || "");
  });
}

export function safeEnvironment(source, credentials = {}, dryRun = false) {
  const env = { ...source };
  // Do not inherit any unrelated provider key, local secret or alternate API endpoint.
  for (const name of Object.keys(env))
    if (/CLOUDFLARE|VERTEX|TURNSTILE|TOKEN|SECRET|PASSWORD|KEY|CREDENTIAL|NODE_OPTIONS|WRANGLER_LOG/i.test(name)) delete env[name];
  Object.assign(env, {
    CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  });
  if (!dryRun) Object.assign(env, credentials);
  return env;
}

export function productionConfig(config, env) {
  const result = structuredClone(config);
  const production = result.env?.production;
  if (!production) throw new Error("缺少 production 配置");
  if (production.vars.PROVIDER_MODE !== "vertex" || production.vars.APP_ENV !== "production" || production.vars.VERTEX_BASE_URL)
    throw new Error("production 必须直连 Vertex，禁止开发代理");
  for (const key of ["GUEST_DAILY_SETS", "GLOBAL_DAILY_IMAGES", "GUEST_DAILY_RUNS", "QUOTA_CLIENT_OPS_DAILY"]) {
    const value = env[key] ?? production.vars[key];
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} 必须为非负整数`);
    production.vars[key] = value;
  }
  result.main = "../src/index.ts";
  result.$schema = "../node_modules/wrangler/config-schema.json";
  result.assets.directory = "../../web/out";
  for (const bindings of [result, ...Object.values(result.env)])
    for (const database of bindings.d1_databases || []) database.migrations_dir = "../migrations";
  return result;
}

export async function smoke(baseUrl, { request = fetch, log = console.log } = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
    throw new Error("冒烟地址必须为 HTTPS origin");
  async function me(cookie) {
    const response = await request(`${url.origin}/api/me`, { redirect: "error", signal: AbortSignal.timeout(30000),
      headers: cookie ? { Cookie: cookie } : {} });
    if (response.status !== 200) throw new Error(`冒烟 /api/me HTTP ${response.status}`);
    return { response, body: await response.json() };
  }
  const first = await me();
  const cookie = first.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie || !first.body.user?.isGuest || !first.body.quota?.resetAt) throw new Error("匿名身份或额度无效");
  const again = await me(cookie);
  if (again.body.user?.id !== first.body.user.id) throw new Error("访客 cookie 未保持身份");
  const other = await me();
  if (other.body.user?.id === first.body.user.id) throw new Error("独立访客未隔离");
  log("PASS：匿名身份、cookie 复用与独立访客隔离；未消费图片或文本额度。");
}

async function bundleSummary(folder) {
  const files = [];
  async function walk(path) {
    for (const name of await readdir(path)) {
      const full = join(path, name), info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else if (!name.endsWith(".map") && name !== "README.md") files.push({ file: full.slice(folder.length + 1).replaceAll("\\", "/"), bytes: info.size });
    }
  }
  await walk(folder);
  const bytes = files.reduce((sum, item) => sum + item.bytes, 0);
  // Also enforce a conservative 3 MiB budget, below the current 64 MiB platform limit.
  if (bytes > 3 * 1024 * 1024) throw new Error("Worker 超过本项目 3 MiB 部署体积预算");
  return { files, uncompressedBytes: bytes, budgetBytes: 3 * 1024 * 1024, platformLimitBytes: 64 * 1024 * 1024, source: "https://developers.cloudflare.com/workers/platform/limits/#worker-size" };
}

export async function deploy({ dryRun = false, env = process.env, run = runChild, log = console.log, read = readFile, write = writeFile, makeDir = mkdir, remove = rm, summarize = bundleSummary, smokeTest = smoke } = {}) {
  const privateEnv = !dryRun && env.CLOUDFLARE_ENV_FILE ? parseEnv(await read(env.CLOUDFLARE_ENV_FILE, "utf8")) : {};
  const vertex = dryRun ? undefined : env.VERTEX_API_KEY || (env.VERTEX_KEY_FILE ? parseEnv(await read(env.VERTEX_KEY_FILE, "utf8")).GEMINI_KEY : undefined);
  const session = dryRun ? undefined : env.SESSION_SECRET;
  const credentials = { CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN || privateEnv.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID || privateEnv.CLOUDFLARE_ACCOUNT_ID };
  const redact = redactor([...Object.values(credentials), vertex, session, env.VERTEX_API_KEY, env.SESSION_SECRET]);
  const report = value => log(redact(value));
  try {
    if (!dryRun && (!credentials.CLOUDFLARE_API_TOKEN || !/^[a-f0-9]{32}$/i.test(credentials.CLOUDFLARE_ACCOUNT_ID || "") || !vertex || !session || session.length < 32))
      throw new Error("部署需要 Cloudflare 凭据、VERTEX_API_KEY 和至少32字符 SESSION_SECRET");
    const config = productionConfig(JSON.parse(await read(join(edge, "wrangler.jsonc"), "utf8")), env);
    const production = config.env.production;
    report(dryRun ? "DRY-RUN：纯本地，不连接 Cloudflare API；不创建资源、不迁移、不部署、不写 secret。" : "开始 production 部署。");
    const childEnv = safeEnvironment(env, credentials, dryRun);
    // This gate is the only route to subprocesses; dry-run has an exact allowlist.
    async function execute(kind, args, options = {}) {
      if (dryRun && !["shared-build", "web-build", "bundle"].includes(kind)) throw new Error("dry-run 拦截远端步骤");
      if (dryRun && kind === "bundle" && (args[0] !== wrangler || args[1] !== "deploy" || !args.includes("--dry-run")))
        throw new Error("dry-run 仅允许本地 Wrangler 打包");
      return run(args, { env: childEnv, redact, log: report, ...options });
    }
    await makeDir(local, { recursive: true });
    const names = { database: production.d1_databases[0].database_name, bucket: production.r2_buckets[0].bucket_name, queue: production.queues.producers[0].queue };
    report(`1. 检查/复用 D1 ${names.database}、R2 ${names.bucket}、Queue ${names.queue}；仅不存在时创建。`);
    if (!dryRun) {
      const resources = JSON.parse(await execute("resources", [join(root, "scripts/cloudflare-resources.mjs"), "--apply"], { input: JSON.stringify(names), quiet: true }));
      production.d1_databases[0].database_id = resources.databaseId;
      await write(join(local, "resources.json"), JSON.stringify(resources, null, 2) + "\n");
    }
    // Effective configuration contains only public bindings, IDs and quotas.
    const configPath = join(local, "wrangler.json");
    await write(configPath, JSON.stringify(config, null, 2) + "\n");
    const flags = ["--config", configPath, "--env", "production"];
    report("2. 回填资源 ID 到 apps/edge/.deploy/wrangler.json（dry-run 保留占位 ID）。");
    report("3. wrangler d1 migrations apply DB --remote --env production。");
    if (!dryRun) await execute("migrate", [wrangler, "d1", "migrations", "apply", "DB", "--remote", ...flags], { cwd: edge });
    const pnpm = env.npm_execpath && /pnpm\.(?:c?js|mjs)$/.test(env.npm_execpath) ? env.npm_execpath : join(dirname(process.execPath), "node_modules/corepack/dist/pnpm.js");
    // Corepack may not be installed beside Node; resolve pnpm's installed JS entry.
    const pnpmEntry = existsSync(pnpm) ? pnpm : join(env.APPDATA || "", "npm/node_modules/pnpm/bin/pnpm.cjs");
    report("4. 构建 shared 与 web（NEXT_PUBLIC_API_MODE=http）。");
    const buildEnv = { ...safeEnvironment(env), NEXT_PUBLIC_API_MODE: "http" };
    await execute("shared-build", [pnpmEntry, "--filter", "@loomic/shared", "build"], { env: buildEnv });
    await execute("web-build", [pnpmEntry, "--filter", "@loomic/web", "build"], { env: buildEnv });
    report(`5. wrangler deploy${dryRun ? " --dry-run" : ""} --env production。`);
    const outdir = join(local, "bundle");
    // Exact known child path, never derive a recursive cleanup path from user input.
    if (resolve(outdir) !== resolve(edge, ".deploy", "bundle")) throw new Error("构建清理路径无效");
    await remove(outdir, { recursive: true, force: true });
    const output = await execute("bundle", [wrangler, "deploy", ...flags, "--outdir", outdir, ...(dryRun ? ["--dry-run"] : [])], { cwd: edge });
    const size = await summarize(outdir);
    await write(join(local, "bundle-summary.json"), JSON.stringify(size, null, 2) + "\n");
    report(`Worker 打包：${size.uncompressedBytes} bytes；本项目预算 ${size.budgetBytes} bytes；Cloudflare 未压缩限制 ${size.platformLimitBytes} bytes。`);
    report("6. wrangler secret put VERTEX_API_KEY / SESSION_SECRET：仅经 stdin 传入。");
    if (!dryRun) {
      await execute("secret", [wrangler, "secret", "put", "VERTEX_API_KEY", ...flags], { cwd: edge, input: vertex + "\n" });
      await execute("secret", [wrangler, "secret", "put", "SESSION_SECRET", ...flags], { cwd: edge, input: session + "\n" });
    }
    report("7. 部署后匿名身份与 cookie 隔离冒烟；dry-run 跳过远端请求。");
    if (!dryRun) {
      const baseUrl = env.DEPLOY_BASE_URL || output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i)?.[0];
      if (!baseUrl) throw new Error("无法识别部署 URL，请设置 DEPLOY_BASE_URL 后重新部署/冒烟");
      await smokeTest(baseUrl, { log: report });
    }
    report(dryRun ? "PASS：dry-run 完成，未执行任何 Cloudflare 写操作。" : "PASS：部署与匿名冒烟完成。");
    return size;
  } catch (error) { throw new Error(redact(error.message)); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry-run")) { console.error("用法：node scripts/deploy.mjs [--dry-run]"); process.exitCode = 1; }
  else deploy({ dryRun: args.includes("--dry-run") }).catch((error) => { console.error(`FAIL：${error.message}`); process.exitCode = 1; });
}
