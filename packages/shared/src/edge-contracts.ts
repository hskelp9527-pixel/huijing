import { z } from "zod";
import { MAX_SET_SHOTS, productAnalysisSchema, setStateSchema, setShotSchema } from "./set-templates.js";
export * from "./set-templates.js";
export * from "./text-styles.js";
export * from "./agent-roles.js";
export * from "./agent-canvas.js";

export const MAX_PROJECT_ELEMENTS = 5000;
export const edgeIdSchema = z.string().min(1).max(180);
const date = z.string().datetime();
export const runStateSchema = z.enum([
  "queued",
  "planning",
  "running",
  "waiting_input",
  "completed",
  "failed",
  "cancelled",
]);
export const taskStateSchema = z.enum([
  "queued",
  "submitted",
  "running",
  "ingesting",
  "committed",
  "failed",
  "cancelled",
]);
export const edgeErrorCodeSchema = z.enum([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_INPUT",
  "QUOTA_EXCEEDED",
  "QUOTA_EXCEEDED_IP",
  "QUOTA_EXCEEDED_GLOBAL",
  "CANVAS_CONFLICT",
  "CANVAS_LIMIT_EXCEEDED",
  "RUN_ACTIVE",
  "IDEMPOTENCY_MISMATCH",
  "RATE_LIMITED",
  "NO_IMAGE",
  "SAFETY_BLOCKED",
  "UPSTREAM_ERROR",
  "TIMEOUT",
  "PROVIDER_SUBMIT_UNKNOWN",
  "PROVIDER_ERROR",
  "UNSUPPORTED_CAPABILITY",
  "INTERNAL_ERROR",
  "MEDIA_LIMIT_EXCEEDED",
  "OCR_UNAVAILABLE",
  "OCR_TIMEOUT",
  "AGENT_LIMIT_EXCEEDED",
  "INPUT_REQUEST_CLOSED",
]);
export const edgeErrorSchema = z.object({
  error: z.object({
    code: edgeErrorCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    details: z.unknown().optional(),
  }),
});
export const userSchema = z.object({
  id: edgeIdSchema,
  name: z.string(),
  isGuest: z.literal(true),
});
export const quotaSchema = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  globalRemaining: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  ipRemaining: z.number().int().nonnegative(),
  runsRemaining: z.number().int().nonnegative(),
  setsRemaining: z.number().int().nonnegative().optional(),
  resetAt: date,
});
export const meResponseSchema = z.object({
  user: userSchema,
  quota: quotaSchema,
});
export const settingsSchema = z
  .object({
    count: z.number().int().min(1).max(4).default(1),
    aspectRatio: z
      .enum(["auto", "1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "4:5", "5:4", "21:9"])
      .default("auto"),
    quality: z.enum(["standard", "high"]).default("standard"),
    modelId: z.string().max(100).default("auto"),
  })
  .strict();
export const settingsExplicitKeysSchema = z
  .array(z.enum(["count", "aspectRatio", "quality", "modelId"]))
  .max(4)
  .default([]);
export const promptPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(20000) }).strict(),
  z.object({ type: z.literal("image"), assetId: edgeIdSchema }).strict(),
]);
export const referenceSchema = z
  .object({
    snapshotId: edgeIdSchema,
    purpose: z.enum(["subject", "style", "composition", "general"]),
    order: z.number().int().min(0).max(3),
  })
  .strict();
