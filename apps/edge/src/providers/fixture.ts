import type { ProviderContent, GenerationSettings } from "@loomic/shared/edge";
import { z } from "zod";
import { ApiError } from "../core";
import { encodePixels } from "../images";
import { sleep } from "./vertex";
import { allowsAutomaticRevision } from "../agent-policy";
export class FixtureProvider {
  async agent(
    contents: ProviderContent[],
    _tools?: unknown[],
    _userId?: string,
    _options?: import("./vertex").FallbackOptions,
  ): Promise<ProviderContent> {
    const text = contents
      .filter((c) => c.role === "user")
      .flatMap((c) => c.parts)
      .map((p) => p.text || "")
      .join(" ");
    const responses = contents.flatMap((content) => content.parts).filter((part) => part.functionResponse)
      .map((part) => z.object({name:z.string(),response:z.record(z.unknown())}).parse(part.functionResponse));
    const read = [...responses].reverse().find((response) => response.name === "read_canvas");
    const call = (name: string, args: unknown): ProviderContent => ({
      role: "model",
      parts: [
        {
          thoughtSignature: "fixture-preserved-signature",
          functionCall: { id: `fixture-${name}`, name, args },
        },
      ],
    });
    if (!read) return call("read_canvas", {});
    if (text.includes("[fixture:layout]") && !responses.some((response) => response.name === "canvas_apply")) {
      const elements = z.array(z.object({id:z.string(),version:z.number(),x:z.number(),y:z.number()})).parse(read.response.elements);
      const targets = elements.slice(0,3).map((element) => ({id:element.id}));
      return call("canvas_apply",{baseCanvasRevision:read.response.revision,
        expectedShapeRevisions:Object.fromEntries(elements.map((element) => [element.id,element.version])),
        commands:[{kind:"align",targets,alignment:"middle"},{kind:"distribute",targets,axis:"horizontal",gap:32},
          {kind:"createText",localKey:"title",text:"三图标题",x:0,y:-64}]});
    }
    if (text.includes("[fixture:layout]")) return {role:"model",parts:[{text:"画布排版已完成。"}]};
    const media = responses.filter((response) => ["generate_images","edit_image"].includes(response.name));
    const userText = contents[0]?.parts.map((part)=>part.text||"").join(" ") || "";
    const revise = text.includes("[fixture:quality-revise]") && (allowsAutomaticRevision(userText) || text.includes("[fixture:force-revision]")) && media.length === 1;
    if (!media.length || revise) {
      const snapshots = z.array(z.object({id:z.string()})).parse(read.response.snapshots);
      const snapshot = snapshots.at(-1)?.id;
      if (/改|edit/i.test(text) && snapshot)
        return call("edit_image", { snapshotId: snapshot, prompt: text });
      return call("generate_images", {
        prompt: text,
        count: z.object({count:z.number()}).parse(read.response.settings).count,
        ...(snapshots.length ? {snapshotIds:snapshots.slice(0,4).map((item)=>item.id)} : {}),
      });
    }
    return { role: "model", parts: [{ text: text.includes('"qualityStatus":"unchecked"') ? "图片任务已完成；质量未检查。" : text.includes("[fixture:quality-revise]") ? "图片任务已完成；建议修订，原结果已保留。" : "图片任务已完成。" }] };
  }
  async image(prompt: string, size?: { width: number; height: number }, settings?: GenerationSettings) {
    const delay = Number(prompt.match(/\[fixture:delay=(\d+)\]/)?.[1] || 0);
    if (delay) await sleep(Math.min(delay, 10000));
    if (prompt.includes("[fixture:429]")) throw new ApiError("RATE_LIMITED", "演示限流", 429, true);
    if (prompt.includes("[fixture:unknown]"))
      throw new ApiError("PROVIDER_SUBMIT_UNKNOWN", "演示提交不确定", 502);
    if (prompt.includes("[fixture:error]")) throw new ApiError("PROVIDER_ERROR", "演示失败", 502);
    if (size) {
      const data = new Uint8ClampedArray(size.width * size.height * 4);
      for (let i = 0; i < data.length; i += 4) data.set([255, 0, 255, 255], i);
      return {
        bytes: await encodePixels({ ...size, data }),
        mime: "image/png",
        parts: [{ text: "fixture 媒体输出" }],
      };
    }
    const [a, b] = (settings?.aspectRatio && settings.aspectRatio !== "auto" ? settings.aspectRatio : "1:1").split(":").map(Number);
    const side = settings?.quality === "high" ? 2048 : 1024;
    const width = Math.round(side * a / Math.max(a, b)), height = Math.round(side * b / Math.max(a, b));
    const colors: [RegExp, number[]][] = [[/蓝|blue/i, [38, 112, 230]], [/红|red/i, [224, 52, 66]], [/绿|green/i, [36, 169, 102]], [/黄|yellow/i, [240, 192, 38]], [/紫|purple/i, [151, 74, 210]], [/橙|orange/i, [240, 132, 42]]];
    const seed = [...prompt].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
    const color = colors.find(([pattern]) => pattern.test(prompt))?.[1] || [60 + seed % 160, 60 + (seed >>> 8) % 160, 60 + (seed >>> 16) % 160];
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const border = x < width * .025 || y < height * .025 || x > width * .975 || y > height * .975;
      const subject = x > width * .25 && x < width * .75 && y > height * .2 && y < height * .8;
      const offset = (y * width + x) * 4;
      data[offset] = border || subject ? color[0] : 235;
      data[offset + 1] = border || subject ? color[1] : 239;
      data[offset + 2] = border || subject ? color[2] : 245;
      data[offset + 3] = 255;
    }
    return {
      bytes: await encodePixels({ width, height, data }),
      mime: "image/png",
      parts: [{ text: `fixture 演示输出 ${width}×${height}; RGB=${color.join(",")}` }],
    };
  }
}
