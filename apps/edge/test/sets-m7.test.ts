import { describe, expect, it } from "vitest";
import { Response as WorkerResponse } from "miniflare";
import { textStyleFor } from "@loomic/shared/edge";
import { harness, until } from "./harness";
import { png, postForm } from "./media-helpers";

const points = [{ title: "Visible color", detail: "Original color" }, { title: "Product shape", detail: "Visible construction" }, { title: "Surface texture", detail: "Visible surface" }];
type H = Awaited<ReturnType<typeof harness>>;
async function seed(h: H) {
  const { cookie } = await h.guest();
  const form = new FormData(); form.set("file", new Blob([new Uint8Array(png(16, 16))], { type: "image/png" }), "source.png");
  const assetId = (await (await postForm(h, cookie, form)).json() as { asset: { id: string } }).asset.id;
  return { cookie, body: { sourceAssetIds: [assetId], templateId: "amazon-7", sellingPoints: points } };
}
const get = async (h: H, id: string, cookie: string) => (await h.request(`/api/sets/${id}`, "GET", undefined, cookie)).json<any>();
const done = (h: H, id: string, cookie: string) => until(() => get(h, id, cookie), s => ["completed", "partial", "failed"].includes(s.state));
const imageReply = () => new WorkerResponse(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png(16, 16).toString("base64") } }] } }] }));

