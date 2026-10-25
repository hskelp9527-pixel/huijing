import { describe, it, expect, vi } from "vitest";
import type { ProviderContent } from "@loomic/shared/edge";
import type { Env } from "../src/types";

// WASM integration is exercised by the Workers fixtures. Here isolate request construction
// and inspect the exact decoded pixel bytes used by resizing and provider inlineData.
const imageMocks = vi.hoisted(() => ({
  decode: vi.fn(async () => ({ width: 4, height: 2, mime: "image/png", data: new Uint8ClampedArray([
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  ]) })),
  encode: vi.fn(async (image: { data: Uint8ClampedArray }) => new Uint8Array(image.data)),
}));
vi.mock("../src/images", () => ({ decodePixels: imageMocks.decode, encodePixels: imageMocks.encode }));
import { AgentModelAdapter, AGENT_ROLE_REGISTRY, prepareAgentImage, parseChildResult, qualityStatus, type AgentModelStep } from "../src/agent-model";

function env(overrides: Record<string, string> = {}) {
  return {
    PROVIDER_MODE: "fixture", AGENT_MODEL_ID: "gemini-3.8-flash", VISION_MODEL_ID: "gemini-3.1-flash-lite",
    APP_ENV: "test", VERTEX_API_KEY: "unit-test-placeholder",
    PROVIDER_GATE: { idFromName: () => "global", get: () => ({ fetch: vi.fn(async () => Response.json({ ok: true })) }) },
    ...overrides,
  } as unknown as Env;
}
const input = (overrides: Partial<AgentModelStep> = {}): AgentModelStep => ({
  runId: "child-1", parentRunId: "parent-1", role: "reference-review", objective: "参考图名称是蓝色，实际像素优先",
  userId: "user-1", referenceSnapshots: [{ id: "snapshot-1", mime: "image/png", data: new Uint8Array([1]), width: 9000, height: 9000 }],
  ...overrides,
});
const text = (value: unknown): ProviderContent => ({ role: "model", parts: [{ text: JSON.stringify(value) }] });

