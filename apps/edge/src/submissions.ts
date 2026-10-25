import type { Submission } from "@loomic/shared/edge";
import { directIntent } from "./direct";
import { assertBudget, ApiError, hash, id, now, one, owned, roomCall, stmt } from "./core";
import type { Env, Row } from "./types";
import { assertImageModel } from "./models";
export async function validateResources(
  env: Env,
  userId: string,
  submission: Submission,
  projectId?: string,
) {
  assertImageModel(env, submission.settings.modelId);
  const snapshots: Row[] = [];
  const assets: Row[] = [];
  for (const ref of submission.references) {
    const snapshot = await owned(env, "appearance_snapshots", ref.snapshotId, userId);
    if (snapshot.project_id && snapshot.project_id !== projectId)
      throw new ApiError("FORBIDDEN", "参考快照已归属其他项目", 403);
    snapshots.push(snapshot);
    for (const assetId of new Set([snapshot.asset_id, snapshot.source_asset_id]))
      assets.push(await owned(env, "assets", assetId, userId));
  }
  for (const part of submission.parts)
    if (part.type === "image") {
      const asset = await owned(env, "assets", part.assetId, userId);
      if (asset.project_id && asset.project_id !== projectId)
        throw new ApiError("FORBIDDEN", "图片已归属其他项目", 403);
      assets.push(asset);
    }
  if (submission.references.length + submission.parts.filter((p) => p.type === "image").length > 4)
    throw new ApiError("INVALID_INPUT", "最多引用四张图片", 422);
  return {
    assets: [...new Map(assets.map((a) => [a.id, a])).values()],
    snapshots,
  };
}
export function runWrites(
  env: Env,
  userId: string,
  projectId: string,
  threadId: string,
  runId: string,
  messageId: string,
  submission: Submission,
  initiatorClientId = `user:${userId}`,
  quotaIp = "local",
) {
  return [
    stmt(
      env,
      "INSERT INTO runs(id,project_id,thread_id,user_id,state,frozen_submission,started_at,created_at,initiator_client_id,quota_ip) VALUES(?,?,?,?,'queued',?,?,?,?,?)",
      runId,
      projectId,
      threadId,
      userId,
      JSON.stringify(submission),
      Date.now(),
      now(),
      initiatorClientId,
      quotaIp,
    ),
    stmt(
      env,
      "INSERT INTO messages(id,project_id,thread_id,run_id,role,parts,created_at) VALUES(?,?,?,?,?,?,?)",
      messageId,
      projectId,
      threadId,
      runId,
      "user",
      JSON.stringify(submission.parts),
      now(),
    ),
  ];
}
export async function start(env: Env, userId: string, key: string, submission: Submission, initiatorClientId = `user:${userId}`, quotaIp = "local") {
  const digest = await hash(JSON.stringify(submission));
  const replay = async () => {
    const previous = await one(
      env,
      "SELECT * FROM idempotency WHERE user_id=? AND scope='start' AND key=?",
      userId,
      key,
    );
    if (previous && previous.hash !== digest)
      throw new ApiError("IDEMPOTENCY_MISMATCH", "submissionId 已用于其他内容", 409);
    return previous ? JSON.parse(previous.response) : null;
  };
  const old = await replay();
  if (old) {
    await roomCall(env, old.projectId, "wake");
    return { response: old, created: false };
  }
  await assertBudget(env, userId, quotaIp, directIntent(submission.parts.map(p => p.type === "text" ? p.text : "").join(" ")) ? "image" : "text");
  const resources = await validateResources(env, userId, submission);
  const projectId = id("project"),
    threadId = id("thread"),
    runId = id("run"),
    messageId = id("msg");
  const title = submission.parts.find((p) => p.type === "text")?.text.slice(0, 80) || "新项目";
  const response = { projectId, threadId, runId };
  try {
    await env.DB.batch([
      stmt(
        env,
        "INSERT INTO projects(id,user_id,title,created_at,updated_at,last_thread_id) VALUES(?,?,?,?,?,?)",
        projectId,
        userId,
        title,
        now(),
        now(),
        threadId,
      ),
      stmt(env, "INSERT INTO threads(id,project_id,title,created_at) VALUES(?,?,?,?)", threadId, projectId, "新对话", now()),
      ...runWrites(env, userId, projectId, threadId, runId, messageId, submission, initiatorClientId, quotaIp),
      ...resources.assets.map((a) =>
        stmt(env, "UPDATE assets SET project_id=? WHERE id=?", projectId, a.id),
      ),
      ...resources.snapshots.map((s) =>
        stmt(env, "UPDATE appearance_snapshots SET project_id=? WHERE id=?", projectId, s.id),
      ),
      stmt(
        env,
        "INSERT INTO idempotency VALUES(?,?,?,?,?)",
        userId,
        "start",
        key,
        digest,
        JSON.stringify(response),
      ),
    ]);
  } catch (error) {
    const raced = await replay();
    if (raced) return { response: raced, created: false };
    throw error;
  }
  await roomCall(env, projectId, "wake");
  return { response, created: true };
}
export async function addMessage(
  env: Env,
  userId: string,
  thread: Row,
  key: string,
  submission: Submission,
  initiatorClientId = `user:${userId}`,
  quotaIp = "local",
) {
  const scope = `message:${thread.id}`;
  const digest = await hash(JSON.stringify(submission));
  const replay = async () => {
    const old = await one(
      env,
      "SELECT * FROM idempotency WHERE user_id=? AND scope=? AND key=?",
      userId,
      scope,
      key,
    );
    if (old?.hash !== digest && old)
      throw new ApiError("IDEMPOTENCY_MISMATCH", "clientMessageId 内容不同", 409);
    return old ? JSON.parse(old.response) : null;
  };
  const old = await replay();
  if (old) {
    await roomCall(env, thread.project_id, "wake");
    return { response: old, created: false };
  }
  await assertBudget(env, userId, quotaIp, directIntent(submission.parts.map(p => p.type === "text" ? p.text : "").join(" ")) ? "image" : "text");
  const resources = await validateResources(env, userId, submission, thread.project_id);
  const runId = id("run"),
    messageId = id("msg");
  const response = { messageId, runId };
  try {
    await env.DB.batch([
      ...runWrites(env, userId, thread.project_id, thread.id, runId, messageId, submission, initiatorClientId, quotaIp),
      ...resources.assets
        .filter((a) => !a.project_id)
        .map((a) =>
          stmt(env, "UPDATE assets SET project_id=? WHERE id=?", thread.project_id, a.id),
        ),
      ...resources.snapshots
        .filter((s) => !s.project_id)
        .map((s) =>
          stmt(
            env,
            "UPDATE appearance_snapshots SET project_id=? WHERE id=?",
            thread.project_id,
            s.id,
          ),
        ),
      stmt(
        env,
        "INSERT INTO idempotency VALUES(?,?,?,?,?)",
        userId,
        scope,
        key,
        digest,
        JSON.stringify(response),
      ),
    ]);
  } catch (error) {
    const raced = await replay();
    if (raced) return { response: raced, created: false };
    if (
      await one(
        env,
        "SELECT id FROM runs WHERE thread_id=? AND state IN ('queued','planning','running','waiting_input')",
        thread.id,
      )
    )
      throw new ApiError("RUN_ACTIVE", "当前对话仍有进行中的任务", 409);
    throw error;
  }
  await roomCall(env, thread.project_id, "wake");
  return { response, created: true };
}
