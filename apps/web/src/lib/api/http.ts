import { type ZodTypeAny, z } from "zod";

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
  type CanvasOpsRequest,
  type ConnectionState,
  type EdgeEvent,
  type EventHandler,
  type MediaOpRequest,
  type MessageRequest,
  type SnapshotRequest,
  type StartRequest,
  answerResponseSchema,
  canvasOpsResponseSchema,
  capabilitiesResponseSchema,
  createProjectResponseSchema,
  createThreadResponseSchema,
  edgeErrorSchema,
  edgeEventSchema,
  meResponseSchema,
  mediaOpResponseSchema,
  messageResponseSchema,
  messagesResponseSchema,
  projectListResponseSchema,
  projectResponseSchema,
  retryTaskResponseSchema,
  snapshotResponseSchema,
  startResponseSchema,
  taskResponseSchema,
  uploadResponseSchema,
} from "./contract";
import {
  type CreateSetRequest,
  type PatchAnalysisBody,
  type RegenerateScope,
  createSetResponseSchema,
  publicSetTemplateSchema,
  setResponseSchema,
} from "../sets/types";

/** 响应与契约不符时给出明确报错（哪个接口、哪个字段），而不是静默放过 */
export function parseOrThrow<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  what: string,
): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue ? issue.path.join(".") || "(根)" : "?";
  throw new ApiError(
    "CONTRACT_MISMATCH",
    `${what}：响应与接口契约不符（${where}：${issue?.message ?? "未知"}）`,
    {
      details: r.error.issues,
    },
  );
}

