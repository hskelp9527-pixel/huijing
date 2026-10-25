import {
  TEXT_BASE_FRAME_WIDTH,
  TEXT_LAYOUT,
  type TextRole,
  textStyleFor,
} from "@loomic/shared/edge";

/**
 * 套图文字排版（前端统一做，服务端只给「位置和内容」）。
 *
 * 为什么放在前端：后端写入的文字图层只有粗略位置，没有字号、字体、底条；而排版要看着真实画布调。
 * 所有数值来自 packages/shared 的 text-styles.ts（TEXT_STYLES / TEXT_LAYOUT），这里只有算法，没有常量。
 *
 * 规则：
 * - 同一个 frame 里 customData.setId + role 的文字图层是一组，按图层 ID 末尾的序号排序；
 * - 留白区（customData.textArea）里放一块浅色半透明底条（frame 内的普通矩形，locked，customData.kind=setband），
 *   文字按 标题 / 副标题 / 要点 / 说明 的层级从上到下排在底条里，左对齐；
 * - 排版结果用 customData.typeset 做指纹（frame 尺寸 + 留白位置 + 各槽文字）：指纹没变就不动，用户拖过的位置不会被重排；
 *   文字变了（服务端改卖点）才整组重排；
 * - 底条不保存到服务端（canvas-pane 的保存差异里跳过 kind=setband），但参与导出，所以导出的 PNG 与画布一致；
 * - 层级顺序：底图 < 底条 < 文字。
 *
 * TODO: 以后后端自己写好字号/底条时，只要 customData.typeset 带上同一份指纹，这里会自动跳过。
 */
export const BAND_KIND = "setband";

// biome-ignore lint/suspicious/noExplicitAny: Excalidraw 元素是宽松的 JSON，字段按需读取
export type El = Record<string, any>;

const ROLES: readonly TextRole[] = ["title", "subtitle", "bullet", "caption"];
const isRole = (v: unknown): v is TextRole => ROLES.includes(v as TextRole);

// ───────── 度量与折行 ─────────
const WIDE = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const CLOSING = /^[，。、；：！？）》」』】,.;:!?)\]]$/;
const isWide = (ch: string) => WIDE.test(ch);
/** 保守的字宽估计：汉字 1em；拉丁标题（Lilita One 偏窄）0.54em，正文 0.55em。实际渲染不会比它更宽。 */
const charW = (ch: string, fs: number, role: TextRole) =>
  isWide(ch) ? fs : fs * (role === "title" ? 0.54 : 0.55);
