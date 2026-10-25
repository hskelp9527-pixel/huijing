// Read-only pre-publication check. Never prints matched credentials or source contents.
import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "./deploy.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const values = [process.env.VERTEX_API_KEY, process.env.CLOUDFLARE_API_TOKEN, process.env.CLOUDFLARE_ACCOUNT_ID, process.env.SESSION_SECRET];
for (const file of [process.env.VERTEX_KEY_FILE, process.env.CLOUDFLARE_ENV_FILE].filter(Boolean)) {
  const parsed = parseEnv(await readFile(file, "utf8"));
  values.push(parsed.GEMINI_KEY, parsed.CLOUDFLARE_API_TOKEN, parsed.CLOUDFLARE_ACCOUNT_ID);
}
const secrets = [...new Set(values.filter(Boolean))];
if (secrets.length < 3) throw new Error("请提供仓库外的 Vertex/Cloudflare 凭据以执行真实值泄漏扫描");
const needles = secrets.flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString("base64")]).map(value => Buffer.from(value));
const files = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean))];
let scanned = 0;
const issues = [];
const allowedEmail = /^(?:[^@]+@(?:example\.(?:com|test)|test\.example|guest\.invalid)|noreply@openai\.com)$/;
for (const file of files) {
  let data;
  try { data = await readFile(join(root, file)); }
  catch (error) { if (["ENOENT", "EISDIR"].includes(error.code)) continue; throw error; }
  scanned++;
  if (needles.some(needle => data.includes(needle))) issues.push({ file, category: "known-secret" });
  const text = data.toString("utf8");
  if (/AIza[\w-]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push({ file, category: "credential-pattern" });
  // Preserve third-party font metadata and licensing; personal-email checks target text/code files.
  const emails = /\.(?:ttf|otf|woff2?)$/.test(file) ? [] : text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
  for (const email of emails)
    if (!allowedEmail.test(email)) issues.push({ file, category: "personal-email" });
  if (/\.(?:[cm]?js|tsx?|jsonc?)$/.test(file) && /(?:HTTPS?_PROXY|ALL_PROXY)\s*(?:\|\|=|=|:)\s*["']https?:\/\/(?:127\.0\.0\.1|localhost)/.test(text))
    issues.push({ file, category: "hardcoded-proxy" });
}
let artifactFilesScanned = 0;
async function checkArtifacts(folder) {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    const file = join(folder, entry.name);
    if (entry.isDirectory()) await checkArtifacts(file);
    else {
      artifactFilesScanned++;
      const data = await readFile(file);
      if (needles.some(needle => data.includes(needle))) issues.push({ file: file.slice(root.length + 1), category: "artifact-known-secret" });
    }
  }
}
await checkArtifacts(join(root, "apps/edge/.deploy/bundle"));
await checkArtifacts(join(root, "apps/web/out"));
const config = JSON.parse(await readFile(join(root, "apps/edge/wrangler.jsonc"), "utf8"));
for (const cfg of [config, ...Object.values(config.env || {})])
  if (cfg.account_id || cfg.d1_databases?.some(db => db.database_id !== "00000000-0000-0000-0000-000000000000"))
    issues.push({ file: "apps/edge/wrangler.jsonc", category: "non-placeholder-account-binding" });
for (const patch of [git("diff", "--binary"), git("diff", "--cached", "--binary")])
  if (needles.some(needle => Buffer.from(patch).includes(needle))) issues.push({ file: "git-diff", category: "known-secret" });
// Stream all reachable commit patches and metadata, retaining only overlap for pattern matches.
let historyLeak = false;
await new Promise((accept, reject) => {
  const child = spawn("git", ["log", "--all", "-p", "--format=fuller"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  let tail = Buffer.alloc(0);
  const overlap = Math.max(...needles.map(n => n.length));
  child.stdout.on("data", chunk => { const data = Buffer.concat([tail, chunk]);
    if (needles.some(needle => data.includes(needle))) historyLeak = true;
    tail = data.subarray(Math.max(0, data.length - overlap)); });
  child.on("error", reject);
  child.on("close", code => code === 0 ? accept() : reject(new Error("Git历史读取失败")));
});
if (historyLeak) issues.push({ file: "git-history", category: "known-secret" });
const report = { at: new Date().toISOString(), scannedFiles: scanned, artifactFilesScanned,
  historyCommits: Number(git("rev-list", "--count", "--all").trim()),
  knownSecretForms: ["raw", "url-encoded", "base64"],
  issues: [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()],
  exclusions: ["third-party font author metadata is preserved; font bytes still scanned for known secrets"],
  scope: "tracked and nonignored files, staged/worktree diffs, all reachable commit patches and metadata" };
console.log(JSON.stringify(report));
if (report.issues.length) process.exitCode = 1;
