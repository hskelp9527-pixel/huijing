import { describe, it, expect } from "vitest";
import { placeBatch, worldBounds } from "../src/placement";
import { configuredInt, quotaDay } from "../src/core";
const image = (id: string, width = 360, height = 180) => ({
  id,
  type: "image",
  x: 0,
  y: 0,
  width,
  height,
  version: 1,
});
describe("placement and natural day", () => {
  it("额度和并发配置无效时拒绝执行，不能退化为无限额度", () => {
    for (const value of ["NaN", "Infinity", "-1", "1.5"])
      expect(() => configuredInt(value)).toThrow();
    expect(() => configuredInt("0", 1)).toThrow();
    expect(configuredInt("0")).toBe(0);
  });
  it("源图右48、真实尺寸比例、间隔32、整批避让", () => {
    const source = { ...image("source", 200, 300), x: 10, y: 20 };
    const outputs = [image("a", 360, 180), image("b", 180, 360)];
    const obstacle = { ...image("obstacle", 300, 200), x: 258, y: 20 };
    const placed = placeBatch(outputs, [source, obstacle], source);
    expect(placed.map((p) => [p.x, p.y, p.width, p.height])).toEqual([
      [258, 252, 360, 180],
      [650, 252, 180, 360],
    ]);
  });
  it("旋转源图使用世界 AABB，无源图从冻结视口中心开始", () => {
    const bounds = worldBounds({
      ...image("source", 200, 100),
      angle: Math.PI / 2,
    });
    expect(bounds.x).toBeCloseTo(50);
    expect(bounds.y).toBeCloseTo(-50);
    expect(bounds.width).toBeCloseTo(100);
    expect(bounds.height).toBeCloseTo(200);
    const placed = placeBatch([image("a")], [], undefined, { x: 700, y: 400 });
    expect([placed[0].x, placed[0].y]).toEqual([700, 400]);
  });
  it("UTC 16:00Z 跨自然日", () => {
    expect(quotaDay(Date.parse("2026-10-25T23:59:59Z"))).toBe("2026-10-25");
    expect(quotaDay(Date.parse("2026-10-26T00:00:00Z"))).toBe("2026-10-26");
  });
});