const newClientOp = () =>
  `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** 同源 /api/*；后端契约见 packages/shared 的 edge-contracts 与 docs/接口.md */
export class HttpApiClient implements ApiClient {
  readonly mode = "http" as const;
  constructor(private readonly base = "") {}

  private async request(
    path: string,
    init: RequestInit & { json?: unknown } = {},
  ): Promise<unknown> {
    const { json, headers, ...rest } = init;
    const h = new Headers(headers);
    let body = rest.body;
    if (json !== undefined) {
      h.set("Content-Type", "application/json");
      body = JSON.stringify(json);
    }
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        credentials: "same-origin",
        ...rest,
        headers: h,
        ...(body != null ? { body } : {}),
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ApiError("NETWORK", "网络连接失败，请检查网络后重试", {
        retryable: true,
      });
    }
    if (!res.ok) {
      let payload: unknown;
      try {
        payload = await res.json();
      } catch {
        /* 非 JSON 错误体 */
      }
      const parsed = edgeErrorSchema.safeParse(payload);
      if (parsed.success) {
        const { code, message, retryable, details } = parsed.data.error;
        throw new ApiError(code, message, {
          retryable,
          status: res.status,
          details,
        });
      }
      throw new ApiError(
        res.status === 401 ? "UNAUTHENTICATED" : "INTERNAL_ERROR",
        `请求失败（${res.status}）`,
        {
          retryable: res.status >= 500,
          status: res.status,
        },
      );
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      throw new ApiError("CONTRACT_MISMATCH", `${path}：响应不是有效的 JSON`);
    }
  }

  async getSession(opts?: CallOptions): Promise<Me | null> {
    try {
      return parseOrThrow(
        meResponseSchema,
        await this.request("/api/me", { ...opts }),
        "GET /api/me",
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === "UNAUTHENTICATED") return null;
      throw e;
    }
  }
  async getQuota() {
    const me = await this.getSession();
    if (!me) throw new ApiError("UNAUTHENTICATED", "无法读取访客额度", { status: 401 });
    return me.quota;
  }
  async getCapabilities(opts?: CallOptions) {
    return parseOrThrow(
      capabilitiesResponseSchema,
      await this.request("/api/capabilities", { ...opts }),
      "GET /api/capabilities",
    );
  }

  // ───────── 模板一键出图（契约：docs/模板生图.md 与 shared 的 set-templates） ─────────
  async listTemplates(opts?: CallOptions) {
    return parseOrThrow(
      z.array(publicSetTemplateSchema),
      await this.request("/api/templates", { ...opts }),
      "GET /api/templates",
    );
  }
  async createSet(req: CreateSetRequest, opts?: CallOptions) {
    return parseOrThrow(
      createSetResponseSchema,
      await this.request("/api/sets", { method: "POST", json: req, ...opts }),
      "POST /api/sets",
    );
  }
  async getSet(setId: string, opts?: CallOptions) {
    return parseOrThrow(
      setResponseSchema,
      await this.request(`/api/sets/${encodeURIComponent(setId)}`, { ...opts }),
      "GET /api/sets/:id",
    );
  }
  async regenerateShot(setId: string, shotId: string) {
    await this.request(
      `/api/sets/${encodeURIComponent(setId)}/shots/${encodeURIComponent(shotId)}/regenerate`,
      { method: "POST", json: { clientOperationId: newClientOp() } },
    );
  }
  async regenerateSet(setId: string, scope: RegenerateScope) {
    await this.request(`/api/sets/${encodeURIComponent(setId)}/regenerate`, {
      method: "POST",
      json: { scope, clientOperationId: newClientOp() },
    });
  }
  async patchAnalysis(setId: string, body: PatchAnalysisBody) {
    await this.request(`/api/sets/${encodeURIComponent(setId)}/analysis`, {
      method: "PATCH",
      json: body,
    });
  }

  assetUrl(assetId: string) {
    return `${this.base}/api/assets/${encodeURIComponent(assetId)}`;
  }
  async uploadAsset(file: File, opts?: CallOptions & { projectId?: string }) {
    const form = new FormData();
    form.set("file", file);
    if (opts?.projectId) form.set("projectId", opts.projectId);
    const { projectId: _p, ...call } = opts ?? {};
    return parseOrThrow(
      uploadResponseSchema,
      await this.request("/api/uploads", {
        method: "POST",
        body: form,
        ...call,
      }),
      "POST /api/uploads",
    ).asset;
  }
  async createSnapshot(
    req: SnapshotRequest,
    png?: Blob,
    opts?: CallOptions,
  ): Promise<SnapshotResult> {
    let data: unknown;
    if (png) {
      const form = new FormData();
      form.set("metadata", JSON.stringify(req));
      form.set("file", new File([png], "snapshot.png", { type: "image/png" }));
      data = await this.request("/api/snapshots", {
        method: "POST",
        body: form,
        ...opts,
      });
    } else {
      data = await this.request("/api/snapshots", {
        method: "POST",
        json: req,
        ...opts,
      });
    }
    return parseOrThrow(snapshotResponseSchema, data, "POST /api/snapshots")
      .snapshot;
  }

  async listProjects(opts?: CallOptions) {
    return parseOrThrow(
      projectListResponseSchema,
      await this.request("/api/projects", { ...opts }),
      "GET /api/projects",
    ).items;
  }
  async createProject(title?: string) {
    return parseOrThrow(
      createProjectResponseSchema,
      await this.request("/api/projects", {
        method: "POST",
        json: title ? { title } : {},
      }),
      "POST /api/projects",
    ).project;
  }
  async startProject(req: StartRequest, opts?: CallOptions) {
    return parseOrThrow(
      startResponseSchema,
      await this.request("/api/projects/start", {
        method: "POST",
        json: req,
        ...opts,
      }),
      "POST /api/projects/start",
    );
  }
  async getProject(id: string, opts?: CallOptions) {
    return parseOrThrow(
      projectResponseSchema,
      await this.request(`/api/projects/${encodeURIComponent(id)}`, {
        ...opts,
      }),
      "GET /api/projects/:id",
    );
  }
  async renameProject(id: string, title: string) {
    await this.request(`/api/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      json: { title },
    });
  }
  async applyCanvasOps(projectId: string, req: CanvasOpsRequest) {
    return parseOrThrow(
      canvasOpsResponseSchema,
      await this.request(
        `/api/projects/${encodeURIComponent(projectId)}/canvas/ops`,
        { method: "POST", json: req },
      ),
      "POST /api/projects/:id/canvas/ops",
    );
  }

  async createThread(projectId: string) {
    return parseOrThrow(
      createThreadResponseSchema,
      await this.request("/api/threads", {
        method: "POST",
        json: { projectId },
      }),
      "POST /api/threads",
    ).thread;
  }
  async getMessages(threadId: string, opts?: CallOptions) {
    return parseOrThrow(
      messagesResponseSchema,
      await this.request(
        `/api/threads/${encodeURIComponent(threadId)}/messages`,
        { ...opts },
      ),
      "GET /api/threads/:id/messages",
    );
  }
  async postMessage(threadId: string, req: MessageRequest, opts?: CallOptions) {
    return parseOrThrow(
      messageResponseSchema,
      await this.request(
        `/api/threads/${encodeURIComponent(threadId)}/messages`,
        { method: "POST", json: req, ...opts },
      ),
      "POST /api/threads/:id/messages",
    );
  }
  async cancelRun(runId: string) {
    await this.request(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
    });
  }
  async answerInputRequest(id: string, req: AnswerRequest) {
    parseOrThrow(
      answerResponseSchema,
      await this.request(
        `/api/input-requests/${encodeURIComponent(id)}/answers`,
        { method: "POST", json: req },
      ),
      "POST /api/input-requests/:id/answers",
    );
  }
  async mediaOp(req: MediaOpRequest) {
    return parseOrThrow(
      mediaOpResponseSchema,
      await this.request("/api/media/ops", { method: "POST", json: req }),
      "POST /api/media/ops",
    );
  }
  async retryTask(taskId: string, clientOperationId: string) {
    return parseOrThrow(
      retryTaskResponseSchema,
      await this.request(`/api/tasks/${encodeURIComponent(taskId)}/retry`, {
        method: "POST",
        json: { clientOperationId },
      }),
      "POST /api/tasks/:id/retry",
    );
  }

  async getEvents(
    projectId: string,
    cursor: number,
    opts?: CallOptions,
  ): Promise<EdgeEvent[]> {
    const data = (await this.request(
      `/api/projects/${encodeURIComponent(projectId)}/events?cursor=${cursor}`,
      { ...opts },
    )) as { items?: unknown[] };
    if (!Array.isArray(data?.items))
      throw new ApiError(
        "CONTRACT_MISMATCH",
        "GET /api/projects/:id/events：缺少 items",
      );
    return data.items.map((it, i) =>
      parseOrThrow(edgeEventSchema, it, `事件 #${i}`),
    );
  }

  subscribe(
    projectId: string,
    cursor: number,
    handler: EventHandler,
    onConnection?: (s: ConnectionState) => void,
    onError?: (e: ApiError) => void,
  ): Subscription {
    let lastSeq = cursor;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      onConnection?.(attempt === 0 ? "connecting" : "reconnecting");
      const origin = this.base || window.location.origin;
      const url = `${origin.replace(/^http/, "ws")}/api/projects/${encodeURIComponent(projectId)}/ws?cursor=${lastSeq}`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempt = 0;
        onConnection?.("open");
      };
      ws.onmessage = (m) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(m.data));
        } catch {
          onError?.(
            new ApiError("CONTRACT_MISMATCH", "WebSocket 收到无法解析的帧"),
          );
          return;
        }
        const parsed = edgeEventSchema.safeParse(raw);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          onError?.(
            new ApiError(
              "CONTRACT_MISMATCH",
              `WebSocket 事件与契约不符（${(raw as { type?: string })?.type ?? "?"}：${issue?.path.join(".")}：${issue?.message}）`,
              { details: parsed.error.issues },
            ),
          );
          return;
        }
        const ev = parsed.data;
        if (ev.seq <= lastSeq) return; // 补发与实时可能重叠，按 seq 去重
        lastSeq = ev.seq;
        handler(ev);
      };
      ws.onclose = () => {
        if (closed) return;
        onConnection?.("reconnecting");
        attempt += 1;
        timer = setTimeout(
          connect,
          Math.min(15000, 500 * 2 ** Math.min(attempt, 5)),
        );
      };
      ws.onerror = () => ws?.close();
    };
    connect();
    return {
      close() {
        closed = true;
        if (timer) clearTimeout(timer);
        ws?.close();
        onConnection?.("closed");
      },
    };
  }
}
