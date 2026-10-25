import type { CanvasElement } from "../api/contract";
import type { Rect } from "./placement";

/** 画布元素 customData 约定（与后端 ProjectRoom 插入的元素一致）：taskId、artifactId、snapshotId、slotIndex、naturalWidth/Height。 */
/** 前端临时元素（占位、高亮）：不参与保存与引用 */
export interface TransientMeta {
  kind: "placeholder" | "highlight";
  taskId?: string;
  batchId?: string;
}

export const customDataOf = (el: { customData?: unknown }):
  | Record<string, unknown>
  | undefined =>
  el.customData && typeof el.customData === "object"
    ? (el.customData as Record<string, unknown>)
    : undefined;

export const isTransient = (el: { customData?: unknown }) => {
  const k = customDataOf(el)?.kind;
  return k === "placeholder" || k === "highlight";
};

export function elementRect(el: Record<string, unknown>): Rect {
  return {
    x: Number(el.x ?? 0),
    y: Number(el.y ?? 0),
    width: Number(el.width ?? 0),
    height: Number(el.height ?? 0),
  };
}

/**
 * 图片外观键：像素来源 + 裁切 + 翻转 + 旋转。移动/缩放不改变它，所以只有内容真的变了才提示“引用较旧”。
 * （调色参数在 M3 的 appearance 里加入。）
 */
export function appearanceKey(el: Record<string, unknown>): string {
  const crop = el.crop ? JSON.stringify(el.crop) : "";
  const scale = Array.isArray(el.scale) ? el.scale.join(",") : "";
  return [
    el.fileId ?? "",
    crop,
    scale,
    Math.round(Number(el.angle ?? 0) * 1000),
  ].join("|");
}

let counter = 0;
const nonce = () => (Math.random() * 2 ** 31) | 0;
export const newElementId = (prefix = "el") =>
  `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}${nonce().toString(36)}`;

/** 构造一个可直接交给 Excalidraw 的图片元素 */
export function makeImageElement(args: {
  id: string;
  fileId: string;
  rect: Rect;
  frameId?: string;
  customData?: Record<string, unknown>;
}): CanvasElement {
  return {
    id: args.id,
    type: "image",
    x: args.rect.x,
    y: args.rect.y,
    width: args.rect.width,
    height: args.rect.height,
    angle: 0,
    strokeColor: "transparent",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: args.frameId ?? null,
    roundness: null,
    seed: nonce(),
    version: 1,
    versionNonce: nonce(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    status: "saved",
    fileId: args.fileId,
    scale: [1, 1],
    crop: null,
    ...(args.customData ? { customData: args.customData } : {}),
  };
}

/** 后端约定：Excalidraw fileId 就是 Asset ID */
export const fileIdForAsset = (assetId: string) => assetId;

const baseEl = (id: string, type: string, rect: Rect) => ({
  id,
  type,
  x: rect.x,
  y: rect.y,
  width: rect.width,
  height: rect.height,
  angle: 0,
  strokeColor: "transparent",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null as string | null,
  roundness: null,
  seed: nonce(),
  version: 1,
  versionNonce: nonce(),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
});

/** Excalidraw frame 元素（套图里每张图一个） */
export function makeFrameElement(args: {
  id: string;
  name: string;
  rect: Rect;
  customData?: Record<string, unknown>;
}): CanvasElement {
  return {
    ...baseEl(args.id, "frame", args.rect),
    strokeColor: "#bbbbbb",
    name: args.name,
    ...(args.customData ? { customData: args.customData } : {}),
  } as CanvasElement;
}

/**
 * 文字图层。autoResize=false + 固定宽度：`text` 是按宽度折好行的显示文本，`originalText` 是未折行的原文，
 * 用户在画布上双击编辑时 Excalidraw 会按宽度重新折行。
 */
export function makeTextElement(args: {
  id: string;
  rect: Rect;
  text: string;
  originalText: string;
  fontSize: number;
  fontFamily: number;
  color: string;
  lineHeight: number;
  frameId: string;
  customData?: Record<string, unknown>;
}): CanvasElement {
  return {
    ...baseEl(args.id, "text", args.rect),
    strokeColor: args.color,
    frameId: args.frameId,
    text: args.text,
    originalText: args.originalText,
    fontSize: args.fontSize,
    fontFamily: args.fontFamily,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: args.lineHeight,
    autoResize: false,
    ...(args.customData ? { customData: args.customData } : {}),
  } as CanvasElement;
}