export function measure(text: string, fs: number, role: TextRole = "bullet"): number {
  let w = 0;
  for (const ch of text) w += charW(ch, fs, role);
  return w;
}
/** 最长的不可断片段（英文词）的宽度；汉字可逐字断，不算 */
function longestWord(text: string, fs: number, role: TextRole): number {
  let max = 0;
  for (const w of text.split(/[\s\n]+/))
    if (!isWide(w[0] ?? "")) max = Math.max(max, measure(w, fs, role));
  return max;
}
/** 折行：汉字逐字、英文按词；句末标点不单独起行；超长英文词按字符硬切 */
export function wrapText(text: string, maxW: number, fs: number, role: TextRole = "bullet"): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    let lw = 0;
    const tokens = para.match(/[A-Za-z0-9'’%$&+\-./]+|\s+|./gu) ?? [];
    for (const tok of tokens) {
      const tw = measure(tok, fs, role);
      const closing = CLOSING.test(tok);
      if (lw + tw <= maxW || !line || closing) {
        if (tw > maxW && !line) {
          for (const ch of tok) {
            const cw = charW(ch, fs, role);
            if (lw + cw > maxW && line) {
              lines.push(line);
              line = "";
              lw = 0;
            }
            line += ch;
            lw += cw;
          }
          continue;
        }
        line += tok;
        lw += tw;
      } else {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(tok) ? "" : tok;
        lw = line ? tw : 0;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// ───────── 版式计算（纯函数，frame 相对坐标） ─────────
export interface SlotInput {
  role: TextRole;
  text: string;
}
export interface SlotPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  wrapped: string;
}
export interface GroupLayout {
  card: { x: number; y: number; width: number; height: number };
  slots: Array<SlotPlacement | null>;
}
type Area = "top" | "bottom" | "left" | "right";

export function layoutGroup(
  frame: { width: number; height: number },
  area: Area,
  slots: SlotInput[],
): GroupLayout {
  const L = TEXT_LAYOUT;
  const k = frame.width / TEXT_BASE_FRAME_WIDTH;
  const side = area === "left" || area === "right";
  const margin = Math.round(frame.width * L.margin);
  const pad = Math.round(frame.width * L.padding);
  const cardW = side ? Math.round(frame.width * L.sideWidth) : frame.width - margin * 2;
  const contentW = cardW - pad * 2;
  const maxH = side ? frame.height - margin * 2 : Math.round(frame.height * L.horizontalMaxHeight);

  const build = (scale: number) => {
    const rows: Array<{ i: number; fs: number; lines: string[]; h: number; gap: number } | null> = slots.map(() => null);
    let y = pad;
    let last = -1;
    slots.forEach((s, i) => {
      if (!s.text.trim()) return;
      const style = textStyleFor(s.role, frame.width);
      let fs = Math.max(8, Math.round(style.fontSize * scale * (side && s.role === "title" ? L.sideTitleScale : 1)));
      // 单个英文词比栏宽还长时，把这一层单独缩小（最多缩到 60%），不让词被拦腰断开
      const word = longestWord(s.text, fs, s.role);
      if (word > contentW) fs = Math.max(Math.round(fs * 0.6), Math.floor((fs * contentW) / word));
      const lines = wrapText(s.text, contentW, fs, s.role);
      const h = Math.round(lines.length * fs * style.lineHeight);
      const gap = Math.round(fs * L.gapAfter[s.role]);
      rows[i] = { i, fs, lines, h, gap };
      last = i;
    });
    for (const r of rows) if (r) y += r.h + (r.i === last ? 0 : r.gap);
    return { rows, height: y + pad };
  };

  let scale = 1;
  let built = build(scale);
  while (built.height > maxH && scale > L.minScale) {
    scale = Math.max(L.minScale, scale - 0.04);
    built = build(scale);
  }

  const cardH = built.height;
  const cardX = area === "right" ? frame.width - margin - cardW : margin;
  const cardY =
    area === "top" ? margin : area === "bottom" ? frame.height - margin - cardH : Math.max(margin, Math.round((frame.height - cardH) / 2));
  let y = cardY + pad;
  const out: Array<SlotPlacement | null> = [];
  const last = built.rows.reduce((m, r) => (r ? r.i : m), -1);
  for (const r of built.rows) {
    if (!r) {
      out.push(null);
      continue;
    }
    out.push({ x: cardX + pad, y, width: contentW, height: r.h, fontSize: r.fs, wrapped: r.lines.join("\n") });
    y += r.h + (r.i === last ? 0 : r.gap);
  }
  return { card: { x: cardX, y: cardY, width: cardW, height: cardH }, slots: out };
}

// ───────── 场景处理 ─────────
const sigOf = (parts: unknown): string => {
  const s = JSON.stringify(parts);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `v1:${(h >>> 0).toString(36)}`;
};
const slotIndexOf = (el: El, fallback: number) => {
  const m = /_(\d+)$/.exec(String(el.id));
  return m ? Number(m[1]) : fallback;
};
const bump = (el: El): El => ({
  ...el,
  version: Number(el.version ?? 0) + 1,
  versionNonce: (Math.random() * 2 ** 31) | 0,
  updated: Date.now(),
});
const same = (a: El, patch: El) => Object.entries(patch).every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v));

export interface TypesetResult {
  elements: El[];
  /** 被改动或新增的元素 ID（调用方据此标记为「已同步」，不当作用户改动保存） */
  changed: string[];
}

/** 给场景里所有套图 frame 的文字图层排版；没有任何需要改的就原样返回同一个数组 */
export function typesetScene(elements: readonly El[]): TypesetResult {
  const frames = elements.filter((e) => !e.isDeleted && e.type === "frame" && e.customData?.setId);
  if (!frames.length) return { elements: elements as El[], changed: [] };
  const byId = new Map<string, El>();
  const changed = new Set<string>();

  for (const frame of frames) {
    const texts = elements
      .filter((e) => !e.isDeleted && e.type === "text" && e.frameId === frame.id && isRole(e.customData?.role))
      .sort((a, b) => slotIndexOf(a, 0) - slotIndexOf(b, 0));
    const bandId = `band_${frame.id}`;
    const old = elements.find((e) => e.id === bandId);
    const area = (texts[0]?.customData?.textArea ?? "top") as Area | "none";
    const raws = texts.map((t) => String(t.originalText ?? t.text ?? ""));
    if (!texts.length || area === "none" || raws.every((r) => !r.trim())) {
      if (old && !old.isDeleted) {
        byId.set(bandId, bump({ ...old, isDeleted: true }));
        changed.add(bandId);
      }
      continue;
    }
    const sig = sigOf([frame.width, frame.height, area, texts.map((t, i) => [t.customData?.role, raws[i]])]);
    let placed: Array<El> = texts;
    if (texts.some((t) => t.customData?.typeset !== sig)) {
      const lay = layoutGroup(
        frame as { width: number; height: number },
        area,
        texts.map((t, i) => ({ role: t.customData.role as TextRole, text: raws[i] ?? "" })),
      );
      placed = texts.map((t, i) => {
        const p = lay.slots[i];
        const role = t.customData.role as TextRole;
        const st = textStyleFor(role, frame.width);
        const patch = p
          ? {
              x: frame.x + p.x,
              y: frame.y + p.y,
              width: p.width,
              height: p.height,
              text: p.wrapped,
              originalText: raws[i],
              fontSize: p.fontSize,
              fontFamily: st.fontFamily,
              strokeColor: st.strokeColor,
              lineHeight: st.lineHeight,
              textAlign: "left",
              verticalAlign: "top",
              autoResize: false,
              opacity: 100,
            }
          : { text: "", originalText: "" };
        const next = bump({ ...t, ...patch, customData: { ...t.customData, typeset: sig } });
        byId.set(t.id, next);
        changed.add(t.id);
        return next;
      });
    }
    // 底条 = 当前文字图层包围盒 + 内边距（用户把文字拖开后，底条跟着变）
    const live = placed.filter((t) => String(t.text ?? "").trim());
    const pad = Math.round(frame.width * TEXT_LAYOUT.padding);
    const x1 = Math.min(...live.map((t) => t.x)) - pad;
    const y1 = Math.min(...live.map((t) => t.y)) - pad;
    const x2 = Math.max(...live.map((t) => t.x + t.width)) + pad;
    const y2 = Math.max(...live.map((t) => t.y + t.height)) + pad;
    const k = frame.width / TEXT_BASE_FRAME_WIDTH;
    const geo = {
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      angle: 0,
      type: "rectangle",
      strokeColor: "transparent",
      backgroundColor: TEXT_LAYOUT.band.color,
      fillStyle: "solid",
      strokeWidth: 0,
      roughness: 0,
      opacity: TEXT_LAYOUT.band.opacity,
      roundness: { type: 3, value: Math.round(TEXT_LAYOUT.band.radius * k) },
      frameId: frame.id,
      locked: true,
      isDeleted: false,
    };
    if (old && !old.isDeleted && same(old, geo)) continue;
    const band: El = old
      ? bump({ ...old, ...geo })
      : {
          id: bandId,
          groupIds: [],
          seed: 1,
          version: 1,
          versionNonce: 1,
          boundElements: null,
          updated: Date.now(),
          link: null,
          strokeStyle: "solid",
          ...geo,
          customData: { kind: BAND_KIND, setId: frame.customData.setId, shotId: frame.customData.shotId },
        };
    byId.set(bandId, band);
    changed.add(bandId);
  }
  if (!changed.size) return { elements: elements as El[], changed: [] };

  // 替换已有元素，再保证层级：同一 frame 里 底图 < 底条 < 文字
  let out = elements.map((e) => byId.get(e.id) ?? e);
  for (const frame of frames) {
    const bandId = `band_${frame.id}`;
    const band = byId.get(bandId) ?? out.find((e) => e.id === bandId);
    const firstText = out.findIndex(
      (e) => !e.isDeleted && e.type === "text" && e.frameId === frame.id && isRole(e.customData?.role),
    );
    if (!band && firstText < 0) continue;
    const without = out.filter((e) => e.id !== bandId);
    let at = without.findIndex(
      (e) => !e.isDeleted && e.type === "text" && e.frameId === frame.id && isRole(e.customData?.role),
    );
    if (at < 0) at = without.length;
    const images = without.filter((e, i) => e.type === "image" && e.frameId === frame.id && i > at);
    const rest = without.filter((e, i) => !(e.type === "image" && e.frameId === frame.id && i > at));
    // rest 里 at 之前的元素数量没变（被挪走的图片都在 at 之后），所以 at 仍是插入点
    rest.splice(at, 0, ...images, ...(band ? [band] : []));
    out = rest;
  }
  return { elements: out, changed: [...changed] };
}
