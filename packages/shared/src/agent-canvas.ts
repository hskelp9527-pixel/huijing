import { z } from "zod";

const shapeId = z.string().min(1).max(180);
const position = z.number().finite().min(-1000000).max(1000000);
const dimension = z.number().finite().min(1).max(100000);
/** Existing IDs must have been returned by read_canvas; new IDs are server allocated. */
export const agentShapeRefSchema = z.union([
  z.object({ id: shapeId }).strict(),
  z.object({ localKey: z.string().min(1).max(80) }).strict(),
]);
const geometry = {
  x: position.optional(),
  y: position.optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  angle: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2).optional(),
};
export const agentCanvasCommandSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("createText"), localKey: z.string().min(1).max(80),
    text: z.string().min(1).max(4000), x: position, y: position,
    width: dimension.optional(), height: dimension.optional(),
    fontSize: z.number().min(8).max(256).default(24),
    textAlign: z.enum(["left", "center", "right"]).default("center"),
  }).strict(),
  z.object({
    kind: z.literal("createFrame"), localKey: z.string().min(1).max(80),
    name: z.string().max(120).default("分组"),
    x: position, y: position, width: dimension, height: dimension,
  }).strict(),
  z.object({ kind: z.literal("updateGeometry"), target: agentShapeRefSchema, ...geometry }).strict(),
  z.object({ kind: z.literal("updateText"), target: agentShapeRefSchema, text: z.string().max(4000) }).strict(),
  z.object({
    kind: z.literal("align"), targets: z.array(agentShapeRefSchema).min(2).max(100),
    alignment: z.enum(["left", "center", "right", "top", "middle", "bottom"]),
  }).strict(),
  z.object({
    kind: z.literal("distribute"), targets: z.array(agentShapeRefSchema).min(2).max(100),
    axis: z.enum(["horizontal", "vertical"]), gap: z.number().finite().min(0).max(10000).optional(),
  }).strict(),
  z.object({
    kind: z.literal("reorder"), target: agentShapeRefSchema,
    placement: z.enum(["front", "back", "forward", "backward"]),
  }).strict(),
  z.object({ kind: z.literal("reparent"), target: agentShapeRefSchema, frame: agentShapeRefSchema.nullable() }).strict(),
  z.object({ kind: z.literal("setVisibility"), target: agentShapeRefSchema, visible: z.boolean() }).strict(),
  z.object({ kind: z.literal("setLocked"), target: agentShapeRefSchema, locked: z.boolean() }).strict(),
  z.object({ kind: z.literal("softDelete"), target: agentShapeRefSchema }).strict(),
]);
export const agentCanvasApplySchema = z.object({
  baseCanvasRevision: z.number().int().nonnegative(),
  expectedShapeRevisions: z.record(z.number().int().positive()).default({}),
  commands: z.array(agentCanvasCommandSchema).min(1).max(100),
}).strict();
export const agentCanvasUndoRequestSchema = z.object({
  clientOperationId: shapeId,
}).strict();
export type AgentShapeRef = z.infer<typeof agentShapeRefSchema>;
export type AgentCanvasCommand = z.infer<typeof agentCanvasCommandSchema>;
export type AgentCanvasApply = z.infer<typeof agentCanvasApplySchema>;
