import { describe, expect, it, vi } from "vitest";
import { VertexProvider } from "../src/providers/vertex";
import type { Env } from "../src/types";
import { deferImage, DeferredImage, imageRetryDelay, parseRetryAfter, retryInfo } from "../src/provider-backoff";
import { imageCapacity, updateCapacity } from "../src/provider-capacity";

const settings = { count: 1, modelId: "auto", quality: "standard", aspectRatio: "1:1" } as const;
function setup() {
  const gate = vi.fn(async () => Response.json({ ok: true }));
  const env = { VERTEX_API_KEY: "unit-test-placeholder", APP_ENV: "test",
    IMAGE_MODEL_ID: "gemini-3.1-flash-image", IMAGE_MODEL_PRO_ID: "gemini-3-pro-image",
    PROVIDER_GATE: { idFromName: () => "global", get: () => ({ fetch: gate }) },
  } as unknown as Env;
  return { env, gate };
}
describe("M8 图片限流", () => {
  it("套图429交给延迟队列，释放并发、不sleep、不降lite", async () => {
    const { env, gate } = setup(), wait = vi.fn(async () => {});
    const request = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    await expect(new VertexProvider(env, request, wait).image("cup", settings, [], {
      id: "t", userId: "u", kind: "image", setId: "set", queueRetry: { attempt: 0, waitMs: 0 },
    }, false)).rejects.toMatchObject({ code: "RATE_LIMITED", delayMs: 30000 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(gate.mock.calls.some((args: any) => JSON.parse(args[1].body).count)).toBe(false);
  });
  it.each([429, 503])("%s优先读取RetryInfo，队列重投不计费", async status => {
    const { env, gate } = setup(), wait = vi.fn(async () => {});
    const request = vi.fn(async () => Response.json({ error: { details: [
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32.2s" },
    ] } }, { status }));
    await expect(new VertexProvider(env, request, wait).image("cup", settings, [], {
      id: "t", userId: "u", kind: "image", setId: "set", queueRetry: { attempt: 2, waitMs: 5000 },
    }, false)).rejects.toMatchObject({ code: status === 429 ? "RATE_LIMITED" : "UPSTREAM_ERROR", delayMs: 33000 });
    expect(request).toHaveBeenCalledTimes(1); expect(wait).not.toHaveBeenCalled();
    expect(gate.mock.calls.some((args: any) => JSON.parse(args[1].body).count)).toBe(false);
  });
  it("等待上限终止套图且不降lite，下一轮队列尝试保留累计预算", async () => {
    const { env } = setup(), fallback = vi.fn();
    const request = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "30" } }));
    await expect(new VertexProvider(env, request).image("cup", settings, [], {
      id: "t", userId: "u", kind: "image", setId: "set", onFallback: fallback,
      queueRetry: { attempt: 8, waitMs: 590000 },
    }, false)).rejects.toMatchObject({ code: "RATE_LIMITED", details: { waitMs: 590000, maxWaitMs: 600000 } });
    expect(request).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled();
    expect(() => deferImage({ ...env, PROVIDER_RETRY_MAX_WAIT_MS: "5000" }, { attempt: 0, waitMs: 4000 }, 1000, "RATE_LIMITED"))
      .toThrow(DeferredImage);
    expect(() => deferImage({ ...env, PROVIDER_RETRY_MAX_WAIT_MS: "5000" }, { attempt: 0, waitMs: 5000 }, 1000, "RATE_LIMITED"))
      .toThrow(expect.objectContaining({ code: "RATE_LIMITED", details: { waitMs: 5000, maxWaitMs: 5000 } }));
  });
  it("Gate繁忙立即释放Worker，尚未发送模型请求", async () => {
    const { env, gate } = setup(); gate.mockImplementation(async () => new Response(null, { status: 429 }));
    const request = vi.fn(), wait = vi.fn();
    await expect(new VertexProvider(env, request, wait).image("cup", settings, [], {
      id: "t", userId: "u", kind: "image", setId: "set", queueRetry: { attempt: 0, waitMs: 0 },
    }, false)).rejects.toMatchObject({ code: "RATE_LIMITED", upstream: false });
    expect(request).not.toHaveBeenCalled(); expect(wait).not.toHaveBeenCalled();
  });
  it.each([
    [{ promptFeedback: { blockReason: "SAFETY" } }, "SAFETY_BLOCKED", 1],
    [{ candidates: [{ finishReason: "IMAGE_SAFETY" }] }, "SAFETY_BLOCKED", 1],
    [{ candidates: [{ finishReason: "NO_IMAGE" }] }, "NO_IMAGE", 2],
  ])("准确区分安全阻断与无图：%j", async (reply, code, sends) => {
    const { env } = setup(), request = vi.fn(async () => Response.json(reply));
    await expect(new VertexProvider(env, request).image("cup", settings, [], { id: "t", userId: "u", kind: "image" }, false))
      .rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledTimes(sends);
  });
  it.each([[500, "UPSTREAM_ERROR"], [502, "UPSTREAM_ERROR"], [504, "TIMEOUT"], [408, "TIMEOUT"]])("HTTP%s分类%s且不重复未知提交", async (status, code) => {
    const { env } = setup(), request = vi.fn(async () => new Response("{}", { status: Number(status) }));
    await expect(new VertexProvider(env, request).image("cup", settings, [], {
      id: "t", userId: "u", kind: "image", setId: "set", queueRetry: { attempt: 0, waitMs: 0 },
    }, false)).rejects.toMatchObject({ code });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("跨队列无图重试标记保留，不再多发", async () => {
    const { env } = setup(), request = vi.fn(async () => Response.json({}));
    await expect(new VertexProvider(env, request).image("cup", settings, [], {
      id: "t", userId: "u", kind: "image", setId: "set", queueRetry: { attempt: 1, waitMs: 1000, noImageRetries: 1 },
    }, false)).rejects.toMatchObject({ code: "NO_IMAGE" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("M8 退避解析与抖动", () => {
  it.each([["30", 30000], ["0.5", 500], ["0", 0], [null, undefined], ["", undefined], ["oops", undefined], ["-2", undefined]])("Retry-After %s", (value, expected) => {
    expect(parseRetryAfter(value as string | null, 0)).toBe(expected);
  });
  it("支持HTTP日期，坏RetryInfo不会覆盖有效提示", async () => {
    expect(parseRetryAfter("Mon, 26 Oct 2026 00:00:30 GMT", Date.parse("2026-10-26T00:00:00Z"))).toBe(30000);
    expect(retryInfo({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: { seconds: "2", nanos: 500000000 } }] } })).toBe(2500);
    expect(retryInfo({ error: { details: [{ "@type": "wrong", retryDelay: "90s" }] } })).toBeUndefined();
    expect(retryInfo(null)).toBeUndefined();
    expect(await imageRetryDelay(Response.json({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "5s" }] } }, { headers: { "Retry-After": "30" } }), 0)).toBe(30000);
    expect(await imageRetryDelay(new Response("bad", { headers: { "Retry-After": "1" } }), 7)).toBe(1000);
  });
  it("无提示时指数增长加抖动，最大单次60秒", async () => {
    expect(await imageRetryDelay(new Response("{}"), 0, 10000, () => 0)).toBe(5000);
    expect(await imageRetryDelay(new Response("{}"), 1, 10000, () => 1)).toBe(20000);
    expect(await imageRetryDelay(new Response("{}"), 9, 10000, () => 0.5)).toBe(45000);
  });
});

