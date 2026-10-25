import { canvasOpsRequestSchema, edgeEventSchema } from "@loomic/shared/edge";

import { makeImageElement } from "../canvas/elements";
import {
  type Rect,
  fitLongEdge,
  layoutRow,
  worldBounds,
} from "../canvas/placement";
import type {
  CreateSetRequest,
  PatchAnalysisBody,
  RegenerateScope,
  SetDetail,
  SetTemplate,
} from "../sets/types";
import { must } from "../utils";
import type {
  ApiClient,
  CallOptions,
  Me,
  SnapshotResult,
  Subscription,
} from "./client";
import {
  type AnswerRequest,
  ApiError,
  type ArtifactPayload,
  type Asset,
  type CanvasElement,
  type CanvasOp,
  type CanvasOpsRequest,
  type CapabilitiesResponse,
  type ConnectionState,
  type EdgeEvent,
  type EventHandler,
  MAX_UPLOAD_BYTES,
  type MediaOpRequest,
  type MessageRequest,
  type MessagesResponse,
  type Project,
  type ProjectResponse,
  type Quota,
  RUN_ACTIVE_STATES,
  type RunState,
  type SnapshotRequest,
  type StartRequest,
  TASK_TERMINAL,
  type TaskError,
  type TaskState,
  type Thread,
  UPLOAD_MIMES,
} from "./contract";
import { FixtureSets, type SetRec } from "./fixture-sets";
import {
  actualPixels,
  conceptName,
  hash,
  makeArtSvg,
  readAndShrink,
} from "./fixture-art";

/**
 * 浏览器内的后端模拟，数据形状与 apps/edge（packages/shared 的 edge-contracts）一致：
 * 幂等 submissionId、Run 步骤事件（read_canvas / generate_images / ask_user）、任务 queued→…→committed、
 * 服务端把结果插入画布并整批重排（canvas.ops）、取消、失败/限流、追问、额度、事件序号与补发。
 * 发出的每个事件都会用 shared 的 schema 校验，保证演示数据和真实协议不漂移。数据存 localStorage。
 */

const DB_KEY = "fx-db-v4";
const DAILY_LIMIT = 30;
const GUEST_DAILY_SETS = 2;
const GLOBAL_REMAINING = 1180;
const MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-3.1-flash-lite-image",
];

interface StoredMessage {
  id: string;
  runId: string | null;
  role: "user" | "assistant";
  parts: Array<{ text: string }>;
  createdAt: string;
}
interface Settings {
  count: number;
  aspectRatio: string;
  quality: string;
  modelId: string;
}
interface TaskRec {
  id: string;
  runId: string;
  slotIndex: number;
  state: TaskState;
  error: TaskError | null;
  artifact: ArtifactPayload | null;
  input: {
    prompt: string;
    settings: Settings;
    sourceElementId?: string;
    anchor: Rect | null;
    viewportCenter: { x: number; y: number };
    fallbackDims?: { width: number; height: number };
  };
}
interface RunRec {
  id: string;
  threadId: string;
  state: RunState;
  submission: {
    text: string;
    settings: Settings;
    explicit: string[];
    viewportCenter?: { x: number; y: number };
    snapshotIds: string[];
    imageAssetIds: string[];
  };
}
interface InputRec {
  id: string;
  runId: string;
  question: string;
  choices: Array<{ id: string; label: string }>;
  state: "pending" | "answered";
}
interface ThreadRec {
  thread: Thread;
  messages: StoredMessage[];
  runs: RunRec[];
  tasks: TaskRec[];
  inputs: InputRec[];
}
interface ProjectRec {
  project: Project;
  canvas: {
    revision: number;
    elements: CanvasElement[];
    files: Record<string, { assetId: string }>;
  };
  elRev: Record<string, number>;
  threadIds: string[];
  seq: number;
  events: EdgeEvent[];
  ops: Record<string, number>;
}
interface Db {
  used: number;
  /** 今天已创建的套图数（每天 GUEST_DAILY_SETS 套） */
  usedSets: number;
  day: string;
  projects: Record<string, ProjectRec>;
  threads: Record<string, ThreadRec>;
  submissions: Record<
    string,
    { projectId: string; threadId: string; runId: string }
  >;
  clientMessages: Record<string, { messageId: string; runId: string }>;
  retryOps: Record<string, { taskId: string; runId: string }>;
  assets: Record<string, Asset>;
  snapshots: Record<string, SnapshotResult & { sourceAssetId: string }>;
  /** 套图（模板一键出图）；旧存档没有这个字段 */
  sets: Record<string, SetRec>;
}

