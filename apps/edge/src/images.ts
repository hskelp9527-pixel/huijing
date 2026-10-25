import decodeJPEG, { init as initJPEG } from "@jsquash/jpeg/decode.js";
import decodePNG, { init as initPNG } from "@jsquash/png/decode.js";
import encodePNG, { init as initPNGEncoder } from "@jsquash/png/encode.js";
import decodeWebP, { init as initWebP } from "@jsquash/webp/decode.js";
import { artifactSchema } from "@loomic/shared/edge";
import jpegWasm from "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
// @ts-expect-error Wrangler imports a compiled Module; package declares raw WASM exports.
import pngWasm from "@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import webpWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import { base64 } from "./bytes";
import { ApiError, assetView, hash, id, now, one, stmt } from "./core";
import type { Env, Row } from "./types";
// wasm-bindgen PNG decoder needs ImageData; Workers has no DOM.
const workerGlobal = globalThis as typeof globalThis & { ImageData?: unknown };
if (!workerGlobal.ImageData)
  workerGlobal.ImageData = class {
    constructor(
      public data: Uint8ClampedArray,
      public width: number,
      public height: number,
    ) {}
  };
let initialized: Promise<unknown> | undefined;
/** Header preflight bounds allocation; actual WASM decompression validates image content. */
function header(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    bytes[1] === 80 &&
    bytes[2] === 78 &&
    bytes[3] === 71
  )
    return {
      mime: "image/png",
      width: v.getUint32(16),
      height: v.getUint32(20),
    };
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1];
      const length = v.getUint16(offset + 2);
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return {
          mime: "image/jpeg",
          width: v.getUint16(offset + 7),
          height: v.getUint16(offset + 5),
        };
      if (length < 2) break;
      offset += length + 2;
    }
  }
  if (
    bytes.length >= 30 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X")
      return {
        mime: "image/webp",
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    if (chunk === "VP8 ")
      return {
        mime: "image/webp",
        width: v.getUint16(26, true) & 16383,
        height: v.getUint16(28, true) & 16383,
      };
    if (chunk === "VP8L") {
      const bits = v.getUint32(21, true);
      return {
        mime: "image/webp",
        width: 1 + (bits & 16383),
        height: 1 + ((bits >>> 14) & 16383),
      };
    }
  }
  throw new ApiError("INVALID_INPUT", "图片格式无效", 422);
}
export async function decodePixels(
  bytes: Uint8Array,
  claimedMime?: string,
  maxPixels = 32000000,
  maxSide = Number.MAX_SAFE_INTEGER,
) {
  if (!bytes.length || bytes.length > 20 * 1024 * 1024)
    throw new ApiError("INVALID_INPUT", "图片大小必须在 1 字节至 20MB 之间", 422);
  const meta = header(bytes);
  if (
    !meta.width ||
    !meta.height ||
    meta.width * meta.height > maxPixels ||
    meta.width > maxSide ||
    meta.height > maxSide
  )
    throw new ApiError(
      maxPixels < 32000000 ? "MEDIA_LIMIT_EXCEEDED" : "INVALID_INPUT",
      "图片超出允许的像素上限",
      422,
    );
  if (claimedMime && claimedMime !== meta.mime)
    throw new ApiError("INVALID_INPUT", "图片内容与 MIME 不一致", 422);
  initialized ||= Promise.all([initPNG(pngWasm), initJPEG(jpegWasm), initWebP(webpWasm)]);
  await initialized;
  try {
    const buffer = bytes.slice().buffer as ArrayBuffer;
    const decoded = await (meta.mime === "image/png"
      ? decodePNG(buffer)
      : meta.mime === "image/jpeg"
        ? decodeJPEG(buffer, { preserveOrientation: true })
        : decodeWebP(buffer));
    if (!decoded.width || !decoded.height || !decoded.data.length) throw new Error("empty");
    return {
      width: decoded.width,
      height: decoded.height,
      mime: meta.mime,
      data: decoded.data as Uint8ClampedArray,
    };
  } catch {
    throw new ApiError("INVALID_INPUT", "图片解码失败", 422);
  }
}
export async function decodeImage(bytes: Uint8Array, claimedMime?: string) {
  const { width, height, mime } = await decodePixels(bytes, claimedMime);
  return { width, height, mime };
}
export async function encodePixels(image: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}) {
  await initPNGEncoder(pngWasm);
  return new Uint8Array(await encodePNG(image as Parameters<typeof encodePNG>[0]));
}
export async function assetBytes(env: Env, asset: Pick<Row, "storage_key">) {
  const object = await env.BUCKET.get(asset.storage_key);
  if (!object) throw new ApiError("NOT_FOUND", "图片文件不存在", 404);
  return new Uint8Array(await object.arrayBuffer());
}
export async function saveAsset(
  env: Env,
  bytes: Uint8Array,
  userId: string,
  projectId: string | null,
  claimedMime?: string,
): Promise<
  Pick<Row, "id" | "user_id" | "storage_key" | "mime" | "width" | "height" | "sha256"> & {
    project_id: string | null;
  }
> {
  const meta = await decodeImage(bytes, claimedMime);
  const sha = await hash(bytes);
  const old = await one(
    env,
    "SELECT * FROM assets WHERE user_id=? AND sha256=? AND project_id IS ?",
    userId,
    sha,
    projectId,
  );
  if (old) return old;
  const assetId = id("asset");
  const row = {
    id: assetId,
    user_id: userId,
    project_id: projectId,
    storage_key: `images/${assetId}/${sha}`,
    ...meta,
    byte_length: bytes.length,
    sha256: sha,
    created_at: now(),
  };
  await env.BUCKET.put(row.storage_key, bytes, {
    httpMetadata: { contentType: meta.mime },
  });
  await stmt(
    env,
    "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)",
    row.id,
    userId,
    projectId,
    row.storage_key,
    meta.mime,
    bytes.length,
    sha,
    meta.width,
    meta.height,
    row.created_at,
  ).run();
  return row;
}
export async function assetInline(env: Env, asset: Pick<Row, "storage_key" | "mime">) {
  const object = await env.BUCKET.get(asset.storage_key);
  if (!object) throw new ApiError("NOT_FOUND", "图片文件不存在", 404);
  return {
    inlineData: {
      mimeType: asset.mime,
      data: base64(new Uint8Array(await object.arrayBuffer())),
    },
  };
}
export async function artifactView(env: Env, row: Row) {
  return artifactSchema.parse({
    id: row.id,
    taskId: row.task_id,
    asset: assetView((await one(env, "SELECT * FROM assets WHERE id=?", row.asset_id))!),
    snapshotId: row.snapshot_id,
    mode: JSON.parse(row.provider_parts).mode || "vertex",
    ...(JSON.parse(row.provider_parts).modelId
      ? { modelId: JSON.parse(row.provider_parts).modelId }
      : {}),
    ...(JSON.parse(row.provider_parts).provenance
      ? { provenance: JSON.parse(row.provider_parts).provenance }
      : {}),
  });
}
