import type { MediaOpRequest } from "@loomic/shared/edge";
import { base64 } from "./bytes";
import { ApiError, one, requireRow } from "./core";
import { assetBytes, decodePixels, encodePixels } from "./images";
import type { Env } from "./types";
export const MAX_MEDIA_PIXELS = 4194304;
export const MAX_MEDIA_SIDE = 4096;
export type Pixels = { width: number; height: number; data: Uint8ClampedArray };
export function mediaSize(width: number, height: number) {
  if (width > MAX_MEDIA_SIDE || height > MAX_MEDIA_SIDE || width * height > MAX_MEDIA_PIXELS)
    throw new ApiError("MEDIA_LIMIT_EXCEEDED", "服务端处理上限为 4MP（4,194,304 像素）、单边 4096；请减少扩展范围，原图不会被自动缩小", 422);
}
export async function loadMediaPixels(
  env: Env,
  assetId: string,
  projectId: string,
  userId: string,
) {
  const asset = requireRow(
    await one(
      env,
      "SELECT * FROM assets WHERE id=? AND project_id=? AND user_id=?",
      assetId,
      projectId,
      userId,
    ),
  );
  mediaSize(asset.width, asset.height);
  if (asset.byte_length > 8 * 1024 * 1024)
    throw new ApiError("MEDIA_LIMIT_EXCEEDED", "处理图片不得超过 8MB", 422);
  return decodePixels(await assetBytes(env, asset), asset.mime, MAX_MEDIA_PIXELS, MAX_MEDIA_SIDE);
}
export function expanded(
  source: Pixels,
  margins: { left: number; top: number; right: number; bottom: number },
): Pixels {
  const width = source.width + margins.left + margins.right,
    height = source.height + margins.top + margins.bottom;
  mediaSize(width, height);
  const output = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  paste(source, output, margins.left, margins.top);
  return output;
}
export function paste(source: Pixels, target: Pixels, x: number, y: number) {
  for (let row = 0; row < source.height; row++)
    target.data.set(
      source.data.subarray(row * source.width * 4, (row + 1) * source.width * 4),
      ((y + row) * target.width + x) * 4,
    );
}
export async function prepareMedia(env: Env, op: MediaOpRequest, userId: string) {
  const snapshot = requireRow(
    await one(
      env,
      "SELECT * FROM appearance_snapshots WHERE id=? AND project_id=? AND user_id=?",
      op.source.snapshotId,
      op.projectId,
      userId,
    ),
  );
  const source = await loadMediaPixels(env, snapshot.asset_id, op.projectId, userId);
  const input = op.op === "expand" ? expanded(source, op.params.margin) : source;
  const references = [
    { inlineData: { mimeType: "image/png", data: base64(await encodePixels(input)) } },
  ];
  let mask: Pixels | undefined;
  if (op.op === "erase_ai") {
    mask = await loadMediaPixels(env, op.params.maskAssetId, op.projectId, userId);
    if (mask.width !== source.width || mask.height !== source.height)
      throw new ApiError("INVALID_INPUT", "遮罩必须与快照同尺寸", 422);
    references.push({
      inlineData: { mimeType: "image/png", data: base64(await encodePixels(mask)) },
    });
  }
  return { source, input, mask, references };
}
export async function restoreMedia(
  op: MediaOpRequest,
  prepared: Awaited<ReturnType<typeof prepareMedia>>,
  bytes: Uint8Array,
  mime: string,
) {
  if (bytes.length > 8 * 1024 * 1024)
    throw new ApiError("MEDIA_LIMIT_EXCEEDED", "模型图片不得超过 8MB", 422);
  let output: Pixels = await decodePixels(bytes, mime, MAX_MEDIA_PIXELS, MAX_MEDIA_SIDE);
  mediaSize(output.width, output.height);
  if (op.op !== "expand" && op.op !== "erase_ai") return { bytes, mime };
  output = fitGenerated(output, prepared.input.width, prepared.input.height,
    op.op === "expand" ? prepared.input.data : undefined);
  if (op.op === "expand")
    paste(prepared.source, output, op.params.margin.left, op.params.margin.top);
  else {
    const mask = prepared.mask!;
    for (let i = 0; i < output.data.length; i += 4) {
      const editable =
        mask.data[i + 3] > 0 && (mask.data[i] + mask.data[i + 1] + mask.data[i + 2]) / 3 >= 128;
      if (!editable) output.data.set(prepared.source.data.subarray(i, i + 4), i);
    }
  }
  return { bytes: await encodePixels(output), mime: "image/png" };
}
/** Resample only the generated fill; preserved source pixels are pasted afterwards. */
function fitGenerated(source: Pixels, width: number, height: number, reusable?: Uint8ClampedArray): Pixels {
  if (source.width === width && source.height === height) return source;
  // The expanded input has already been sent; reuse its pixels rather than allocate another 16MiB.
  const target = { width, height, data: reusable || new Uint8ClampedArray(width * height * 4) };
  for (let y = 0; y < height; y++) {
    const sy = ((y + 0.5) * source.height) / height - 0.5;
    const y0 = Math.max(0, Math.floor(sy)),
      y1 = Math.min(source.height - 1, Math.ceil(sy)),
      fy = Math.max(0, sy - y0);
    for (let x = 0; x < width; x++) {
      const sx = ((x + 0.5) * source.width) / width - 0.5;
      const x0 = Math.max(0, Math.floor(sx)),
        x1 = Math.min(source.width - 1, Math.ceil(sx)),
        fx = Math.max(0, sx - x0);
      for (let channel = 0; channel < 4; channel++) {
        const a = source.data[(y0 * source.width + x0) * 4 + channel],
          b = source.data[(y0 * source.width + x1) * 4 + channel];
        const c = source.data[(y1 * source.width + x0) * 4 + channel],
          d = source.data[(y1 * source.width + x1) * 4 + channel];
        target.data[(y * width + x) * 4 + channel] =
          (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
      }
    }
  }
  return target;
}
export function mediaPrompt(op: MediaOpRequest) {
  switch (op.op) {
    case "edit":
      return op.params.prompt;
    case "replace_text":
      return `只替换指定区域内的文字，保留其他构图。坐标为快照像素，原点左上：${JSON.stringify(op.params.regions.map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height, originalText: r.text, newText: r.newText })))}`;
    case "multiview":
      return `生成同一主体的新视角：azimuth=${op.params.azimuth}°，elevation=${op.params.elevation}°，保留主体身份与风格。`;
    case "move_object":
      return `将 srcBox 中的对象移动到 dstBox，坐标为快照像素，原点左上，补全原位置背景：${JSON.stringify(op.params)}`;
    case "expand":
      return `补全透明边缘。保持输入画布像素尺寸不变，保留原图位置和比例。四边扩展像素：${JSON.stringify(op.params.margin)}`;
    case "erase_ai":
      return "第二张图为遮罩：不透明且 RGB 均值>=128 的区域需要消除并补全背景。保持第一张图尺寸不变。";
  }
}