const now = () => new Date().toISOString();
let idCounter = 0;
const uid = (p: string) =>
  `${p}_${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
const latency = (signal?: AbortSignal) =>
  sleep(120 + Math.random() * 200, signal);

function endOfDayShanghai(): string {
  const d = new Date(Date.now() + 8 * 3600_000);
  d.setUTCHours(24, 0, 0, 0);
  return new Date(d.getTime() - 8 * 3600_000).toISOString();
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 };
/** 从文字里找“N 张 / N 个方案”之类的数量要求（与后端 textSettings 同一规则） */
export function parseRequestedCount(text: string): number | null {
  const m = text.match(/([1-4一二两三四])\s*(?:张|个方案|种构图|种方案|幅|版)/);
  if (!m) return null;
  return CN_NUM[m[1] ?? "1"] ?? Number(m[1]);
}

const sha = (s: string) => {
  let out = "";
  for (let i = 0; out.length < 64; i++)
    out += hash(`${s}:${i}`).toString(16).padStart(8, "0");
  return out.slice(0, 64);
};

export class FixtureApiClient implements ApiClient {
  readonly mode = "fixture" as const;
  private db: Db;
  private persistOk = true;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private subs = new Map<string, Set<EventHandler>>();
  private cancelled = new Set<string>();
  private answers = new Map<
    string,
    (a: { choiceId?: string | undefined; text?: string | undefined }) => void
  >();
  private uploadAttempts = new Map<string, number>();

  private sets: FixtureSets;

  constructor() {
    this.db = this.load();
    this.sets = new FixtureSets(this.setHost());
    this.recoverInterrupted();
    this.sets.recover();
    if (Object.keys(this.db.projects).length === 0) this.seed();
  }

  // ───────── 套图（模板一键出图） ─────────
  private setHost() {
    // biome-ignore lint/complexity/noUselessThisAlias: 对象字面量里的方法要访问私有成员
    const self = this;
    return {
      sets: this.db.sets,
      assets: this.db.assets,
      uid,
      createProject: (title: string, setId: string) => {
        const rec = self.newProject(title);
        rec.project.setId = setId;
        const th = self.newThread(rec, title);
        return { projectId: rec.project.id, threadId: th.thread.id };
      },
      emit: (
        projectId: string,
        type: "set.state" | "set.analyzed" | "set.shot",
        payload: unknown,
      ) => self.emitRaw(projectId, type, payload),
      setsRemaining: () => Math.max(0, GUEST_DAILY_SETS - self.db.usedSets),
      chargeSet: () => {
        self.db.usedSets += 1;
      },
      upsert: (projectId: string, elements: CanvasElement[]) =>
        self.serverUpsert(projectId, elements),
      getElement: (projectId: string, id: string) =>
        self.db.projects[projectId]?.canvas.elements.find((e) => e.id === id),
      setCover: (projectId: string, url: string) => {
        const rec = self.db.projects[projectId];
        if (rec) rec.project.coverUrl = url;
      },
      remaining: () => Math.max(0, DAILY_LIMIT - self.db.used),
      charge: (n: number, projectId: string) => {
        self.db.used += n;
        self.emitRaw(projectId, "quota.updated", self.quota());
      },
      refund: (n: number, projectId: string) => {
        self.db.used = Math.max(0, self.db.used - n);
        self.emitRaw(projectId, "quota.updated", self.quota());
      },
      save: () => self.save(),
      addAsset: (a: Asset) => {
        self.db.assets[a.id] = a;
      },
    };
  }
  /** 服务端写画布：元素版本 +1，revision +1，发 canvas.ops（source: task） */
  private serverUpsert(projectId: string, elements: CanvasElement[]) {
    const rec = this.db.projects[projectId];
    if (!rec || !elements.length) return;
    const applied: CanvasOp[] = [];
    for (const el of elements) {
      const old = rec.canvas.elements.find((e) => e.id === el.id);
      const element = {
        ...el,
        version: old ? Math.max(old.version + 1, el.version) : el.version,
      } as CanvasElement;
      this.putElement(rec, element);
      applied.push({ kind: "upsert", element });
    }
    rec.canvas.revision += 1;
    for (const el of elements) rec.elRev[el.id] = rec.canvas.revision;
    rec.project.updatedAt = now();
    this.emitRaw(projectId, "canvas.ops", {
      revision: rec.canvas.revision,
      ops: applied,
      source: "task",
    });
  }

  async listTemplates(opts?: CallOptions): Promise<SetTemplate[]> {
    await latency(opts?.signal);
    return this.sets.listTemplates();
  }
  async createSet(req: CreateSetRequest, opts?: CallOptions) {
    await sleep(300, opts?.signal);
    const res = await this.sets.create(req);
    console.info("[fixture] 套图已创建", res);
    return res;
  }
  async getSet(setId: string, opts?: CallOptions): Promise<SetDetail> {
    await sleep(40, opts?.signal);
    return this.sets.get(setId);
  }
  async regenerateShot(setId: string, shotId: string) {
    await sleep(150);
    await this.sets.regenerate(setId, shotId);
  }
  async regenerateSet(setId: string, scope: RegenerateScope) {
    await sleep(150);
    await this.sets.regenerateSet(setId, scope);
  }
  async patchAnalysis(setId: string, body: PatchAnalysisBody) {
    await sleep(120);
    await this.sets.patchAnalysis(setId, body);
  }
  /** 演示专用：把今日已用额度设为 n，用来演示额度不足（控制台 `__api.debugSetUsed(28)`） */
  debugSetUsed(n: number, sets?: number) {
    this.db.used = n;
    if (sets !== undefined) this.db.usedSets = sets;
    this.save();
  }

  // ───────── 持久化 ─────────
  private load(): Db {
    const empty: Db = {
      used: 0,
      usedSets: 0,
      day: this.today(),
      projects: {},
      threads: {},
      submissions: {},
      clientMessages: {},
      retryOps: {},
      assets: {},
      snapshots: {},
      sets: {},
    };
    if (typeof window === "undefined") return empty;
    try {
      const raw = window.localStorage.getItem(DB_KEY);
      if (raw) {
        const db = JSON.parse(raw) as Db;
        db.sets ??= {};
        db.usedSets ??= 0;
        if (db.day !== this.today()) {
          db.used = 0;
          db.usedSets = 0;
          db.day = this.today();
        }
        return db;
      }
    } catch {
      /* 存储不可用或损坏：从空库开始 */
    }
    return empty;
  }
  private today() {
    return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  }
  private save() {
    if (!this.persistOk || typeof window === "undefined") return;
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        for (const p of Object.values(this.db.projects))
          p.events = p.events.slice(-600);
        window.localStorage.setItem(DB_KEY, JSON.stringify(this.db));
      } catch {
        this.persistOk = false; // 超出配额：本次会话只在内存里演示
      }
    }, 300);
  }
  /** 页面刷新会中断模拟中的 Run；把未结束的任务标为可重试失败，避免永远转圈 */
  private recoverInterrupted() {
    for (const [tid, t] of Object.entries(this.db.threads)) {
      const projectId = t.thread.projectId;
      for (const task of t.tasks) {
        if (!TASK_TERMINAL.includes(task.state)) {
          task.state = "failed";
          task.error = {
            code: "PROVIDER_ERROR",
            message: "演示数据：页面刷新中断了这次生成，可以重试",
            retryable: true,
          };
          this.emitRaw(
            projectId,
            "task.state",
            { state: "failed", slotIndex: task.slotIndex, error: task.error },
            { runId: task.runId, taskId: task.id },
          );
        }
      }
      for (const run of t.runs) {
        if (RUN_ACTIVE_STATES.includes(run.state)) {
          run.state = "failed";
          this.emitRaw(
            projectId,
            "run.state",
            {
              state: "failed",
              error: {
                code: "PROVIDER_ERROR",
                message: "演示数据：页面刷新中断",
                retryable: true,
              },
            },
            { runId: run.id },
          );
        }
      }
      for (const i of t.inputs) if (i.state === "pending") i.state = "answered";
      void tid;
    }
  }

  // ───────── 事件 ─────────
  private emitRaw(
    projectId: string,
    type: EdgeEvent["type"],
    payload: unknown,
    extra: { runId?: string; taskId?: string } = {},
  ) {
    const rec = this.db.projects[projectId];
    if (!rec) return;
    rec.seq += 1;
    const ev = {
      seq: rec.seq,
      type,
      projectId,
      ...extra,
      at: now(),
      payload: clone(payload),
    };
    // 与真实协议对齐：不符合 shared schema 的演示事件立刻在控制台暴露
    const parsed = edgeEventSchema.safeParse(ev);
    if (!parsed.success)
      console.error(
        "[fixture] 事件不符合 shared 契约",
        type,
        parsed.error.issues[0],
      );
    rec.events.push(ev as EdgeEvent);
    this.save();
    for (const h of this.subs.get(projectId) ?? [])
      queueMicrotask(() => h(ev as EdgeEvent));
  }

  async getEvents(
    projectId: string,
    cursor: number,
    opts?: CallOptions,
  ): Promise<EdgeEvent[]> {
    await latency(opts?.signal);
    const rec = this.db.projects[projectId];
    if (!rec) throw new ApiError("NOT_FOUND", "项目不存在", { status: 404 });
    return clone(rec.events.filter((e) => e.seq > cursor).slice(0, 1000));
  }

  subscribe(
    projectId: string,
    cursor: number,
    handler: EventHandler,
    onConnection?: (s: ConnectionState) => void,
  ): Subscription {
    const set = this.subs.get(projectId) ?? new Set<EventHandler>();
    this.subs.set(projectId, set);
    onConnection?.("connecting");
    let active = true;
    const wrapped: EventHandler = (e) => active && handler(e);
    queueMicrotask(() => {
      if (!active) return;
      // 先补发 cursor 之后缺失的事件，再接实时
      for (const ev of this.db.projects[projectId]?.events ?? [])
        if (ev.seq > cursor) handler(ev);
      set.add(wrapped);
      onConnection?.("open");
    });
    return {
      close: () => {
        active = false;
        set.delete(wrapped);
        onConnection?.("closed");
      },
    };
  }

  // ───────── 认证、额度、能力 ─────────
  /** 匿名访客：没有登录，固定身份（真实后端首次请求时自动下发匿名 cookie） */
  private readUser(): { id: string; name: string; isGuest: true } {
    return { id: "visitor_demo", name: "访客", isGuest: true };
  }
  private requireUser() {
    return this.readUser();
  }
  private quota(): Quota {
    const remaining = Math.max(0, DAILY_LIMIT - this.db.used);
    return {
      used: this.db.used,
      limit: DAILY_LIMIT,
      globalRemaining: GLOBAL_REMAINING - this.db.used,
      remaining,
      ipRemaining: remaining,
      runsRemaining: remaining,
      setsRemaining: Math.max(0, GUEST_DAILY_SETS - this.db.usedSets),
      resetAt: endOfDayShanghai(),
    };
  }
  async getSession(opts?: CallOptions): Promise<Me | null> {
    await sleep(60, opts?.signal);
    const user = this.readUser();
    return user ? { user, quota: this.quota() } : null;
  }
  async getQuota() {
    return this.quota();
  }
  async getCapabilities(): Promise<CapabilitiesResponse> {
    return {
      mode: "fixture",
      operations: ["generate", "edit"],
      models: MODELS,
      maxCount: 4,
    };
  }

  // ───────── 资源 ─────────
  assetUrl(assetId: string) {
    return this.db.assets[assetId]?.url ?? "";
  }
  async uploadAsset(
    file: File,
    opts?: CallOptions & { projectId?: string },
  ): Promise<Asset> {
    this.requireUser();
    await sleep(500 + Math.random() * 700, opts?.signal);
    if (!(UPLOAD_MIMES as readonly string[]).includes(file.type))
      throw new ApiError("INVALID_INPUT", "只支持 PNG、JPEG、WebP 图片", {
        status: 422,
      });
    if (file.size > MAX_UPLOAD_BYTES)
      throw new ApiError("INVALID_INPUT", "图片超过 20MB", { status: 413 });
    // 演示用：文件名含 fail 的图片第一次上传失败，重试成功，用来演示失败与重试
    if (/fail/i.test(file.name)) {
      const n = (this.uploadAttempts.get(file.name) ?? 0) + 1;
      this.uploadAttempts.set(file.name, n);
      if (n === 1)
        throw new ApiError("INTERNAL_ERROR", "网络中断，上传没有完成", {
          retryable: true,
        });
    }
    const { width, height, dataUrl } = await readAndShrink(file);
    const id = uid("asset");
    const asset: Asset = {
      id,
      url: dataUrl,
      width,
      height,
      sha256: sha(id),
      mime: file.type as Asset["mime"],
    };
    this.db.assets[id] = asset;
    this.save();
    return clone(asset);
  }
  async createSnapshot(req: SnapshotRequest): Promise<SnapshotResult> {
    this.requireUser();
    await sleep(150);
    const existing = this.db.snapshots[req.renderKey];
    if (existing) return clone(existing);
    const src = this.db.assets[req.sourceAssetId];
    if (!src) throw new ApiError("NOT_FOUND", "找不到源图片", { status: 404 });
    const snap = {
      id: uid("snapshot"),
      assetId: src.id,
      renderKey: req.renderKey,
      width: src.width,
      height: src.height,
      sourceAssetId: src.id,
    };
    this.db.snapshots[req.renderKey] = snap;
    this.save();
    return clone(snap);
  }

  // ───────── 项目 ─────────
  private newProject(title: string): ProjectRec {
    const id = uid("project");
    const rec: ProjectRec = {
      project: {
        id,
        title,
        coverUrl: null,
        updatedAt: now(),
        lastThreadId: null,
      },
      canvas: { revision: 0, elements: [], files: {} },
      elRev: {},
      threadIds: [],
      seq: 0,
      events: [],
      ops: {},
    };
    this.db.projects[id] = rec;
    return rec;
  }
  private newThread(rec: ProjectRec, title = "新对话"): ThreadRec {
    const thread: Thread = {
      id: uid("thread"),
      projectId: rec.project.id,
      title,
      createdAt: now(),
    };
    const t: ThreadRec = {
      thread,
      messages: [],
      runs: [],
      tasks: [],
      inputs: [],
    };
    this.db.threads[thread.id] = t;
    rec.threadIds.push(thread.id);
    rec.project.lastThreadId = thread.id;
    return t;
  }
  async listProjects(opts?: CallOptions): Promise<Project[]> {
    this.requireUser();
    await latency(opts?.signal);
    return Object.values(this.db.projects)
      .map((p) => clone(p.project))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async createProject(title?: string): Promise<Project> {
    this.requireUser();
    await latency();
    const rec = this.newProject(title?.trim() || "新项目");
    this.newThread(rec);
    this.save();
    return clone(rec.project);
  }
  async getProject(id: string, opts?: CallOptions): Promise<ProjectResponse> {
    this.requireUser();
    await latency(opts?.signal);
    const rec = this.db.projects[id];
    if (!rec)
      throw new ApiError("NOT_FOUND", "项目不存在或已被删除", { status: 404 });
    return {
      project: clone(rec.project),
      canvas: clone({
        revision: rec.canvas.revision,
        elements: rec.canvas.elements,
        files: rec.canvas.files,
      }),
      threads: rec.threadIds.map((t) => clone(must(this.db.threads[t]).thread)),
      eventCursor: rec.seq,
    };
  }
  async renameProject(id: string, title: string) {
    const rec = this.db.projects[id];
    if (!rec) throw new ApiError("NOT_FOUND", "项目不存在", { status: 404 });
    const t = title.trim();
    if (!t) throw new ApiError("INVALID_INPUT", "项目名不能为空");
    rec.project.title = t.slice(0, 120);
    rec.project.updatedAt = now();
    this.save();
  }

  async applyCanvasOps(
    projectId: string,
    req: CanvasOpsRequest,
  ): Promise<{ revision: number }> {
    const rec = this.db.projects[projectId];
    if (!rec) throw new ApiError("NOT_FOUND", "项目不存在", { status: 404 });
    await sleep(80);
    const parsed = canvasOpsRequestSchema.safeParse(req);
    if (!parsed.success)
      throw new ApiError("INVALID_INPUT", "请求格式无效", {
        status: 422,
        details: parsed.error.issues,
      });
    const known = rec.ops[req.clientOpId];
    if (known !== undefined) return { revision: known }; // clientOpId 幂等
    const touched = req.ops.map((o) =>
      o.kind === "upsert" ? o.element.id : o.elementId,
    );
    if (req.baseRevision < rec.canvas.revision) {
      const conflicts = touched.filter(
        (id) => (rec.elRev[id] ?? 0) > req.baseRevision,
      );
      if (conflicts.length) {
        throw new ApiError(
          "CANVAS_CONFLICT",
          "画布已被更新，涉及的对象有冲突",
          {
            status: 409,
            details: {
              revision: rec.canvas.revision,
              serverElements: clone(
                rec.canvas.elements.filter((e) => conflicts.includes(e.id)),
              ),
            },
          },
        );
      }
    }
    const applied: CanvasOp[] = [];
    for (const op of req.ops) {
      if (op.kind === "upsert") {
        const old = rec.canvas.elements.find((e) => e.id === op.element.id);
        const element = {
          ...op.element,
          version: old
            ? Math.max(old.version + 1, op.element.version)
            : op.element.version,
        } as CanvasElement;
        this.putElement(rec, element);
        applied.push({ kind: "upsert", element });
      } else {
        const old = rec.canvas.elements.find((e) => e.id === op.elementId);
        if (old) {
          const element = {
            ...old,
            isDeleted: true,
            version: old.version + 1,
          } as CanvasElement;
          this.putElement(rec, element);
          applied.push({ kind: "upsert", element });
        }
      }
    }
    rec.canvas.revision += 1;
    for (const id of touched) rec.elRev[id] = rec.canvas.revision;
    rec.ops[req.clientOpId] = rec.canvas.revision;
    rec.project.updatedAt = now();
    this.emitRaw(projectId, "canvas.ops", {
      revision: rec.canvas.revision,
      ops: applied,
      source: "user",
    });
    return { revision: rec.canvas.revision };
  }
  private putElement(rec: ProjectRec, element: CanvasElement) {
    const i = rec.canvas.elements.findIndex((e) => e.id === element.id);
    if (i >= 0) rec.canvas.elements[i] = element;
    else rec.canvas.elements.push(element);
    if (element.fileId)
      rec.canvas.files[element.fileId] = { assetId: element.fileId };
  }

  // ───────── 对话与 Run ─────────
  async createThread(projectId: string): Promise<Thread> {
    const rec = this.db.projects[projectId];
    if (!rec) throw new ApiError("NOT_FOUND", "项目不存在", { status: 404 });
    await latency();
    const t = this.newThread(rec);
    this.save();
    return clone(t.thread);
  }
  async getMessages(
    threadId: string,
    opts?: CallOptions,
  ): Promise<MessagesResponse> {
    this.requireUser();
    await latency(opts?.signal);
    const t = this.db.threads[threadId];
    if (!t) throw new ApiError("NOT_FOUND", "对话不存在", { status: 404 });
    return clone({
      items: t.messages.map((m) => ({ ...m, parts: m.parts })),
      runs: [...t.runs].reverse().map((r) => ({ id: r.id, state: r.state })),
      tasks: t.tasks.map((x) => ({
        id: x.id,
        runId: x.runId,
        state: x.state,
        slotIndex: x.slotIndex,
        artifact: x.artifact,
        error: x.error,
      })),
      inputRequests: t.inputs
        .filter((i) => i.state === "pending")
        .map((i) => ({
          id: i.id,
          runId: i.runId,
          question: i.question,
          choices: i.choices,
        })),
      before: null,
    }) as MessagesResponse;
  }

  async startProject(req: StartRequest, opts?: CallOptions) {
    this.requireUser();
    await sleep(350 + Math.random() * 450, opts?.signal);
    const dup = this.db.submissions[req.submissionId];
    if (dup) return clone(dup); // 幂等：同一 submissionId 返回原项目/线程/Run
    const text = textOf(req.parts);
    if (!text && !req.parts.some((p) => p.type === "image"))
      throw new ApiError("INVALID_INPUT", "请先写下需求");
    this.checkQuota(text, req.settings?.count);
    const rec = this.newProject(
      text.replace(/\s+/g, " ").slice(0, 18) || "新项目",
    );
    const thread = this.newThread(rec, text.slice(0, 16) || "新对话");
    const { runId } = this.createUserMessage(rec, thread, req);
    const res = {
      projectId: rec.project.id,
      threadId: thread.thread.id,
      runId,
    };
    this.db.submissions[req.submissionId] = res;
    this.save();
    return clone(res);
  }

  async postMessage(threadId: string, req: MessageRequest, opts?: CallOptions) {
    this.requireUser();
    await sleep(200 + Math.random() * 250, opts?.signal);
    const dup = this.db.clientMessages[req.clientMessageId];
    if (dup) return clone(dup);
    const thread = this.db.threads[threadId];
    if (!thread) throw new ApiError("NOT_FOUND", "对话不存在", { status: 404 });
    if (thread.runs.some((r) => RUN_ACTIVE_STATES.includes(r.state))) {
      throw new ApiError(
        "RUN_ACTIVE",
        "这个对话还有进行中的任务，请先等待或停止",
        { status: 409 },
      );
    }
    const text = textOf(req.parts);
    if (!text && !req.references?.length)
      throw new ApiError("INVALID_INPUT", "请先写下需求");
    this.checkQuota(text, req.settings?.count);
    const rec = must(this.db.projects[thread.thread.projectId]);
    const res = this.createUserMessage(rec, thread, req);
    this.db.clientMessages[req.clientMessageId] = res;
    return clone(res);
  }

  private checkQuota(text: string, count: number | undefined) {
    const want = parseRequestedCount(text) ?? count ?? 1;
    if (this.db.used + want > DAILY_LIMIT) {
      throw new ApiError(
        "QUOTA_EXCEEDED",
        `今日额度只剩 ${Math.max(0, DAILY_LIMIT - this.db.used)} 张，北京时间零点重置`,
        { status: 429 },
      );
    }
  }

  private createUserMessage(
    rec: ProjectRec,
    thread: ThreadRec,
    req: MessageRequest | StartRequest,
  ) {
    const createdAt = now();
    const runId = uid("run");
    const messageId = uid("msg");
    const text = textOf(req.parts);
    const rs = req.settings ?? {};
    const settings: Settings = {
      count: rs.count ?? 1,
      aspectRatio: rs.aspectRatio ?? "auto",
      quality: rs.quality ?? "standard",
      modelId: rs.modelId ?? "auto",
    };
    const run: RunRec = {
      id: runId,
      threadId: thread.thread.id,
      state: "queued",
      submission: {
        text,
        settings,
        explicit: [...(req.settingsExplicitKeys ?? [])],
        ...(req.viewportCenter ? { viewportCenter: req.viewportCenter } : {}),
        snapshotIds: (req.references ?? []).map((r) => r.snapshotId),
        imageAssetIds: req.parts.flatMap((p) =>
          p.type === "image" ? [p.assetId] : [],
        ),
      },
    };
    thread.messages.push({
      id: messageId,
      runId,
      role: "user",
      parts: [{ text }],
      createdAt,
    });
    thread.runs.push(run);
    rec.project.updatedAt = createdAt;
    this.emitRaw(rec.project.id, "run.state", { state: "queued" }, { runId });
    void this.driveRun(rec, thread, run).catch((e) =>
      console.error("[fixture] run crashed", e),
    );
    return { messageId, runId };
  }

  async cancelRun(runId: string) {
    for (const thread of Object.values(this.db.threads)) {
      const run = thread.runs.find((r) => r.id === runId);
      if (!run) continue;
      if (!RUN_ACTIVE_STATES.includes(run.state)) return;
      this.cancelled.add(runId);
      const pid = thread.thread.projectId;
      for (const task of thread.tasks.filter(
        (t) => t.runId === runId && !TASK_TERMINAL.includes(t.state),
      )) {
        task.state = "cancelled";
        this.emitRaw(
          pid,
          "task.state",
          { state: "cancelled", slotIndex: task.slotIndex },
          { runId, taskId: task.id },
        );
      }
      for (const ir of thread.inputs.filter(
        (i) => i.runId === runId && i.state === "pending",
      ))
        ir.state = "answered";
      run.state = "cancelled";
      this.emitRaw(pid, "run.state", { state: "cancelled" }, { runId });
      return;
    }
  }

  async answerInputRequest(id: string, req: AnswerRequest) {
    await sleep(150);
    const resolve = this.answers.get(id);
    if (!resolve)
      throw new ApiError("NOT_FOUND", "这个问题已经结束", { status: 409 });
    this.answers.delete(id);
    resolve({ choiceId: req.answer.choiceId, text: req.answer.text });
  }

  async mediaOp(
    req: MediaOpRequest,
  ): Promise<{ taskId: string; runId: string; threadId: string }> {
    this.requireUser();
    await sleep(250);
    const rec = this.db.projects[req.projectId];
    if (!rec) throw new ApiError("NOT_FOUND", "项目不存在", { status: 404 });
    const src = rec.canvas.elements.find(
      (e) => e.id === req.source.elementId && !e.isDeleted,
    );
    const snap = Object.values(this.db.snapshots).find(
      (s) => s.id === req.source.snapshotId,
    );
    if (!src || !snap)
      throw new ApiError("INVALID_INPUT", "源元素与快照不匹配", {
        status: 422,
      });
    if (req.op === "expand") {
      const m = req.params.margin;
      if (m.top + m.right + m.bottom + m.left === 0)
        throw new ApiError("INVALID_INPUT", "至少扩展一边", { status: 422 });
    }
    this.checkQuota("", 1);
    const label = {
      edit: "快速编辑",
      expand: "扩图",
      multiview: "多视角",
      replace_text: "OCR 改字",
      move_object: "图内移动",
      erase_ai: "AI 消除",
    }[req.op];
    const thread = this.newThread(rec, "图片后处理");
    const settings: Settings = {
      count: 1,
      aspectRatio: "auto",
      quality: req.settings?.quality ?? "standard",
      modelId: req.settings?.modelId ?? "auto",
    };
    const run: RunRec = {
      id: uid("run"),
      threadId: thread.thread.id,
      state: "running",
      submission: {
        text: label,
        settings,
        explicit: [],
        snapshotIds: [snap.id],
        imageAssetIds: [],
      },
    };
    thread.runs.push(run);
    const m = req.op === "expand" ? req.params.margin : null;
    const dims = {
      width: snap.width + (m ? m.left + m.right : 0),
      height: snap.height + (m ? m.top + m.bottom : 0),
    };
    const task: TaskRec = {
      id: uid("task"),
      runId: run.id,
      slotIndex: 0,
      state: "queued",
      error: null,
      artifact: null,
      input: {
        prompt: label,
        settings,
        sourceElementId: src.id,
        anchor: worldBounds(
          src as {
            x: number;
            y: number;
            width: number;
            height: number;
            angle?: number;
          },
        ),
        viewportCenter: { x: 0, y: 0 },
        fallbackDims: dims,
      },
    };
    thread.tasks.push(task);
    this.emitRaw(
      rec.project.id,
      "run.state",
      { state: "running" },
      { runId: run.id },
    );
    this.emitRaw(
      rec.project.id,
      "task.state",
      { state: "queued", slotIndex: 0 },
      { runId: run.id, taskId: task.id },
    );
    void this.runTask(rec, thread, run, task, "none").then(() =>
      this.finishRun(rec, thread, run),
    );
    return { taskId: task.id, runId: run.id, threadId: thread.thread.id };
  }
  async retryTask(taskId: string, clientOperationId: string) {
    await sleep(150);
    const dup = this.db.retryOps[clientOperationId];
    if (dup) return clone(dup);
    for (const thread of Object.values(this.db.threads)) {
      const old = thread.tasks.find((t) => t.id === taskId);
      if (!old) continue;
      if (thread.runs.some((r) => RUN_ACTIVE_STATES.includes(r.state)))
        throw new ApiError("RUN_ACTIVE", "这个对话还有进行中的任务", {
          status: 409,
        });
      if (old.state !== "failed" && old.state !== "cancelled")
        throw new ApiError("INVALID_INPUT", "只有失败或已停止的任务才能重试");
      const rec = must(this.db.projects[thread.thread.projectId]);
      const prev = must(thread.runs.find((r) => r.id === old.runId));
      const run: RunRec = {
        id: uid("run"),
        threadId: thread.thread.id,
        state: "running",
        submission: prev.submission,
      };
      thread.runs.push(run);
      const task: TaskRec = {
        ...clone(old),
        id: uid("task"),
        runId: run.id,
        state: "queued",
        error: null,
        artifact: null,
      };
      thread.tasks.push(task);
      const res = { taskId: task.id, runId: run.id };
      this.db.retryOps[clientOperationId] = res;
      this.emitRaw(
        rec.project.id,
        "run.state",
        { state: "running" },
        { runId: run.id },
      );
      this.emitRaw(
        rec.project.id,
        "task.state",
        { state: "queued", slotIndex: task.slotIndex },
        { runId: run.id, taskId: task.id },
      );
      void this.runTask(rec, thread, run, task, "none").then(() =>
        this.finishRun(rec, thread, run),
      );
      return clone(res);
    }
    throw new ApiError("NOT_FOUND", "任务不存在", { status: 404 });
  }

  // ───────── Agent Run 模拟 ─────────
  private step(
    rec: ProjectRec,
    run: RunRec,
    tool: "read_canvas" | "generate_images" | "edit_image" | "ask_user",
    summary: string,
  ) {
    const stepId = uid("step");
    this.emitRaw(
      rec.project.id,
      "run.step",
      { stepId, tool, status: "started", summary },
      { runId: run.id },
    );
    return (status: "completed" | "failed", text: string) =>
      this.emitRaw(
        rec.project.id,
        "run.step",
        { stepId, tool, status, summary: text },
        { runId: run.id },
      );
  }
  private setRun(
    rec: ProjectRec,
    run: RunRec,
    state: RunState,
    error?: TaskError,
  ) {
    run.state = state;
    this.emitRaw(
      rec.project.id,
      "run.state",
      error ? { state, error } : { state },
      { runId: run.id },
    );
  }
  private finalMessage(
    rec: ProjectRec,
    thread: ThreadRec,
    run: RunRec,
    text: string,
  ) {
    const id = uid("msg");
    thread.messages.push({
      id,
      runId: run.id,
      role: "assistant",
      parts: [{ text }],
      createdAt: now(),
    });
    this.emitRaw(
      rec.project.id,
      "message.final",
      { messageId: id, parts: [{ type: "text", text }] },
      { runId: run.id },
    );
  }

  private async driveRun(rec: ProjectRec, thread: ThreadRec, run: RunRec) {
    const { text, settings: base, explicit } = run.submission;
    await sleep(500);
    if (this.cancelled.has(run.id)) return;
    this.setRun(rec, run, "planning");
    const done1 = this.step(rec, run, "read_canvas", "读取画布");
    await sleep(800);
    if (this.cancelled.has(run.id)) return;
    done1("completed", "工具已完成");

    // 文字要求覆盖默认值；文字与显式设置冲突先澄清
    const textCount = parseRequestedCount(text);
    let count = base.count;
    if (textCount && !explicit.includes("count")) count = textCount;
    else if (textCount && explicit.includes("count") && textCount !== count) {
      const ir: InputRec = {
        id: uid("input"),
        runId: run.id,
        question: `文字里写了 ${textCount} 张，但设置里选的是 ${count} 张，按哪个生成？`,
        choices: [
          { id: "text", label: `按文字，${textCount} 张` },
          { id: "setting", label: `按设置，${count} 张` },
        ],
        state: "pending",
      };
      thread.inputs.push(ir);
      const doneAsk = this.step(rec, run, "ask_user", "确认需求");
      this.setRun(rec, run, "waiting_input");
      this.emitRaw(
        rec.project.id,
        "input.requested",
        {
          id: ir.id,
          runId: run.id,
          question: ir.question,
          choices: ir.choices,
        },
        { runId: run.id },
      );
      const answer = await new Promise<{
        choiceId?: string | undefined;
        text?: string | undefined;
      }>((resolve) => this.answers.set(ir.id, resolve));
      if (this.cancelled.has(run.id)) return;
      ir.state = "answered";
      if (answer.choiceId === "text") count = textCount;
      doneAsk("completed", "工具已完成");
      this.setRun(rec, run, "planning");
    }
    const settings: Settings = { ...base, count };

    // 编辑：取第一个引用对应的画布元素作为来源（snapshot 的资源在画布上有同 fileId 的元素）
    const sourceSnapshot = run.submission.snapshotIds
      .map((id) => Object.values(this.db.snapshots).find((s) => s.id === id))
      .find(Boolean);
    const sourceEl = sourceSnapshot
      ? rec.canvas.elements.find(
          (e) => e.fileId === sourceSnapshot.assetId && !e.isDeleted,
        )
      : undefined;
    const editing = !!sourceSnapshot && /改|换|edit/i.test(text);
    const doneGen = this.step(
      rec,
      run,
      editing ? "edit_image" : "generate_images",
      editing ? "编辑图片" : "生成图片",
    );
    await sleep(600);
    if (this.cancelled.has(run.id)) return;
    const effectiveCount = editing ? 1 : count;
    const fallbackDims = sourceSnapshot
      ? { width: sourceSnapshot.width, height: sourceSnapshot.height }
      : undefined;
    const tasks: TaskRec[] = Array.from(
      { length: effectiveCount },
      (_, slot) => ({
        id: uid("task"),
        runId: run.id,
        slotIndex: slot,
        state: "queued" as TaskState,
        error: null,
        artifact: null,
        input: {
          prompt: effectiveCount > 1 ? `${text}（${conceptName(slot)}）` : text,
          settings,
          ...(sourceEl ? { sourceElementId: sourceEl.id } : {}),
          anchor: sourceEl
            ? worldBounds(
                sourceEl as {
                  x: number;
                  y: number;
                  width: number;
                  height: number;
                  angle?: number;
                },
              )
            : null,
          viewportCenter: run.submission.viewportCenter ?? { x: 0, y: 0 },
          ...(fallbackDims ? { fallbackDims } : {}),
        },
      }),
    );
    thread.tasks.push(...tasks);
    this.setRun(rec, run, "running");
    for (const t of tasks)
      this.emitRaw(
        rec.project.id,
        "task.state",
        { state: "queued", slotIndex: t.slotIndex },
        { runId: run.id, taskId: t.id },
      );
    doneGen("completed", "图片任务已排队");

    await Promise.all(
      tasks.map((task) => {
        const fail =
          /限流/.test(text) && task.slotIndex === 0
            ? "limit"
            : /失败|拒绝/.test(text) && task.slotIndex === effectiveCount - 1
              ? "refuse"
              : "none";
        return this.runTask(rec, thread, run, task, fail);
      }),
    );
    if (this.cancelled.has(run.id)) return;
    this.finishRun(rec, thread, run);
  }

  private finishRun(rec: ProjectRec, thread: ThreadRec, run: RunRec) {
    if (this.cancelled.has(run.id) || !RUN_ACTIVE_STATES.includes(run.state))
      return;
    const mine = thread.tasks.filter((t) => t.runId === run.id);
    const ok = mine.filter((t) => t.state === "committed").length;
    const failed = mine.filter((t) => t.state === "failed");
    // 与后端一致：有任务失败时 Run 为 failed，已成功的产物保留
    if (failed.length)
      this.setRun(rec, run, "failed", {
        code: failed[0]?.error?.code ?? "PROVIDER_ERROR",
        message: failed[0]?.error?.message ?? "生成失败",
        retryable: failed[0]?.error?.retryable ?? false,
      });
    else this.setRun(rec, run, "completed");
    this.finalMessage(
      rec,
      thread,
      run,
      failed.length === 0
        ? `完成了，${ok} 张结果已放到画布上。可以点选其中一张，再点“引用所选”继续改。`
        : ok > 0
          ? `${ok} 张已完成，${failed.length} 张没有成功${failed.some((f) => f.error?.retryable) ? "，可以在任务卡上重试" : ""}。`
          : `这次没有生成成功：${failed[0]?.error?.message ?? "未知原因"}`,
    );
  }

  private async runTask(
    rec: ProjectRec,
    thread: ThreadRec,
    run: RunRec,
    task: TaskRec,
    fail: "none" | "limit" | "refuse",
  ) {
    const pid = rec.project.id;
    const set = (state: TaskState, error?: TaskError) => {
      if (TASK_TERMINAL.includes(task.state)) return false;
      task.state = state;
      task.error = error ?? null;
      this.emitRaw(
        pid,
        "task.state",
        error
          ? { state, slotIndex: task.slotIndex, error }
          : { state, slotIndex: task.slotIndex },
        { runId: run.id, taskId: task.id },
      );
      return true;
    };
    const model = task.input.settings.modelId;
    const base =
      model === "gemini-3-pro-image"
        ? 5200
        : model === "gemini-3.1-flash-lite-image"
          ? 1500
          : 2800;
    // 后面的 slot 先完成：演示按 slotIndex 占位、结果整批重排而不是按返回顺序追加
    const dur =
      base +
      (hash(task.input.prompt) % 1200) +
      (task.input.settings.count - 1 - task.slotIndex) * 900;
    await sleep(300 + task.slotIndex * 350);
    if (!set("submitted")) return;
    await sleep(500);
    if (!set("running")) return;
    await sleep(dur);
    if (TASK_TERMINAL.includes(task.state)) return;
    if (fail === "limit") {
      set("failed", {
        code: "RATE_LIMITED",
        message: "模型服务繁忙（限流），稍后重试即可，不会扣额度",
        retryable: true,
      });
      return;
    }
    if (fail === "refuse") {
      set("failed", {
        code: "PROVIDER_ERROR",
        message: "模型拒绝了这条提示词，请调整描述后再试",
        retryable: false,
      });
      return;
    }
    if (!set("ingesting")) return;
    await sleep(700);
    if (TASK_TERMINAL.includes(task.state)) return;
    this.commit(rec, thread, run, task);
  }

  /** 入库 + 插入画布：整批按实际尺寸重排（与后端 ProjectRoom 一致），任务取消后不会走到这里 */
  private commit(
    rec: ProjectRec,
    thread: ThreadRec,
    run: RunRec,
    task: TaskRec,
  ) {
    const pid = rec.project.id;
    const px = actualPixels(
      task.input.settings.aspectRatio as never,
      task.input.settings.quality as never,
      task.input.fallbackDims,
    );
    const jpeg = task.input.settings.modelId === "gemini-3.1-flash-lite-image";
    const url = makeArtSvg({
      prompt: task.input.prompt,
      slot: task.slotIndex,
      width: px.width,
      height: px.height,
      model: task.input.settings.modelId,
    });
    const assetId = uid("asset");
    const asset: Asset = {
      id: assetId,
      url,
      width: px.width,
      height: px.height,
      sha256: sha(assetId),
      mime: jpeg ? "image/jpeg" : "image/png",
    };
    this.db.assets[assetId] = asset;
    const snapshotId = uid("snapshot");
    this.db.snapshots[`gen:${assetId}`] = {
      id: snapshotId,
      assetId,
      renderKey: `gen:${assetId}`,
      width: px.width,
      height: px.height,
      sourceAssetId: assetId,
    };
    const artifact: ArtifactPayload = {
      id: uid("artifact"),
      taskId: task.id,
      asset,
      snapshotId,
      mode: "fixture",
    };
    task.artifact = artifact;

    const display = fitLongEdge(px.width, px.height);
    const element = makeImageElement({
      id: `element_${task.id}`,
      fileId: assetId,
      rect: { x: 0, y: 0, ...display },
      customData: {
        taskId: task.id,
        artifactId: artifact.id,
        snapshotId,
        slotIndex: task.slotIndex,
        naturalWidth: px.width,
        naturalHeight: px.height,
      },
    });
    // 同一批（同一 Run）的兄弟任务：已完成的用实际尺寸，未完成的预留 360×360；整批重排
    const siblings = thread.tasks
      .filter((t) => t.runId === run.id)
      .sort((a, b) => a.slotIndex - b.slotIndex);
    const ids = new Set(siblings.map((s) => `element_${s.id}`));
    const sizes = siblings.map((s) => {
      if (s.id === task.id)
        return { width: display.width, height: display.height };
      const ex = rec.canvas.elements.find((e) => e.id === `element_${s.id}`);
      return ex
        ? { width: ex.width, height: ex.height }
        : { width: 360, height: 360 };
    });
    const obstacles = rec.canvas.elements
      .filter((e) => !e.isDeleted && !ids.has(e.id))
      .map((e) =>
        worldBounds(
          e as {
            x: number;
            y: number;
            width: number;
            height: number;
            angle?: number;
          },
        ),
      );
    const rects = layoutRow({
      sizes,
      source: task.input.anchor ?? undefined,
      viewportCenter: task.input.viewportCenter,
      obstacles,
    });
    const ops: CanvasOp[] = [];
    siblings.forEach((s, i) => {
      const r = must(rects[i]);
      const id = `element_${s.id}`;
      if (s.id === task.id) {
        const placed = { ...element, x: r.x, y: r.y } as CanvasElement;
        this.putElement(rec, placed);
        ops.push({ kind: "upsert", element: placed });
      } else {
        const ex = rec.canvas.elements.find((e) => e.id === id);
        if (ex && (ex.x !== r.x || ex.y !== r.y)) {
          const moved = {
            ...ex,
            x: r.x,
            y: r.y,
            version: ex.version + 1,
          } as CanvasElement;
          this.putElement(rec, moved);
          ops.push({ kind: "upsert", element: moved });
        }
      }
    });
    rec.canvas.revision += 1;
    for (const op of ops)
      if (op.kind === "upsert") rec.elRev[op.element.id] = rec.canvas.revision;
    rec.project.coverUrl = rec.project.coverUrl ?? url;
    rec.project.updatedAt = now();
    this.db.used += 1;
    this.emitRaw(
      pid,
      "canvas.ops",
      { revision: rec.canvas.revision, ops, source: "task" },
      { runId: run.id, taskId: task.id },
    );
    task.state = "committed";
    this.emitRaw(
      pid,
      "task.state",
      { state: "committed", slotIndex: task.slotIndex },
      { runId: run.id, taskId: task.id },
    );
    this.emitRaw(
      pid,
      "artifact.committed",
      { artifact, elementIds: [element.id], revision: rec.canvas.revision },
      { runId: run.id, taskId: task.id },
    );
    this.emitRaw(pid, "quota.updated", this.quota());
  }

  // ───────── 初始演示数据 ─────────
  private seed() {
    const demos = [
      {
        title: "手冲咖啡店开业海报",
        prompt: "手冲咖啡店开业海报，暖色调，留出标题位置",
        w: 768,
        h: 1024,
        ago: 3600_000 * 3,
      },
      {
        title: "运动鞋社媒方案",
        prompt: "轻量跑鞋的社媒主视觉，清爽的蓝绿配色",
        w: 1024,
        h: 1024,
        ago: 3600_000 * 26,
      },
    ];
    for (const d of demos) {
      const rec = this.newProject(d.title);
      const thread = this.newThread(rec, d.title);
      const run: RunRec = {
        id: uid("run"),
        threadId: thread.thread.id,
        state: "completed",
        submission: {
          text: d.prompt,
          settings: {
            count: 2,
            aspectRatio: "auto",
            quality: "standard",
            modelId: "auto",
          },
          explicit: [],
          snapshotIds: [],
          imageAssetIds: [],
        },
      };
      thread.messages.push({
        id: uid("msg"),
        runId: run.id,
        role: "user",
        parts: [{ text: d.prompt }],
        createdAt: new Date(Date.now() - d.ago).toISOString(),
      });
      thread.runs.push(run);
      this.emitRaw(
        rec.project.id,
        "run.state",
        { state: "queued" },
        { runId: run.id },
      );
      const read = this.step(rec, run, "read_canvas", "读取画布");
      read("completed", "工具已完成");
      const gen = this.step(rec, run, "generate_images", "生成图片");
      const tasks: TaskRec[] = [0, 1].map((slot) => ({
        id: uid("task"),
        runId: run.id,
        slotIndex: slot,
        state: "queued" as TaskState,
        error: null,
        artifact: null,
        input: {
          prompt: d.prompt,
          settings: run.submission.settings,
          anchor: null,
          viewportCenter: { x: 0, y: 0 },
          fallbackDims: { width: d.w, height: d.h },
        },
      }));
      thread.tasks.push(...tasks);
      this.emitRaw(
        rec.project.id,
        "run.state",
        { state: "running" },
        { runId: run.id },
      );
      for (const t of tasks)
        this.emitRaw(
          rec.project.id,
          "task.state",
          { state: "queued", slotIndex: t.slotIndex },
          { runId: run.id, taskId: t.id },
        );
      gen("completed", "图片任务已排队");
      for (const t of tasks) {
        t.state = "ingesting";
        this.commit(rec, thread, run, t);
      }
      this.setRun(rec, run, "completed");
      this.finalMessage(rec, thread, run, "完成了，2 张结果已放到画布上。");
      rec.project.updatedAt = new Date(Date.now() - d.ago).toISOString();
    }
    this.save();
  }
}

function textOf(parts: Array<{ type: string; text?: string }>): string {
  return parts
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}
