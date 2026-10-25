import { describe, expect, it } from "vitest";
import {
  type ComposerImage,
  buildPayload,
  checkSubmit,
  composerReducer,
  emptyComposer,
} from "./composer-model";

const img = (p: Partial<ComposerImage>): ComposerImage => ({
  id: "i1",
  kind: "upload",
  name: "a.png",
  previewUrl: "blob:x",
  status: "ready",
  purpose: "general",
  ...p,
});

describe("checkSubmit", () => {
  it("空输入不发送；上传中/失败指明是哪一项", () => {
    let s = emptyComposer();
    expect(checkSubmit(s).ok).toBe(false);
    s = composerReducer(s, { type: "text", text: "画一只猫" });
    expect(checkSubmit(s).ok).toBe(true);
    s = composerReducer(s, {
      type: "add",
      images: [img({ name: "猫.png", status: "uploading" })],
    });
    const up = checkSubmit(s);
    expect(!up.ok && up.reason).toContain("猫.png");
    s = composerReducer(s, {
      type: "patch",
      id: "i1",
      patch: { status: "failed" },
    });
    const failed = checkSubmit(s);
    expect(!failed.ok && failed.reason).toContain("上传失败");
  });
  it("纯空白不算输入", () => {
    expect(
      checkSubmit(
        composerReducer(emptyComposer(), { type: "text", text: "  \n " }),
      ).ok,
    ).toBe(false);
  });
});

describe("buildPayload", () => {
  it("所有图片都作为 references 提交（带用途和顺序），settingsExplicitKeys 只含用户改过的项", () => {
    let s = composerReducer(emptyComposer(), {
      type: "text",
      text: "改成冷色调",
    });
    s = composerReducer(s, {
      type: "add",
      images: [
        img({
          id: "u",
          purpose: "style",
          asset: {
            id: "ast1",
            url: "u",
            width: 10,
            height: 20,
            mime: "image/png",
            sha256: "0".repeat(64),
          },
          snapshot: {
            id: "snp0",
            assetId: "ast1",
            renderKey: "upload:ast1",
            width: 10,
            height: 20,
          },
        }),
        img({
          id: "c",
          kind: "canvas",
          elementId: "el1",
          purpose: "subject",
          snapshot: {
            id: "snp1",
            assetId: "ast2",
            renderKey: "k",
            width: 5,
            height: 5,
          },
        }),
      ],
    });
    s = composerReducer(s, { type: "setting", key: "count", value: 3 });
    const { request, meta } = buildPayload(s);
    expect(request.parts).toEqual([{ type: "text", text: "改成冷色调" }]);
    expect(request.references).toEqual([
      { snapshotId: "snp0", purpose: "style", order: 0 },
      { snapshotId: "snp1", purpose: "subject", order: 1 },
    ]);
    expect(request.settingsExplicitKeys).toEqual(["count"]);
    expect(request.settings?.count).toBe(3);
    expect(meta.sourceElementId).toBe("el1");
  });
  it("内容变化后作废 submissionId", () => {
    let s = composerReducer(emptyComposer(), {
      type: "phase",
      phase: "submitting",
      submissionId: "sub1",
    });
    expect(s.submissionId).toBe("sub1");
    s = composerReducer(s, { type: "text", text: "x" });
    expect(s.submissionId).toBeUndefined();
  });
});
