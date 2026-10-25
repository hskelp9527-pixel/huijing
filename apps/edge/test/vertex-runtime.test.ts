import { describe, it, expect } from "vitest";
import { harness, submission, until } from "./harness";
describe("Vertex in actual Workers runtime", () => {
  it("read_canvas 后连续 502 会重试并降级，显式图片模型不阻止文本 fallback", async () => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "unit-test-placeholder", PROVIDER_RETRY_MS: "1" });
    try {
      const main = h.mock.get("https://aiplatform.googleapis.com");
      main.intercept({ method: "POST", path: /gemini-3.8-flash:generateContent$/ }).reply(200, { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_canvas", id: "signed-read", args: {} }, thoughtSignature: "kept" }] } }] });
      main.intercept({ method: "POST", path: /gemini-3.8-flash:generateContent$/ }).reply(502, { error: { message: "Bad Gateway" } }).times(4);
      main.intercept({ method: "POST", path: /gemini-3.1-flash-lite:generateContent$/ }).reply(200, { candidates: [{ content: { role: "model", parts: [{ text: "画布为空，可添加参考图片。" }] } }] });
      const { cookie } = await h.guest();
      const s = await (await h.request("/api/projects/start", "POST", { ...submission("读取画布概要", 1), settings: { modelId: "gemini-3-pro-image" }, settingsExplicitKeys: ["modelId"] }, cookie)).json<any>();
      const run = await until(() => h.db.prepare("SELECT * FROM runs WHERE id=?").bind(s.runId).first<any>(), r => ["failed", "completed"].includes(r.state));
      expect(run.state, run.error).toBe("completed");
      const result = await (await h.request(`/api/threads/${s.threadId}/messages`, "GET", undefined, cookie)).json<any>();
      expect(result.runs[0].steps.some((step: any) => step.summary.includes("备用模型"))).toBe(true);
      expect(JSON.parse(run.contents)[1].parts[0].thoughtSignature).toBe("kept");
      expect(result.tasks).toEqual([]);
    } finally { await h.close(); }
  });
  it("文本全链耗尽后消息接口给出可读错误和重试标记", async () => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "unit-test-placeholder", PROVIDER_RETRY_MS: "1" });
    try {
      h.mock.get("https://aiplatform.googleapis.com").intercept({ method: "POST", path: /generateContent$/ }).reply(502, { error: { message: "Bad Gateway" } }).times(8);
      const { cookie } = await h.guest();
      const s = await (await h.request("/api/projects/start", "POST", submission("读取画布概要", 1), cookie)).json<any>();
      await until(() => h.db.prepare("SELECT state FROM runs WHERE id=?").bind(s.runId).first<any>(), r => r.state === "failed");
      const result = await (await h.request(`/api/threads/${s.threadId}/messages`, "GET", undefined, cookie)).json<any>();
      expect(result.runs[0].error).toMatchObject({ code: "PROVIDER_ERROR", retryable: true, message: expect.stringContaining("重试") });
    } finally { await h.close(); }
  });
  it("原生 fetch 生图、持久化完整 parts 并完成工具续轮", async () => {
    const h = await harness({
      PROVIDER_MODE: "vertex",
      VERTEX_API_KEY: "unit-test-placeholder",
    });
    try {
      const responses = [
        [
          {
            functionCall: { name: "read_canvas", id: "native-read", args: {} },
            thoughtSignature: "native-read-signature",
            futureField: "retained",
          },
        ],
        [
          {
            functionCall: {
              name: "generate_images",
              id: "native-generate",
              args: { prompt: "生成杯子", count: 1 },
            },
            thoughtSignature: "native-generate-signature",
          },
        ],
        [{ text: "图片生成完成" }],
      ];
      for (const parts of responses)
        h.mock
          .get("https://aiplatform.googleapis.com")
          .intercept({
            method: "POST",
            path: /gemini-3.8-flash:generateContent$/,
          })
          .reply(200, { candidates: [{ content: { role: "model", parts } }] });
      h.mock
        .get("https://aiplatform.googleapis.com")
        .intercept({
          method: "POST",
          path: /gemini-3.1-flash-image:generateContent$/,
        })
        .reply(200, {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
                    },
                  },
                ],
              },
            },
          ],
        });
      const { cookie } = await h.guest();
      const s = await (
        await h.request(
          "/api/projects/start",
          "POST",
          submission("讨论杯子设计方案并执行", 1),
          cookie,
        )
      ).json<any>();
      const run = await until(
        () =>
          h.db
            .prepare("SELECT * FROM runs WHERE id=?")
            .bind(s.runId)
            .first<any>(),
        (r) => ["failed", "completed"].includes(r.state),
      );
      expect(run.state, run.error).toBe("completed");
      const contents = JSON.parse(run.contents);
      expect(contents[1].parts[0]).toEqual({
        functionCall: { name: "read_canvas", id: "native-read", args: {} },
        thoughtSignature: "native-read-signature",
        futureField: "retained",
      });
      expect(contents[3].parts[0].thoughtSignature).toBe(
        "native-generate-signature",
      );
      expect(
        (
          await h.db
            .prepare("SELECT COUNT(*) n FROM insertions WHERE project_id=?")
            .bind(s.projectId)
            .first<any>()
        ).n,
      ).toBe(1);
    } finally {
      await h.close();
    }
  });
});
