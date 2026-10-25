import { afterAll, beforeAll, describe, it, expect } from "vitest";
import {
  edgeEventSchema,
  projectResponseSchema,
  messagesResponseSchema,
} from "@loomic/shared/edge";
import { harness, submission, until } from "./harness";
describe("Cloudflare fixture integration", () => {
  let h: Awaited<ReturnType<typeof harness>>, cookie: string, other: string;
  beforeAll(async () => {
    h = await harness();
    cookie = (await h.guest()).cookie;
    other = (await h.guest()).cookie;
  });
  afterAll(async () => {
    await h?.close();
  });
  async function start(text?: string, count?: number) {
    const r = await h.request(
      "/api/projects/start",
      "POST",
      submission(text, count),
      cookie,
    );
    expect(r.status, await r.clone().text()).toBe(201);
    return r.json<any>();
  }
  async function finished(runId: string) {
    return until(
      () =>
        h.db.prepare("SELECT * FROM runs WHERE id=?").bind(runId).first<any>(),
      (r) =>
        ["completed", "failed", "cancelled", "waiting_input"].includes(r.state),
    );
  }
  it("其他用户访问项目和 WebSocket 均为 403", async () => {
    const s = await start("生成一张杯子", 1);
    expect(
      (await h.request(`/api/projects/${s.projectId}`, "GET", undefined, other))
        .status,
    ).toBe(403);
    expect(
      (
        await h.request(
          `/api/projects/${s.projectId}/ws`,
          "GET",
          undefined,
          other,
          { Upgrade: "websocket" },
        )
      ).status,
    ).toBe(403);
    await finished(s.runId);
  });
  it("重复 submissionId 仅一个项目，正文不同返回409", async () => {
    const body = submission("生成一张杯子", 1);
    const [a, b] = await Promise.all([
      h.request("/api/projects/start", "POST", body, cookie),
      h.request("/api/projects/start", "POST", body, cookie),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const first = await a.json<any>();
    expect(await b.json()).toEqual(first);
    expect(
      (
        await h.request(
          "/api/projects/start",
          "POST",
          { ...body, parts: [{ type: "text", text: "不同" }] },
          cookie,
        )
      ).status,
    ).toBe(409);
    await finished(first.runId);
  });
  it("Run 两张图各插入一次；重复投递与重复 commit 无副作用", async () => {
    const s = await start();
    const run = await finished(s.runId);
    expect(
      run.state,
      JSON.stringify({
        error: run.error,
        tasks: (
          await h.db
            .prepare("SELECT state,error FROM tasks WHERE run_id=?")
            .bind(s.runId)
            .all()
        ).results,
      }),
    ).toBe("completed");
    const tasks = (
      await h.db
        .prepare("SELECT * FROM tasks WHERE run_id=? ORDER BY slot_index")
        .bind(s.runId)
        .all<any>()
    ).results;
    expect(tasks).toHaveLength(2);
    expect(tasks.map((t) => t.state)).toEqual(["committed", "committed"]);
    const ns = await h.mf.getDurableObjectNamespace("PROJECT_ROOM");
    const stub = ns.get(ns.idFromName(s.projectId));
    for (const t of tasks) {
      const r = await stub.fetch("https://room/claim", {
        method: "POST",
        body: JSON.stringify({ projectId: s.projectId, taskId: t.id }),
      });
      expect(await r.json()).toEqual({ claimed: false });
      await stub.fetch("https://room/commit", {
        method: "POST",
        body: JSON.stringify({ projectId: s.projectId, taskId: t.id }),
      });
    }
    expect(
      (
        await h.db
          .prepare("SELECT COUNT(*) n FROM insertions WHERE project_id=?")
          .bind(s.projectId)
          .first<any>()
      ).n,
    ).toBe(2);
    const p = await (
      await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)
    ).json<any>();
    expect(projectResponseSchema.safeParse(p).success).toBe(true);
    expect(p.canvas.elements).toHaveLength(2);
    expect(p.canvas.elements[1].x - p.canvas.elements[0].x).toBe(392);
    const messages = await (
      await h.request(
        `/api/threads/${s.threadId}/messages`,
        "GET",
        undefined,
        cookie,
      )
    ).json();
    expect(messagesResponseSchema.safeParse(messages).success).toBe(true);
    const events = (
      await (
        await h.request(
          `/api/projects/${s.projectId}/events`,
          "GET",
          undefined,
          cookie,
        )
      ).json<any>()
    ).items;
    expect(
      events.filter((e: any) => e.type === "artifact.committed"),
    ).toHaveLength(2);
    for (const e of events)
      expect(edgeEventSchema.safeParse(e).success).toBe(true);
  });
  it("取消先到，迟到产物只入库、不插入、不复活 Run", async () => {
    const s = await start("生成一张杯子 [fixture:delay=1000]", 1);
    await until(
      () =>
        h.db
          .prepare("SELECT * FROM tasks WHERE run_id=?")
          .bind(s.runId)
          .first<any>(),
      (t) => t?.state === "running",
    );
    expect(
      (await h.request(`/api/runs/${s.runId}/cancel`, "POST", {}, cookie))
        .status,
    ).toBe(200);
    await until(
      () =>
        h.db
          .prepare(
            "SELECT a.id FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.run_id=?",
          )
          .bind(s.runId)
          .first<any>(),
      (a) => !!a,
    );
    expect(
      (
        await h.db
          .prepare("SELECT COUNT(*) n FROM insertions WHERE project_id=?")
          .bind(s.projectId)
          .first<any>()
      ).n,
    ).toBe(0);
    expect((await finished(s.runId)).state).toBe("cancelled");
  });
  it("canvas 同元素冲突409、不同元素基于旧版本可合并、幂等校验", async () => {
    const p = await (
      await h.request("/api/projects", "POST", {}, cookie)
    ).json<any>();
    const path = `/api/projects/${p.project.id}/canvas/ops`;
    const element = {
      id: "rect",
      type: "rectangle",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      version: 1,
    };
    const op = {
      clientOpId: "a",
      baseRevision: 0,
      ops: [{ kind: "upsert", element }],
    };
    expect((await h.request(path, "POST", op, cookie)).status).toBe(200);
    expect((await h.request(path, "POST", op, cookie)).status).toBe(200);
    expect(
      (await h.request(path, "POST", { ...op, clientOpId: "b" }, cookie))
        .status,
    ).toBe(409);
    expect(
      (
        await h.request(
          path,
          "POST",
          {
            ...op,
            clientOpId: "c",
            ops: [{ kind: "upsert", element: { ...element, id: "other" } }],
          },
          cookie,
        )
      ).status,
    ).toBe(200);
  });
  it("WebSocket 重连 cursor 补发顺序连续且无重复", async () => {
    const s = await start("生成一张杯子", 1);
    await finished(s.runId);
    async function replay(cursor: number) {
      const r = await h.request(
        `/api/projects/${s.projectId}/ws?cursor=${cursor}`,
        "GET",
        undefined,
        cookie,
        { Upgrade: "websocket" },
      );
      expect(r.status).toBe(101);
      const ws = r.webSocket!;
      const items: any[] = [];
      ws.addEventListener("message", (e) =>
        items.push(JSON.parse(String(e.data))),
      );
      ws.accept();
      const max = (
        await h.db
          .prepare("SELECT event_seq FROM projects WHERE id=?")
          .bind(s.projectId)
          .first<any>()
      ).event_seq;
      await until(
        async () => items,
        (es) => es.length === max - cursor,
      );
      ws.close();
      return items;
    }
    const first = await replay(0);
    const cursor = first[Math.floor(first.length / 2)].seq;
    const second = await replay(cursor);
    expect(second.map((e) => e.seq)).toEqual(
      first.filter((e) => e.seq > cursor).map((e) => e.seq),
    );
  });
  it("明确生图请求采用显式界面设置，不增加确认轮次", async () => {
    const body = { ...submission("生成两张杯子", 1), settingsExplicitKeys: ["count"] };
    const s = await (await h.request("/api/projects/start", "POST", body, cookie)).json<any>();
    const run = await finished(s.runId);
    expect(run.state).toBe("completed");
    expect(JSON.parse(run.effective_settings).count).toBe(1);
    expect((await h.db.prepare("SELECT COUNT(*) n FROM tasks WHERE run_id=?").bind(s.runId).first<any>()).n).toBe(1);
    expect((await h.db.prepare("SELECT COUNT(*) n FROM input_requests WHERE run_id=?").bind(s.runId).first<any>()).n).toBe(0);
  });
  it("同线程已有活跃 Run 返回 RUN_ACTIVE", async () => {
    const s = await start("生成一张图 [fixture:delay=1000]", 1);
    const r = await h.request(
      `/api/threads/${s.threadId}/messages`,
      "POST",
      {
        clientMessageId: crypto.randomUUID(),
        parts: [{ type: "text", text: "再次生成" }],
      },
      cookie,
    );
    expect(r.status).toBe(409);
    expect((await r.json<any>()).error.code).toBe("RUN_ACTIVE");
    await finished(s.runId);
  });
});
describe("quota", () => {
  it("UTC 每日额度耗尽，提交前拦截且不计数", async () => {
    const h = await harness({ GUEST_DAILY_IMAGES: "0" });
    try {
      const { cookie } = await h.guest();
      const response = await h.request("/api/projects/start", "POST", submission("生成一张图", 1), cookie);
      expect(response.status).toBe(429);
      expect((await response.json<any>()).error).toMatchObject({ code: "QUOTA_EXCEEDED_IP", details: { resetAt: expect.stringMatching(/T00:00:00.000Z$/) } });
      expect(
        (
          await (
            await h.request("/api/me", "GET", undefined, cookie)
          ).json<any>()
        ).quota.used,
      ).toBe(0);
    } finally {
      await h.close();
    }
  });
});
