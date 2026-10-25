import { ApiError } from "./core";
import type { Env } from "./types";

export function imageModels(env: Env) {
  const models = [...new Set((env.IMAGE_MODEL_ALLOWLIST ?? `${env.IMAGE_MODEL_ID},${env.IMAGE_MODEL_PRO_ID},gemini-3.1-flash-lite-image,${env.IMAGE_FALLBACK_CHAIN || ""}`)
    .split(",").map(s => s.trim()).filter(Boolean))];
  if (!models.length || models.some(s => !/^[a-zA-Z0-9._-]+$/.test(s)))
    throw new ApiError("INTERNAL_ERROR", "图片模型白名单配置无效", 503);
  return models;
}
export function assertImageModel(env: Env, modelId: string) {
  if (modelId !== "auto" && !imageModels(env).includes(modelId))
    throw new ApiError("INVALID_INPUT", "不支持此图片模型，请选择可用模型", 422);
}
