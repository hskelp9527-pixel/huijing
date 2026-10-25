import type {
  answerRequestSchema,
  canvasOpsRequestSchema,
  mediaOpRequestSchema,
  messageRequestSchema,
  snapshotRequestSchema,
  startRequestSchema,
} from "@loomic/shared/edge";
/**
 * 前后端契约入口。
 * 线上协议类型与 zod schema 全部来自 `@loomic/shared/edge`（后端 apps/edge 同源），这里只做：
 *   1) 重新导出，业务代码统一从这里 import；
 *   2) 前端自己的视图模型（由消息快照 + 事件流拼出来的 Run/Task/Step 等）和界面常量。
 * 不要在别处再定义接口形状。
 */
import type { z } from "zod";


export {
  answerRequestSchema,
  createProjectResponseSchema,
  meResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  artifactSchema,
  canvasOpsRequestSchema,
  canvasOpsResponseSchema,
  capabilitiesResponseSchema,
  cancelResponseSchema,
  createThreadResponseSchema,
  edgeErrorSchema,
  edgeEventSchema,
  messagesResponseSchema,
  messageResponseSchema,
  retryTaskResponseSchema,
  snapshotResponseSchema,
  startResponseSchema,
  taskResponseSchema,
  mediaOpResponseSchema,
  uploadResponseSchema,
  answerResponseSchema,
} from "@loomic/shared/edge";
export type {
  Artifact as ArtifactPayload,
  Asset,
  CanvasElement,
  CanvasOp,
  CapabilitiesResponse,
  EdgeErrorCode,
  EdgeEvent,
  MessagesResponse,
  MeResponse,
  Project,
  ProjectResponse,
  Quota,
  RunState,
  TaskState,
  Thread,
} from "@loomic/shared/edge";
import type {
  Artifact as ArtifactPayload,
  Asset,
  MessagesResponse,
  MeResponse,
  Project,
  ProjectResponse,
  RunState,
  TaskState,
  Thread,
} from "@loomic/shared/edge";

/** 请求入参类型（schema 的 input 侧，允许省略带默认值的字段） */
export type StartRequest = z.input<typeof startRequestSchema>;
export type MessageRequest = z.input<typeof messageRequestSchema>;
export type SnapshotRequest = z.input<typeof snapshotRequestSchema>;
export type MediaOpRequest = z.input<typeof mediaOpRequestSchema>;
export type AnswerRequest = z.input<typeof answerRequestSchema>;
export type CanvasOpsRequest = z.input<typeof canvasOpsRequestSchema>;

export type ProjectSummary = Project;
export type ThreadSummary = Thread;
export type ISODate = string;

// ───────── 错误 ─────────
/** 前端自己产生的错误码（网络、契约不符、本地校验）与后端 edgeErrorCode 并列 */
export type ClientErrorCode =
  | "NETWORK"
  | "CONTRACT_MISMATCH"
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_UNSUPPORTED";

export class ApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly details?: unknown;
  constructor(
    code: string,
    message: string,
    opts: { retryable?: boolean; status?: number; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.status = opts.status ?? 0;
    this.details = opts.details;
  }
}

// ───────── 用户输入侧 ─────────
export type ReferencePurpose = "subject" | "style" | "composition" | "general";
export const PURPOSE_LABEL: Record<ReferencePurpose, string> = {
  subject: "主体",
  style: "风格",
  composition: "构图",
  general: "一般参考",
};

export type AspectRatio =
  | "auto"
  | "1:1"
  | "3:4"
  | "4:3"
  | "9:16"
  | "16:9"
  | "3:2"
  | "2:3"
  | "4:5"
  | "5:4"
  | "21:9";
export const ASPECT_OPTIONS: AspectRatio[] = [
  "auto",
  "1:1",
  "3:4",
  "4:3",
  "9:16",
  "16:9",
];
export type Quality = "standard" | "high";
export const QUALITY_OPTIONS: ReadonlyArray<{ id: Quality; label: string }> = [
  { id: "standard", label: "1K" },
  { id: "high", label: "2K" },
];
export type ImageCount = 1 | 2 | 3 | 4;

/** 界面里持有的生成设置（后端 settings 的完整形态；modelId 为 "auto" 时由服务端选默认模型） */
export interface GenSettings {
  count: ImageCount;
  aspectRatio: AspectRatio;
  quality: Quality;
  modelId: string;
}
export type SettingsKey = keyof GenSettings;
export const DEFAULT_MODEL = "auto";

/** 模型的中文名与提示。可选项以服务端 /api/capabilities 返回的 models 为准；界面不显示内部 ID。 */
export const MODEL_INFO: Record<string, { label: string; hint: string }> = {
  "gemini-3.1-flash-image": { label: "标准", hint: "默认，约 15 秒" },
  "gemini-3-pro-image": { label: "高质量", hint: "约 20–50 秒" },
  "gemini-3.1-flash-lite-image": { label: "快速草图", hint: "约 5 秒" },
};
/** 模型显示名：已知档位用中文名，未知模型直接显示服务端给的 ID（不再猜成“标准”） */
export const modelLabel = (
  id: string | undefined,
  models?: readonly string[],
) => {
  const real = !id || id === "auto" ? models?.[0] : id;
  return real ? (MODEL_INFO[real]?.label ?? real) : "默认模型";
};

