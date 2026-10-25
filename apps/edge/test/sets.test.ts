import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeEventSchema, publicSetTemplateSchema, setResponseSchema } from "@loomic/shared/edge";
import { harness, until } from "./harness";
import { png, postForm } from "./media-helpers";
import { Response as WorkerResponse } from "miniflare";

const points = [{ title: "原图颜色", detail: "保留原图颜色" }, { title: "可见外形", detail: "呈现原图结构" }, { title: "表面细节", detail: "展示可见表面" }];
describe("模板套图 Workers 集成", () => {
  let h: Awaited<ReturnType<typeof harness>>, cookie: string, assetId: string;
  beforeAll(async () => {
    h = await harness(); cookie = (await h.guest()).cookie;
    const form = new FormData(); form.set("file", new Blob([new Uint8Array(png(16, 16))], { type: "image/png" }), "product.png");
    assetId = (await (await postForm(h, cookie, form)).json() as { asset: { id: string } }).asset.id;
  });
  afterAll(async () => { await h?.close(); });
  const get = async (setId: string) => setResponseSchema.parse(await (await h.request(`/api/sets/${setId}`, "GET", undefined, cookie)).json());
  async function create(templateId = "amazon-7", note?: string, sellingPoints?: typeof points) {
    const response = await h.request("/api/sets", "POST", { sourceAssetIds: [assetId], templateId, note, sellingPoints }, cookie);
    expect(response.status, await response.clone().text()).toBe(201);
    return response.json<any>();
  }
  const done = (setId: string) => until(() => get(setId), set => ["completed", "partial", "failed"].includes(set.state));
  it("4套模板隐藏所有提示词，原图权限与参数验证", async () => {
    const templates = await (await h.request("/api/templates", "GET", undefined, cookie)).json<any[]>();
    expect(templates.map(t => t.shots.length)).toEqual([7, 6, 4, 1]);
    templates.forEach(t => publicSetTemplateSchema.parse(t));
    expect(JSON.stringify(templates)).not.toContain('"prompt"');
    const other = (await h.guest()).cookie;
    expect((await h.request("/api/sets", "POST", { templateId: "amazon-7", sourceAssetIds: [assetId] }, other)).status).toBe(403);
    expect((await h.request("/api/sets", "POST", { templateId: "invalid", sourceAssetIds: [assetId] }, cookie)).status).toBe(422);
    expect((await h.request("/api/sets", "POST", { templateId: "amazon-7", sourceAssetIds: [] }, cookie)).status).toBe(422);
  });
  it("7张即时插入，4张换行；重放不重复；改卖点只改文字且重出保留文字", async () => {
    const s = await create(); const set = await done(s.setId);
    expect(set.state, JSON.stringify(set)).toBe("completed"); expect(set.shots).toHaveLength(7);
    expect(set.analysis?.sellingPoints).toHaveLength(3);
    const p = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
    const frames = p.canvas.elements.filter((e: any) => e.type === "frame");
    expect(frames.map((e: any) => [e.x, e.y])).toEqual([[0,0],[392,0],[784,0],[1176,0],[0,512],[392,512],[784,512]]);
    expect(p.canvas.elements.filter((e: any) => e.type === "image")).toHaveLength(7);
    expect(set.shots[0].textElementIds).toHaveLength(0);
    const texts = p.canvas.elements.filter((e: any) => e.type === "text"); expect(texts).toHaveLength(12);
    expect(texts.every((e: any) => e.frameId && e.customData.source && Number.isFinite(e.fontFamily) && e.fontSize > 0 && e.lineHeight > 0 && e.strokeColor)).toBe(true);
    const tasksBefore = (await h.db.prepare("SELECT id,input FROM tasks WHERE project_id=?").bind(s.projectId).all<any>()).results;
    expect(tasksBefore.every(t => JSON.parse(t.input).assetIds.length === 1 && JSON.parse(t.input).snapshotIds.length === 0)).toBe(true);
    const specTitleId = set.shots.find(shot => shot.shotId === "spec")!.textElementIds[0];
    const specTitle = p.canvas.elements.find((element: any) => element.id === specTitleId);
    expect((await h.request(`/api/projects/${s.projectId}/canvas/ops`, "POST", { clientOpId: crypto.randomUUID(), baseRevision: p.canvas.revision,
      ops: [{ kind: "upsert", element: { ...specTitle, text: "用户保留的规格标题", originalText: "用户保留的规格标题" } }] }, cookie)).status).toBe(200);
    const bucketBefore = (await (await h.mf.getR2Bucket("BUCKET")).list()).objects.length;
    const result = await h.request(`/api/sets/${s.setId}/selling-points`, "PATCH", { sellingPoints: points }, cookie);
    expect(result.status, await result.clone().text()).toBe(200);
    const updated = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
    expect(updated.canvas.elements.filter((e: any) => e.type === "image")).toEqual(p.canvas.elements.filter((e: any) => e.type === "image"));
    expect(updated.canvas.elements.find((e: any) => e.id === set.shots[1].textElementIds[0]).text).toBe(points[0].title);
    expect(updated.canvas.elements.find((element: any) => element.id === specTitleId).text).toBe("用户保留的规格标题");
    expect((await h.db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=?").bind(s.projectId).first<any>())!.n).toBe(7);
    expect((await (await h.mf.getR2Bucket("BUCKET")).list()).objects).toHaveLength(bucketBefore);
    const body = { clientOperationId: crypto.randomUUID() };
    const [a, b] = await Promise.all([h.request(`/api/sets/${s.setId}/shots/main/regenerate`, "POST", body, cookie), h.request(`/api/sets/${s.setId}/shots/main/regenerate`, "POST", body, cookie)]);
    expect(a.status, await a.clone().text()).toBe(202); expect(await b.json()).toEqual(await a.json());
    const regenerated = await done(s.setId); expect(regenerated.state).toBe("completed");
    expect(regenerated.shots[0].imageElementId).toBe(set.shots[0].imageElementId);
    const final = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
    expect(final.canvas.elements.filter((e: any) => e.type === "image")).toHaveLength(7);
    expect(final.canvas.elements.filter((e: any) => e.type === "text")).toEqual(updated.canvas.elements.filter((e: any) => e.type === "text"));
    const ns = await h.mf.getDurableObjectNamespace("PROJECT_ROOM");
    await ns.get(ns.idFromName(s.projectId)).fetch("https://room/commit", { method: "POST", body: JSON.stringify({ projectId: s.projectId, taskId: regenerated.shots[0].taskId }) });
    const events = (await (await h.request(`/api/projects/${s.projectId}/events`, "GET", undefined, cookie)).json<any>()).items;
    events.forEach((e: unknown) => edgeEventSchema.parse(e));
    expect(events.filter((e: any) => e.type === "set.shot" && e.payload.state === "completed")).toHaveLength(8);
    const firstComplete = events.findIndex((e: any) => e.type === "set.shot" && e.payload.state === "completed");
    expect(events.slice(firstComplete + 1).some((e: any) => e.type === "set.shot" && ["running", "submitted", "queued"].includes(e.payload.state))).toBe(true);
    expect((await h.db.prepare("SELECT project_id FROM assets WHERE id=?").bind(assetId).first<any>())!.project_id).toBeNull();
    const other = (await h.guest()).cookie;
    for (const [path, method, data] of [[`/api/sets/${s.setId}`, "GET", undefined], [`/api/sets/${s.setId}/selling-points`, "PATCH", { sellingPoints: points }], [`/api/sets/${s.setId}/shots/main/regenerate`, "POST", {}]] as const)
      expect((await h.request(path, method, data, other)).status).toBe(403);
  });
  it("供应卖点跳过模型分析，quick-single按note选择场景", async () => {
    const s = await create("quick-single", "办公室使用场景", points); const set = await done(s.setId);
    expect(set.state).toBe("completed"); expect(set.analysis?.sellingPoints).toEqual(points); expect(set.lang).toBe("zh");
    expect(set.shots[0].textElementIds).toHaveLength(2);
    expect((await h.db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='text'").first<any>())!.n).toBe(0);
  });
});

describe("套图额度与真实provider故障路径", () => {
  async function seed(h: Awaited<ReturnType<typeof harness>>) {
    const { cookie } = await h.guest();
    const form = new FormData(); form.set("file", new Blob([new Uint8Array(png(16, 16))], { type: "image/png" }), "product.png");
    const assetId = (await (await postForm(h, cookie, form)).json() as { asset: { id: string } }).asset.id;
    return { cookie, body: { templateId: "amazon-7", sourceAssetIds: [assetId], sellingPoints: points } };
  }
  it("两个并发7图整套申请只有一个通过；不足时告知3张并且无空项目", async () => {
    const h = await harness({ GUEST_DAILY_IMAGES: "10", GLOBAL_DAILY_IMAGES: "10" });
    try {
      const { cookie, body } = await seed(h);
      const responses = await Promise.all([h.request("/api/sets", "POST", body, cookie), h.request("/api/sets", "POST", body, cookie)]);
      expect(responses.map(r => r.status).sort()).toEqual([201,429]);
      expect(await responses.find(r => r.status === 429)!.json()).toMatchObject({ error: { details: { availableImages: 3, requested: 7 } } });
      expect((await h.db.prepare("SELECT COUNT(*) n FROM image_sets").first<any>())!.n).toBe(1);
    } finally { await h.close(); }
  });
  it("单张429退回，其余6张照常完成为partial；重出只补一张", async () => {
    let recovered = false, rejected = 0;
    const response = { candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: png(16,16).toString("base64") } }] } }] };
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder", PROVIDER_RETRY_MS: "1", PROVIDER_RETRY_MAX_WAIT_MS: "10000", IMAGE_FALLBACK_CHAIN: "gemini-3.1-flash-image" }, "src/index.ts", async request => {
      const main = (await request.text()).includes("Amazon primary listing");
      if (main && !recovered) { rejected++; return new WorkerResponse("{}", { status: 429, headers: { "Retry-After": "30" } }); }
      return new WorkerResponse(JSON.stringify(response), { headers: { "content-type": "application/json" } });
    });
    try {
      const { cookie, body } = await seed(h);
      const s = await (await h.request("/api/sets", "POST", body, cookie)).json<any>();
      const set = await until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>(), s => ["completed","partial","failed"].includes(s.state));
      expect(set.state, JSON.stringify(set)).toBe("partial"); expect(set.shots.filter((s: any) => s.state === "completed")).toHaveLength(6);
      expect(set.shots[0]).toMatchObject({ state: "failed", error: { code: "RATE_LIMITED" } });
      expect(rejected).toBe(1);
      expect((await h.request("/api/me", "GET", undefined, cookie)).status).toBe(200);
      expect((await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota.used).toBe(6);
      recovered = true;
      expect((await h.request(`/api/sets/${s.setId}/shots/main/regenerate`, "POST", {}, cookie)).status).toBe(202);
      const final = await until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>(), s => s.state === "completed");
      expect(final.shots).toHaveLength(7);
      expect((await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota.used).toBe(7);
    } finally { await h.close(); }
  });
  it("结构化分析含过长标题则失败且全额退回，不调用图片模型", async () => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder", PROVIDER_RETRY_MS: "1" });
    try {
      const { cookie, body } = await seed(h);
      const { sellingPoints: _, ...request } = body;
      h.mock.get("https://aiplatform.googleapis.com").intercept({ method: "POST", path: /gemini-3.1-flash-lite:generateContent$/ })
        .reply(200, { candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ productName: "商品", category: "日用", audience: "日常", sellingPoints: points.map(p => ({ ...p, title: "这是一个明显超过十二个字的错误标题" })) }) }] } }] });
      const s = await (await h.request("/api/sets", "POST", request, cookie)).json<any>();
      const set = await until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>(), s => s.state === "failed");
      expect(set.shots.every((shot: any) => shot.state === "failed")).toBe(true);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM tasks").first<any>())!.n).toBe(0);
      const me = await (await h.request("/api/me", "GET", undefined, cookie)).json<any>(); expect(me.quota.used).toBe(0); expect(me.quota.remaining).toBe(1000);
    } finally { await h.close(); }
  });
  it("一次结构化分析带原图与note；7张都引用原图且全站图片并发不超过2", async () => {
    let analyses = 0, images = 0, active = 0, peak = 0;
    const inputs: string[][] = [];
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder" }, "src/index.ts", async request => {
      const body = JSON.parse(await request.text());
      const parts = body.contents[0].parts;
      inputs.push(parts.filter((part: any) => part.inlineData).map((part: any) => part.inlineData.data));
      if (request.url.includes("flash-lite:")) {
        analyses++;
        expect(body.generationConfig.responseMimeType).toBe("application/json");
        expect(body.generationConfig.responseSchema.required).toContain("sellingPoints");
        expect(JSON.parse(parts.at(-1).text)).toMatchObject({ note: "给办公室人群", outputLanguage: "en" });
        return new WorkerResponse(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ productName: "Product", category: "Everyday goods", audience: "Office users", sellingPoints: points }) }] } }] }));
      }
      images++; active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 50)); active--;
      return new WorkerResponse(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: png(16,16).toString("base64") } }] } }] }));
    });
    try {
      const { cookie, body } = await seed(h); const { sellingPoints: _, ...request } = body;
      const s = await (await h.request("/api/sets", "POST", { ...request, note: "给办公室人群" }, cookie)).json<any>();
      const set = await until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>(), set => ["completed","partial","failed"].includes(set.state));
      expect(set.state, JSON.stringify(set)).toBe("completed"); expect(analyses).toBe(1); expect(images).toBe(7);
      expect(peak).toBe(2); expect(inputs).toHaveLength(8); expect(inputs.every(input => input.length === 1 && input[0] === inputs[0][0])).toBe(true);
    } finally { await h.close(); }
  });
  it("图片502视为不确定且不自动重提，但套图失败张退回额度", async () => {
    let attempts = 0;
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder" }, "src/index.ts", async () => { attempts++; return new WorkerResponse("{}", { status: 502 }); });
    try {
      const { cookie, body } = await seed(h);
      const s = await (await h.request("/api/sets", "POST", { ...body, templateId: "quick-single" }, cookie)).json<any>();
      const set = await until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>(), set => set.state === "failed");
      expect(attempts).toBe(1); expect(set.shots[0].error.code).toBe("UPSTREAM_ERROR");
      const quota = (await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota;
      expect(quota.used).toBe(0); expect(quota.remaining).toBe(1000);
      expect((await h.db.prepare("SELECT used FROM quota_usage WHERE subject='*'").first<any>())!.used).toBe(0);
    } finally { await h.close(); }
  });
  it.each([false, true])("分析不能从织物外观推出耐用；用户明确提供该信息时可用=%s", async allowed => {
    const analyzed = { productName: "Woven bag", category: "Bags", audience: "Everyday users", sellingPoints: [
      { title: "Durable fabric", detail: "Woven surface" }, { title: "Black exterior", detail: "Visible black color" }, { title: "Buckle straps", detail: "Visible buckle fasteners" },
    ] };
    let images = 0;
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder" }, "src/index.ts", async request => {
      const image = request.url.includes("flash-image:"); if (image) images++;
      return new WorkerResponse(JSON.stringify({ candidates: [{ content: { role: "model", parts: [image
        ? { inlineData: { mimeType: "image/png", data: png(16,16).toString("base64") } } : { text: JSON.stringify(analyzed) }] } }] }));
    });
    try {
      const { cookie, body } = await seed(h); const { sellingPoints: _, ...request } = body;
      const s = await (await h.request("/api/sets", "POST", { ...request, templateId: "quick-single", note: allowed ? "用户提供：面料耐用，白底" : undefined }, cookie)).json<any>();
      const set = await until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>(), set => ["completed","failed"].includes(set.state));
      expect(set.state, JSON.stringify(set)).toBe(allowed ? "completed" : "failed"); expect(images).toBe(allowed ? 1 : 0);
      if (!allowed) expect(set.error.message).toContain("外观无法证明");
    } finally { await h.close(); }
  });
  it("分析中停止整套会退额；迟到分析不再排图片，旧文本重试不能留下孤儿活动Run", async () => {
    let images = 0;
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder" }, "src/index.ts", async request => {
      if (request.url.includes("flash-image:")) images++;
      await new Promise(resolve => setTimeout(resolve, 400));
      return new WorkerResponse(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ productName: "Bag", category: "Bags", audience: "Users", sellingPoints: points }) }] } }] }));
    });
    try {
      const { cookie, body } = await seed(h); const { sellingPoints: _, ...request } = body;
      const s = await (await h.request("/api/sets", "POST", request, cookie)).json<any>();
      const set = await until(() => h.db.prepare("SELECT * FROM image_sets WHERE id=?").bind(s.setId).first<any>(), set => !!set.analysis_started_at);
      expect((await h.request(`/api/runs/${set.run_id}/cancel`, "POST", {}, cookie)).status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 650));
      const result = await (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>();
      expect(result.state).toBe("failed"); expect(result.error.message).toContain("已停止"); expect(images).toBe(0);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=?").bind(s.projectId).first<any>())!.n).toBe(0);
      expect((await h.request(`/api/runs/${set.run_id}/retry`, "POST", { clientOperationId: crypto.randomUUID() }, cookie)).status).toBe(409);
      expect((await h.db.prepare("SELECT state FROM runs WHERE id=?").bind(set.run_id).first<any>())!.state).toBe("cancelled");
      expect((await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota.remaining).toBe(1000);
    } finally { await h.close(); }
  });
  it("已出图的套图不能借旧Run取消接口反复退额并绕过全站准入", async () => {
    const h = await harness();
    try {
      const { cookie, body } = await seed(h);
      const s = await (await h.request("/api/sets", "POST", { ...body, note: "[fixture:delay=1000]" }, cookie)).json<any>();
      const set = await until(() => h.db.prepare("SELECT * FROM image_sets WHERE id=?").bind(s.setId).first<any>(), set => set.state === "generating");
      expect((await h.request(`/api/runs/${set.run_id}/cancel`, "POST", {}, cookie)).status).toBe(409);
      expect((await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota.remaining).toBe(993);
      const final = await until(async () => (await h.request(`/api/sets/${s.setId}`, "GET", undefined, cookie)).json<any>(), set => ["completed","partial","failed"].includes(set.state));
      expect(final.state, JSON.stringify(final)).toBe("completed");
      expect((await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota.used).toBe(7);
    } finally { await h.close(); }
  });
});
