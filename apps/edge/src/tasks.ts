import { mediaOpRequestSchema, taskInputSchema } from "@loomic/shared/edge";
import { all, now, one, publicError, quota, roomCall, stmt } from "./core";
import { prepareMedia, restoreMedia } from "./media-pixels";
import { storeTaskArtifact } from "./task-artifacts";
import { taskImage, taskReferences } from "./task-provider";
import type { Env } from "./types";
import { refundSetTask } from "./sets";
import { DeferredImage } from "./provider-backoff";
export async function consumeTask(env: Env, taskId: string, projectId: string) {
  const claim = await roomCall(env, projectId, "claim", { taskId });
  if (!claim.claimed) return;
  const task = (await one(env, "SELECT * FROM tasks WHERE id=?", taskId))!;
  try {
    const input = taskInputSchema.parse(JSON.parse(task.input));
    const references = await taskReferences(env, task, input);
    const mediaOp = input.mediaOp ? mediaOpRequestSchema.parse(input.mediaOp) : undefined;
    const prepared = mediaOp ? await prepareMedia(env, mediaOp, task.user_id) : undefined;
    if (prepared) references.splice(0, references.length, ...prepared.references);
    const imageStarted = Date.now();
    const result = await taskImage(env, task, input, references, prepared?.input);
    references.length = 0;
    if (prepared) prepared.references.length = 0;
    await roomCall(env, projectId, "timing", { runId: task.run_id, taskId, timing: { phase: "image", label: "图片模型执行（含排队与退避）", startedAt: new Date(imageStarted).toISOString(), durationMs: Date.now() - imageStarted } });
    const ingestStarted = Date.now();
    await stmt(
      env,
      "UPDATE submit_intents SET state='acknowledged',updated_at=? WHERE task_id=?",
      now(),
      taskId,
    ).run();
    await roomCall(env, projectId, "task-state", {
      taskId,
      state: "ingesting",
    });
    const output =
      mediaOp && prepared
        ? await restoreMedia(mediaOp, prepared, result.bytes, result.mime)
        : result;
    if (prepared) {
      prepared.source.data = new Uint8ClampedArray(0);
      prepared.input.data = new Uint8ClampedArray(0);
      if (prepared.mask) prepared.mask.data = new Uint8ClampedArray(0);
    }
    await storeTaskArtifact(env, task, input, output, result);
    await roomCall(env, projectId, "commit", { taskId });
    await roomCall(env, projectId, "timing", { runId: task.run_id, taskId, timing: { phase: "ingest", label: "解码、R2/D1 入库与画布插入", startedAt: new Date(ingestStarted).toISOString(), durationMs: Date.now() - ingestStarted } });
    await roomCall(env, projectId, "quota", {
      runId: task.run_id,
      quota: await quota(env, task.user_id, (await one(env, "SELECT quota_ip FROM runs WHERE id=?", task.run_id))?.quota_ip),
    });
  } catch (error) {
    if (error instanceof DeferredImage) {
      await roomCall(env, projectId, "defer-task", { taskId, delayMs: error.delayMs, upstream: error.upstream });
      return;
    }
    const e = publicError(error);
    if (["PROVIDER_SUBMIT_UNKNOWN", "UPSTREAM_ERROR", "TIMEOUT"].includes(e.code))
      await stmt(
        env,
        "UPDATE submit_intents SET state='unknown',updated_at=? WHERE task_id=?",
        now(),
        taskId,
      ).run();
    if (e.code === "RATE_LIMITED") await refundSetTask(env, taskId);
    await roomCall(env, projectId, "task-state", {
      taskId,
      state: "failed",
      error: e.body().error,
    });
  }
}
/** Durable outbox recovery covers a crash between D1 commit and Queue.send. */
export async function recover(env: Env) {
  const orphans = await all(env, `SELECT task_id FROM quota_reservations WHERE state='reserved' AND reserved_at>0 AND reserved_at<?
    AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=quota_reservations.task_id)
    AND NOT EXISTS(SELECT 1 FROM set_shots s WHERE s.task_id=quota_reservations.task_id) LIMIT 100`, Date.now() - 300000);
  for (const orphan of orphans) await refundSetTask(env, orphan.task_id);
  const pending = await all(
    env,
    "SELECT o.task_id,t.project_id,t.provider_retry_at FROM outbox o JOIN tasks t ON t.id=o.task_id WHERE t.state='queued' AND (o.sent_at IS NULL OR o.sent_at<?) AND (t.provider_retry_at IS NULL OR t.provider_retry_at<=?) ORDER BY t.slot_index LIMIT 100",
    Date.now() - 60000,
    Date.now(),
  );
  for (const task of pending) {
    await env.MEDIA_QUEUE.send({
      taskId: task.task_id,
      projectId: task.project_id,
    });
    await stmt(env, "UPDATE outbox SET sent_at=? WHERE task_id=? AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND COALESCE(provider_retry_at,0)=?)", Date.now(), task.task_id, task.task_id, task.provider_retry_at || 0).run();
  }
  const stalled = await all(
    env,
    "SELECT id,project_id FROM tasks WHERE state IN ('submitted','running','ingesting') AND updated_at<? LIMIT 100",
    new Date(Date.now() - 240000).toISOString(),
  );
  for (const task of stalled) {
    if (await one(env, "SELECT id FROM artifacts WHERE task_id=?", task.id))
      await roomCall(env, task.project_id, "commit", { taskId: task.id });
    else {
      const intent = await one(env, "SELECT * FROM submit_intents WHERE task_id=?", task.id);
      const gate = env.PROVIDER_GATE.get(env.PROVIDER_GATE.idFromName("global"));
      await gate.fetch("https://gate/release", {
        method: "POST",
        body: JSON.stringify({
          id: task.id,
          count: !!intent && ["sent", "unknown", "acknowledged"].includes(intent.state),
        }),
      });
      if (intent?.state === "prepared" || intent?.state === "rejected") {
        await stmt(env, "UPDATE tasks SET state='queued' WHERE id=?", task.id).run();
        await env.MEDIA_QUEUE.send({
          taskId: task.id,
          projectId: task.project_id,
        });
      } else {
        await stmt(
          env,
          "UPDATE submit_intents SET state='unknown',updated_at=? WHERE task_id=?",
          now(),
          task.id,
        ).run();
        await roomCall(env, task.project_id, "task-state", {
          taskId: task.id,
          state: "failed",
          error: {
            code: "PROVIDER_SUBMIT_UNKNOWN",
            message: "上次提交结果无法确认，请手动重试",
            retryable: false,
          },
        });
      }
    }
  }
  const runs = await all(
    env,
    "SELECT DISTINCT project_id FROM runs WHERE state IN ('queued','planning','running') LIMIT 100",
  );
  for (const run of runs) await roomCall(env, run.project_id, "wake");
}