export const submissionSchema = z
  .object({
    parts: z.array(promptPartSchema).min(1).max(24),
    references: z.array(referenceSchema).max(4).default([]),
    settings: settingsSchema.default({}),
    settingsExplicitKeys: settingsExplicitKeysSchema,
    viewportCenter: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.parts.some((p) => p.type === "image" || p.text.trim().length > 0) ||
      s.references.length > 0,
    "输入不能为空",
  );
// Keep the object shape reusable before the non-empty refinement.
export const startRequestSchema = z
  .object({
    submissionId: edgeIdSchema,
    parts: z.array(promptPartSchema).min(1).max(24),
    references: z.array(referenceSchema).max(4).default([]),
    settings: settingsSchema.default({}),
    settingsExplicitKeys: settingsExplicitKeysSchema,
    viewportCenter: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (s) => s.parts.some((p) => p.type === "image" || p.text.trim()) || s.references.length > 0,
  );
export const messageRequestSchema = z
  .object({
    clientMessageId: edgeIdSchema,
    parts: z.array(promptPartSchema).min(1).max(24),
    references: z.array(referenceSchema).max(4).default([]),
    settings: settingsSchema.default({}),
    settingsExplicitKeys: settingsExplicitKeysSchema,
    viewportCenter: z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (s) => s.parts.some((p) => p.type === "image" || p.text.trim()) || s.references.length > 0,
  );
export const startResponseSchema = z.object({
  projectId: edgeIdSchema,
  threadId: edgeIdSchema,
  runId: edgeIdSchema,
});
export const messageResponseSchema = z.object({
  messageId: edgeIdSchema,
  runId: edgeIdSchema,
});
export const createProjectRequestSchema = z
  .object({ title: z.string().trim().min(1).max(120).optional() })
  .strict();
export const patchProjectRequestSchema = z
  .object({ title: z.string().trim().min(1).max(120) })
  .strict();
export const createThreadRequestSchema = z.object({ projectId: edgeIdSchema }).strict();
export const canvasElementSchema = z
  .object({
    id: edgeIdSchema,
    type: z.string().min(1).max(50),
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    version: z.number().int().positive(),
    fileId: edgeIdSchema.nullable().optional(),
    isDeleted: z.boolean().optional(),
  })
  .passthrough();
export const canvasOpSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upsert"), element: canvasElementSchema }).strict(),
  z.object({ kind: z.literal("delete"), elementId: edgeIdSchema }).strict(),
]);
export const canvasOpsRequestSchema = z
  .object({
    clientOpId: edgeIdSchema,
    baseRevision: z.number().int().nonnegative(),
    ops: z.array(canvasOpSchema).min(1).max(500),
  })
  .strict();
export const canvasOpsResponseSchema = z.object({
  revision: z.number().int().nonnegative(),
});
export const canvasSchema = z.object({
  revision: z.number().int().nonnegative(),
  elements: z.array(canvasElementSchema),
  files: z.record(z.object({ assetId: edgeIdSchema })),
});
export const assetSchema = z.object({
  id: edgeIdSchema,
  url: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sha256: z.string().length(64),
  mime: z.enum(["image/png", "image/jpeg", "image/webp", "image/svg+xml"]),
});
export const uploadResponseSchema = z.object({ asset: assetSchema });
export const appearanceSchema = z
  .object({
    crop: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        w: z.number().positive().max(1),
        h: z.number().positive().max(1),
      })
      .refine((c) => c.x + c.w <= 1 && c.y + c.h <= 1)
      .optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    adjust: z.record(z.number().finite().min(-100).max(100)).optional(),
  })
  .strict();
export const snapshotRequestSchema = z
  .object({
    sourceAssetId: edgeIdSchema,
    projectId: edgeIdSchema.optional(),
    appearance: appearanceSchema.default({}),
    renderKey: z.string().min(1).max(180),
  })
  .strict();
