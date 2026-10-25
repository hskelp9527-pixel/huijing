import type { AspectRatio, Quality } from "./contract";

/** 演示用的本地“生成结果”：按提示词和 slot 生成确定性的 SVG 抽象图，不请求任何外部资源。 */

export function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const RATIO: Record<Exclude<AspectRatio, "auto">, [number, number]> = {
  "4:5": [4, 5],
  "5:4": [5, 4],
  "21:9": [21, 9],
  "1:1": [1, 1],
  "3:4": [3, 4],
  "4:3": [4, 3],
  "9:16": [9, 16],
  "16:9": [16, 9],
  "3:2": [3, 2],
  "2:3": [2, 3],
};

/**
 * 模拟模型“比例非严格”：16:9 实测约 1.79:1。前端一律使用返回的实际像素。
 */
export function actualPixels(
  aspect: AspectRatio,
  quality: Quality,
  fallback?: { width: number; height: number },
) {
  const long = quality === "high" ? 2048 : 1024;
  let rw = 1;
  let rh = 1;
  if (aspect === "auto") {
    if (fallback) {
      rw = fallback.width;
      rh = fallback.height;
    }
  } else {
    [rw, rh] = RATIO[aspect];
  }
  let ratio = rw / rh;
  if (aspect === "16:9") ratio = 1.79;
  const width = ratio >= 1 ? long : Math.round(long * ratio);
  const height = ratio >= 1 ? Math.round(long / ratio) : long;
  return { width, height };
}

const CONCEPTS = ["留白构图", "高对比", "暖色调", "插画质感"];
export const conceptName = (slot: number) =>
  CONCEPTS[slot % CONCEPTS.length] ?? "留白构图";

export function makeArtSvg(args: {
  prompt: string;
  slot: number;
  width: number;
  height: number;
  model: string;
}): string {
  const { prompt, slot, width, height } = args;
  const seed = hash(`${prompt}#${slot}`);
  const hue = seed % 360;
  const hue2 = (hue + 40 + ((seed >> 8) % 90)) % 360;
  const hue3 = (hue + 200) % 360;
  const r = (n: number, mod: number) => ((seed >> n) & 0xffff) % mod;
  const w = width;
  const h = height;
  const circles = [0, 1, 2, 3]
    .map((i) => {
      const cx = ((r(i * 3, 100) + 10) / 120) * w;
      const cy = ((r(i * 5 + 1, 100) + 10) / 120) * h;
      const rad = (0.16 + r(i * 7 + 2, 30) / 100) * Math.min(w, h);
      const fill = i % 2 ? `hsl(${hue2} 80% 62%)` : `hsl(${hue3} 70% 58%)`;
      return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${rad.toFixed(0)}" fill="${fill}" opacity="0.${5 + (i % 3)}"/>`;
    })
    .join("");
  const bandY = (0.55 + r(4, 20) / 100) * h;
  const fs = Math.round(Math.min(w, h) * 0.03);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 78% 72%)"/><stop offset="1" stop-color="hsl(${hue2} 70% 46%)"/></linearGradient>
<filter id="b"><feGaussianBlur stdDeviation="${Math.round(Math.min(w, h) * 0.02)}"/></filter></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<g filter="url(#b)">${circles}</g>
<path d="M0 ${bandY.toFixed(0)} C ${(w * 0.3).toFixed(0)} ${(bandY - h * 0.12).toFixed(0)}, ${(w * 0.6).toFixed(0)} ${(bandY + h * 0.14).toFixed(0)}, ${w} ${(bandY - h * 0.04).toFixed(0)} L ${w} ${h} L 0 ${h} Z" fill="hsl(${hue3} 40% 18%)" opacity="0.55"/>
<text x="${Math.round(w * 0.04)}" y="${h - Math.round(w * 0.04)}" font-family="sans-serif" font-size="${fs}" fill="#fff" opacity="0.8">演示 · ${w}×${h}</text>
</svg>`;
  // Excalidraw 按 base64 data URL 解析图片文件，所以这里用 base64
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** 读取图片实际尺寸，并缩成 ≤maxEdge 的 JPEG data URL（fixture 里代替服务端存储） */
export async function readAndShrink(
  file: File,
  maxEdge = 1024,
): Promise<{ width: number; height: number; dataUrl: string }> {
  const bmp = await createImageBitmap(file);
  const { width, height } = bmp;
  const k = Math.min(1, maxEdge / Math.max(width, height));
  const cw = Math.max(1, Math.round(width * k));
  const ch = Math.max(1, Math.round(height * k));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(bmp, 0, 0, cw, ch);
  bmp.close();
  return { width, height, dataUrl: canvas.toDataURL("image/jpeg", 0.82) };
}

/** 把 data URL 图片缩到 ≤maxEdge（JPEG），用来内嵌进演示底图，避免每张图都带一份大图 */
export function shrinkDataUrl(url: string, maxEdge = 420): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const ctx = c.getContext("2d");
      if (!ctx) return resolve(url);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => resolve(url);
    img.src = url;
  });
}

/**
 * 套图底图（演示）：只有画面、没有文字——文字由画布上的文字图层负责。
 * 按 textArea 把商品放在留白的另一侧；main 类型是纯白底、商品占约 85%。
 */
export function makeShotSvg(args: {
  kind: string;
  textArea: string;
  width: number;
  height: number;
  product: string;
  hue: number;
  variant: number;
}): string {
  const { kind, textArea, width: w, height: h, product, variant } = args;
  const hue = (args.hue + variant * 37) % 360;
  const hue2 = (hue + 36) % 360;
  let box = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 };
  if (kind === "main") box = { x: 0.075, y: 0.075, w: 0.85, h: 0.85 };
  else if (textArea === "top") box = { x: 0.1, y: 0.38, w: 0.8, h: 0.56 };
  else if (textArea === "bottom") box = { x: 0.1, y: 0.06, w: 0.8, h: 0.56 };
  else if (textArea === "left") box = { x: 0.46, y: 0.12, w: 0.5, h: 0.76 };
  else if (textArea === "right") box = { x: 0.04, y: 0.12, w: 0.5, h: 0.76 };
  const bx = box.x * w;
  const by = box.y * h;
  const bw = box.w * w;
  const bh = box.h * h;
  const white = kind === "main";
  const bg = white
    ? `<rect width="${w}" height="${h}" fill="#ffffff"/>`
    : `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 55% 95%)"/><stop offset="1" stop-color="hsl(${hue2} 50% 86%)"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${(w * (0.78 + 0.1 * (variant % 2))).toFixed(0)}" cy="${(h * 0.22).toFixed(0)}" r="${(Math.min(w, h) * 0.22).toFixed(0)}" fill="hsl(${hue2} 60% 80%)" opacity=".55"/><circle cx="${(w * 0.16).toFixed(0)}" cy="${(h * 0.86).toFixed(0)}" r="${(Math.min(w, h) * 0.16).toFixed(0)}" fill="hsl(${hue} 55% 78%)" opacity=".5"/>`;
  const shadow = `<ellipse cx="${(bx + bw / 2).toFixed(0)}" cy="${(by + bh * 0.97).toFixed(0)}" rx="${(bw * 0.34).toFixed(0)}" ry="${(bh * 0.035).toFixed(0)}" fill="#000" opacity="${white ? 0.1 : 0.16}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg}${shadow}<image href="${product}" xlink:href="${product}" x="${bx.toFixed(0)}" y="${by.toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}
