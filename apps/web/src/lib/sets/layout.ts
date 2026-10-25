import { TEXT_BASE_FRAME_WIDTH } from "@loomic/shared/edge";

import type { Rect } from "../canvas/placement";
import type { SetShotDef } from "./types";

/**
 * 套图 frame 的几何：与后端 `set-canvas.ts` 的 frameElement 同规则（宽 360、横向间距 32、每行 4 张、行高取该行最高的一张且不低于 480）。
 * 仅演示后端和首页模板示意图使用；真实套图的 frame 位置以服务端写入的画布为准。
 * 文字排版不在这里：见 typeset.ts 与 packages/shared 的 text-styles.ts。
 */
const ROW_MAX = 4;
const GAP = 32;
const MIN_ROW_H = 480;

export function frameRects(shots: Pick<SetShotDef, "aspectRatio">[]): Rect[] {
  const size = (a: string) => {
    const [w = 1, h = 1] = a.split(":").map(Number);
    return { width: TEXT_BASE_FRAME_WIDTH, height: Math.round((TEXT_BASE_FRAME_WIDTH * h) / w) };
  };
  const rects: Rect[] = [];
  let y = 0;
  for (let i = 0; i < shots.length; i += ROW_MAX) {
    const row = shots.slice(i, i + ROW_MAX).map((s) => size(s.aspectRatio));
    row.forEach((sz, n) => rects.push({ x: n * (TEXT_BASE_FRAME_WIDTH + GAP), y, ...sz }));
    y += Math.max(MIN_ROW_H, ...row.map((r) => r.height)) + GAP;
  }
  return rects;
}
