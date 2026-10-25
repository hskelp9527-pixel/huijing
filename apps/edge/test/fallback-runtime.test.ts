import { describe, expect, it } from "vitest";
import { edgeEventSchema } from "@loomic/shared/edge";
import { harness, submission, until } from "./harness";
import type { Row } from "../src/types";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
describe("Workers 429 降级闭环", () => {
  it.each([false, true])("显式 modelId=%s 时任务、事件和额度正确", async (explicit) => {
    const h = await harness({
      PROVIDER_MODE: "vertex",
      VERTEX_API_KEY: "unit-test-placeholder",
      PROVIDER_RETRY_MS: "1",
      PROVIDER_RETRY_MAX_WAIT_MS: "1000",
    });
    try {
      const pool = h.mock.get("https://aiplatform.googleapis.com");
      const responses = [
        [{ functionCall: { name: "read_canvas", id: "read", args: {} }, thoughtSignature: "sig" }],
        [
          {
            functionCall: {
              name: "generate_images",
              id: "generate",
              args: { prompt: "杯子", count: 1 },
            },
            thoughtSignature: "sig2",
          },
        ],
        [{ text: "已完成" }],
      ];
      for (const parts of responses)
        pool
          .intercept({ method: "POST", path: /gemini-3.8-flash:generateContent$/ })
          .reply(200, { candidates: [{ content: { role: "model", parts } }] });
      pool
        .intercept({ method: "POST", path: /gemini-3.1-flash-image:generateContent$/ })
        .reply(429, {})
        .persist();
      pool
        .intercept({ method: "POST", path: /gemini-3.1-flash-lite-image:generateContent$/ })
        .reply(200, {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ inlineData: { mimeType: "image/png", data: png } }],
              },
            },
          ],
        });
      const { cookie } = await h.guest();
      const body = {
        ...submission("生成一张杯子", 1),
        settings: { count: 1, modelId: "gemini-3.1-flash-image" },
        settingsExplicitKeys: explicit ? ["modelId"] : [],
      };
      const { runId, projectId } = await (
        await h.request("/api/projects/start", "POST", body, cookie)
      ).json<{ runId: string; projectId: string }>();
      const run = await until(
        () => h.db.prepare("SELECT * FROM runs WHERE id=?").bind(runId).first<Row>(),
        (r) => !!r && ["completed", "failed"].includes(r.state),
      );
      expect(run?.state, run?.error).toBe(explicit ? "failed" : "completed");
      const task = await h.db
        .prepare("SELECT * FROM tasks WHERE run_id=?")
        .bind(runId)
        .first<Row>();
      if (explicit)
        expect(JSON.parse(task!.error)).toMatchObject({ code: "RATE_LIMITED", retryable: true });
      else expect(JSON.parse(task!.output).modelId).toBe("gemini-3.1-flash-lite-image");
      const rows = await h.db
        .prepare("SELECT data FROM events WHERE project_id=? ORDER BY seq")
        .bind(projectId)
        .all<{ data: string }>();
      const events = rows.results.map((r) => edgeEventSchema.parse(JSON.parse(r.data)));
      expect(
        events.filter(
          (e) => e.type === "run.step" && e.payload.summary === "高峰限流，已改用快速模型",
        ),
      ).toHaveLength(explicit ? 0 : 1);
      expect(events.map((e) => e.seq)).toEqual(events.map((_, index) => index + 1));
      expect(
        (
          await (
            await h.request("/api/me", "GET", undefined, cookie)
          ).json<{ quota: { used: number } }>()
        ).quota.used,
      ).toBe(explicit ? 0 : 1);
    } finally {
      await h.close();
    }
  });
  it("Agent 文本限流降级会发 run.step 且不计生图额度", async () => {
    const h = await harness({
      PROVIDER_MODE: "vertex",
      VERTEX_API_KEY: "unit-test-placeholder",
      PROVIDER_RETRY_MS: "1",
    });
    try {
      const pool = h.mock.get("https://aiplatform.googleapis.com");
      pool
        .intercept({ method: "POST", path: /gemini-3.8-flash:generateContent$/ })
        .reply(429, {})
        .persist();
      pool
        .intercept({ method: "POST", path: /gemini-3.1-flash-lite:generateContent$/ })
        .reply(200, { candidates: [{ content: { role: "model", parts: [{ text: "你好" }] } }] });
      const { cookie } = await h.guest();
      const { runId, projectId } = await (
        await h.request("/api/projects/start", "POST", submission("你好", 1), cookie)
      ).json<{ runId: string; projectId: string }>();
      const run = await until(
        () => h.db.prepare("SELECT * FROM runs WHERE id=?").bind(runId).first<Row>(),
        (r) => !!r && ["completed", "failed"].includes(r.state),
      );
      expect(run?.state, run?.error).toBe("completed");
      const event = await h.db
        .prepare(
          "SELECT data FROM events WHERE project_id=? AND json_extract(data,'$.payload.summary')=?",
        )
        .bind(projectId, "文本模型暂时不可用，已切换备用模型重试")
        .first<{ data: string }>();
      expect(edgeEventSchema.parse(JSON.parse(event!.data)).type).toBe("run.step");
      expect(
        (
          await (
            await h.request("/api/me", "GET", undefined, cookie)
          ).json<{ quota: { used: number } }>()
        ).quota.used,
      ).toBe(0);
    } finally {
      await h.close();
    }
  });
});
