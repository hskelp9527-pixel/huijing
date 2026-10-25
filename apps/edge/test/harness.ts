import { Miniflare, createFetchMock } from "miniflare";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, copyFile, readdir, rm } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
type TestResponse = Omit<
  Awaited<ReturnType<Miniflare["dispatchFetch"]>>,
  "json"
> & { json<T = any>(): Promise<T> };
export async function harness(overrides: Record<string, string> = {}, entryPoint = "src/index.ts", outboundService?: (request: import("miniflare").Request) => Promise<import("miniflare").Response>) {
  const root = resolve(".local");
  await mkdir(root, { recursive: true });
  const out = await mkdtemp(resolve(root, "test-worker-"));
  await build({
    entryPoints: [entryPoint],
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
            const path = resolve("node_modules", args.path);
            const name = basename(path);
            await copyFile(path, resolve(out, name));
            return { path: `./${name}`, external: true };
          });
        },
      },
    ],
  });
  const mock = createFetchMock();
  mock.disableNetConnect();
  const mf = new Miniflare({
    name: "test",
    modules: true,
    scriptPath: resolve(out, "index.js"),
    modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
    compatibilityDate: "2026-07-01",
    compatibilityFlags: ["nodejs_compat"],
    inspectorPort: 0,
    d1Databases: { DB: "test" },
    r2Buckets: ["BUCKET"],
    durableObjects: {
      PROJECT_ROOM: { className: "ProjectRoom", useSQLite: true },
      PROVIDER_GATE: { className: "ProviderGate", useSQLite: true },
    },
    queueProducers: { MEDIA_QUEUE: "media" },
    queueConsumers: {
      media: { maxBatchSize: 4, maxBatchTimeout: 0, maxRetries: 0 },
    },
    ...(outboundService ? { outboundService } : { fetchMock: mock }),
    bindings: {
      PROVIDER_MODE: "fixture",
      APP_ENV: "test",
      SESSION_SECRET: "test-only-session-signing-placeholder-32",
      IMAGE_MODEL_ID: "gemini-3.1-flash-image",
      IMAGE_MODEL_PRO_ID: "gemini-3-pro-image",
      AGENT_MODEL_ID: "gemini-3.8-flash",
      VISION_MODEL_ID: "gemini-3.1-flash-lite",
      GUEST_DAILY_IMAGES: "1000",
      GUEST_DAILY_SETS: "1000",
      GLOBAL_DAILY_IMAGES: "2000",
      GUEST_DAILY_RUNS: "1000",
      VERTEX_IMAGE_CONCURRENCY: "2",
      VERTEX_TEXT_CONCURRENCY: "4",
      ...overrides,
    },
  });
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(resolve("migrations", file), "utf8");
    for (const statement of splitSQL(sql)) await db.prepare(statement).run();
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie?: string,
    headers: Record<string, string> = {},
  ): Promise<TestResponse> {
    return mf.dispatchFetch(`https://app.test${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }) as Promise<TestResponse>;
  }
  async function guest(_label?: string) {
    const r = await request("/api/me");
    if (r.status !== 200) throw new Error(`guest ${r.status} ${await r.text()}`);
    return {
      cookie: r.headers.get("set-cookie")!.split(";")[0],
      ...(await r.json<any>()),
    };
  }
  return { mf, db, mock, request, guest, close: async () => {
    await mf.dispose();
    if (!out.startsWith(root + sep)) throw new Error("Unexpected test workspace");
    await rm(out, { recursive: true, force: true });
  } };
}
function splitSQL(sql: string) {
  const result: string[] = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += line + "\n";
    if (
      line.trim().endsWith(";") &&
      (!current.includes("CREATE TRIGGER") || line.includes("END;"))
    ) {
      result.push(current);
      current = "";
    }
  }
  return result.filter((s) => s.trim());
}
export async function until<T>(
  read: () => Promise<T>,
  done: (v: T) => boolean,
  timeout = 15000,
): Promise<T> {
  const end = Date.now() + timeout;
  let value: T;
  do {
    value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 50));
  } while (Date.now() < end);
  throw new Error(`等待超时: ${JSON.stringify(value)}`);
}
export const submission = (text = "生成两张陶瓷杯", count = 2) => ({
  submissionId: crypto.randomUUID(),
  parts: [{ type: "text", text }],
  references: [],
  settings: { count },
  settingsExplicitKeys: [],
});
