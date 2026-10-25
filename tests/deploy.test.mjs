import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { deploy, parseEnv, productionConfig, redactor, safeEnvironment, smoke } from "../scripts/deploy.mjs";
import { ensureResources } from "../scripts/cloudflare-resources.mjs";

const sourceConfig = JSON.parse(await readFile(new URL("../apps/edge/wrangler.jsonc", import.meta.url), "utf8"));
const token = "synthetic-cloudflare-token", account = "a".repeat(32), vertex = "synthetic-vertex-key", session = "synthetic-session-placeholder-at-least-32";
const size = { uncompressedBytes: 100, budgetBytes: 3145728, platformLimitBytes: 67108864 };
function fixture(env = {}) {
  const calls = [], writes = [], logs = [];
  return {
    calls, writes, logs,
    options: {
      env: { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, VERTEX_API_KEY: vertex, SESSION_SECRET: session, ...env }, log: (message) => logs.push(message),
      read: async (path) => {
        if (path.endsWith(".cloudflare.env")) return `CLOUDFLARE_API_TOKEN='${token}'\nCLOUDFLARE_ACCOUNT_ID=${account}`;
        if (path.endsWith("gemini_key.md")) return `# 手册\nGEMINI_KEY = '${vertex}'\n`;
        return JSON.stringify(sourceConfig);
      },
      write: async (path, data) => writes.push({ path, data }), makeDir: async () => {}, remove: async () => {}, summarize: async () => size,
      run: async (args, options) => {
        calls.push({ args, ...options });
        if (args[0].endsWith("cloudflare-resources.mjs")) return JSON.stringify({ databaseId: "b".repeat(8) + "-bbbb-bbbb-bbbb-" + "b".repeat(12), bucketName: "huijing-assets", queueName: "huijing-media", queueId: "q1" });
        options.log(options.redact(`${env.CLOUDFLARE_API_TOKEN || token} ${env.VERTEX_API_KEY || vertex} ${account}`));
        return "https://huijing.example.workers.dev";
      },
      smokeTest: async (...args) => calls.push({ smoke: args }),
    },
  };
}

test("private env parser and redactor handle quotes, encoding, comments and raw keys", () => {
  assert.equal(parseEnv("export GEMINI_KEY = 'a#b' # comment").GEMINI_KEY, "a#b");
  assert.equal(parseEnv("CLOUDFLARE_API_TOKEN=abc # comment").CLOUDFLARE_API_TOKEN, "abc");
  const redact = redactor(["s/ecret+value"]);
  for (const value of ["s/ecret+value", encodeURIComponent("s/ecret+value"), Buffer.from("s/ecret+value").toString("base64")])
    assert.equal(redact(value), "[REDACTED]");
  assert.equal(redact("Authorization=Bearer-secret"), "Authorization=[REDACTED]");
});

