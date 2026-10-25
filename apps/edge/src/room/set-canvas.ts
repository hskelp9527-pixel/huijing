import { canvasSchema, textStyleFor, type Canvas, type CanvasElement, type ProductAnalysis, type TemplateShot } from "@loomic/shared/edge";
import { hash, id, one, requireRow, stmt } from "../core";
import type { Env } from "../types";
import type { SetRecord, ShotRecord } from "../sets";
import { ensureIndexes } from "./indexes";
import { operationWrites } from "./operations";

export async function setCanvas(env: Env, projectId: string) {
  return canvasSchema.parse(JSON.parse(requireRow(await one(env, "SELECT canvas FROM projects WHERE id=?", projectId)).canvas));
}
export function frameElement(set: SetRecord, row: ShotRecord, shot: TemplateShot): CanvasElement {
  const [a, b] = shot.aspectRatio.split(":").map(Number);
  const siblings = (JSON.parse(set.template) as { shots: TemplateShot[] }).shots;
  let rowY = 0;
  for (let priorRow = 0; priorRow < Math.floor(row.ordinal / 4); priorRow++) {
    const heights = siblings.slice(priorRow * 4, priorRow * 4 + 4).map(item => {
      const [width, height] = item.aspectRatio.split(":").map(Number);
      return 360 * height / width;
    });
    rowY += Math.max(480, ...heights) + 32;
  }
  return { ...baseElement(row.frame_element_id, "frame"), x: row.ordinal % 4 * 392, y: rowY,
    width: 360, height: 360 * b / a, name: shot.name, customData: { setId: set.id, shotId: shot.id } };
}
export function baseElement(elementId: string, type: string): CanvasElement {
  return { id: elementId, type, x: 0, y: 0, width: 1, height: 1, version: 1, angle: 0, strokeColor: "#202020",
    backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100,
    groupIds: [], frameId: null, roundness: null, seed: 1, versionNonce: 1, isDeleted: false,
    boundElements: null, updated: Date.now(), link: null, locked: false };
}
export function textContent(analysis: ProductAnalysis, source: string, maxChars: number) {
  const parts = source.split(".");
  const value = parts[0] === "sellingPoints"
    ? analysis.sellingPoints[Number(parts[1])]?.[parts[2] as "title" | "detail"] || ""
    : String(analysis[parts[0] as "productName" | "category" | "audience"] || "");
  return [...value].slice(0, maxChars).join("");
}
export function textElements(set: SetRecord, row: ShotRecord, shot: TemplateShot, frame: CanvasElement, analysis: ProductAnalysis) {
  const area = shot.textArea || "top";
  if (area === "none") return [];
  const vertical = area === "left" || area === "right";
  const x = frame.x + (area === "right" ? frame.width * .72 : 12);
  const width = vertical ? frame.width * .26 - 12 : frame.width - 24;
  const contents = shot.textSlots.map(slot => {
    const text = textContent(analysis, slot.source, slot.maxChars);
    const style = textStyleFor(slot.role, frame.width);
    return { text, style, height: textHeight(text, width, style.fontSize, style.lineHeight) };
  });
  const gap = 6 * frame.width / 360;
  const totalHeight = contents.reduce((sum, item) => sum + item.height, 0) + gap * Math.max(0, contents.length - 1);
  let y = area === "bottom" ? frame.y + frame.height - 12 - totalHeight : frame.y + 12;
  return shot.textSlots.map((slot, index): CanvasElement => {
    const { text, style, height } = contents[index];
    const element: CanvasElement = {
      ...baseElement(`text_${set.id}_${shot.id}_${index}`, "text"), ...style, frameId: frame.id, x, y, width, height,
      text, originalText: text,
      textAlign: "left", verticalAlign: "top", containerId: null, autoResize: false,
      customData: { setId: set.id, shotId: shot.id, role: slot.role, source: slot.source, textArea: area },
    };
    y += height + gap;
    return element;
  });
}
export function textHeight(text: string, width: number, fontSize: number, lineHeight: number) {
  const lines = text.split("\n").reduce((total, line) => {
    const units = [...line].reduce((sum, char) => sum + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char) ? 1 : .56), 0);
    return total + Math.max(1, Math.ceil(units * fontSize / Math.max(1, width)));
  }, 0);
  return Math.ceil(lines * fontSize * lineHeight);
}
export async function canvasWrites(env: Env, projectId: string, canvas: Canvas, elements: CanvasElement[], extra: D1PreparedStatement[] = []) {
  const old = [...canvas.elements];
  canvas.elements = [...canvas.elements.map(element => elements.find(updated => updated.id === element.id) || element),
    ...elements.filter(element => !old.some(prior => prior.id === element.id))];
  ensureIndexes(canvas.elements, new Set(elements.map(element => element.id)));
  const before = canvas.revision++;
  const ops = elements.map(element => ({ kind: "upsert" as const, element }));
  return { writes: [stmt(env, "UPDATE projects SET canvas=? WHERE id=?", JSON.stringify(canvas), projectId),
    ...operationWrites(env, projectId, id("set-op"), await hash(JSON.stringify(ops)), "task", before, canvas, ops, old), ...extra],
    event: { type: "canvas.ops" as const, payload: { revision: canvas.revision, ops, source: "task" as const } } };
}
