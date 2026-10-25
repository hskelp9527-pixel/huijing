/**
 * 结果放置规则（规格第 4 节），与后端 apps/edge/src/placement.ts 的 placeBatch 保持一致：
 *  - 有源图：从源图世界外框右侧 48 单位起，顶边与源图对齐
 *  - 无源图：左上角放在视口中心
 *  - 一批图片按 slot 顺序横排，长边 360、保持实际像素比例，相邻图片间距 32（按每张图实际显示宽度排，没有固定格子）
 *  - 与已有对象重叠：整批下移到首个空区域
 *
 * 真实结果的位置只由后端 ProjectRoom 决定，前端渲染 canvas.ops。这个文件只用于：
 *  1) fixture（浏览器内模拟的“服务端”）；2) 任务进行中的占位估算；3) “重新放入”产生的新元素。
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

export const LONG_EDGE = 360;
export const GAP = 32;
export const SOURCE_OFFSET = 48;

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** 按实际像素比例缩放到长边 360 */
export function fitLongEdge(
  width: number,
  height: number,
  longEdge = LONG_EDGE,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: longEdge, height: longEdge };
  const k = longEdge / Math.max(width, height);
  return { width: width * k, height: height * k };
}

/** 旋转后的世界外框 */
export function worldBounds(el: {
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
}): Rect {
  const angle = Number.isFinite(el.angle) ? (el.angle as number) : 0;
  const w =
    Math.abs(Math.cos(angle)) * el.width +
    Math.abs(Math.sin(angle)) * el.height;
  const h =
    Math.abs(Math.sin(angle)) * el.width +
    Math.abs(Math.cos(angle)) * el.height;
  return {
    x: el.x + (el.width - w) / 2,
    y: el.y + (el.height - h) / 2,
    width: w,
    height: h,
  };
}

export interface RowInput {
  /** 每个 slot 的显示尺寸（未完成的 slot 用 360×360 预留） */
  sizes: Array<{ width: number; height: number }>;
  source?: Rect | undefined;
  viewportCenter?: Point | undefined;
  obstacles: Rect[];
}

/** 排出一行并避让障碍；返回每个 slot 的矩形 */
export function layoutRow({
  sizes,
  source,
  viewportCenter,
  obstacles,
}: RowInput): Rect[] {
  let x = source
    ? source.x + source.width + SOURCE_OFFSET
    : (viewportCenter?.x ?? 0);
  let y = source ? source.y : (viewportCenter?.y ?? 0);
  const row: Rect[] = sizes.map((s) => {
    const r = { x, y, width: s.width, height: s.height };
    x += s.width + GAP;
    return r;
  });
  for (let n = 0; n <= obstacles.length; n++) {
    const hits = obstacles.filter((o) => row.some((r) => intersects(r, o)));
    if (!hits.length) break;
    y = Math.max(...hits.map((o) => o.y + o.height)) + GAP;
    for (const r of row) r.y = y;
  }
  return row;
}
