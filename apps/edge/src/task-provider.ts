import { edgeErrorSchema, taskInputSchema } from "@loomic/shared/edge";
import type { z } from "zod";
import { ApiError, now, one, roomCall, stmt } from "./core";
import { assetInline } from "./images";
import { FixtureProvider } from "./providers/fixture";
import { sleep, VertexProvider } from "./providers/vertex";
import type { Env, Row } from "./types";
type Input = z.infer<typeof taskInputSchema>;
export async function taskReferences(env: Env, task: Row, input: Input) {
  const projectId = task.project_id;
  const references: unknown[] = [];
  for (const snapshotId of input.snapshotIds) {
    const snapshot = await one(
      env,
      "SELECT * FROM appearance_snapshots WHERE id=? AND project_id=?",
      snapshotId,
      projectId,
    );
    if (!snapshot) throw new ApiError("FORBIDDEN", "快照不属于当前项目", 403);
    references.push(
      await assetInline(
        env,
        (await one(env, "SELECT * FROM assets WHERE id=?", snapshot.asset_id))!,
      ),
    );
  }
  for (const assetId of input.assetIds || []) {
    const asset = await one(
      env,
      "SELECT * FROM assets WHERE id=? AND project_id=? AND user_id=?",
      assetId,
      projectId,
      task.user_id,
    );
    if (!asset) throw new ApiError("FORBIDDEN", "资源不属于当前项目", 403);
    references.push(await assetInline(env, asset));
  }
  return references;
}
export async function taskImage(
  env: Env,
  task: Row,
  input: Input,
  references: unknown[],
  size?: { width: number; height: number },
) {
  const taskId = task.id,
    projectId = task.project_id,
    providerMode = input.providerMode || env.PROVIDER_MODE;
  const beforeSend = async (attempt: number) => {
    if (!(await roomCall(env, projectId, "submit", { taskId, attempt })).ok)
      throw new ApiError("INVALID_INPUT", "任务已经停止", 409);
  };
  const onRejected = async () => {
    await stmt(
      env,
      "UPDATE submit_intents SET state='rejected',updated_at=? WHERE task_id=?",
      now(),
      taskId,
    ).run();
  };
  let result;
  if (providerMode === "vertex")
    result = await new VertexProvider(env).image(
      input.prompt,
      input.settings,
      references,
      {
        id: taskId,
        userId: task.user_id,
        kind: "image",
        setId: input.setId,
        queueRetry: { attempt: task.provider_retry_attempt, waitMs: task.provider_wait_ms, noImageRetries: task.provider_no_image_retries },
        onNoImageRetry: async () => {
          await stmt(env, "UPDATE tasks SET provider_no_image_retries=1 WHERE id=?", taskId).run();
        },
        beforeSend,
        onRejected,
        explicitModel: !!input.setId || (input.settingsExplicitKeys || []).includes("modelId"),
        onFallback: async () => {
          await roomCall(env, projectId, "step", {
            runId: task.run_id,
            taskId,
            tool: task.operation === "edit" ? "edit_image" : "generate_images",
            summary: "高峰限流，已改用快速模型",
          });
        },
      },
      task.operation === "edit",
    );
  else result = await fixtureImage(env, task, input, size, beforeSend, onRejected);
  return result;
}

async function fixtureImage(
  env: Env,
  task: Row,
  input: Input,
  size: { width: number; height: number } | undefined,
  beforeSend: (attempt: number) => Promise<void>,
  onRejected: () => Promise<void>,
) {
  const taskId = task.id;
  let result;

  const gate = env.PROVIDER_GATE.get(env.PROVIDER_GATE.idFromName("global"));
  let admitted: Response = new Response(null, { status: 429 });
  for (let n = 0; n < 100; n++) {
    admitted = await gate.fetch("https://gate/acquire", {
      method: "POST",
      body: JSON.stringify({
        id: taskId,
        kind: "image",
        userId: task.user_id,
      }),
    });
    if (admitted.ok || admitted.status === 403) break;
    await sleep(100);
  }
  if (!admitted.ok) {
    if (admitted.status === 403) {
      const { error } = edgeErrorSchema.parse(await admitted.json());
      throw new ApiError(error.code, error.message, 429, error.retryable, error.details);
    }
    throw new ApiError("RATE_LIMITED", "服务繁忙，请稍后重试", 429, true);
  }
  let count = false;
  try {
    await beforeSend(0);
    result = await new FixtureProvider().image(input.prompt, size, input.settings);
    count = true;
  } catch (error) {
    if (error instanceof ApiError && error.code === "PROVIDER_SUBMIT_UNKNOWN") count = true;
    else await onRejected();
    throw error;
  } finally {
    await gate.fetch("https://gate/release", {
      method: "POST",
      body: JSON.stringify({ id: taskId, count }),
    });
  }
  return result;
}
