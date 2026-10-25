import type { CanvasElement, GenerationSettings } from "@loomic/shared/edge";
import { all, id, one, requireRow } from "./core";
import { placeBatch } from "./placement";
import type { Env } from "./types";

export function estimateSize(settings: GenerationSettings, actual?: { width: number; height: number }) {
  const [a, b] = (settings.aspectRatio === "auto" ? "1:1" : settings.aspectRatio).split(":").map(Number);
  const width = actual?.width || a, height = actual?.height || b;
  const scale = 360 / Math.max(width, height);
  return { width: width * scale, height: height * scale };
}
/** Caller holds the room gate. Freeze against both canvas and other queued reservations. */
export async function freezeSlots(env: Env, projectId: string, input: {
  settings: GenerationSettings; anchor?: { x: number; y: number; width: number; height: number } | null;
  viewportCenter?: { x: number; y: number };
}, count: number, actual?: { width: number; height: number }) {
  const project = requireRow(await one(env, "SELECT canvas FROM projects WHERE id=?", projectId));
  const canvas = JSON.parse(project.canvas);
  const pending = await all(env, "SELECT id,input FROM tasks WHERE project_id=? AND state NOT IN ('committed','failed','cancelled')", projectId);
  const reserved = pending.flatMap(task => {
    const slot = JSON.parse(task.input).slot;
    return slot ? [{ id: `reserved_${task.id}`, type: "image", x: slot.x, y: slot.y, width: slot.w, height: slot.h, version: 1 }] : [];
  });
  const size = estimateSize(input.settings, actual);
  const batch: CanvasElement[] = Array.from({ length: count }, () => ({ id: id("slot"), type: "image", x: 0, y: 0, ...size, version: 1 }));
  return placeBatch(batch, [...canvas.elements, ...reserved], input.anchor || undefined, input.viewportCenter)
    .map(e => ({ x: e.x, y: e.y, w: e.width, h: e.height }));
}
