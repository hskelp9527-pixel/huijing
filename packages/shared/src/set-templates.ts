import { z } from "zod";

const identifier = z.string().min(1).max(180);
export const MAX_SET_SHOTS = 32;
export const sellingPointSchema = z.object({
  title: z.string().trim().min(1).max(72).refine(value => /[\p{Script=Han}]/u.test(value)
    ? [...value].length <= 12 : value.split(/\s+/).length <= 6, "标题最多12字或6个英文词"),
  detail: z.string().trim().min(1).max(30),
}).strict();
export const productAnalysisSchema = z.object({
  productName: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  audience: z.string().trim().min(1).max(160),
  sellingPoints: z.array(sellingPointSchema).min(3).max(5),
}).strict();
export const templateShotSchema = z.object({
  id: identifier, name: z.string().min(1),
  kind: z.enum(["main", "selling", "scene", "detail", "spec", "compare", "cover"]),
  aspectRatio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]),
  sellingPointIndex: z.number().int().nonnegative().max(4).optional(),
  prompt: z.string().min(1),
  textArea: z.enum(["top", "bottom", "left", "right", "none"]).optional(),
  textSlots: z.array(z.object({
    role: z.enum(["title", "subtitle", "bullet", "caption"]),
    source: z.string().regex(/^(productName|category|audience|sellingPoints\.[0-4]\.(title|detail))$/),
    maxChars: z.number().int().min(1).max(160),
  }).strict()),
}).strict();
export const setTemplateSchema = z.object({
  id: identifier, name: z.string(), description: z.string(), lang: z.enum(["zh", "en", "auto"]),
  coverUrl: z.string().optional(), shots: z.array(templateShotSchema).min(1).max(MAX_SET_SHOTS),
}).strict();
export const publicSetTemplateSchema = setTemplateSchema.extend({ shots: z.array(templateShotSchema.omit({ prompt: true })) });
export const createSetRequestSchema = z.object({
  sourceAssetIds: z.array(identifier).min(1).max(3).refine(ids => new Set(ids).size === ids.length, "原图不能重复"),
  templateId: identifier, note: z.string().max(4000).optional(),
  sellingPoints: z.array(sellingPointSchema).min(3).max(5).optional(), lang: z.enum(["zh", "en"]).optional(),
}).strict();
export const patchSellingPointsRequestSchema = z.object({ sellingPoints: z.array(sellingPointSchema).min(3).max(5) }).strict();
export const patchAnalysisRequestSchema = productAnalysisSchema.pick({ productName: true, audience: true, sellingPoints: true }).partial().strict()
  .refine(value => Object.keys(value).length > 0, "至少提供一个分析字段");
export const regenerateSetRequestSchema = z.object({ scope: z.enum(["failed", "all"]), clientOperationId: identifier.optional() }).strict();
export const regenerateShotRequestSchema = z.object({ clientOperationId: identifier.optional() }).strict();
export const createSetResponseSchema = z.object({ setId: identifier, projectId: identifier, threadId: identifier });
export const setStateSchema = z.enum(["analyzing", "generating", "completed", "partial", "failed"]);
export const setShotStateSchema = z.enum(["queued", "submitted", "running", "ingesting", "completed", "failed", "cancelled"]);
export const setShotSchema = z.object({
  retryAt: z.string().datetime().optional(),
  shotId: identifier, state: setShotStateSchema, taskId: identifier.optional(), frameElementId: identifier,
  imageElementId: identifier.optional(), textElementIds: z.array(identifier),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional(), details: z.unknown().optional() }).optional(),
});
export const setResponseSchema = createSetResponseSchema.extend({
  templateId: identifier, state: setStateSchema, analysis: productAnalysisSchema.optional(), shots: z.array(setShotSchema),
  // Additive metadata supports diagnosis and language-aware editing.
  lang: z.enum(["zh", "en"]).optional(), error: setShotSchema.shape.error,
});
export type SellingPoint = z.infer<typeof sellingPointSchema>;
export type ProductAnalysis = z.infer<typeof productAnalysisSchema>;
export type SetTemplate = z.infer<typeof setTemplateSchema>;
export type TemplateShot = z.infer<typeof templateShotSchema>;
export type CreateSetRequest = z.infer<typeof createSetRequestSchema>;
export type PatchAnalysisRequest = z.infer<typeof patchAnalysisRequestSchema>;