test("dry-run allows only local builds and Wrangler dry bundle, no credentials or secrets on disk", async () => {
  const f = fixture({ CLOUDFLARE_API_TOKEN: "inherited-token", VERTEX_API_KEY: "inherited-key" });
  const originalEnv = { ...process.env };
  await deploy({ ...f.options, dryRun: true });
  assert.ok(JSON.stringify({ ...process.env }) === JSON.stringify(originalEnv), "部署不得修改父进程环境");
  assert.equal(f.calls.length, 3);
  const bundle = f.calls.at(-1);
  assert.equal(bundle.args[1], "deploy");
  assert.ok(bundle.args.includes("--dry-run"));
  for (const call of f.calls) {
    assert.equal(call.env.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(call.env.CLOUDFLARE_ACCOUNT_ID, undefined);
    assert.equal(call.env.VERTEX_API_KEY, undefined);
    assert.equal(call.env.WRANGLER_WRITE_LOGS, "false");
    assert.equal(call.input, undefined);
  }
  assert.equal(f.calls[1].env.NEXT_PUBLIC_API_MODE, "http");
  for (const value of [token, vertex, account, session]) {
    assert.ok(!JSON.stringify(f.writes).includes(value));
    assert.ok(!f.logs.join("\n").includes(value));
  }
});

test("live orchestration order and stdin-only secret handling use mocked children", async () => {
  const f = fixture();
  await deploy(f.options);
  assert.ok(f.calls[0].args[0].endsWith("cloudflare-resources.mjs"));
  assert.equal(f.calls[0].env.CLOUDFLARE_API_TOKEN, token);
  assert.ok(f.calls[1].args.includes("--remote"));
  const secret = f.calls.find((call) => call.args?.includes("secret"));
  assert.equal(secret.input, vertex + "\n");
  assert.equal(f.calls.find(call => call.args?.includes("SESSION_SECRET")).input, session + "\n");
  assert.ok(!f.calls.some((call) => call.args?.some((arg) => arg.includes(vertex) || arg.includes(token))));
  assert.ok(f.calls.at(-1).smoke);
  assert.ok(f.writes.some((item) => item.data.includes('"database_id": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"')));
  for (const value of [token, vertex, account, session]) assert.ok(!f.logs.join("\n").includes(value));
});

test("bad configuration aborts before children; a failed step stops following mutations", async () => {
  for (const env of [{ SESSION_SECRET: "short" }, { GUEST_DAILY_SETS: "NaN" }, { GLOBAL_DAILY_IMAGES: "-1" }, { GUEST_DAILY_RUNS: "1.5" }]) {
    const f = fixture(env);
    await assert.rejects(deploy(f.options));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  let count = 0;
  await assert.rejects(deploy({ ...f.options, run: async () => { count++; throw new Error(vertex); } }), /REDACTED/);
  assert.equal(count, 1);
  assert.equal(safeEnvironment({ NODE_OPTIONS: "bad", CLOUDFLARE_API_BASE_URL: "bad", PATH: "ok" }, {}, true).PATH, "ok");
  const config = structuredClone(sourceConfig);
  config.env.production.vars.VERTEX_BASE_URL = "http://localhost:8790";
  assert.throws(() => productionConfig(config, {}));
});

test("resource lookup reuses existing names and follows pagination without creating resources", async () => {
  const calls = [];
  const names = { database: "database-production", bucket: "bucket-production", queue: "queue-production" };
  const resources = await ensureResources(names, { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }, async (url, options) => {
    calls.push({ url, ...options });
    let result;
    if (url.includes("/d1/")) result = [{ name: names.database, uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }];
    else if (url.includes("/r2/")) result = { name: names.bucket };
    else if (url.includes("page=1&")) result = Array.from({ length: 100 }, (_, i) => ({ queue_name: `other-${i}` }));
    else result = [{ queue_name: names.queue, queue_id: "q1" }];
    return Response.json({ success: true, result });
  });
  assert.equal(resources.queueId, "q1");
  assert.ok(calls.some((call) => call.url.includes("page=2")));
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("resource absence creates each resource once; lookup errors never become create", async () => {
  const names = { database: "database-production", bucket: "bucket-production", queue: "queue-production" };
  const calls = [];
  await ensureResources(names, { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }, async (url, options) => {
    calls.push(options.method);
    if (options.method === "GET") return url.includes("/r2/") ? new Response("missing", { status: 404 }) : Response.json({ success: true, result: [] });
    const result = url.includes("/d1/") ? { uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" } : url.includes("/r2/") ? { name: names.bucket } : { queue_name: names.queue, queue_id: "q1" };
    return Response.json({ success: true, result });
  });
  assert.equal(calls.filter((method) => method === "POST").length, 3);
  let failedCalls = 0;
  await assert.rejects(ensureResources(names, { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account }, async (_, options) => {
    failedCalls++; assert.equal(options.method, "GET"); return new Response("denied", { status: 403 });
  }));
  assert.equal(failedCalls, 1);
});

test("post-deploy smoke checks anonymous isolation without exposing cookies", async () => {
  const calls = [], logs = [];
  await smoke("https://app.example", { log: line => logs.push(line), request: async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({ user: { id: calls.length === 3 ? "other" : "guest", isGuest: true }, quota: { resetAt: "2026-10-26T00:00:00.000Z" } },
      { headers: { "set-cookie": "session=private-cookie; HttpOnly; Secure" } });
  } });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].headers.Cookie, "session=private-cookie");
  assert.ok(!logs.join("\n").includes("private-cookie"));
  await assert.rejects(smoke("http://app.example"));
});

test("dry-run does not read private files or require secrets", async () => {
  const f = fixture({ CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", VERTEX_API_KEY: "", SESSION_SECRET: "", CLOUDFLARE_ENV_FILE: "private.env", VERTEX_KEY_FILE: "private.md" });
  await deploy({ ...f.options, dryRun: true, read: async path => {
    assert.ok(path.endsWith("wrangler.jsonc")); return JSON.stringify(sourceConfig);
  } });
  assert.equal(f.calls.length, 3);
});