describe("M8 自适应并发", () => {
  it("连续两次429降至1，冷却30秒且成功两次后逐步回升，不超过env", () => {
    const s = imageCapacity(2);
    updateCapacity(s, 2, "rate_limited", 0); expect(s.limit).toBe(2);
    updateCapacity(s, 2, "rate_limited", 1); expect(s.limit).toBe(1);
    updateCapacity(s, 2, "success", 10); updateCapacity(s, 2, "success", 20); expect(s.limit).toBe(1);
    updateCapacity(s, 2, "success", 30001); expect(s.limit).toBe(2);
    updateCapacity(s, 2, "success", 40000); updateCapacity(s, 2, "success", 50000); expect(s.limit).toBe(2);
    updateCapacity(s, 1, "success", 60000); expect(s.limit).toBe(1);
  });
  it("429被成功或其他错误隔开时不算连续；新的429重置恢复计数", () => {
    const s = imageCapacity(2);
    updateCapacity(s, 2, "rate_limited", 0); updateCapacity(s, 2, "success", 1);
    updateCapacity(s, 2, "rate_limited", 2); expect(s.limit).toBe(2);
    updateCapacity(s, 2, "other", 3); updateCapacity(s, 2, "rate_limited", 4); expect(s.limit).toBe(2);
    updateCapacity(s, 2, "rate_limited", 5); expect(s.limit).toBe(1);
    updateCapacity(s, 2, "success", 40000); updateCapacity(s, 2, "rate_limited", 40001);
    updateCapacity(s, 2, "success", 80000); expect(s.limit).toBe(1);
    updateCapacity(s, 2, "success", 80001); expect(s.limit).toBe(2);
  });
});