describe("AG02/AG03/AG04 独立角色模型适配器", () => {
  it("注册四角色且子角色工具只读，concept 不开放 OCR", () => {
    expect(Object.keys(AGENT_ROLE_REGISTRY)).toEqual(["orchestrator", "reference-review", "concept", "quality-review"]);
    expect(AGENT_ROLE_REGISTRY.concept.tools).toEqual(["read_canvas"]);
    expect(AGENT_ROLE_REGISTRY["quality-review"].tools).toEqual(["read_canvas", "media_ocr"]);
  });
  it("AG03 解码实际像素后按模型限边缩小，忽略名称与伪造尺寸", async () => {
    const prepared = await prepareAgentImage(input().referenceSnapshots[0], 2);
    expect(prepared.text).toBe("snapshotId=snapshot-1; actualPixels=2x1");
    expect(imageMocks.encode).toHaveBeenLastCalledWith({ width: 2, height: 1,
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) });
    expect(prepared.inline.inlineData).toEqual({ mimeType: "image/png", data: btoa(String.fromCharCode(255, 0, 0, 255, 0, 0, 255, 255)) });
  });
  it("AG03 reference/quality 真实 inlineData 独立请求且完整保留 parts 与历史签名", async () => {
    const requests: Record<string, any>[] = [];
    const content = { role: "model" as const, parts: [{ thought: true, text: "private", thoughtSignature: "t" },
      { functionCall: { id: "call-1", name: "read_canvas", args: {} }, thoughtSignature: "signature", future: { retain: true } }] };
    const request = vi.fn(async (_url: string | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ candidates: [{ content }] });
    });
    const adapter = new AgentModelAdapter(env({ PROVIDER_MODE: "vertex" }), request);
    const history: ProviderContent = { role: "model", parts: [{ thoughtSignature: "previous", functionCall: { id: "old", name: "read_canvas", args: {} } }] };
    expect(await adapter.step(input({ messages: [history], tools: [{ name: "read_canvas" }, { name: "generate_images" }] }))).toEqual(content);
    await adapter.step(input({ runId: "child-quality", role: "quality-review" }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[0][0])).toContain("gemini-3.1-flash-lite:generateContent");
    expect(requests[0].contents[0].parts.some((part: any) => !!part.inlineData?.data)).toBe(true);
    expect(requests[1].contents[0].parts.some((part: any) => !!part.inlineData?.data)).toBe(true);
    expect(requests[0].contents[1]).toEqual(history);
    expect(requests[0].tools[0].functionDeclarations).toEqual([{ name: "read_canvas" }]);
    expect(requests[0].contents[0].parts[0].text).toContain('"parentRunId":"parent-1"');
  });
  it("AG03 无视觉或未声明模型在发送前明确拒绝，图片缺失也不假装看图", async () => {
    const request = vi.fn();
    const adapter = new AgentModelAdapter(env({ REFERENCE_MODEL_ID: "text-only" }), request);
    expect(() => adapter.assertRoleCapabilities("reference-review")).toThrow("不支持图片输入");
    await expect(adapter.step(input())).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    await expect(new AgentModelAdapter(env(), request).step(input({ referenceSnapshots: [] }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(request).not.toHaveBeenCalled();
  });
  it("AG03 显式模型能力和独立角色覆盖生效；无图 concept 可用文本模型", async () => {
    const configured = env({ CONCEPT_MODEL_ID: "text-only", REFERENCE_MODEL_ID: "custom-vision",
      AGENT_MODEL_CAPABILITIES: JSON.stringify({ "custom-vision": { supportsImageInput: true, maxImageSide: 2 } }) });
    const adapter = new AgentModelAdapter(configured);
    expect(adapter.roleModelId("reference-review")).toBe("custom-vision");
    expect(adapter.assertRoleCapabilities("reference-review").maxImageSide).toBe(2);
    expect(parseChildResult(await adapter.step(input({ role: "concept", referenceSnapshots: [] })), [], "concept").issues).toEqual([]);
    await expect(adapter.step(input({ role: "concept" }))).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
  });
  it("fixture 模拟角色失败、只读工具及四维修订/无法判断，越权输出不被接受", async () => {
    const adapter = new AgentModelAdapter(env());
    await expect(adapter.step(input({ objective: "[fixture:child-error=reference-review]" }))).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    const result = parseChildResult(await adapter.step(input({ role: "quality-review", objective: "[fixture:quality-revise]" })), ["snapshot-1"], "quality-review");
    expect(result.issues).toHaveLength(4);
    expect(qualityStatus(result)).toBe("revise");
    const unable = parseChildResult(await adapter.step(input({ role: "quality-review", objective: "[fixture:quality-unable]" })), ["snapshot-1"], "quality-review");
    expect(qualityStatus(unable)).toBe("unable_to_judge");
    await expect(adapter.step(input({ role: "concept", objective: "[fixture:child-tool=media_ocr]", tools: [{ name: "media_ocr" }] }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    const call = await adapter.step(input({ objective: "[fixture:child-tool=media_ocr]", tools: [{ name: "media_ocr" }] }));
    expect(call.parts[0].functionCall).toMatchObject({ name: "media_ocr", args: { snapshotId: "snapshot-1" } });
    expect(() => parseChildResult(text({ recommendations: [], selectedSnapshotIds: ["outside"], issues: [] }), ["snapshot-1"])).toThrow("授权范围");
    expect(() => parseChildResult(text({ recommendations: [], selectedSnapshotIds: [], issues: [], generate_images: {} }), [])).toThrow("角色约束");
    expect(() => parseChildResult(text({ recommendations: [], selectedSnapshotIds: [], issues: [] }), [], "quality-review")).toThrow("角色约束");
  });
});
