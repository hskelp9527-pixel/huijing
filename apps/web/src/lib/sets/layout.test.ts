import { TEXT_LAYOUT, publicTemplates } from "@loomic/shared/edge";
import { describe, expect, it } from "vitest";

import { frameRects } from "./layout";
import { layoutGroup, measure, typesetScene, wrapText } from "./typeset";
import { makeZip } from "./zip";

describe("套图 frame 几何", () => {
  it("frame 横排，满 4 张换行且互不重叠", () => {
    const shots = publicTemplates().find((t) => t.id === "amazon-7")?.shots ?? [];
    const r = frameRects(shots);
    expect(r).toHaveLength(7);
    expect(r[4]?.y).toBeGreaterThan(r[0]?.y ?? 0);
    for (let i = 1; i < 4; i++) expect(r[i]?.x).toBeGreaterThan((r[i - 1]?.x ?? 0) + (r[i - 1]?.width ?? 0));
  });
});

describe("文字排版", () => {
  it("折行后每行不超过宽度，中文逐字、英文按词", () => {
    for (const t of ["防水耐用的户外保温杯，雨天也不怕，一整天都是热的", "Keeps drinks hot all day long, built for rain"]) {
      for (const l of wrapText(t, 300, 28)) expect(measure(l, 28)).toBeLessThanOrEqual(300 + 28); // 句末标点允许悬挂一个字，不单独起行
    }
  });

  const frame = { width: 360, height: 360 };
  const slots = [
    { role: "title" as const, text: "防水耐用" },
    { role: "subtitle" as const, text: "IP67 防水等级，雨天户外也不怕" },
  ];
  it("四个留白位置：文字都在 frame 内，底条包住文字，标题明显大于说明", () => {
    for (const area of ["top", "bottom", "left", "right"] as const) {
      const g = layoutGroup(frame, area, slots);
      for (const s of g.slots) {
        expect(s).not.toBeNull();
        if (!s) continue;
        expect(s.x).toBeGreaterThanOrEqual(g.card.x);
        expect(s.x + s.width).toBeLessThanOrEqual(g.card.x + g.card.width);
        expect(s.y + s.height).toBeLessThanOrEqual(g.card.y + g.card.height);
      }
      expect(g.card.x).toBeGreaterThanOrEqual(0);
      expect(g.card.x + g.card.width).toBeLessThanOrEqual(frame.width);
      expect(g.card.y).toBeGreaterThanOrEqual(0);
      expect(g.card.y + g.card.height).toBeLessThanOrEqual(frame.height);
      expect((g.slots[0]?.fontSize ?? 0) / (g.slots[1]?.fontSize ?? 1)).toBeGreaterThan(1.3);
    }
  });
  it("最长文案（标题 12 字 + 说明 30 字）上下留白不超过最大高度，且说明不小于 14", () => {
    const g = layoutGroup({ width: 360, height: 480 }, "top", [
      { role: "title", text: "防水耐用轻量便携长效保温" },
      { role: "subtitle", text: "整机仅三百二十克随手放进背包出门不压肩膀的重量" },
    ]);
    expect(g.card.height).toBeLessThanOrEqual(480 * TEXT_LAYOUT.horizontalMaxHeight + 1);
    expect(g.slots[1]?.fontSize ?? 0).toBeGreaterThanOrEqual(14);
  });
  it("英文长词不被拦腰断开：栏窄时自动缩小这一层", () => {
    const g = layoutGroup(frame, "left", [{ role: "title", text: "Waterproof" }]);
    expect(g.slots[0]?.wrapped).toBe("Waterproof");
  });

  const mkFrame = () => ({ id: "f", type: "frame", x: 100, y: 50, width: 360, height: 360, customData: { setId: "s", shotId: "a" }, version: 1 });
  const mkText = (n: number, role: string, text: string) => ({
    id: `text_s_a_${n}`, type: "text", x: 112, y: 62, width: 300, height: 30, frameId: "f", text, originalText: text, version: 1,
    customData: { setId: "s", shotId: "a", role, textArea: "top" },
  });
  it("场景排版：写入字号/字体并生成底条，层级为 底图 < 底条 < 文字，二次处理不再改动", () => {
    const img = { id: "img", type: "image", frameId: "f", x: 100, y: 50, width: 360, height: 360, version: 1 };
    const els = [mkFrame(), mkText(0, "title", "防水耐用"), mkText(1, "subtitle", "IP67 防水"), img];
    const r = typesetScene(els);
    expect(r.changed).toContain("band_f");
    const ids = r.elements.map((e) => e.id);
    expect(ids.indexOf("img")).toBeLessThan(ids.indexOf("band_f"));
    expect(ids.indexOf("band_f")).toBeLessThan(ids.indexOf("text_s_a_0"));
    const title = r.elements.find((e) => e.id === "text_s_a_0");
    expect(title?.fontSize).toBeGreaterThanOrEqual(30);
    expect(title?.y).toBeGreaterThan(50);
    const again = typesetScene(r.elements);
    expect(again.changed).toEqual([]);
    // 文字被服务端改了：整组重排；没改的位置保持
    const patched = r.elements.map((e) => (e.id === "text_s_a_0" ? { ...e, text: "轻量便携", originalText: "轻量便携" } : e));
    expect(typesetScene(patched).changed).toContain("text_s_a_1");
  });
  it("没有留白区（none）的 frame 不生成底条", () => {
    const t = { ...mkText(0, "title", "x"), customData: { setId: "s", shotId: "a", role: "title", textArea: "none" } };
    expect(typesetScene([mkFrame(), t]).changed).toEqual([]);
  });
});

describe("ZIP", () => {
  it("带正确的文件头和条目数", async () => {
    const z = makeZip([{ name: "01-a.png", data: new Uint8Array([1, 2, 3]) }]);
    const b = new Uint8Array(await z.arrayBuffer());
    expect(Array.from(b.slice(0, 4))).toEqual([0x50, 0x4b, 3, 4]);
    expect(new DataView(b.buffer).getUint16(b.length - 22 + 10, true)).toBe(1);
  });
});
