import { describe, expect, it } from "vitest";
import {
  mediaOpRequestSchema,
  clientResultRequestSchema,
  mediaResultResponseSchema,
  taskDetailResponseSchema,
} from "./edge-contracts";
const base = {
  clientOpId: "op",
  projectId: "project",
  source: { elementId: "element", snapshotId: "snapshot" },
};
describe("M2a 机器契约", () => {
  it("媒体操作严格区分参数，拒绝负 margin 和越界视角", () => {
    expect(
      mediaOpRequestSchema.safeParse({
        ...base,
        op: "expand",
        params: { margin: { left: -1, top: 0, right: 0, bottom: 0 } },
      }).success,
    ).toBe(false);
    expect(
      mediaOpRequestSchema.safeParse({
        ...base,
        op: "edit",
        params: { prompt: "编辑", unknown: true },
      }).success,
    ).toBe(false);
    expect(
      mediaOpRequestSchema.safeParse({
        ...base,
        op: "multiview",
        params: { azimuth: 181, elevation: 0 },
      }).success,
    ).toBe(false);
    expect(
      mediaOpRequestSchema.parse({ ...base, op: "edit", params: { prompt: "编辑" } })
        .settingsExplicitKeys,
    ).toEqual([]);
  });
  it("改字保留原文与每个区域新文字，并限制聚合大小", () => {
    const region = { x: 1, y: 2, width: 3, height: 4, text: "原文", newText: "新文字" };
    expect(
      mediaOpRequestSchema.parse({ ...base, op: "replace_text", params: { regions: [region] } }).op,
    ).toBe("replace_text");
    expect(
      mediaOpRequestSchema.safeParse({
        ...base,
        op: "replace_text",
        params: { regions: Array(100).fill({ ...region, text: "x".repeat(500) }) },
      }).success,
    ).toBe(false);
  });
  it("浏览器 op 必须匹配结果类型且携带有效模型 hash", () => {
    const request = {
      clientOpId: "op",
      projectId: "project",
      sourceSnapshotId: "snapshot",
      params: {},
      op: "ocr",
      engine: { name: "ocr", version: "1", modelSha256: "a".repeat(64) },
      result: { ocrRegions: [] },
    };
    expect(clientResultRequestSchema.safeParse(request).success).toBe(true);
    expect(
      clientResultRequestSchema.safeParse({ ...request, result: { assetId: "asset" } }).success,
    ).toBe(false);
    expect(
      clientResultRequestSchema.safeParse({
        ...request,
        engine: { ...request.engine, modelSha256: "wrong" },
      }).success,
    ).toBe(false);
  });
  it("OCR Artifact 可无图；Task Artifact 继续要求图片，旧任务契约不放宽", () => {
    const artifact = {
      id: "artifact",
      taskId: null,
      asset: null,
      snapshotId: null,
      ocrRegions: [],
    };
    expect(
      mediaResultResponseSchema.safeParse({ artifact, revision: 1, elementIds: [] }).success,
    ).toBe(true);
    expect(
      taskDetailResponseSchema.safeParse({
        taskId: "task",
        state: "committed",
        artifact,
        error: null,
      }).success,
    ).toBe(false);
  });
});
