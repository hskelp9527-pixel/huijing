import { describe, expect, it } from "vitest";
import { harness, submission, until } from "./harness";
import { source } from "./media-helpers";

describe("明确图片请求直出", () => {
  it("两张图在3秒内排队，不调用文本模型和参考审查，不出现planning事件", async () => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "test-placeholder" });
    try {
      h.mock.get("https://aiplatform.googleapis.com").intercept({ method: "POST", path: /gemini-3.1-flash-image:generateContent$/ })
        .reply(200, { candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=" } }] } }] }).times(2);
      const { cookie } = await h.guest();
      const started = Date.now();
      const s = await (await h.request("/api/projects/start", "POST", submission("生成两张介绍如何制作陶瓷杯的海报，不需要质量检查", 2), cookie)).json<any>();
      await until(() => h.db.prepare("SELECT COUNT(*) n FROM tasks WHERE run_id=?").bind(s.runId).first<any>(), r => r.n === 2);
      expect(Date.now() - started).toBeLessThan(3000);
      const run = await until(() => h.db.prepare("SELECT state FROM runs WHERE id=?").bind(s.runId).first<any>(), r => ["completed", "failed"].includes(r.state));
      expect(run.state).toBe("completed");
      const rows = (await h.db.prepare("SELECT data FROM events WHERE project_id=?").bind(s.projectId).all<any>()).results.map(r => JSON.parse(r.data));
      expect(rows.some(e => e.payload.state === "planning" || /规划中/.test(e.payload.summary || ""))).toBe(false);
      expect(rows.some(e => e.payload.summary === "生成 2 张图")).toBe(true);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='text'").first<any>()).n).toBe(0);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM child_runs").first<any>()).n).toBe(0);
    } finally { await h.close(); }
  });
  it("明确改图和扩图使用给定快照直接创建任务；缺少目标才追问", async () => {
    const h = await harness();
    try {
      const { cookie } = await h.guest();
      const s = await source(h, cookie);
      const p = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
      for (const text of ["把这张图改成蓝色", "向右扩图，保持主体"]) {
        const result = await (await h.request(`/api/threads/${p.threads[0].id}/messages`, "POST", {
          clientMessageId: crypto.randomUUID(), parts: [{ type: "text", text }], references: [{ snapshotId: s.source.snapshotId, purpose: "subject", order: 0 }], settings: { count: 1 }, settingsExplicitKeys: [],
        }, cookie)).json<any>();
        const run = await until(() => h.db.prepare("SELECT * FROM runs WHERE id=?").bind(result.runId).first<any>(), r => ["completed", "failed"].includes(r.state));
        expect(run.state, run.error).toBe("completed"); expect(run.direct_mode).toBe(1);
        const task = await h.db.prepare("SELECT * FROM tasks WHERE run_id=?").bind(result.runId).first<any>();
        expect(task.operation).toBe("edit"); expect(JSON.parse(task.input).snapshotIds).toEqual([s.source.snapshotId]);
      }
      const missing = await (await h.request("/api/projects/start", "POST", submission("把图改成蓝色", 1), cookie)).json<any>();
      const run = await until(() => h.db.prepare("SELECT state FROM runs WHERE id=?").bind(missing.runId).first<any>(), r => r.state === "waiting_input");
      expect(run.state).toBe("waiting_input");
    } finally { await h.close(); }
  });
  it("单张原始上传可直接改图，不要求用户重新添加快照", async () => {
    const h = await harness();
    try {
      const { cookie } = await h.guest();
      const s = await source(h, cookie);
      const result = await (await h.request("/api/projects/start", "POST", { ...submission("把上传的图改成蓝色", 1), parts: [
        { type: "text", text: "把上传的图改成蓝色" }, { type: "image", assetId: s.asset.id },
      ] }, cookie)).json<any>();
      // The source helper claims its asset; a different project must still reject reuse.
      expect(result.error.code).toBe("FORBIDDEN");
      const project = await (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)).json<any>();
      const message = await (await h.request(`/api/threads/${project.threads[0].id}/messages`, "POST", {
        clientMessageId: crypto.randomUUID(), parts: [{ type: "text", text: "把上传的图改成蓝色" }, { type: "image", assetId: s.asset.id }], references: [], settings: { count: 1 }, settingsExplicitKeys: [],
      }, cookie)).json<any>();
      const run = await until(() => h.db.prepare("SELECT * FROM runs WHERE id=?").bind(message.runId).first<any>(), r => ["completed", "failed"].includes(r.state));
      expect(run.state, run.error).toBe("completed"); expect(run.direct_mode).toBe(1);
      const task = await h.db.prepare("SELECT input FROM tasks WHERE run_id=?").bind(message.runId).first<any>();
      expect(JSON.parse(task.input).assetIds).toEqual([]);
      expect(JSON.parse(task.input).snapshotIds).toHaveLength(1);
    } finally { await h.close(); }
  });

});
