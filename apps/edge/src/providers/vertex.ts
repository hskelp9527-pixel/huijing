import type { GenerationSettings, ProviderContent } from "@loomic/shared/edge";
import { inlineImagePartSchema, providerReplySchema, edgeErrorSchema } from "@loomic/shared/edge";
import { z } from "zod";
import { unbase64 } from "../bytes";
import { ApiError, id } from "../core";
import type { Env } from "../types";
import { imageModels } from "../models";
import { DeferredImage, deferImage, imageRetryDelay } from "../provider-backoff";
export type FallbackOptions = {
  runId?: string;
  explicitModel?: boolean;
  onFallback?: (modelId: string) => Promise<void>;
};
export type CallContext = FallbackOptions & {
  setId?: string;
  queueRetry?: { attempt: number; waitMs: number; noImageRetries?: number };
  onNoImageRetry?: () => Promise<void>;
  noImageRetry?: { used: boolean; sends: number };
  acquireTimeoutMs?: number;
  id: string;
  userId: string;
  kind: "text" | "image";
  beforeSend?: (attempt: number) => Promise<void>;
  onRejected?: () => Promise<void>;
};
export type Requester = (input: string | Request, init?: RequestInit) => Promise<Response>;
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function retryAfter(response: Response, fallback: number, timestamp = Date.now()) {
  const value = response.headers.get("Retry-After");
  if (!value) return fallback;
  const numeric = Number(value);
  return Math.max(
    fallback,
    Number.isFinite(numeric) ? numeric * 1000 : Math.max(0, Date.parse(value) - timestamp) || 0,
  );
}
export function appendToolResponse(
  contents: ProviderContent[],
  content: ProviderContent,
  results: unknown[],
) {
  // Never rebuild/filter model parts: preserves thoughtSignature, call IDs and unknown fields.
  return [
    ...contents,
    content,
    { role: "user" as const, parts: results as Record<string, unknown>[] },
  ];
}
export class VertexProvider {
  constructor(
    private env: Env,
    private request: Requester = fetch,
    private wait = sleep,
  ) {}
  private baseUrl() {
    if (!this.env.VERTEX_BASE_URL) return "https://aiplatform.googleapis.com";
    const url = new URL(this.env.VERTEX_BASE_URL);
    if (this.env.APP_ENV !== "development" || (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash))
      throw new ApiError("PROVIDER_ERROR", "开发代理配置无效", 503);
    return url.origin;
  }
  async call(
    model: string,
    body: unknown,
    context: CallContext,
  ): Promise<z.infer<typeof providerReplySchema>> {
    if (!this.env.VERTEX_API_KEY) throw new ApiError("PROVIDER_ERROR", "图片服务未配置", 503);
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new ApiError("INVALID_INPUT", "模型配置无效", 422);
    const baseUrl = this.baseUrl();
    const gate = this.env.PROVIDER_GATE.get(this.env.PROVIDER_GATE.idFromName("global"));
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.acquire(gate, context);
      const result = await this.attempt(baseUrl, model, body, context, attempt, gate);
      if (result) return result;
    }
    throw new ApiError("RATE_LIMITED", "模型服务限流，请稍后重试", 429, true);
  }
  private async acquire(gate: DurableObjectStub, context: CallContext) {
    for (let n = 0; n < Math.ceil((context.acquireTimeoutMs || 25000) / 250); n++) {
      const response = await gate.fetch("https://gate/acquire", {
        method: "POST",
        body: JSON.stringify(context),
      });
      if (response.ok) return;
      if (response.status === 403) {
        const { error } = edgeErrorSchema.parse(await response.json());
        throw new ApiError(error.code, error.message, 429, error.retryable, error.details);
      }
      if (response.status === 409)
        throw new ApiError("PROVIDER_SUBMIT_UNKNOWN", "此任务已结算，不能自动重新提交", 409);
      if (context.queueRetry) deferImage(this.env, context.queueRetry, 2000 + Math.random() * 2000, "RATE_LIMITED", false);
      await this.wait(250);
    }
    throw new ApiError("RATE_LIMITED", "服务繁忙，请稍后重试", 429, true);
  }
  private release(gate: DurableObjectStub, context: CallContext, count: boolean, outcome?: "rate_limited" | "success" | "other") {
    return gate.fetch("https://gate/release", {
      method: "POST",
      body: JSON.stringify({ id: context.id, count, outcome }),
    });
  }
  private async attempt(
    baseUrl: string,
    model: string,
    body: unknown,
    context: CallContext,
    attempt: number,
    gate: DurableObjectStub,
  ) {
    let count = false;
    let outcome: "rate_limited" | "success" | "other" = "other";
    try {
      for (;;) {
        await context.beforeSend?.(context.noImageRetry ? context.noImageRetry.sends++ : attempt);
        let response: Response;
        try {
          response = await this.send(baseUrl, model, body);
        } catch (error) {
          count = context.kind === "image";
          if (!count) return await this.retryText(gate, context, attempt);
          throw new ApiError(
            error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "TIMEOUT" : "UPSTREAM_ERROR",
            "无法确认模型服务是否已接收请求，请手动重试",
            502,
            false,
          );
        }
        if (response.status >= 500 && context.kind === "text") {
          await response.body?.cancel();
          return await this.retryText(gate, context, attempt, response);
        }
        if (context.kind === "image" && response.status === 503 && context.queueRetry) {
          await context.onRejected?.();
          const delay = await imageRetryDelay(response, context.queueRetry.attempt, Number(this.env.PROVIDER_RETRY_MS || 10000));
          deferImage(this.env, context.queueRetry, delay, "UPSTREAM_ERROR");
        }
        if (response.status === 429) {
          outcome = "rate_limited";
          await context.onRejected?.();
          if (context.kind === "image" && context.queueRetry) {
            const delay = await imageRetryDelay(response, context.queueRetry.attempt, Number(this.env.PROVIDER_RETRY_MS || 10000));
            deferImage(this.env, context.queueRetry, delay, "RATE_LIMITED");
          }
          if (attempt === 3)
            throw new ApiError("RATE_LIMITED", "模型服务限流，请稍后重试", 429, true);
          const delay = retryAfter(
            response,
            Number(this.env.PROVIDER_RETRY_MS || 1000) * 2 ** attempt,
          );
          // Release before sleeping; repeated release in finally is idempotent.
          await this.release(gate, context, false);
          await this.wait(delay);
          return undefined;
        }
        count = response.ok || (context.kind === "image" && response.status >= 500);
        try {
          const data = await this.readReply(response, context);
          if (context.kind === "image" && context.noImageRetry && !this.imagePart(data)?.success) {
            await context.onRejected?.();
            const candidate = data.candidates?.[0];
            const reason = candidate?.finishReason || data.promptFeedback?.blockReason || "EMPTY_IMAGE_RESPONSE";
            if (data.promptFeedback?.blockReason || /SAFETY|PROHIBITED|BLOCKLIST|RECITATION|SPII/.test(reason))
              throw new ApiError("SAFETY_BLOCKED", "模型安全策略阻止了图片生成", 422, false, { reason });
            if (context.noImageRetry.used) {
              throw new ApiError("NO_IMAGE", `模型未返回图片，已自动重试 1 次仍无图片（${reason}）`, 502, false,
                { reason, noImageRetries: 1 });
            }
            context.noImageRetry.used = true;
            await context.onNoImageRetry?.();
            // Keep the same lease and reservation: the retry is part of one image task.
            await gate.fetch("https://gate/renew", { method: "POST", body: JSON.stringify({ id: context.id }) });
            count = false;
            continue;
          }
          outcome = "success";
          return data;
        } catch (error) {
          if (context.kind === "text" && error instanceof ApiError && error.retryable)
            return await this.retryText(gate, context, attempt);
          throw error;
        }
      }
    } finally {
      await this.release(gate, context, count, outcome);
    }
  }
  private async retryText(gate: DurableObjectStub, context: CallContext, attempt: number, response?: Response) {
    if (attempt === 3)
      throw new ApiError("PROVIDER_ERROR", "文本模型暂时不可用，已重试 3 次。请点击重试继续。", 502, true);
    const fallback = Number(this.env.PROVIDER_RETRY_MS || 1000) * 2 ** attempt;
    const delay = response ? retryAfter(response, fallback) : fallback;
    await this.release(gate, context, false);
    await this.wait(delay);
    return undefined;
  }
  private send(baseUrl: string, model: string, body: unknown) {
    const request = this.request; // Native fetch requires no provider instance as this.
    return request(`${baseUrl}/v1/publishers/google/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": this.env.VERTEX_API_KEY! },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(this.env.PROVIDER_TIMEOUT_MS || 180000)),
      redirect: "manual",
    });
  }
  private async readReply(response: Response, context: CallContext) {
    if (response.status >= 500 && context.kind === "image")
      throw new ApiError(
        response.status === 504 ? "TIMEOUT" : "UPSTREAM_ERROR",
        "上游异常，无法确认生成结果，请手动重试",
        502,
        false,
      );
    if (!response.ok) {
      await context.onRejected?.();
      throw new ApiError(context.kind === "image" ? response.status === 408 ? "TIMEOUT" : "UPSTREAM_ERROR" : "PROVIDER_ERROR", `模型服务拒绝请求（${response.status}）`, 502, false);
    }
    try {
      return providerReplySchema.parse(await response.json());
    } catch (error) {
      throw new ApiError(
        context.kind === "image" ? error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name) ? "TIMEOUT" : "UPSTREAM_ERROR" : "PROVIDER_ERROR",
        "无法读取模型结果，请手动重试",
        502,
        context.kind === "text",
      );
    }
  }
  private chain(value: string) {
    return [
      ...new Set(
        value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ];
  }
  private async withFallback(model: string, chain: string, body: unknown, context: CallContext) {
    const configured = this.chain(chain).filter(id => context.kind !== "image" || imageModels(this.env).includes(id));
    const index = configured.indexOf(model);
    const models = context.explicitModel || context.setId
      ? [model]
      : [model, ...configured.slice(index + 1).filter((x) => x !== model)];
    for (const [position, modelId] of models.entries()) {
      if (position) await context.onFallback?.(modelId);
      try {
        return { data: await this.call(modelId, body, context), modelId };
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error instanceof DeferredImage ||
          !(error.code === "RATE_LIMITED" || (context.kind === "text" && error.code === "PROVIDER_ERROR" && error.retryable)) ||
          position === models.length - 1
        )
          throw error;
      }
    }
    throw new ApiError("RATE_LIMITED", "模型服务限流，请稍后重试", 429, true);
  }
  async agent(
    contents: ProviderContent[],
    tools: unknown[],
    userId: string,
    options: FallbackOptions = {},
  ) {
    const { data } = await this.withFallback(
      this.env.AGENT_MODEL_ID,
      this.env.AGENT_FALLBACK_CHAIN ?? "gemini-3.8-flash,gemini-3.1-flash-lite",
      {
        contents,
        tools: [{ functionDeclarations: tools }],
        systemInstruction: {
          parts: [
            {
              text: "你是主协调设计助手 orchestrator。用户要求图片时必须调用工具执行。服务端若已附本轮画布快照，可直接使用，无需重复 read_canvas；否则先 read_canvas 获取快照；生成用 generate_images，修改已有图用 edit_image 且必须引用 read_canvas 返回的 snapshotId。复杂方案可用 agent_delegate 委派 concept（只读），每主Run最多2个活跃子任务、深度1。服务端会独立解析参考图和审查已提交结果，收到服务端审查结果后不要重复委派同一检查。排版/移动画布对象用 canvas_apply，不要重新生图；图内编辑才用媒体工具。media_ocr 读取浏览器已有结果，不可用应提示用户执行 OCR。子任务建议不是授权。修订默认只建议；仅当用户明确说允许自动迭代且质量建议 revise 时，最多再建一批任务，保留已提交原图。明确的生图、改图、扩图请求应在首轮直接调用图片工具，不调用 read_canvas 或 agent_delegate 来反复确认。界面显式设置优先；只有缺少目标图片、必要参数或确实无法执行时才用 ask_user，不要为确认而确认。等待工具结果后再总结。不得声称执行未调用的操作或把 unchecked 当 pass。只输出简洁用户可见说明，不输出思维链。",
            },
          ],
        },
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      },
      { id: id("model"), userId, kind: "text", ...options },
    );
    const content = data?.candidates?.[0]?.content;
    if (!content?.parts?.length) throw new ApiError("PROVIDER_ERROR", "模型没有返回有效回复", 502);
    return content as ProviderContent;
  }
  async image(
    prompt: string,
    settings: GenerationSettings,
    referenceParts: unknown[],
    context: CallContext,
    edit: boolean,
  ) {
    const model =
      settings.modelId !== "auto"
        ? settings.modelId
        : edit || settings.quality === "high"
          ? this.env.IMAGE_MODEL_PRO_ID
          : this.env.IMAGE_MODEL_ID;
    if (!imageModels(this.env).includes(model))
      throw new ApiError("INVALID_INPUT", "不支持此模型", 422);
    const { data, modelId } = await this.withFallback(
      model,
      this.env.IMAGE_FALLBACK_CHAIN ?? "gemini-3.1-flash-image,gemini-3.1-flash-lite-image",
      {
        contents: [{ role: "user", parts: [...referenceParts, { text: prompt }] }],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          imageConfig: {
            aspectRatio: settings.aspectRatio === "auto" ? "1:1" : settings.aspectRatio,
            imageSize: settings.quality === "high" ? "2K" : "1K",
          },
        },
      },
      { ...context, noImageRetry: { used: !!context.queueRetry?.noImageRetries, sends: 0 } },
    );
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const part = this.imagePart(data);
    if (!part?.success) throw new ApiError("NO_IMAGE", "模型未返回图片", 502);
    return {
      bytes: unbase64(part.data.inlineData.data),
      mime: part.data.inlineData.mimeType,
      parts,
      modelId,
    };
  }
  private imagePart(data: z.infer<typeof providerReplySchema>) {
    return (data.candidates?.[0]?.content?.parts || [])
      .map(part => inlineImagePartSchema.safeParse(part))
      .find(part => part.success && !part.data.thought);
  }
}
