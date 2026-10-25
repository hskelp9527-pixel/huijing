import { generateKeyBetween } from "fractional-indexing";
import type { CanvasElement } from "@loomic/shared/edge";

/** Excalidraw uses the same fractional-indexing alphabet and key format. */
export function indexAt(elements: CanvasElement[], position: number): string {
  const prior = elements.slice(0, position).reverse().find(e => typeof e.index === "string");
  const next = elements.slice(position + 1).find(e => typeof e.index === "string" && (!prior || String(e.index) > String(prior.index)));
  return generateKeyBetween(typeof prior?.index === "string" ? prior.index : null, typeof next?.index === "string" ? next.index : null);
}
export function appendIndex(elements: CanvasElement[]) {
  return indexAt([...elements, {} as CanvasElement], elements.length);
}
export function ensureIndexes(elements: CanvasElement[], written: Set<string>) {
  elements.forEach((element, position) => {
    if (written.has(element.id) && typeof element.index !== "string") element.index = indexAt(elements, position);
  });
}
