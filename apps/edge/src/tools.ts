import { settingsSchema, type GenerationSettings } from "@loomic/shared/edge";
export { toolSchemas } from "@loomic/shared/edge";
export const tools = [
  {
    name: "agent_delegate",
    description: "独立只读子任务：reference-review 解析真实参考图，concept 制定复杂方案，quality-review 检查已提交结果。required 决定失败时是否询问用户。不得把子任务意见当作用户授权。",
    parameters: { type: "OBJECT", properties: {
      role: { type: "STRING", enum: ["reference-review", "concept", "quality-review"] },
      objective: { type: "STRING" }, referenceSnapshotIds: { type: "ARRAY", items: { type: "STRING" } },
      required: { type: "BOOLEAN" },
    }, required: ["role", "objective", "required"] },
  },
  {
    name: "media_ocr", description: "只读指定快照已有的浏览器 OCR 结果；OCR_UNAVAILABLE 时提示用户在前端执行 OCR，不能声称无文字。",
    parameters: { type: "OBJECT", properties: { snapshotId: { type: "STRING" }, language: { type: "STRING" } }, required: ["snapshotId"] },
  },
  {
    name: "canvas_apply",
    description: "canvas.apply：只对 read_canvas 返回的合法元素 ID 排版、对齐、分布、建标题或 frame、改层级。先读取最新 revision。锁定对象不可改，用户正在编辑的对象会跳过。新对象使用 localKey 引用，ID由服务分配。已有图片内容/assetId不可修改。",
    parameters: { type: "OBJECT", properties: {
      baseCanvasRevision: { type: "INTEGER" },
      commands: { type: "ARRAY", items: { type: "OBJECT", properties: {
        kind: { type: "STRING", enum: ["createText", "createFrame", "updateGeometry", "updateText", "align", "distribute", "reorder", "reparent", "setVisibility", "setLocked", "softDelete"] },
        target: shapeRef(), targets: { type: "ARRAY", items: shapeRef() }, frame: { ...shapeRef(), nullable: true },
        localKey: { type: "STRING" }, text: { type: "STRING" }, name: { type: "STRING" },
        x: { type: "NUMBER" }, y: { type: "NUMBER" }, width: { type: "NUMBER" }, height: { type: "NUMBER" },
        angle: { type: "NUMBER" }, fontSize: { type: "NUMBER" }, textAlign: { type: "STRING", enum: ["left", "center", "right"] },
        alignment: { type: "STRING", enum: ["left", "center", "right", "top", "middle", "bottom"] },
        axis: { type: "STRING", enum: ["horizontal", "vertical"] }, gap: { type: "NUMBER" },
        placement: { type: "STRING", enum: ["front", "back", "forward", "backward"] },
        visible: { type: "BOOLEAN" }, locked: { type: "BOOLEAN" },
      }, required: ["kind"] } },
    }, required: ["baseCanvasRevision", "commands"] },
  },
  {
    name: "read_canvas",
    description: "读取画布 revision、元素、可引用快照以及已确认设置。编辑前必须调用。",
    parameters: { type: "OBJECT", properties: {} },
  },
  {
    name: "generate_images",
    description:
      "按已确认设置生成 1–4 张图片，每张一个任务。count 必须等于 read_canvas 返回的 settings.count。",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: { type: "STRING" },
        count: { type: "INTEGER", minimum: 1, maximum: 4 },
        snapshotIds: { type: "ARRAY", items: { type: "STRING" } },
      },
      required: ["prompt", "count"],
    },
  },
  {
    name: "edit_image",
    description: "编辑指定快照，只能用 read_canvas 返回的 snapshotId。",
    parameters: {
      type: "OBJECT",
      properties: {
        prompt: { type: "STRING" },
        snapshotId: { type: "STRING" },
      },
      required: ["prompt", "snapshotId"],
    },
  },
  {
    name: "ask_user",
    description: "向用户确认不清楚的需求，暂停当前 Run。",
    parameters: {
      type: "OBJECT",
      properties: {
        question: { type: "STRING" },
        choices: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: { id: { type: "STRING" }, label: { type: "STRING" } },
            required: ["id", "label"],
          },
        },
      },
      required: ["question"],
    },
  },
];
function shapeRef() {
  return { type: "OBJECT", properties: { id: { type: "STRING" }, localKey: { type: "STRING" } } };
}
export function textSettings(prompt: string) {
  const result: Partial<GenerationSettings> = {};
  const count = prompt.match(/([1-4一二两三四])\s*(?:张|个方案|种构图|种方案|images?)/i);
  if (count)
    result.count =
      ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 } as Record<string, number>)[count[1]] ||
      Number(count[1]);
  const ratio = prompt.match(/(?:^|[^\d])(1:1|3:4|4:3|9:16|16:9|3:2|2:3|4:5|5:4|21:9)(?:[^\d]|$)/);
  if (ratio) result.aspectRatio = settingsSchema.shape.aspectRatio.parse(ratio[1]);
  if (/高质量|high quality/i.test(prompt)) result.quality = "high";
  return result;
}
