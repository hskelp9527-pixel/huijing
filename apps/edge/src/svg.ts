import { ApiError, hash, id, now, one, stmt } from "./core";
import type { Env } from "./types";
/** Restricted SVG subset emitted by vtracer; active content and external references are rejected. */
export function inspectSvg(bytes: Uint8Array) {
  if (bytes.length > 2 * 1024 * 1024)
    throw new ApiError("MEDIA_LIMIT_EXCEEDED", "SVG 不得超过 2MB", 422);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
      .decode(bytes)
      .trim()
      .replace(/^<\?xml[^?]*\?>\s*/, "");
  } catch {
    invalid();
  }
  const allowedTags = new Set([
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
  ]);
  const allowedAttrs = new Set([
    "xmlns",
    "version",
    "width",
    "height",
    "viewBox",
    "d",
    "fill",
    "stroke",
    "stroke-width",
    "fill-rule",
    "clip-rule",
    "opacity",
    "fill-opacity",
    "stroke-opacity",
    "transform",
    "x",
    "y",
    "x1",
    "x2",
    "y1",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "points",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
  ]);
  const stack: string[] = [];
  let root: Record<string, string> | undefined,
    end = 0;
  for (const match of text.matchAll(/<([^<>]+)>/g)) {
    if (text.slice(end, match.index).trim()) invalid();
    end = match.index! + match[0].length;
    const tag = match[1].match(/^(\/?)([A-Za-z][A-Za-z0-9]*)([\s\S]*?)(\/?)$/);
    if (!tag || !allowedTags.has(tag[2])) invalid();
    if (tag![1]) {
      if (tag![3].trim() || tag![4] || stack.pop() !== tag![2]) invalid();
      continue;
    }
    if (!stack.length && root) invalid();
    const attrs: Record<string, string> = {};
    let offset = 0;
    for (const attr of tag![3].matchAll(/([A-Za-z][A-Za-z0-9:-]*)\s*=\s*("[^"]*"|'[^']*')/g)) {
      if (
        tag![3].slice(offset, attr.index).trim() ||
        !allowedAttrs.has(attr[1]) ||
        attr[1] in attrs
      )
        invalid();
      const value = attr[2].slice(1, -1);
      if (/[<&>]/.test(value) || /url\s*\(|javascript:|data:/i.test(value)) invalid();
      attrs[attr[1]] = value;
      offset = attr.index! + attr[0].length;
    }
    if (tag![3].slice(offset).trim()) invalid();
    if (!root) {
      if (tag![2] !== "svg" || attrs.xmlns !== "http://www.w3.org/2000/svg") invalid();
      root = attrs;
    } else if (tag![2] === "svg") invalid();
    if (!tag![4]) stack.push(tag![2]);
  }
  if (!root || stack.length || text.slice(end).trim()) invalid();
  const width = Number(root!.width?.replace(/px$/, "")),
    height = Number(root!.height?.replace(/px$/, ""));
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    invalid();
  if (width > 4096 || height > 4096 || width * height > 4194304)
    throw new ApiError("MEDIA_LIMIT_EXCEEDED", "SVG 超出尺寸上限", 422);
  return { width, height, mime: "image/svg+xml" };
}
function invalid(): never {
  throw new ApiError("INVALID_INPUT", "SVG 必须是无脚本、无外部引用的静态图形", 422);
}
export async function saveSvg(
  env: Env,
  bytes: Uint8Array,
  userId: string,
  projectId: string | null,
) {
  const meta = inspectSvg(bytes),
    sha = await hash(bytes);
  const old = await one(
    env,
    "SELECT * FROM assets WHERE user_id=? AND sha256=? AND project_id IS ?",
    userId,
    sha,
    projectId,
  );
  if (old) return old;
  const asset = { id: id("asset"), ...meta, sha256: sha };
  await env.BUCKET.put(`svg/${asset.id}/${sha}`, bytes, { httpMetadata: { contentType: meta.mime } });
  await stmt(
    env,
    "INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?)",
    asset.id,
    userId,
    projectId,
    `svg/${asset.id}/${sha}`,
    meta.mime,
    bytes.length,
    sha,
    meta.width,
    meta.height,
    now(),
  ).run();
  return asset;
}
