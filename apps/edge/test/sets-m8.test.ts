import { describe, expect, it } from "vitest";
import { Response as WorkerResponse } from "miniflare";
import { edgeEventSchema } from "@loomic/shared/edge";
import { harness, until } from "./harness";
import { png, postForm } from "./media-helpers";

type H = Awaited<ReturnType<typeof harness>>;
const points = [{ title: "Color", detail: "Original color" }, { title: "Shape", detail: "Visible shape" }, { title: "Texture", detail: "Visible texture" }];
const image = () => new WorkerResponse(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png(16, 16).toString("base64") } }] } }] }));
async function start(h: H) {
  const { cookie } = await h.guest();
  const form = new FormData(); form.set("file", new Blob([new Uint8Array(png(16, 16))], { type: "image/png" }), "source.png");
  const assetId = (await (await postForm(h, cookie, form)).json() as { asset: { id: string } }).asset.id;
  const response = await h.request("/api/sets", "POST", { sourceAssetIds: [assetId], templateId: "amazon-7", sellingPoints: points }, cookie);
  expect(response.status).toBe(201);
  return { cookie, ...await response.json<any>() };
}
async function final(h: H, s: any) {
  return until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, s.cookie)).json<any>(),
    v => ["completed", "partial", "failed"].includes(v.state), 25000);
}
async function events(h: H, projectId: string) {
  return (await h.db.prepare("SELECT data FROM events WHERE project_id=? ORDER BY seq").bind(projectId).all<any>()).results
    .map(row => edgeEventSchema.parse(JSON.parse(row.data)));
}
describe("M8 Queue / DO / D1 套图闭环", () => {
  it("主图先发，429/503延迟重投后7/7，同一模型、单次计费、排队可重放", async () => {
    const calls: { prompt: string; model: string; at: number }[] = [];
    const counts = new Map<string, number>();
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder", PROVIDER_RETRY_MS: "1" }, "src/index.ts", async request => {
      const body = JSON.parse(await request.text());
      const prompt = body.contents[0].parts.find((p: any) => p.text).text;
      calls.push({ prompt, model: request.url, at: Date.now() });
      const n = (counts.get(prompt) || 0) + 1; counts.set(prompt, n);
      if (prompt.includes("Amazon primary listing") && n <= 2) return new WorkerResponse("{}", { status: 429, headers: { "Retry-After": "1" } });
      if (prompt.includes("2–3x macro") && n === 1) return new WorkerResponse(JSON.stringify({ error: { details: [
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" },
      ] } }), { status: 503 });
      return image();
    });
    try {
      const s = await start(h), result = await final(h, s);
      expect(result.state).toBe("completed"); expect(result.shots.every((v: any) => v.state === "completed")).toBe(true);
      expect(calls[0].prompt).toContain("Amazon primary listing");
      expect(new Set(calls.map(c => c.model)).size).toBe(1);
      expect(calls.every(c => !c.model.includes("lite"))).toBe(true);
      const main = calls.filter(c => c.prompt.includes("Amazon primary listing")); expect(main).toHaveLength(3);
      expect(main[1].at - main[0].at).toBeGreaterThanOrEqual(1000);
      expect(main[2].at - main[1].at).toBeGreaterThanOrEqual(1000);
      const history = await events(h, s.projectId);
      const queued = history.filter(e => e.type === "set.shot" && e.payload.retryAt);
      expect(queued.length).toBeGreaterThanOrEqual(3);
      expect(queued.every(e => e.type === "set.shot" && e.payload.state === "queued" && !e.payload.error)).toBe(true);
      const mainTask = await h.db.prepare("SELECT * FROM tasks WHERE id=?").bind(result.shots[0].taskId).first<any>();
      expect(mainTask.provider_retry_attempt).toBe(2); expect(mainTask.provider_wait_ms).toBeGreaterThanOrEqual(2000);
      expect(mainTask.provider_retry_at).toBeNull();
      expect((await h.db.prepare("SELECT attempt FROM submit_intents WHERE task_id=?").bind(mainTask.id).first<any>()).attempt).toBe(3);
      const me = await (await h.request("/api/me", "GET", undefined, s.cookie)).json<any>(); expect(me.quota.used).toBe(7);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE state='counted'").first<any>()).n).toBe(7);
      // Duplicate delivery cannot resend a completed task.
      const ns = await h.mf.getDurableObjectNamespace("PROJECT_ROOM"), room = ns.get(ns.idFromName(s.projectId));
      expect(await (await room.fetch("https://room/claim", { method: "POST", body: JSON.stringify({ projectId: s.projectId, taskId: mainTask.id }) })).json()).toEqual({ claimed: false });
      expect(calls).toHaveLength(10);
    } finally { await h.close(); }
  });

  it("shot.error精确分类；失败图额度退还，限流没有lite或伪无图标签", async () => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder", PROVIDER_RETRY_MAX_WAIT_MS: "10000" }, "src/index.ts", async request => {
      const body = JSON.parse(await request.text());
      const prompt = body.contents[0].parts.find((p: any) => p.text).text;
      expect(request.url).not.toContain("lite");
      if (prompt.includes("Amazon primary listing")) return new WorkerResponse("{}", { status: 429, headers: { "Retry-After": "30" } });
      if (prompt.includes("A second complementary view")) return new WorkerResponse(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }));
      if (prompt.includes("2–3x macro")) return new WorkerResponse("{}", { status: 504 });
      if (prompt.includes("An orderly studio view")) return new WorkerResponse("{}", { status: 500 });
      return new WorkerResponse(JSON.stringify({ candidates: [{ finishReason: "NO_IMAGE" }] }));
    });
    try {
      const s = await start(h), result = await final(h, s);
      expect(result.state).toBe("failed");
      expect(result.shots[0].error.code).toBe("RATE_LIMITED");
      expect(result.shots.find((shot: any) => shot.shotId === "selling-1").error.code).toBe("NO_IMAGE");
      expect(result.shots.find((shot: any) => shot.shotId === "selling-2").error.code).toBe("SAFETY_BLOCKED");
      expect(result.shots.find((shot: any) => shot.shotId === "detail").error.code).toBe("TIMEOUT");
      expect(result.shots.find((shot: any) => shot.shotId === "spec").error.code).toBe("UPSTREAM_ERROR");
      expect((await (await h.request("/api/me", "GET", undefined, s.cookie)).json<any>()).quota.used).toBe(0);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE state<>'released'").first<any>()).n).toBe(0);
      const history = await events(h, s.projectId);
      expect(history.some(e => e.type === "set.shot" && e.payload.shotId === "main" && e.payload.error?.code === "RATE_LIMITED")).toBe(true);
    } finally { await h.close(); }
  });

  it("整套持续429，图片及每日套数额度都退回", async () => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder", PROVIDER_RETRY_MAX_WAIT_MS: "1", GUEST_DAILY_SETS: "2" }, "src/index.ts",
      async () => new WorkerResponse("{}", { status: 429, headers: { "Retry-After": "30" } }));
    try {
      const s = await start(h), result = await final(h, s);
      expect(result.shots.every((shot: any) => shot.error.code === "RATE_LIMITED")).toBe(true);
      expect((await (await h.request("/api/me", "GET", undefined, s.cookie)).json<any>()).quota).toMatchObject({ used: 0, setsRemaining: 2 });
      expect((await h.db.prepare("SELECT COUNT(*) n FROM set_admissions").first<any>()).n).toBe(0);
    } finally { await h.close(); }
  });

  it("DO按env限制全站图片，连续429后真实准入降到1，文本不受影响", async () => {
    const h = await harness({ VERTEX_IMAGE_CONCURRENCY: "2" });
    try {
      const ns = await h.mf.getDurableObjectNamespace("PROVIDER_GATE"), stub = ns.get(ns.idFromName("global"));
      const gate = (path: string, data: object) => stub.fetch(`https://gate/${path}`, { method: "POST", body: JSON.stringify(data) });
      const acquire = (id: string, kind = "image") => gate("acquire", { id, userId: "u", kind });
      expect((await acquire("a")).ok).toBe(true); expect((await acquire("b")).ok).toBe(true);
      expect((await acquire("c")).status).toBe(429);
      await gate("release", { id: "a", count: false, outcome: "rate_limited" });
      await gate("release", { id: "b", count: false, outcome: "rate_limited" });
      expect((await acquire("d")).ok).toBe(true); expect((await acquire("e")).status).toBe(429);
      expect((await acquire("text", "text")).ok).toBe(true);
      await gate("release", { id: "d", count: true, outcome: "success" });
      expect((await acquire("f")).ok).toBe(true); expect((await acquire("g")).status).toBe(429);
    } finally { await h.close(); }
  });
});
