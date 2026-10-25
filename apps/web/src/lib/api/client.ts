import type {
  AnswerRequest,
  ApiError,
  Asset,
  CanvasOpsRequest,
  CapabilitiesResponse,
  ConnectionState,
  EdgeEvent,
  EventHandler,
  MediaOpRequest,
  MessageRequest,
  MessagesResponse,
  MeResponse,
  Project,
  ProjectResponse,
  Quota,
  SnapshotRequest,
  StartRequest,
  Thread,
} from "./contract";
import type {
  CreateSetRequest,
  CreateSetResponse,
  PatchAnalysisBody,
  RegenerateScope,
  SetDetail,
  SetTemplate,
} from "../sets/types";

export type ApiMode = "fixture" | "http";

export interface CallOptions {
  signal?: AbortSignal;
}

export interface Subscription {
  close(): void;
}

/** GET /api/me：访客 + 额度（quota.setsRemaining 是今日还可生成几套） */
export type Me = MeResponse;
export interface SnapshotResult {
  id: string;
  assetId: string;
  renderKey: string;
  width: number;
  height: number;
}

/**
 * 前端唯一的后端入口。HttpApiClient 对接 apps/edge 的 /api/*（响应与事件用 shared 的 zod schema 校验），
 * FixtureApiClient 在浏览器内模拟同样形状的数据。页面和组件只依赖这个接口，不直接 fetch。
 */
export interface ApiClient {
  readonly mode: ApiMode;

  // 访客身份与额度（无登录）、能力
  getSession(opts?: CallOptions): Promise<Me | null>;
  getQuota(): Promise<Quota>;
  getCapabilities(opts?: CallOptions): Promise<CapabilitiesResponse>;

  // 资源
  /** 图片字节地址：http 为同源 /api/assets/:id，fixture 为 data URL */
  assetUrl(assetId: string): string;
  uploadAsset(
    file: File,
    opts?: CallOptions & { projectId?: string },
  ): Promise<Asset>;
  /** 外观为空时走 JSON；带渲染后的 PNG 时走 multipart */
  createSnapshot(
    req: SnapshotRequest,
    png?: Blob,
    opts?: CallOptions,
  ): Promise<SnapshotResult>;

  // 项目
  listProjects(opts?: CallOptions): Promise<Project[]>;
  createProject(title?: string): Promise<Project>;
  startProject(
    req: StartRequest,
    opts?: CallOptions,
  ): Promise<{ projectId: string; threadId: string; runId: string }>;
  getProject(id: string, opts?: CallOptions): Promise<ProjectResponse>;
  renameProject(id: string, title: string): Promise<void>;
  applyCanvasOps(
    projectId: string,
    req: CanvasOpsRequest,
  ): Promise<{ revision: number }>;

  // 对话与 Run
  createThread(projectId: string): Promise<Thread>;
  getMessages(threadId: string, opts?: CallOptions): Promise<MessagesResponse>;
  postMessage(
    threadId: string,
    req: MessageRequest,
    opts?: CallOptions,
  ): Promise<{ messageId: string; runId: string }>;
  cancelRun(runId: string): Promise<void>;
  answerInputRequest(id: string, req: AnswerRequest): Promise<void>;
  /** 图片后处理（快速编辑、扩图、多视角…）：服务端异步执行，进度和结果走项目事件 */
  mediaOp(
    req: MediaOpRequest,
  ): Promise<{ taskId: string; runId: string; threadId: string }>;
  retryTask(
    taskId: string,
    clientOperationId: string,
  ): Promise<{ taskId: string; runId: string }>;

  // 模板一键出图（docs/模板生图.md）
  listTemplates(opts?: CallOptions): Promise<SetTemplate[]>;
  /** 额度不足时抛 ApiError QUOTA_EXCEEDED，details 为 {remaining, need} */
  createSet(
    req: CreateSetRequest,
    opts?: CallOptions,
  ): Promise<CreateSetResponse>;
  getSet(setId: string, opts?: CallOptions): Promise<SetDetail>;
  regenerateShot(setId: string, shotId: string): Promise<void>;
  /** 重出失败的 / 整套重出；按张预扣，额度不足整体拒绝 */
  regenerateSet(setId: string, scope: RegenerateScope): Promise<void>;
  /** 改商品名 / 人群 / 卖点：服务端只更新对应文字图层（用户手改过的图层不覆盖），不重出图 */
  patchAnalysis(setId: string, body: PatchAnalysisBody): Promise<void>;

  /** HTTP 补读事件：seq > cursor，至多 1000 条 */
  getEvents(
    projectId: string,
    cursor: number,
    opts?: CallOptions,
  ): Promise<EdgeEvent[]>;
  /** 订阅项目事件；cursor 之后的事件会先补发。断线由实现负责重连并带上最后 seq。 */
  subscribe(
    projectId: string,
    cursor: number,
    handler: EventHandler,
    onConnection?: (s: ConnectionState) => void,
    onError?: (e: ApiError) => void,
  ): Subscription;
}
