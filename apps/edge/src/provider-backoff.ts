import { ApiError, configuredInt } from "./core";
import type { Env } from "./types";

export function parseRetryAfter(value: string | null, timestamp = Date.now()): number | undefined {
  if (value === null || !value.trim()) return undefined;
  const numeric = Number(value);
  const delay = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(value) - timestamp;
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
}
export function retryInfo(data: unknown): number | undefined {
  const details = (data as { error?: { details?: unknown[] } })?.error?.details;
  if (!Array.isArray(details)) return undefined;
  const delays = details.flatMap((detail: any) => {
    if (detail?.["@type"] !== "type.googleapis.com/google.rpc.RetryInfo") return [];
    const duration = detail.retryDelay;
    const seconds = typeof duration === "string" && /^\d+(\.\d{1,9})?s$/.test(duration)
      ? Number(duration.slice(0, -1))
      : duration && typeof duration === "object" && /^\d+$/.test(String(duration.seconds ?? 0)) &&
        Number.isInteger(duration.nanos ?? 0) && (duration.nanos ?? 0) >= 0 && (duration.nanos ?? 0) < 1e9
        ? Number(duration.seconds ?? 0) + Number(duration.nanos ?? 0) / 1e9 : NaN;
    return Number.isFinite(seconds) && seconds >= 0 ? [seconds * 1000] : [];
  });
  return delays.length ? Math.max(...delays) : undefined;
}
export async function imageRetryDelay(response: Response, attempt: number, baseMs = 10000, random = Math.random) {
  const header = parseRetryAfter(response.headers.get("Retry-After"));
  let info: number | undefined;
  try { info = retryInfo(await response.json()); } catch { /* Errors may have non-JSON bodies. */ }
  if (header !== undefined || info !== undefined) return Math.max(header ?? 0, info ?? 0);
  // Equal jitter prevents synchronized retries while keeping a meaningful minimum delay.
  return Math.min(60000, baseMs * 2 ** Math.min(attempt, 16)) * (0.5 + random() * 0.5);
}
export class DeferredImage extends ApiError {
  constructor(public delayMs: number, public upstream: boolean, code: "RATE_LIMITED" | "UPSTREAM_ERROR") {
    super(code, "图片正在排队，稍后继续生成", code === "RATE_LIMITED" ? 429 : 503, true);
  }
}
export function deferImage(env: Env, state: { attempt: number; waitMs: number }, delayMs: number,
  code: "RATE_LIMITED" | "UPSTREAM_ERROR", upstream = true): never {
  const limit = configuredInt(env.PROVIDER_RETRY_MAX_WAIT_MS ?? "600000", 1);
  const remaining = limit - state.waitMs;
  // Queue timers have second precision. Never retry before the server's minimum delay.
  const rounded = Math.max(1000, Math.ceil(delayMs / 1000) * 1000);
  if (rounded > remaining) throw new ApiError(code,
    code === "RATE_LIMITED" ? "模型持续限流，已达到图片排队等待上限，请稍后重试" : "上游服务持续不可用，已达到图片排队等待上限，请稍后重试",
    code === "RATE_LIMITED" ? 429 : 503, true, { waitMs: state.waitMs, maxWaitMs: limit });
  throw new DeferredImage(rounded, upstream, code);
}
