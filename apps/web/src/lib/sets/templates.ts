import { frameRects } from "./layout";
import type { SetTemplate } from "./types";

const HUES = [28, 200, 340, 150, 260, 48, 180];
/** 首页卡片的占位示例图：按模板版式画出每张 frame 的缩略色块（模板带 coverUrl 时优先用 coverUrl） */
export function templateCoverSvg(tpl: SetTemplate): string {
  const rects = frameRects(tpl.shots);
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  const W = 320;
  const H = 200;
  const k = Math.min((W - 24) / maxX, (H - 24) / maxY);
  const ox = (W - maxX * k) / 2;
  const oy = (H - maxY * k) / 2;
  const body = tpl.shots
    .map((s, i) => {
      const r = rects[i];
      if (!r) return "";
      const hue = HUES[i % HUES.length];
      const x = ox + r.x * k;
      const y = oy + r.y * k;
      const w = r.width * k;
      const h = r.height * k;
      const text = s.textArea && s.textArea !== "none";
      const bar = text
        ? `<rect x="${(x + w * 0.1).toFixed(1)}" y="${(y + (s.textArea === "bottom" ? h * 0.72 : h * 0.12)).toFixed(1)}" width="${(w * 0.5).toFixed(1)}" height="${Math.max(2, h * 0.06).toFixed(1)}" rx="1.5" fill="#1d1b18" opacity=".55"/>`
        : "";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="hsl(${hue} 70% 86%)" stroke="hsl(${hue} 45% 62%)" stroke-width="1"/><circle cx="${(x + w * 0.62).toFixed(1)}" cy="${(y + h * 0.55).toFixed(1)}" r="${(Math.min(w, h) * 0.2).toFixed(1)}" fill="hsl(${hue} 55% 62%)"/>${bar}`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