export const snapshotSchema = z.object({
  id: edgeIdSchema,
  assetId: edgeIdSchema,
  renderKey: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const snapshotResponseSchema = z.object({ snapshot: snapshotSchema });
export const projectSchema = z.object({
  id: edgeIdSchema,
  title: z.string(),
  coverUrl: z.string().nullable(),
  updatedAt: date,
  lastThreadId: edgeIdSchema.nullable(),
  setId: edgeIdSchema.optional(),
});
export const threadSchema = z.object({
  id: edgeIdSchema,
  projectId: edgeIdSchema,
  title: z.string(),
  createdAt: date,
  isSystem: z.boolean().optional(),
});
export const createProjectResponseSchema = z.object({ project: projectSchema });
export const projectListResponseSchema = z.object({
  items: z.array(projectSchema),
});
export const projectResponseSchema = z.object({
  project: projectSchema,
  canvas: canvasSchema,
  threads: z.array(threadSchema),
  eventCursor: z.number().int().nonnegative(),
});
export const createThreadResponseSchema = z.object({ thread: threadSchema });
const pixelBoxSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export const ocrRegionSchema = pixelBoxSchema
  .extend({ text: z.string().max(10000), confidence: z.number().min(0).max(1).optional() })
  .strict();
export const artifactSchema = z.object({
  id: edgeIdSchema,
  taskId: edgeIdSchema,
  asset: assetSchema,
  snapshotId: edgeIdSchema,
  modelId: z.string().optional(),
  provenance: z
    .object({
      sourceSnapshotId: edgeIdSchema,
      op: z.string(),
      params: z.record(z.unknown()),
      engine: z
        .object({ name: z.string(), version: z.string(), modelSha256: z.string() })
        .optional(),
    })
    .optional(),
  mode: z.enum(["fixture", "vertex"]).optional(),
});
export const clientArtifactSchema = artifactSchema.extend({
  taskId: edgeIdSchema.nullable(),
  asset: assetSchema.nullable(),
  snapshotId: edgeIdSchema.nullable(),
  ocrRegions: z.array(ocrRegionSchema).optional(),
});
export type ClientArtifact = z.infer<typeof clientArtifactSchema>;
export const inputRequestSchema = z.object({
  id: edgeIdSchema,
  runId: edgeIdSchema,
  question: z.string(),
  choices: z.array(z.object({ id: edgeIdSchema, label: z.string() })).default([]),
  resumePhase: z.enum(["planning", "running"]).optional(),
});
export const answerRequestSchema = z
  .object({
    clientOperationId: edgeIdSchema,
    answer: z
      .object({
        choiceId: edgeIdSchema.optional(),
        text: z.string().min(1).max(20000).optional(),
        snapshotIds: z.array(edgeIdSchema).max(4).optional(),
      })
      .strict()
      .refine((a) => a.choiceId || a.text || a.snapshotIds?.length),
  })
  .strict();
export const cancelResponseSchema = z.object({
  runId: edgeIdSchema,
  state: runStateSchema,
});
export const answerResponseSchema = z.object({ runId: edgeIdSchema });
const mediaBase = z
  .object({
    clientOpId: edgeIdSchema,
    projectId: edgeIdSchema,
    threadId: edgeIdSchema.optional(),
    source: z.object({ elementId: edgeIdSchema, snapshotId: edgeIdSchema }).strict(),
    settings: settingsSchema.default({}),
    settingsExplicitKeys: settingsExplicitKeysSchema,
  })
  .strict();
export const mediaOpRequestSchema = z.discriminatedUnion("op", [
  mediaBase.extend({
    op: z.literal("edit"),
    params: z.object({ prompt: z.string().min(1).max(20000) }).strict(),
  }),
  mediaBase.extend({
    op: z.literal("replace_text"),
    params: z
      .object({
        regions: z
          .array(ocrRegionSchema.extend({ newText: z.string().max(10000) }))
          .min(1)
          .max(100),
      })
      .strict()
      .refine(
        (value) => JSON.stringify(value).length <= 24000,
        "改字区域文本总长不得超过 24000 字符",
      ),
  }),
  mediaBase.extend({
    op: z.literal("multiview"),
    params: z
      .object({ azimuth: z.number().min(-180).max(180), elevation: z.number().min(-90).max(90) })
      .strict(),
  }),
  mediaBase.extend({
    op: z.literal("move_object"),
    params: z.object({ srcBox: pixelBoxSchema, dstBox: pixelBoxSchema }).strict(),
  }),
  mediaBase.extend({
    op: z.literal("expand"),
    params: z
      .object({
        margin: z
          .object({
            top: z.number().int().nonnegative(),
            right: z.number().int().nonnegative(),
            bottom: z.number().int().nonnegative(),
            left: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  }),
  mediaBase.extend({
    op: z.literal("erase_ai"),
    params: z.object({ maskAssetId: edgeIdSchema }).strict(),
  }),
]);
export const clientResultRequestSchema = z
  .object({
    clientOpId: edgeIdSchema,
    projectId: edgeIdSchema,
    op: z.enum(["remove_bg", "erase", "ocr", "vectorize", "upscale"]),
    sourceSnapshotId: edgeIdSchema,
    params: z
      .record(z.unknown())
      .refine((value) => JSON.stringify(value).length <= 16000, "参数过大"),
    engine: z
      .object({
        name: z.string().min(1).max(100),
        version: z.string().min(1).max(100),
        modelSha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    result: z.union([
      z.object({ assetId: edgeIdSchema }).strict(),
      z.object({ ocrRegions: z.array(ocrRegionSchema).max(1000) }).strict(),
      z.object({ svgAssetId: edgeIdSchema }).strict(),
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const key =
      value.op === "ocr" ? "ocrRegions" : value.op === "vectorize" ? "svgAssetId" : "assetId";
    if (!(key in value.result))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "操作与结果类型不匹配" });
    if (JSON.stringify(value.result).length > 128000)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "结果元数据不得超过 128000 字符" });
  });
export type ClientResultRequest = z.infer<typeof clientResultRequestSchema>;
export const taskResponseSchema = z.object({ taskId: edgeIdSchema, runId: edgeIdSchema.optional(), threadId: edgeIdSchema.optional() });
export const mediaOpResponseSchema = taskResponseSchema.extend({ runId: edgeIdSchema, threadId: edgeIdSchema });
export const retryTaskRequestSchema = z.object({ clientOperationId: edgeIdSchema }).strict();
export const retryRunRequestSchema = retryTaskRequestSchema;
export const retryRunResponseSchema = cancelResponseSchema;
export const retryTaskResponseSchema = z.object({
  taskId: edgeIdSchema,
  runId: edgeIdSchema,
});
export const taskDetailResponseSchema = z.object({
  taskId: edgeIdSchema,
  state: taskStateSchema,
  artifact: artifactSchema.nullable(),
  error: edgeErrorSchema.shape.error.nullable(),
});
export const uploadMetadataSchema = z.object({ projectId: edgeIdSchema.optional() }).strict();
export const capabilitiesResponseSchema = z.object({
  maxProjectElements: z.number().int().positive().optional(),
  mode: z.enum(["fixture", "vertex"]),
  operations: z.array(
    z.enum(["generate", "edit", "replace_text", "multiview", "move_object", "expand", "erase_ai"]),
  ),
  clientOperations: z
    .array(z.enum(["remove_bg", "erase", "ocr", "vectorize", "upscale"]))
    .optional(),
  mediaLimits: z
    .object({ maxPixels: z.number(), maxSide: z.number(), maxBytes: z.number() })
    .optional(),
  models: z.array(z.string()),
  maxCount: z.literal(4),
});
export const slotSchema = z.object({ x: z.number().finite(), y: z.number().finite(), w: z.number().positive(), h: z.number().positive() });
export const runTimingSchema = z.object({
  phase: z.enum(["read_canvas", "model", "tool", "image", "ingest", "review"]),
  durationMs: z.number().nonnegative(),
  startedAt: date,
  label: z.string(),
  requestBytes: z.number().int().nonnegative().optional(),
});
export const eventPayloadSchemas = {
  "set.state": z.object({ setId: edgeIdSchema, state: setStateSchema, error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean().optional() }).optional() }),
  "set.analyzed": z.object({ setId: edgeIdSchema, analysis: productAnalysisSchema }),
  "set.shot": setShotSchema.extend({ setId: edgeIdSchema }),
  "thread.created": z.object({ thread: threadSchema }),
  "message.created": z.object({ messageId: edgeIdSchema, threadId: edgeIdSchema, role: z.enum(["user", "assistant", "tool"]), createdAt: date }),
  "run.timing": runTimingSchema,
  "run.state": z.object({
    state: runStateSchema,
    error: edgeErrorSchema.shape.error.optional(),
    phase: z.string().optional(),
    summary: z.string().optional(),
  }),
  "run.step": z.object({
    stepId: edgeIdSchema,
    tool: z.enum(["read_canvas", "generate_images", "edit_image", "ask_user", "agent_delegate", "canvas_apply", "media_ocr"]),
    status: z.enum(["started", "completed", "failed"]),
    summary: z.string(),
    role: z.enum(["orchestrator", "reference-review", "concept", "quality-review"]).optional(),
    parentRunId: edgeIdSchema.optional(),
    childRunId: edgeIdSchema.optional(),
    childState: z.enum(["queued", "running", "completed", "failed", "cancelled", "skipped"]).optional(),
    warning: z.boolean().optional(),
    qualityStatus: z.enum(["pass", "revise", "unchecked", "unable_to_judge"]).optional(),
  }),
  "message.delta": z.object({ messageId: edgeIdSchema, text: z.string() }),
  "message.final": z.object({
    messageId: edgeIdSchema,
    parts: z.array(promptPartSchema),
  }),
  "task.state": z.object({
    state: taskStateSchema,
    retryAt: date.optional(),
    slotIndex: z.number().int().nonnegative(),
    error: edgeErrorSchema.shape.error.optional(),
    slot: slotSchema.optional(),
  }),
  "artifact.committed": z.object({
    artifact: z.union([artifactSchema, clientArtifactSchema]),
    elementIds: z.array(edgeIdSchema),
    revision: z.number().int().nonnegative(),
  }),
  "canvas.ops": z.object({
    revision: z.number().int().nonnegative(),
    ops: z.array(canvasOpSchema),
    source: z.enum(["user", "agent", "task"]),
    elementOrder: z.array(edgeIdSchema).optional(),
  }),
  "input.requested": inputRequestSchema,
  "quota.updated": quotaSchema,
} as const;
const envelope = z.object({
  seq: z.number().int().positive(),
  type: z.string(),
  projectId: edgeIdSchema,
  runId: edgeIdSchema.optional(),
  taskId: edgeIdSchema.optional(),
  at: date,
});
export const edgeEventSchema = z.discriminatedUnion("type", [
  envelope.extend({ type: z.literal("set.state"), payload: eventPayloadSchemas["set.state"] }),
  envelope.extend({ type: z.literal("set.analyzed"), payload: eventPayloadSchemas["set.analyzed"] }),
  envelope.extend({ type: z.literal("set.shot"), payload: eventPayloadSchemas["set.shot"] }),
  envelope.extend({ type: z.literal("thread.created"), payload: eventPayloadSchemas["thread.created"] }),
  envelope.extend({ type: z.literal("message.created"), payload: eventPayloadSchemas["message.created"] }),
  envelope.extend({ type: z.literal("run.timing"), payload: eventPayloadSchemas["run.timing"] }),
  envelope.extend({
    type: z.literal("run.state"),
    payload: eventPayloadSchemas["run.state"],
  }),
  envelope.extend({
    type: z.literal("run.step"),
    payload: eventPayloadSchemas["run.step"],
  }),
  envelope.extend({
    type: z.literal("message.delta"),
    payload: eventPayloadSchemas["message.delta"],
  }),
  envelope.extend({
    type: z.literal("message.final"),
    payload: eventPayloadSchemas["message.final"],
  }),
  envelope.extend({
    type: z.literal("task.state"),
    payload: eventPayloadSchemas["task.state"],
  }),
  envelope.extend({
    type: z.literal("artifact.committed"),
    payload: eventPayloadSchemas["artifact.committed"],
  }),
  envelope.extend({
    type: z.literal("canvas.ops"),
    payload: eventPayloadSchemas["canvas.ops"],
  }),
  envelope.extend({
    type: z.literal("input.requested"),
    payload: eventPayloadSchemas["input.requested"],
  }),
  envelope.extend({
    type: z.literal("quota.updated"),
    payload: eventPayloadSchemas["quota.updated"],
  }),
]);
// Provider parts deliberately remain opaque: signatures, call IDs and future fields must survive round trips.
export const providerPartSchema = z.record(z.unknown());
export const providerContentSchema = z
  .object({
    role: z.enum(["user", "model"]),
    parts: z.array(providerPartSchema),
  })
  .passthrough();
export const storedMessageSchema = z.object({
  id: edgeIdSchema,
  runId: edgeIdSchema.nullable(),
  role: z.enum(["user", "assistant", "tool"]),
  parts: z.array(providerPartSchema),
  createdAt: date,
  references: z.array(referenceSchema.extend({ thumbnailUrl: z.string().nullable() })).optional(),
  settings: settingsSchema.optional(),
  effectiveSettings: settingsSchema.optional(),
  settingsExplicitKeys: settingsExplicitKeysSchema.optional(),
});
export const messagesResponseSchema = z.object({
  items: z.array(storedMessageSchema),
  runs: z.array(z.object({ id: edgeIdSchema, state: runStateSchema, executionMode: z.enum(["direct", "tools"]).optional(),
    error: edgeErrorSchema.shape.error.nullable().optional(),
    steps: z.array(eventPayloadSchemas["run.step"].extend({ seq: z.number().int(), at: date })).optional(),
    timings: z.array(runTimingSchema.extend({ seq: z.number().int(), at: date, taskId: edgeIdSchema.optional() })).optional(),
  })),
  tasks: z.array(
    z.object({
      id: edgeIdSchema,
      runId: edgeIdSchema,
      state: taskStateSchema,
      slotIndex: z.number().int().nonnegative(),
      slot: slotSchema.optional(),
      artifact: artifactSchema.nullable(),
      error: edgeErrorSchema.shape.error.nullable(),
    }),
  ),
  inputRequests: z.array(inputRequestSchema),
  before: edgeIdSchema.nullable(),
});
export type RunState = z.infer<typeof runStateSchema>;
export type TaskState = z.infer<typeof taskStateSchema>;
export type EdgeErrorCode = z.infer<typeof edgeErrorCodeSchema>;
export type EdgeEvent = z.infer<typeof edgeEventSchema>;
export type Submission = z.infer<typeof submissionSchema>;
export type GenerationSettings = z.infer<typeof settingsSchema>;
export type CanvasElement = z.infer<typeof canvasElementSchema>;
export type CanvasOp = z.infer<typeof canvasOpSchema>;
export type Canvas = z.infer<typeof canvasSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type ProviderContent = z.infer<typeof providerContentSchema>;
export type StartRequest = z.infer<typeof startRequestSchema>;
export type StartResponse = z.infer<typeof startResponseSchema>;
export type MessageRequest = z.infer<typeof messageRequestSchema>;
export type InputRequest = z.infer<typeof inputRequestSchema>;
export type MeResponse = z.infer<typeof meResponseSchema>;
export type Quota = z.infer<typeof quotaSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Thread = z.infer<typeof threadSchema>;
export type MessageResponse = z.infer<typeof messageResponseSchema>;
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;
export type ProjectResponse = z.infer<typeof projectResponseSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type CanvasOpsRequest = z.infer<typeof canvasOpsRequestSchema>;
export type CanvasOpsResponse = z.infer<typeof canvasOpsResponseSchema>;
export type SnapshotRequest = z.infer<typeof snapshotRequestSchema>;
export type SnapshotResponse = z.infer<typeof snapshotResponseSchema>;
export type UploadResponse = z.infer<typeof uploadResponseSchema>;
export type AnswerRequest = z.infer<typeof answerRequestSchema>;
export type AnswerResponse = z.infer<typeof answerResponseSchema>;
export type RetryTaskRequest = z.infer<typeof retryTaskRequestSchema>;
export type RetryTaskResponse = z.infer<typeof retryTaskResponseSchema>;
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;
export type MediaOpRequest = z.infer<typeof mediaOpRequestSchema>;
export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;

export const toolSchemas = {
  read_canvas: z.object({}).strict(),
  generate_images: z
    .object({
      prompt: z.string().min(1).max(20000),
      count: z.number().int().min(1).max(4),
      snapshotIds: z.array(edgeIdSchema).max(4).optional(),
    })
    .strict(),
  edit_image: z.object({ prompt: z.string().min(1).max(20000), snapshotId: edgeIdSchema }).strict(),
  ask_user: z
    .object({
      question: z.string().min(1).max(2000),
      choices: z
        .array(z.object({ id: edgeIdSchema, label: z.string() }))
        .max(8)
        .optional(),
    })
    .strict(),
};
export const functionCallSchema = z
  .object({ name: z.string(), id: z.string().optional(), args: z.unknown() })
  .passthrough();
export const pendingCallSchema = z.object({
  key: z.string(),
  functionCall: functionCallSchema,
  taskIds: z.array(edgeIdSchema).optional(),
  childRunIds: z.array(edgeIdSchema).optional(),
  response: z.record(z.unknown()).optional(),
});
export const pendingCallsSchema = z.array(pendingCallSchema);
export type PendingCall = z.infer<typeof pendingCallSchema>;
export const roomRequestSchemas = {
  wake: z.object({ projectId: edgeIdSchema }),
  quota: z.object({ projectId: edgeIdSchema, runId: edgeIdSchema.optional(), quota: quotaSchema }),
  snapshot: z.object({ projectId: edgeIdSchema }),
  canvas: z.object({ projectId: edgeIdSchema, body: canvasOpsRequestSchema }),
  cancel: z.object({ projectId: edgeIdSchema, runId: edgeIdSchema }),
  answer: z.object({ projectId: edgeIdSchema, requestId: edgeIdSchema, body: answerRequestSchema }),
  claim: z.object({ projectId: edgeIdSchema, taskId: edgeIdSchema }),
  "defer-task": z.object({ projectId: edgeIdSchema, taskId: edgeIdSchema,
    delayMs: z.number().int().min(1000), upstream: z.boolean() }),
  submit: z.object({
    projectId: edgeIdSchema,
    taskId: edgeIdSchema,
    attempt: z.number().int().nonnegative(),
  }),
  "task-state": z.object({
    projectId: edgeIdSchema,
    taskId: edgeIdSchema,
    state: taskStateSchema,
    error: edgeErrorSchema.shape.error.optional(),
  }),
  commit: z.object({ projectId: edgeIdSchema, taskId: edgeIdSchema }),
  step: z.object({
    projectId: edgeIdSchema,
    runId: edgeIdSchema,
    taskId: edgeIdSchema.optional(),
    tool: eventPayloadSchemas["run.step"].shape.tool,
    summary: z.string(),
  }),
  "client-result": z.object({
    projectId: edgeIdSchema,
    userId: edgeIdSchema,
    body: clientResultRequestSchema,
  }),
  "media-op": z.object({
    projectId: edgeIdSchema,
    userId: edgeIdSchema,
    body: mediaOpRequestSchema,
    quotaIp: z.string().default("local"),
  }),
};
export const providerReplySchema = z.object({
  candidates: z
    .array(
      z.object({
        content: providerContentSchema.extend({ role: z.enum(["user", "model"]).default("model") }).default({ role: "model", parts: [] }),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
});
export const inlineImagePartSchema = z.object({
  thought: z.boolean().optional(),
  inlineData: z.object({
    data: z.string().min(1),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  }),
});
export const mediaResultResponseSchema = z.object({
  artifact: clientArtifactSchema,
  revision: z.number().int().nonnegative(),
  elementIds: z.array(edgeIdSchema),
});

export const taskInputSchema = z.object({
  setId: edgeIdSchema.optional(),
  shotId: edgeIdSchema.optional(),
  slot: slotSchema.optional(),
  prompt: z.string().min(1).max(30000),
  settings: settingsSchema,
  settingsExplicitKeys: settingsExplicitKeysSchema,
  snapshotIds: z.array(edgeIdSchema).max(4),
  assetIds: z.array(edgeIdSchema).max(4).default([]),
  providerMode: z.enum(["fixture", "vertex"]).optional(),
  anchor: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .nullable()
    .optional(),
  viewportCenter: z.object({ x: z.number(), y: z.number() }).optional(),
  mediaOp: mediaOpRequestSchema.optional(),
});
export const gateRequestSchema = z.object({
  setId: edgeIdSchema.optional(),
  setAdmissionId: edgeIdSchema.optional(),
  ids: z.array(edgeIdSchema).min(1).max(MAX_SET_SHOTS).optional(),
  id: edgeIdSchema,
  kind: z.enum(["text", "image"]).optional(),
  runId: edgeIdSchema.optional(),
  ipSubject: z.string().optional(),
  userId: edgeIdSchema.optional(),
  count: z.boolean().optional(),
  outcome: z.enum(["rate_limited", "success", "other"]).optional(),
});
