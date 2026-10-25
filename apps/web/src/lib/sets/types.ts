/**
 * 套图（模板一键出图）的类型：契约全部来自 `@loomic/shared/edge`（docs/模板生图.md），这里只做别名。
 * 不要在前端重复定义接口形状。
 */
import type {
  ProductAnalysis,
  createSetRequestSchema,
  publicSetTemplateSchema,
  setResponseSchema,
  setShotStateSchema,
  setStateSchema,
} from "@loomic/shared/edge";
import type { z } from "zod";

export {
  createSetResponseSchema,
  publicSetTemplateSchema,
  setResponseSchema,
  setShotStateSchema,
} from "@loomic/shared/edge";
export type {
  CreateSetRequest as CreateSetRequestParsed,
  SellingPoint,
  TextRole,
} from "@loomic/shared/edge";

export type SetTemplate = z.infer<typeof publicSetTemplateSchema>;
export type SetShotDef = SetTemplate["shots"][number];
export type SetAnalysis = ProductAnalysis;
export type SetState = z.infer<typeof setStateSchema>;
export type ShotState = z.infer<typeof setShotStateSchema>;
export type SetDetail = z.infer<typeof setResponseSchema>;
export type SetShotStatus = SetDetail["shots"][number];
export type CreateSetRequest = z.input<typeof createSetRequestSchema>;
export type CreateSetResponse = { setId: string; projectId: string; threadId: string };

/** 改分析：商品名 / 人群 / 卖点，哪个改了传哪个（PATCH /api/sets/:id/analysis） */
export interface PatchAnalysisBody {
  productName?: string | undefined;
  audience?: string | undefined;
  sellingPoints?: Array<{ title: string; detail: string }> | undefined;
}
/** 整套重出的范围（POST /api/sets/:id/regenerate） */
export type RegenerateScope = "failed" | "all";

/** 单张是否还在处理中（排队、已提交、出图中、入库中） */
export const shotBusy = (s: { state: string }) =>
  s.state === "queued" ||
  s.state === "submitted" ||
  s.state === "running" ||
  s.state === "ingesting";