describe("M7 套图联调契约", () => {
  it("项目可直接取setId；分析修改保护手改卖点及删除图层，重出使用新分析并保留文字", async () => {
    const h = await harness();
    try {
      const { cookie, body } = await seed(h);
      const s = await (await h.request("/api/sets", "POST", body, cookie)).json<any>();
      await done(h, s.setId, cookie);
      const project = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
      expect(project.project.setId).toBe(s.setId);
      const list = await (await h.request("/api/projects", "GET", undefined, cookie)).json<any>();
      expect(list.items.find((p: any) => p.id === s.projectId).setId).toBe(s.setId);
      const texts = project.canvas.elements.filter((e: any) => e.type === "text");
      for (const text of texts) {
        expect(text).toMatchObject(textStyleFor(text.customData.role, 360));
        expect(text.height).toBeGreaterThanOrEqual(text.fontSize * text.lineHeight);
      }
      const edited = texts.find((t: any) => t.customData.source === "sellingPoints.0.title");
      const deleted = texts.find((t: any) => t.customData.source === "sellingPoints.1.title");
      await h.request(`/api/projects/${s.projectId}/canvas/ops`, "POST", { clientOpId: crypto.randomUUID(), baseRevision: project.canvas.revision,
        ops: [{ kind: "upsert", element: { ...edited, text: "用户手改", originalText: "用户手改", fontSize: 19 } }, { kind: "upsert", element: { ...deleted, isDeleted: true } }] }, cookie);
      const changes = { productName: "Updated product", audience: "Office users", sellingPoints: points.map(p => ({ ...p, title: "New title" })) };
      const result = await h.request(`/api/sets/${s.setId}/analysis`, "PATCH", changes, cookie);
      expect(result.status, await result.clone().text()).toBe(200);
      expect((await result.json<any>()).analysis).toMatchObject(changes);
      const updated = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
      expect(updated.canvas.elements.find((e: any) => e.id === edited.id)).toMatchObject({ text: "用户手改", fontSize: 19 });
      expect(updated.canvas.elements.find((e: any) => e.id === deleted.id).isDeleted).toBe(true);
      expect(updated.canvas.elements.find((e: any) => e.customData?.source === "productName").text).toBe("Updated product");
      expect((await h.request(`/api/sets/${s.setId}/selling-points`, "PATCH", { audience: "Travel users" }, cookie)).status).toBe(200);
      expect((await h.request(`/api/sets/${s.setId}/analysis`, "PATCH", {}, cookie)).status).toBe(422);
      const other = (await h.guest()).cookie;
      expect((await h.request(`/api/sets/${s.setId}/analysis`, "PATCH", changes, other)).status).toBe(403);
      expect((await h.request(`/api/sets/${s.setId}/regenerate`, "POST", { scope: "all" }, other)).status).toBe(403);
      const operation = { scope: "all", clientOperationId: crypto.randomUUID() };
      const responses = await Promise.all([h.request(`/api/sets/${s.setId}/regenerate`, "POST", operation, cookie), h.request(`/api/sets/${s.setId}/regenerate`, "POST", operation, cookie)]);
      expect(responses.every(r => r.status === 202)).toBe(true);
      expect(await responses[0].json()).toEqual(await responses[1].json());
      const final = await done(h, s.setId, cookie); expect(final.state).toBe("completed");
      expect((await h.request(`/api/sets/${s.setId}/regenerate`, "POST", { ...operation, scope: "failed" }, cookie)).status).toBe(409);
      const tasks = (await h.db.prepare("SELECT input FROM tasks WHERE project_id=?").bind(s.projectId).all<any>()).results;
      expect(tasks).toHaveLength(14);
      expect(tasks.filter(t => JSON.parse(t.input).prompt.includes("Updated product"))).toHaveLength(7);
      expect(tasks.filter(t => JSON.parse(t.input).prompt.includes("Travel users"))).toHaveLength(1);
      const latest = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
      expect(latest.canvas.elements.filter((e: any) => e.type === "text")).toEqual(updated.canvas.elements.filter((e: any) => e.type === "text"));
    } finally { await h.close(); }
  });

  it("同IP并发最多2套7图，不受旧10张限制；单张最多3次，不再占套数", async () => {
    const h = await harness({ GUEST_DAILY_SETS: "2", GUEST_DAILY_IMAGES: "10", GLOBAL_DAILY_IMAGES: "150" });
    try {
      const { cookie, body } = await seed(h);
      const responses = await Promise.all(Array.from({ length: 3 }, () => h.request("/api/sets", "POST", body, cookie)));
      expect(responses.map(r => r.status).sort()).toEqual([201, 201, 429]);
      const sets = await Promise.all(responses.filter(r => r.ok).map(r => r.json<any>()));
      for (const s of sets) expect((await done(h, s.setId, cookie)).state).toBe("completed");
      const other = (await h.guest()).cookie;
      expect((await (await h.request("/api/me", "GET", undefined, other)).json<any>()).quota.setsRemaining).toBe(0);
      expect((await (await h.request("/api/me", "GET", undefined, other, { "CF-Connecting-IP": "192.0.2.9", "X-Forwarded-For": "local" })).json<any>()).quota.setsRemaining).toBe(2);
      const url = `/api/sets/${sets[0].setId}/shots/main/regenerate`;
      for (let i = 0; i < 3; i++) {
        const op = { clientOperationId: crypto.randomUUID() };
        const a = await h.request(url, "POST", op, cookie); expect(a.status).toBe(202);
        expect(await (await h.request(url, "POST", op, cookie)).json()).toEqual(await a.json());
        await done(h, sets[0].setId, cookie);
      }
      expect((await h.request(url, "POST", {}, cookie)).status).toBe(429);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM set_admissions").first<any>()).n).toBe(2);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM tasks").first<any>()).n).toBe(17);
      await h.db.prepare("UPDATE set_admissions SET day='2000-01-01'").run();
      expect((await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota.setsRemaining).toBe(2);
    } finally { await h.close(); }
  });

  it("整套全站额度不足时原子拒绝；failed无失败张时空操作不扣套数", async () => {
    const h = await harness({ GLOBAL_DAILY_IMAGES: "10" });
    try {
      const { cookie, body } = await seed(h);
      const s = await (await h.request("/api/sets", "POST", body, cookie)).json<any>(); await done(h, s.setId, cookie);
      const result = await h.request(`/api/sets/${s.setId}/regenerate`, "POST", { scope: "all" }, cookie);
      expect(result.status).toBe(429);
      expect(await result.json()).toMatchObject({ error: { code: "QUOTA_EXCEEDED_GLOBAL", details: { requested: 7, availableImages: 3 } } });
      const noop = await h.request(`/api/sets/${s.setId}/regenerate`, "POST", { scope: "failed" }, cookie);
      expect(await noop.json()).toEqual({ setId: s.setId, shots: [] });
      expect((await h.db.prepare("SELECT COUNT(*) n FROM tasks").first<any>()).n).toBe(7);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM set_admissions").first<any>()).n).toBe(1);
      expect((await get(h, s.setId, cookie)).state).toBe("completed");
    } finally { await h.close(); }
  });

  it("无图自动重试一次；成功只扣一张，仍无图保留原因；failed范围只重出失败张", async () => {
    const calls = new Map<string, number>(); let recover = false;
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder" }, "src/index.ts", async request => {
      const body = await request.text();
      const shot = body.includes("Amazon primary listing") ? "main" : body.includes("2–3x macro") ? "detail" : "other";
      const n = (calls.get(shot) || 0) + 1; calls.set(shot, n);
      if (!recover && (shot === "detail" || (shot === "main" && n === 1))) return new WorkerResponse(JSON.stringify({ candidates: [{ finishReason: "NO_IMAGE" }] }));
      return imageReply();
    });
    try {
      const { cookie, body } = await seed(h);
      const s = await (await h.request("/api/sets", "POST", body, cookie)).json<any>();
      const first = await done(h, s.setId, cookie);
      expect(first.state).toBe("partial"); expect(calls.get("main")).toBe(2); expect(calls.get("detail")).toBe(2);
      expect(first.shots.find((s: any) => s.shotId === "detail").error).toMatchObject({ code: "NO_IMAGE", message: expect.stringContaining("已自动重试 1 次"), details: { reason: "NO_IMAGE", noImageRetries: 1 } });
      const me = await (await h.request("/api/me", "GET", undefined, cookie)).json<any>(); expect(me.quota.used).toBe(6);
      expect((await h.db.prepare("SELECT attempt FROM submit_intents WHERE task_id=?").bind(first.shots[0].taskId).first<any>()).attempt).toBe(2);
      recover = true;
      const response = await h.request(`/api/sets/${s.setId}/regenerate`, "POST", { scope: "failed" }, cookie);
      expect(response.status).toBe(202); expect((await response.json<any>()).shots).toHaveLength(1);
      const final = await done(h, s.setId, cookie); expect(final.state).toBe("completed");
      expect(final.shots[0].taskId).toBe(first.shots[0].taskId);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM tasks").first<any>()).n).toBe(8);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM set_admissions").first<any>()).n).toBe(2);
      expect((await (await h.request("/api/me", "GET", undefined, cookie)).json<any>()).quota.used).toBe(7);
    } finally { await h.close(); }
  });

  it("分析失败可整套重出重新分析，旧分析错误及取消状态不会遗留", async () => {
    let valid = false;
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder" }, "src/index.ts", async request => {
      if (request.url.includes("flash-image:")) return imageReply();
      return new WorkerResponse(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(valid ? { productName: "Product", category: "Goods", audience: "Users", sellingPoints: points } : {}) }] } }] }));
    });
    try {
      const { cookie, body } = await seed(h); const { sellingPoints, ...request } = body;
      const s = await (await h.request("/api/sets", "POST", request, cookie)).json<any>(); expect((await done(h, s.setId, cookie)).state).toBe("failed");
      valid = true;
      expect((await h.request(`/api/sets/${s.setId}/regenerate`, "POST", { scope: "failed" }, cookie)).status).toBe(202);
      expect((await done(h, s.setId, cookie)).state).toBe("completed");
    } finally { await h.close(); }
  });
});
