import type { EdgeErrorCode } from "@loomic/shared/edge";
import { edgeErrorSchema } from "@loomic/shared/edge";
import type { Env, Row } from "./types";
export class ApiError extends Error {
  constructor(
    public code: EdgeErrorCode,
    message: string,
    public status = 400,
    public retryable = false,
    public details?: unknown,
  ) {
    super(message);
  }
  body() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export const now = () => new Date().toISOString();
export const hash = async (value: string | Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? new TextEncoder().encode(value) : value,
      ),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export const stmt = (env: Env, sql: string, ...args: unknown[]) =>
  env.DB.prepare(sql).bind(...args);
export const one = (env: Env, sql: string, ...args: unknown[]) =>
  stmt(env, sql, ...args).first<Row>();
export const all = async (env: Env, sql: string, ...args: unknown[]) =>
  (await stmt(env, sql, ...args).all<Row>()).results;
export function requireRow(row: Row | null): Row {
  if (!row) throw new ApiError("NOT_FOUND", "资源不存在", 404);
  return row;
}
export async function owned(
  env: Env,
  table: "projects" | "assets" | "appearance_snapshots" | "runs" | "tasks",
  resourceId: string,
  userId: string,
) {
  const row = requireRow(await one(env, `SELECT * FROM ${table} WHERE id=?`, resourceId));
  if (row.user_id !== userId) throw new ApiError("FORBIDDEN", "无权访问此资源", 403);
  const projectId = table === "projects" ? row.id : row.project_id;
  if (projectId) {
    const touched = await stmt(env, "UPDATE projects SET last_accessed_at=? WHERE id=? AND deleting=0 RETURNING id", now(), projectId).first();
    if (!touched) throw new ApiError("NOT_FOUND", "项目已过期清理", 404);
  }
  return row;
}
export async function threadOwned(env: Env, threadId: string, userId: string) {
  const row = requireRow(await one(env, "SELECT * FROM threads WHERE id=?", threadId));
  await owned(env, "projects", row.project_id, userId);
  return row;
}
export const room = (env: Env, projectId: string) =>
  env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
export async function roomCall(env: Env, projectId: string, path: string, data: unknown = {}) {
  const response = await room(env, projectId).fetch(`https://room/${path}`, {
    method: "POST",
    body: JSON.stringify({ projectId, ...(data as object) }),
  });
  if (!response.ok) {
    const result = edgeErrorSchema.parse(await response.json());
    throw new ApiError(
      result.error.code,
      result.error.message,
      response.status,
      result.error.retryable,
      result.error.details,
    );
  }
  return response.json<Record<string, unknown>>();
}
export function quotaDay(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}
export function configuredInt(value: string, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new ApiError("INTERNAL_ERROR", "服务额度或并发配置无效", 503);
  return parsed;
}
export async function quota(env: Env, userId: string, ipSubject = "local") {
  const limit = configuredInt(env.GUEST_DAILY_IMAGES ?? env.GLOBAL_DAILY_IMAGES ?? "150");
  const globalLimit = configuredInt(env.GLOBAL_DAILY_IMAGES ?? "150");
  const runsLimit = configuredInt(env.GUEST_DAILY_RUNS ?? "30");
  const day = quotaDay();
  const rows = await all(env,
    "SELECT user_id,ip_subject,kind,state,COUNT(*) n FROM quota_reservations WHERE day=? AND state IN ('reserved','counted') GROUP BY user_id,ip_subject,kind,state", day);
  const count = (kind: string, predicate: (r: Row) => boolean) => rows.filter(r => r.kind === kind && predicate(r)).reduce((n,r) => n + Number(r.n), 0);
  const personal = count("image", r => r.user_id === userId);
  const used = count("image", r => r.user_id === userId && r.state === "counted");
  const ipRemaining = Math.max(0, limit - count("image", r => r.ip_subject === ipSubject));
  const globalRemaining = Math.max(0, globalLimit - count("image", () => true));
  const runsRemaining = Math.max(0, runsLimit - count("text", r => r.ip_subject === ipSubject));
  const setsUsed = await one(env, "SELECT COUNT(*) n FROM set_admissions WHERE day=? AND ip_subject=?", day, ipSubject);
  const setsRemaining = Math.max(0, configuredInt(env.GUEST_DAILY_SETS ?? "2") - Number(setsUsed?.n || 0));
  return { used, limit, remaining: Math.min(Math.max(0, limit - personal), ipRemaining, globalRemaining),
    ipRemaining, globalRemaining, runsRemaining, setsRemaining,
    resetAt: new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString() };
}
export async function assertBudget(env: Env, userId: string, ip: string, kind: "image" | "text") {
  const usage = await quota(env, userId, ip);
  const globalExceeded = kind === "image" && usage.globalRemaining === 0;
  if (globalExceeded || (kind === "image" ? usage.remaining : usage.runsRemaining) === 0)
    throw new ApiError(globalExceeded ? "QUOTA_EXCEEDED_GLOBAL" : "QUOTA_EXCEEDED_IP",
      globalExceeded ? "今日全站图片额度已用尽，请明日再来" : kind === "image" ? "此访客或 IP 的今日图片额度已用尽" : "此 IP 的今日文本调用额度已用尽",
      429, false, usage);
}
export const assetView = (r: Pick<Row, "id" | "width" | "height" | "sha256" | "mime">) => ({
  id: r.id,
  url: `/api/assets/${r.id}`,
  width: r.width,
  height: r.height,
  sha256: r.sha256,
  mime: r.mime,
});
export const projectView = (r: Row) => ({
  id: r.id,
  title: r.title,
  coverUrl: r.cover_url,
  updatedAt: r.updated_at,
  lastThreadId: r.last_thread_id,
  ...(r.set_id ? { setId: r.set_id } : {}),
});
export const threadView = (r: Row) => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  createdAt: r.created_at,
  isSystem: !!r.is_system,
});
export function publicError(err: unknown) {
  if (err instanceof Error && err.message.includes("project_canvas_limit"))
    return new ApiError("CANVAS_LIMIT_EXCEEDED", "单项目最多保留5000个画布元素，请使用新项目继续", 422);
  return err instanceof ApiError
    ? err
    : new ApiError("INTERNAL_ERROR", "服务暂时不可用", 500, true);
}
