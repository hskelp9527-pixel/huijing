// 套图文字图层的排版 token：服务端写入画布时套用，前端编辑/导出时沿用同一份，避免两端各定一套。
// 数值全部以 frame 宽 360 为基准，按实际 frame 宽等比缩放（textStyleFor / scaleLayout）。
// fontFamily 为 Excalidraw 0.18 编号：6 Nunito（正文）、7 Lilita One（标题）、9 Liberation Sans。
// 这些字体没有 CJK 字形：前端用 @font-face 的 unicode-range 把汉字交给系统黑体（标题取粗体），见 apps/web/src/styles/set-fonts.css。
export type TextRole = "title" | "subtitle" | "bullet" | "caption";
export type TextStyle = { fontSize: number; fontFamily: number; strokeColor: string; lineHeight: number };
export const TEXT_BASE_FRAME_WIDTH = 360;
// 层级：标题（卖点名）明显大于说明；说明在 360 宽 frame 里不小于 19，缩略（约 35% 缩放）时标题仍可辨认。
export const TEXT_STYLES: Record<TextRole, TextStyle> = {
  title: { fontSize: 38, fontFamily: 7, strokeColor: "#141414", lineHeight: 1.18 },
  subtitle: { fontSize: 22, fontFamily: 6, strokeColor: "#2b2b2b", lineHeight: 1.32 },
  bullet: { fontSize: 19, fontFamily: 6, strokeColor: "#2b2b2b", lineHeight: 1.38 },
  caption: { fontSize: 16, fontFamily: 6, strokeColor: "#555555", lineHeight: 1.3 },
};
export function textStyleFor(role: TextRole, frameWidth = TEXT_BASE_FRAME_WIDTH): TextStyle {
  const style = TEXT_STYLES[role];
  return { ...style, fontSize: Math.round(style.fontSize * frameWidth / TEXT_BASE_FRAME_WIDTH) };
}

// 留白区版式（同样以 360 宽为基准的像素值；比例类字段是占 frame 宽/高的比例）。
// 文字落在一块浅色半透明底条上，保证在任何底图（含深色）上都清楚；底条是 frame 内的普通矩形，导出时一并合成。
export const TEXT_LAYOUT = {
  /** 底条到 frame 边缘的距离（占 frame 宽） */
  margin: 0.05,
  /** 底条内边距（占 frame 宽） */
  padding: 0.05,
  /** 上/下留白：底条最高占 frame 高的比例，超出时整体缩小字号 */
  horizontalMaxHeight: 0.4,
  /** 左/右留白：底条宽占 frame 宽的比例 */
  sideWidth: 0.45,
  /** 左/右留白里标题的缩小系数（栏窄，避免一行放不下一个词） */
  sideTitleScale: 0.8,
  /** 为塞进留白区允许的最小缩放 */
  minScale: 0.72,
  /** 各层级之后的间距（乘以该层级的字号） */
  gapAfter: { title: 0.38, subtitle: 0.3, bullet: 0.22, caption: 0 } as Record<TextRole, number>,
  band: { color: "#ffffff", opacity: 88, radius: 14 },
} as const;
