import { QUICK_SINGLE_SCENE_SHOT, SET_TEMPLATES, edgeErrorSchema, setResponseSchema, setTemplateSchema, type CreateSetRequest, type ProductAnalysis, type SetTemplate } from "@loomic/shared/edge";
import { ApiError, id, now, one, owned, roomCall, stmt } from "./core";
import type { Env } from "./types";

export interface SetRecord {
  id: string; project_id: string; thread_id: string; run_id: string; user_id: string;
  template_id: string; template: string; source_asset_ids: string; note: string; lang: "zh" | "en";
  state: "analyzing" | "generating" | "completed" | "partial" | "failed";
  analysis: string | null; supplied_points: string | null; analysis_started_at: number | null; error: string | null;
  single_regenerations: number;
}
export interface ShotRecord {
  set_id: string; shot_id: string; ordinal: number; task_id: string; frame_element_id: string;
  image_element_id: string | null; text_element_ids: string; state?: string; error?: string | null;
  provider_retry_at?: number | null;
}
export async function loadSet(env: Env, setId: string, userId?: string) {
  const set = await stmt(env, "SELECT * FROM image_sets WHERE id=?", setId).first<SetRecord>();
  if (!set) throw new ApiError("NOT_FOUND", "套图不存在", 404);
  if (userId) await owned(env, "projects", set.project_id, userId);
  return set;
}
export async function setShots(env: Env, setId: string) {
  return (await stmt(env, "SELECT s.*,t.state,t.error,t.provider_retry_at FROM set_shots s LEFT JOIN tasks t ON t.id=s.task_id WHERE s.set_id=? ORDER BY s.ordinal", setId).all<ShotRecord>()).results;
}
export function shotView(shot: ShotRecord) {
  return { shotId: shot.shot_id, state: shot.state === "committed" ? "completed" : shot.state || "queued", taskId: shot.task_id,
    ...(shot.provider_retry_at ? { retryAt: new Date(shot.provider_retry_at).toISOString() } : {}),
    frameElementId: shot.frame_element_id, ...(shot.image_element_id ? { imageElementId: shot.image_element_id } : {}),
    textElementIds: JSON.parse(shot.text_element_ids), ...(shot.error ? { error: JSON.parse(shot.error) } : {}) };
}
export async function setView(env: Env, setId: string, userId?: string) {
  const set = await loadSet(env, setId, userId);
  return setResponseSchema.parse({ setId: set.id, projectId: set.project_id, threadId: set.thread_id,
    templateId: set.template_id, state: set.state, lang: set.lang, ...(set.analysis ? { analysis: JSON.parse(set.analysis) } : {}),
    ...(set.error ? { error: JSON.parse(set.error) } : {}), shots: (await setShots(env, setId)).map(shot => shotView(!shot.state && set.state === "failed" ? { ...shot, state: "failed", error: set.error } : shot)) });
}
export async function reserveSet(env: Env, userId: string, ip: string, taskIds: string[], setAdmissionId?: string) {
  const gate = env.PROVIDER_GATE.get(env.PROVIDER_GATE.idFromName("global"));
  const response = await gate.fetch("https://gate/reserve-set", { method: "POST", body: JSON.stringify({ id: taskIds[0], ids: taskIds, userId, ipSubject: ip, setAdmissionId }) });
  if (!response.ok) {
    const { error } = edgeErrorSchema.parse(await response.json());
    throw new ApiError(error.code, error.message, 429, false, error.details);
  }
}
export async function refundSetAdmission(env: Env, admissionId: string) {
  const gate = env.PROVIDER_GATE.get(env.PROVIDER_GATE.idFromName("global"));
  const response = await gate.fetch("https://gate/refund-admission", { method: "POST", body: JSON.stringify({ id: admissionId }) });
  if (!response.ok) throw new ApiError("INTERNAL_ERROR", "套数退回暂未完成", 503, true);
}
export async function refundSetTask(env: Env, taskId: string) {
  const gate = env.PROVIDER_GATE.get(env.PROVIDER_GATE.idFromName("global"));
  const response = await gate.fetch("https://gate/refund-set", { method: "POST", body: JSON.stringify({ id: taskId }) });
  if (!response.ok) throw new ApiError("INTERNAL_ERROR", "额度退回暂未完成", 503, true);
}
export function selectTemplate(body: CreateSetRequest): SetTemplate {
  const template = SET_TEMPLATES.find(item => item.id === body.templateId);
  if (!template) throw new ApiError("INVALID_INPUT", "模板不存在", 422);
  const selected = structuredClone(template);
  // Explicit white-background requests win; all other nonempty notes select a scene.
  if (selected.id === "quick-single" && body.note?.trim() && !/白底|white\s*(?:back|ground)|pure\s*white/i.test(body.note)) {
    selected.shots = [structuredClone(QUICK_SINGLE_SCENE_SHOT)];
  }
  return setTemplateSchema.parse(selected);
}
export async function createSet(env: Env, userId: string, ip: string, body: CreateSetRequest) {
  const template = selectTemplate(body);
  const lang = template.lang === "auto" ? body.lang || (/[\p{Script=Han}]/u.test(body.note || "") ? "zh" : "en") : template.lang;
  const assets = await Promise.all(body.sourceAssetIds.map(assetId => owned(env, "assets", assetId, userId)));
  if (assets.some(asset => !["image/png", "image/jpeg", "image/webp"].includes(asset.mime)))
    throw new ApiError("INVALID_INPUT", "商品原图必须是 PNG、JPEG 或 WebP", 422);
  const setId = id("set");
  const projectId = id("project");
  const threadId = id("thread");
  const runId = id("run");
  const taskIds = template.shots.map(() => id("task"));
  const copies = assets.map(asset => ({ ...asset, id: id("asset") }));
  await reserveSet(env, userId, ip, taskIds, setId);
  try {
    await env.DB.batch([
      stmt(env, "INSERT INTO projects(id,user_id,title,created_at,updated_at,last_thread_id) VALUES(?,?,?,?,?,?)", projectId, userId, template.name, now(), now(), threadId),
      stmt(env, "INSERT INTO threads(id,project_id,title,created_at) VALUES(?,?,?,?)", threadId, projectId, "商品套图", now()),
      stmt(env, "INSERT INTO runs(id,project_id,thread_id,user_id,state,kind,frozen_submission,started_at,created_at,quota_ip) VALUES(?,?,?,?,'running','set',?,?,?,?)",
        runId, projectId, threadId, userId, JSON.stringify({ parts: [], references: [], settings: {}, settingsExplicitKeys: [] }), Date.now(), now(), ip),
      ...copies.map(asset => stmt(env, "INSERT INTO assets(id,user_id,project_id,storage_key,mime,byte_length,sha256,width,height,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        asset.id, userId, projectId, asset.storage_key, asset.mime, asset.byte_length, asset.sha256, asset.width, asset.height, now())),
      stmt(env, "INSERT INTO image_sets(id,project_id,thread_id,run_id,user_id,template_id,template,source_asset_ids,note,lang,state,supplied_points,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'analyzing',?,?,?)",
        setId, projectId, threadId, runId, userId, template.id, JSON.stringify(template), JSON.stringify(copies.map(asset => asset.id)), body.note || "", lang,
        body.sellingPoints ? JSON.stringify(body.sellingPoints) : null, now(), now()),
      ...template.shots.map((shot, ordinal) => stmt(env, "INSERT INTO set_shots(set_id,shot_id,ordinal,task_id,frame_element_id) VALUES(?,?,?,?,?)", setId, shot.id, ordinal, taskIds[ordinal], `frame_${setId}_${shot.id}`)),
    ]);
  } catch (error) {
    await Promise.all(taskIds.map(taskId => refundSetTask(env, taskId)));
    await refundSetAdmission(env, setId);
    throw error;
  }
  await roomCall(env, projectId, "set-init", { setId });
  return { setId, projectId, threadId };
}
export function parseAnalysis(set: SetRecord): ProductAnalysis {
  if (!set.analysis) throw new ApiError("INVALID_INPUT", "商品分析尚未完成", 409);
  return JSON.parse(set.analysis);
}
