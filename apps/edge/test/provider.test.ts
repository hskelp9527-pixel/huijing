import { describe, it, expect, vi } from "vitest";
import {
  appendToolResponse,
  retryAfter,
  VertexProvider,
} from "../src/providers/vertex";
import type { Env } from "../src/types";
function environment() {
  const gate = vi.fn(async () => Response.json({ ok: true }));
  return {
    env: {
      VERTEX_API_KEY: "unit-test-placeholder",
      APP_ENV: "test",
      AGENT_MODEL_ID: "gemini-3.8-flash",
      IMAGE_MODEL_ID: "gemini-3.1-flash-image",
      IMAGE_MODEL_PRO_ID: "gemini-3-pro-image",
      PROVIDER_GATE: { idFromName: () => "", get: () => ({ fetch: gate }) },
    } as unknown as Env,
    gate,
  };
}
describe("Vertex protocol", () => {
  it.each([
    {},
    { candidates: [] },
    { candidates: [{ finishReason: "NO_IMAGE" }] },
    { candidates: [{ content: { parts: [{ text: "No image today" }] } }] },
    { candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: "image/png", data: btoa("preview") } }] } }] },
  ])("无图响应只自动重试一次，保持同一预留且提供失败原因：%j", async reply => {
    const { env, gate } = environment();
    const beforeSend = vi.fn(async () => {});
    const send = vi.fn(async () => Response.json(reply));
    await expect(new VertexProvider(env, send).image("cup", { count: 1, modelId: "auto", quality: "standard", aspectRatio: "1:1" }, [],
      { id: "t", userId: "u", kind: "image", beforeSend }, false)).rejects.toMatchObject({
        code: "NO_IMAGE", message: expect.stringContaining("已自动重试 1 次"), details: { noImageRetries: 1 },
      });
    expect(send).toHaveBeenCalledTimes(2);
    expect(beforeSend.mock.calls).toEqual([[0], [1]]);
    expect(gate.mock.calls.filter((args: any) => args[0].endsWith("/acquire"))).toHaveLength(1);
    expect(gate.mock.calls.filter((args: any) => args[0].endsWith("/release") && JSON.parse(args[1].body).count)).toHaveLength(1);
  });
  it.each([500, 502, 503, 504, "network"])("文本 %s 重试三次，退避不持有并发且保留完整请求", async (status) => {
    const { env, gate } = environment();
    const wait = vi.fn(async () => {});
    const bodies: string[] = [];
    const send = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 4) return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "完成" }] } }] });
      if (status === "network") throw new TypeError("fetch failed");
      return new Response("upstream failure", { status: Number(status), headers: { "Retry-After": "3" } });
    });
    await new VertexProvider(env, send, wait).agent([{ role: "user", parts: [{ text: "test", thoughtSignature: "opaque" }] }], [], "u");
    expect(send).toHaveBeenCalledTimes(4);
    expect(new Set(bodies).size).toBe(1);
    expect(wait.mock.calls.map((args: any) => args[0])).toEqual(status === "network" ? [1000, 2000, 4000] : [3000, 3000, 4000]);
    expect(gate.mock.calls.filter((args: any) => JSON.parse(args[1].body).count)).toHaveLength(1);
  });
  it("文本持续 502 先重试再 fallback，耗尽可重试；400 不重试", async () => {
    const { env } = environment();
    const send = vi.fn(async () => new Response("{}", { status: 502 }));
    const fallback = vi.fn(async () => {});
    await expect(new VertexProvider(env, send, async () => {}).agent([], [], "u", { onFallback: fallback }))
      .rejects.toMatchObject({ code: "PROVIDER_ERROR", retryable: true, message: expect.stringContaining("重试") });
    expect(send).toHaveBeenCalledTimes(8);
    expect(fallback).toHaveBeenCalledWith("gemini-3.1-flash-lite");
    const bad = vi.fn(async () => new Response("{}", { status: 400 }));
    await expect(new VertexProvider(env, bad, async () => {}).agent([], [], "u")).rejects.toMatchObject({ retryable: false });
    expect(bad).toHaveBeenCalledTimes(1);
  });
  it("图片 502 绝不重试或降级", async () => {
    const { env } = environment();
    const send = vi.fn(async () => new Response("{}", { status: 502 }));
    await expect(new VertexProvider(env, send).image("cup", { count: 1, modelId: "auto", quality: "standard", aspectRatio: "auto" }, [], { id: "t", userId: "u", kind: "image" }, false))
      .rejects.toMatchObject({ code: "UPSTREAM_ERROR", retryable: false });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("模型全部 parts（thoughtSignature、functionCall.id、未知字段）原样回传", async () => {
    const { env } = environment();
    const content: any = {
      role: "model",
      parts: [
        {
          text: "private thought",
          thought: true,
          thoughtSignature: "opaque-text-signature",
        },
        {
          functionCall: { name: "read_canvas", id: "call-123", args: {} },
          thoughtSignature: "opaque-signature",
          futureField: { a: 1 },
        },
      ],
    };
    const requests: any[] = [];
    const request = vi.fn(async (_url: any, init: any) => {
      requests.push(JSON.parse(init.body));
      return Response.json({
        candidates: [
          {
            content:
              requests.length === 1
                ? content
                : { role: "model", parts: [{ text: "完成" }] },
          },
        ],
      });
    });
    const provider = new VertexProvider(env, request);
    const initial: any[] = [{ role: "user", parts: [{ text: "读取画布" }] }];
    const model = await provider.agent(initial, [], "user");
    const response = [
      {
        functionResponse: {
          name: "read_canvas",
          id: "call-123",
          response: { revision: 2 },
        },
      },
    ];
    await provider.agent(
      appendToolResponse(initial, model, response),
      [],
      "user",
    );
    expect(requests[1].contents[1]).toEqual(content);
    expect(requests[1].contents[2].parts).toEqual(response);
    expect(request.mock.calls[0][0]).toBe(
      "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent",
    );
  });
  it("429 指数退避尊重 Retry-After，最终 RATE_LIMITED，不计额度", async () => {
    const { env, gate } = environment();
    const wait = vi.fn(async () => {});
    const send = vi.fn(
      async () =>
        new Response("{}", { status: 429, headers: { "Retry-After": "3" } }),
    );
    const rejected = vi.fn(async () => {});
    await expect(
      new VertexProvider(env, send, wait).call(
        "gemini-3.1-flash-image",
        {},
        { id: "task", kind: "image", userId: "u", onRejected: rejected },
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(send).toHaveBeenCalledTimes(4);
    expect(wait.mock.calls.map((c: any) => c[0])).toEqual([3000, 3000, 4000]);
    expect(rejected).toHaveBeenCalledTimes(4);
    for (const [url, init] of gate.mock.calls as any)
      if (url.endsWith("/release"))
        expect(JSON.parse(init.body).count).toBe(false);
  });
  it("网络超时为提交不确定，绝不自动重提，保守计数", async () => {
    const { env, gate } = environment();
    const send = vi.fn(async () => {
      throw new DOMException("timeout", "TimeoutError");
    });
    await expect(
      new VertexProvider(env, send).call(
        "image",
        {},
        { id: "task", kind: "image", userId: "u" },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse((gate.mock.calls as any).at(-1)[1].body).count).toBe(
      true,
    );
  });
  it("成功图片忽略 thought 预览，JPEG MIME 原样保存", async () => {
    const { env } = environment();
    const send = vi.fn(async () =>
      Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  inlineData: { mimeType: "image/png", data: btoa("preview") },
                },
                {
                  inlineData: { mimeType: "image/jpeg", data: btoa("actual") },
                },
              ],
            },
          },
        ],
      }),
    );
    const output = await new VertexProvider(env, send).image(
      "cup",
      { count: 1, modelId: "auto", quality: "standard", aspectRatio: "16:9" },
      [],
      { id: "task", kind: "image", userId: "u" },
      false,
    );
    expect(output.mime).toBe("image/jpeg");
    expect(new TextDecoder().decode(output.bytes)).toBe("actual");
  });
  it("开发代理仅接受 loopback 地址，线上拒绝且不提交", async () => {
    const { env } = environment();
    env.VERTEX_BASE_URL = "http://169.254.169.254";
    const send = vi.fn();
    await expect(
      new VertexProvider(env, send).call(
        "image",
        {},
        { id: "task", kind: "image", userId: "u" },
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(send).not.toHaveBeenCalled();
  });
  it("Retry-After 支持 HTTP 日期", () => {
    const timestamp = Date.now();
    expect(
      retryAfter(
        new Response("", {
          headers: { "Retry-After": new Date(timestamp + 10000).toUTCString() },
        }),
        1000,
        timestamp,
      ),
    ).toBeGreaterThanOrEqual(9000);
  });
});