// Original prompts authored for this project. Never copied from external prompt libraries.
const identity = "Use every attached source photo as the identity reference for ONE exact physical product, not as a style reference. Preserve its original color, silhouette, construction, material appearance, seams, controls, connectors, handles, and small visible details. Use only observable features of the shown side; recompose with a new crop, camera distance, background or modest camera angle where requested. Do not guess unseen front, back, interiors or alternate components. Rotation of the entire item is allowed, redesign is not. Keep colors faithful with neutral exposure, no increased saturation or orange color shift. Keep every strap and component attached in its original position. Do not add a cap, lid, base, stand or storage case absent from the reference. If a cup is visibly open, it must stay open with the same rim and spoon color. The named PRIMARY product defines the sold item. Loose contents in a bag, cameras, lenses, books, display surfaces and background objects are contextual props, NOT included components of the bag; remove them without changing the bag's own attached dividers or pockets. Product: {product}.";
const clean = "Create ONE continuous photorealistic photograph of ONE intact product only. No collage, split screen, inset, close-up window, duplicated product, floating extra parts, disassembly, diagram, or comparison panel. Absolutely no lettering, digits, typography, logos, badges, watermark, arrows, measurement lines, or pseudo-text anywhere, including on the product. No R/L, plus/minus glyphs or printed control symbols on buttons. Keep any existing printed area blank while preserving its underlying geometry. Do not add or remove physical buttons, ports or cables; a wired item must remain wired, with the same visible cable connection. All copy will be added later as editable canvas layers.";
function shot(id: string, name: string, kind: TemplateShot["kind"], composition: string,
  textArea: NonNullable<TemplateShot["textArea"]> = "top", sellingPointIndex?: number,
  aspectRatio: TemplateShot["aspectRatio"] = "1:1"): TemplateShot {
  const point = sellingPointIndex ?? 0;
  return { id, name, kind, aspectRatio, textArea, ...(sellingPointIndex === undefined ? {} : { sellingPointIndex }),
    prompt: `${identity} ${clean} ${composition} ${textArea === "none" ? "" : `Place the product entirely in the remaining 70%, leaving the ${textArea} 30% naturally empty through camera framing. The background must continue smoothly across the entire photograph with the SAME surface, color and lighting; no blank rectangle, added panel, horizontal band, pasted gradient, seam or hard boundary at the edge of the empty area. Negative space is part of the scene, never a separate graphic block.`}`,
    textSlots: textArea === "none" ? [] : kind === "spec" ? [
      { role: "title", source: "productName", maxChars: 72 }, { role: "subtitle", source: "category", maxChars: 30 },
    ] : [
      { role: "title", source: kind === "cover" ? "productName" : `sellingPoints.${point}.title`, maxChars: 72 },
      { role: "subtitle", source: `sellingPoints.${point}.detail`, maxChars: 30 },
    ],
  };
}
const main = () => shot("main", "白底主图", "main", "Amazon primary listing photo: exactly the named primary product ALONE, entirely visible and centered. If the item is a bag, show the bag with its attached padding/dividers, but remove ALL loose cameras, lenses, books and other contents. Everything including attached straps must fit INSIDE a centered bounding box whose longest dimension is 85% of the image. Leave a completely empty white safety margin of 7.5% at both ends of that dimension. Do not crop any edge or strap. The entire background must be pure solid RGB (255,255,255), including all corners. No props, hands, people, display stands, unrelated packaging, colored cast, gradient, horizon, or cast shadow. Preserve real product texture and true color; use clean even studio light.", "none");
const sceneComposition = "Place the identical product naturally in one plausible setting: {scene}. Intended audience: {audience}. Appropriate scale, credible contact with the surface, restrained supporting environment. No unsupported demonstrations of waterproofing, durability, or medical effects.";
export const QUICK_SINGLE_SCENE_SHOT = shot("main", "场景图", "scene", sceneComposition, "top", 2);
export const SET_TEMPLATES: SetTemplate[] = z.array(setTemplateSchema).parse([
  { id: "amazon-7", name: "亚马逊 7 图套装", description: "白底主图、卖点、场景、细节与规格，一套七张", lang: "en", shots: [
    main(),
    shot("selling-1", "卖点 1", "selling", "A clear three-quarter product view in a restrained studio setting. Visually emphasize this observable property without adding features: {point}.", "top", 0),
    shot("selling-2", "卖点 2", "selling", "A second complementary view that visibly shows this supported property: {point}. Keep the product intact; do not use exploded views or diagrams.", "bottom", 1),
    shot("scene", "使用场景", "scene", sceneComposition, "top", 2),
    shot("detail", "细节特写", "detail", "A photographic close view cropped from a feature ALREADY VISIBLE in the original reference angle, showing its real texture and construction. Do not rotate to an unseen side or fabricate a hidden panel or shoulder strap. Keep enough recognizable contour to identify the exact product. No invented interiors or cutaways.", "top", 0),
    shot("spec", "尺寸规格", "spec", "An orderly studio view of the REFERENCED VISIBLE product portion, suitable for a later factual overlay. If the source cuts off a support, cable or base, preserve only the visible portion; never invent a full mechanical arm, stand, underside or plug. Show only observable shape and construction. No invented dimensions, scales, unit markings, rulers, size arrows, or numerical data.", "bottom", 1),
    shot("compare", "包装清单 / 外观展示", "compare", "A neat single-product tabletop photograph of the exact supplied intact item. If the reference contains only one assembled item, show exactly that one assembled item. Do not unclip or detach straps, buckles, lids, handles, ear pads, plugs or other attached parts to create a pretend inventory. Only include a separate component if it is already visibly separate in the source; never invent packaging, extra cables or accessories.", "bottom", 2),
  ] },
  { id: "taobao-detail", name: "淘宝 / 天猫详情卖点", description: "首屏、三张卖点、场景与参数，共六张", lang: "zh", shots: [
    shot("cover", "首屏海报", "cover", "A polished hero product photograph with soft directional light and a restrained background color that complements the exact original product. Premium but realistic, no sales badges.", "top", undefined, "3:4"),
    ...[0, 1, 2].map(i => shot(`selling-${i + 1}`, `卖点 ${i + 1}`, "selling", "Show the intact product and make this visible feature easy to inspect: {point}. Choose a natural photographic view; no technical diagram or invented performance demonstration.", i === 1 ? "bottom" : "top", i, "3:4")),
    shot("scene", "使用场景", "scene", "A calm everyday lifestyle photograph with the identical product in a plausible setting: {scene}. Audience context: {audience}. Keep surroundings sparse and realistic; do not imply unverified performance.", "top", 2, "3:4"),
    shot("spec", "参数规格", "spec", "A front or three-quarter view of the whole product against a simple neutral studio background, ready for a later factual specification overlay. No made-up dimensions, material claims, scale markings, callouts, or extra accessories.", "bottom", 1, "3:4"),
  ] },
  { id: "xhs-seeding", name: "小红书种草图", description: "一张封面与三张生活方式场景", lang: "zh", shots: [
    shot("cover", "大字封面", "cover", "An inviting lifestyle hero photograph of the identical product, with natural window light, tactile everyday surroundings, and a very spacious clean upper area for a large title.", "top", undefined, "3:4"),
    ...[0, 1, 2].map(i => shot(`scene-${i + 1}`, `生活方式 ${i + 1}`, "scene", `A candid-feeling lifestyle photo, variation ${i + 1}, in a plausible context: {scene}. Audience: {audience}. Keep the exact product as the focal point. Subtly show this supported feature: {point}. No invented functionality.`, i === 1 ? "bottom" : "top", i, "3:4")),
  ] },
  { id: "quick-single", name: "单张快出", description: "白底主图；补充场景要求时生成场景图", lang: "auto", shots: [main()] },
]);
export function publicTemplates() {
  return SET_TEMPLATES.map(template => publicSetTemplateSchema.parse({ ...template, shots: template.shots.map(({ prompt: _, ...rest }) => rest) }));
}
