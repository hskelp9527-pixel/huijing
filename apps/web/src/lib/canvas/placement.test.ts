import { describe, expect, it } from "vitest";
import { fitLongEdge, layoutRow } from "./placement";

const sq = { width: 360, height: 360 };

describe("layoutRow", () => {
  it("有源图时从源图右侧 48 起，相邻图间距 32，按各自实际宽度排", () => {
    const src = { x: 100, y: 50, width: 200, height: 300 };
    const rects = layoutRow({
      sizes: [{ width: 270, height: 360 }, sq, { width: 360, height: 202 }],
      source: src,
      obstacles: [src],
    });
    expect(rects.map((r) => r.x)).toEqual([
      348,
      348 + 270 + 32,
      348 + 270 + 32 + 360 + 32,
    ]);
    expect(rects.every((r) => r.y === 50)).toBe(true);
  });
  it("与已有对象重叠时整批下移到首个空区域", () => {
    const wall = { x: 0, y: 0, width: 2000, height: 500 };
    const rects = layoutRow({
      sizes: [sq, sq],
      viewportCenter: { x: 400, y: 100 },
      obstacles: [wall],
    });
    expect(rects.map((r) => r.y)).toEqual([532, 532]);
  });
  it("无源图时左上角在视口中心", () => {
    expect(
      layoutRow({
        sizes: [sq],
        viewportCenter: { x: 10, y: 20 },
        obstacles: [],
      })[0],
    ).toMatchObject({ x: 10, y: 20 });
  });
});

describe("尺寸用实际像素", () => {
  it("长边缩放到 360 并保持比例", () => {
    const r = fitLongEdge(2752, 1536);
    expect(r.width).toBe(360);
    expect(r.height).toBeCloseTo(200.93, 1);
  });
});
