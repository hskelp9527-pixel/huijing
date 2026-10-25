import type { CanvasElement } from "@loomic/shared/edge";
export const intersects = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width &&
  a.x + a.width > b.x &&
  a.y < b.y + b.height &&
  a.y + a.height > b.y;
export function worldBounds(element: CanvasElement) {
  const angle =
    typeof element.angle === "number" && Number.isFinite(element.angle)
      ? element.angle
      : 0;
  const width =
    Math.abs(Math.cos(angle)) * element.width +
    Math.abs(Math.sin(angle)) * element.height;
  const height =
    Math.abs(Math.sin(angle)) * element.width +
    Math.abs(Math.cos(angle)) * element.height;
  return {
    x: element.x + (element.width - width) / 2,
    y: element.y + (element.height - height) / 2,
    width,
    height,
  };
}
export function placeBatch(
  items: CanvasElement[],
  existing: CanvasElement[],
  anchor?: { x: number; y: number; width: number; height: number },
  viewportCenter = { x: 0, y: 0 },
) {
  let x = anchor ? anchor.x + anchor.width + 48 : viewportCenter.x;
  let y = anchor?.y ?? viewportCenter.y;
  const row = items.map((item) => {
    const placed = { ...item, x, y };
    x += placed.width + 32;
    return placed;
  });
  const occupied = existing
    .filter((e) => !e.isDeleted && !items.some((i) => i.id === e.id))
    .map(worldBounds);
  for (let n = 0; n <= occupied.length; n++) {
    const collisions = occupied.filter((e) =>
      row.some((r) => intersects(r, e)),
    );
    if (!collisions.length) return row;
    y = Math.max(...collisions.map((e) => e.y + e.height)) + 32;
    for (const r of row) r.y = y;
  }
  return row;
}