export const MAX_REFERENCES = 4;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const UPLOAD_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;

// ───────── 消息里的本地元数据（后端只保存文字，参考图/设置的回显由本机记录） ─────────
export interface MessageAttachment {
  assetId: string;
  name?: string;
  purpose: ReferencePurpose;
  order: number;
}
export interface MessageReference {
  snapshotId: string;
  /** 快照对应的图片资源（本机刚发送时才有；服务端回显用 previewUrl） */
  assetId?: string;
  purpose: ReferencePurpose;
  order: number;
  width?: number;
  height?: number;
  /** 引用时画布上的元素 ID（可能已被删除） */
  elementId?: string;
  /** 本机预览图（缩略图 data URL，避免依赖原图仍然可取） */
  previewUrl?: string;
}
export interface MessageMeta {
  attachments: MessageAttachment[];
  references: MessageReference[];
  /** 服务端确认后的设置（effectiveSettings）；刚发送、服务端还没回显时是提交设置 */
  settings: GenSettings;
  explicit: SettingsKey[];
  /** 发送时的视口中心（仅用于提交请求；占位位置以服务端冻结的 slot 为准） */
  viewportCenter?: { x: number; y: number };
  /** 编辑任务的来源元素（仅本机刚发送时有；服务端没有 slot 的旧任务/演示模式用它估算占位） */
  sourceElementId?: string;
}

// ───────── 视图模型（消息快照 + 事件流拼出来） ─────────
export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  text: string;
  runId: string | null;
  createdAt: ISODate;
  meta?: MessageMeta;
}
export interface RunTiming {
  phase: "read_canvas" | "model" | "tool" | "image" | "ingest" | "review";
  durationMs: number;
  label: string;
  taskId?: string;
}
export interface Run {
  id: string;
  threadId: string;
  state: RunState;
  error?: { code: string; message: string; retryable?: boolean };
  /** 首次看到的顺序，用于排序没有消息的重试 Run */
  order: number;
  /** 本机记录：这个 Run 是对哪个任务的重试 */
  retryOf?: string;
  /** 本机记录：这个 Run 是图片后处理（快速编辑、扩图…），显示在标题上 */
  label?: string;
  /** 事件时间（毫秒）：首个事件 / 进入终态，用来显示已用时间 */
  startedAt?: number;
  endedAt?: number;
  /** 服务端阶段说明（run.state 的 summary，例如等待文本模型） */
  summary?: string;
  /** 服务端持久化的耗时分段（刷新后仍在） */
  timings?: RunTiming[];
}
export type StepStatus = "started" | "completed" | "failed";
export interface Step {
  id: string;
  runId: string;
  tool: StepTool;
  status: StepStatus;
  summary: string;
  order: number;
  /** 子 Agent 角色（agent_delegate 步骤） */
  role?: "orchestrator" | "reference-review" | "concept" | "quality-review";
  warning?: boolean;
}
export type StepTool =
  | "read_canvas"
  | "generate_images"
  | "edit_image"
  | "ask_user"
  | "agent_delegate"
  | "canvas_apply"
  | "media_ocr";
export interface TaskError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface Task {
  id: string;
  runId: string;
  slotIndex: number;
  state: TaskState;
  error?: TaskError;
  artifactId?: string;
  /** 服务端排队时冻结的占位矩形（世界坐标）；完成后为实际矩形。旧任务可能没有 */
  slot?: { x: number; y: number; w: number; h: number };
  /** 事件时间（毫秒）：首个事件 / 进入终态 */
  startedAt?: number;
  endedAt?: number;
}
export const TASK_TERMINAL: TaskState[] = ["committed", "failed", "cancelled"];
export const RUN_ACTIVE_STATES: RunState[] = [
  "queued",
  "planning",
  "running",
  "waiting_input",
];
export interface Artifact extends ArtifactPayload {
  runId: string;
  slotIndex: number;
  /** 服务端插入画布的元素 ID；空表示未插入（取消后迟到的产物只入库） */
  elementIds?: string[];
  revision?: number;
}
export interface InputRequestView {
  id: string;
  runId: string;
  question: string;
  choices: Array<{ id: string; label: string }>;
  state: "open" | "answered";
}

export interface ThreadSnapshot {
  thread: Thread;
  messages: Message[];
  runs: MessagesResponse["runs"];
  tasks: Array<{
    id: string;
    runId: string;
    state: TaskState;
    slotIndex: number;
    slot?: { x: number; y: number; w: number; h: number } | undefined;
    artifact: ArtifactPayload | null;
    error: TaskError | null;
  }>;
  inputRequests: Array<{
    id: string;
    runId: string;
    question: string;
    choices: Array<{ id: string; label: string }>;
  }>;
}

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";
export type EventHandler = (
  event: import("@loomic/shared/edge").EdgeEvent,
) => void;

/** 资源类型的便捷别名 */
export type { Asset as AssetPayload };
