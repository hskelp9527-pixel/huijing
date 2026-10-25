import { describe, expect, it, vi } from "vitest";
import { VertexProvider } from "../src/providers/vertex";
import type { Env } from "../src/types";
const image = {
  candidates: [
    { content: { parts: [{ inlineData: { mimeType: "image/png", data: btoa("image") } }] } },
  ],
};
function env() {
  const gate = vi.fn(async () => Response.json({ ok: true }));
  return {
    value: {
      VERTEX_API_KEY: "unit-test-placeholder",
      APP_ENV: "test",
      IMAGE_MODEL_ID: "gemini-3.1-flash-image",
      IMAGE_MODEL_PRO_ID: "gemini-3-pro-image",
      AGENT_MODEL_ID: "gemini-3.8-flash",
      PROVIDER_GATE: { idFromName: () => "global", get: () => ({ fetch: gate }) },
    } as unknown as Env,
    gate,
  };
}
const settings = { count: 1, modelId: "auto", quality: "standard", aspectRatio: "auto" } as const;
describe("退避后的降级策略", () => {
  it("默认图片模型四次 429 后切 Lite，实际 modelId 和一次计额", async () => {
    const { value, gate } = env(),
      onFallback = vi.fn(async () => {}),
      wait = vi.fn(async () => {});
    const request = vi.fn(async (url: string | Request) =>
      String(url).includes("flash-lite-image")
        ? Response.json(image)
        : new Response("{}", { status: 429 }),
    );
    const result = await new VertexProvider(value, request, wait).image(
      "杯子",
      settings,
      [],
      { id: "task", userId: "u", kind: "image", onFallback },
      false,
    );
    expect(request).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(result.modelId).toBe("gemini-3.1-flash-lite-image");
    expect(onFallback).toHaveBeenCalledWith(result.modelId);
    expect(
      gate.mock.calls.filter(
        (args) =>
          JSON.parse(String((args as unknown as [string, RequestInit])[1]?.body || "{}")).count ===
          true,
      ),
    ).toHaveLength(1);
  });
  it("显式模型最终 RATE_LIMITED 可重试，不降级且不计额", async () => {
    const { value, gate } = env(),
      onFallback = vi.fn(async () => {});
    const request = vi.fn(async () => new Response("{}", { status: 429 }));
    await expect(
      new VertexProvider(value, request, async () => {}).image(
        "杯子",
        { ...settings, modelId: value.IMAGE_MODEL_ID },
        [],
        { id: "task", userId: "u", kind: "image", explicitModel: true, onFallback },
        false,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(request).toHaveBeenCalledTimes(4);
    expect(onFallback).not.toHaveBeenCalled();
    expect(
      gate.mock.calls.some(
        (args) =>
          JSON.parse(String((args as unknown as [string, RequestInit])[1]?.body || "{}")).count,
      ),
    ).toBe(false);
  });
  it("Agent 默认 3.8 降 3.1-lite，显式模型不降级", async () => {
    const { value } = env(),
      onFallback = vi.fn(async () => {});
    const request = vi.fn(async (url: string | Request) =>
      String(url).includes("3.1-flash-lite")
        ? Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "完成" }] } }] })
        : new Response("{}", { status: 429 }),
    );
    expect(
      (await new VertexProvider(value, request, async () => {}).agent([], [], "u", { onFallback }))
        .parts,
    ).toEqual([{ text: "完成" }]);
    expect(request).toHaveBeenCalledTimes(5);
    expect(onFallback).toHaveBeenCalledWith("gemini-3.1-flash-lite");
    request.mockClear();
    await expect(
      new VertexProvider(value, request, async () => {}).agent([], [], "u", {
        explicitModel: true,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("自定义降级链、链路耗尽及非 429 不降级", async () => {
    const { value } = env();
    value.IMAGE_FALLBACK_CHAIN = "gemini-3.1-flash-image,custom-lite";
    const request = vi.fn(async () => new Response("{}", { status: 429 }));
    await expect(
      new VertexProvider(value, request, async () => {}).image(
        "杯子",
        settings,
        [],
        { id: "task", userId: "u", kind: "image" },
        false,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(request).toHaveBeenCalledTimes(8);
    const bad = vi.fn(async () => new Response("{}", { status: 400 }));
    await expect(
      new VertexProvider(value, bad, async () => {}).image(
        "杯子",
        settings,
        [],
        { id: "task", userId: "u", kind: "image" },
        false,
      ),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
