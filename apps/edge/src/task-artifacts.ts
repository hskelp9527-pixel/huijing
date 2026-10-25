import type { taskInputSchema } from "@loomic/shared/edge";
import type { z } from "zod";
import { hash, id, now, stmt } from "./core";
import { saveAsset } from "./images";
import type { taskImage } from "./task-provider";
import type { Env, Row } from "./types";
export async function storeTaskArtifact(
  env: Env,
  task: Row,
  input: z.infer<typeof taskInputSchema>,
  output: { bytes: Uint8Array; mime: string },
  result: Awaited<ReturnType<typeof taskImage>>,
) {
  const taskId = task.id,
    projectId = task.project_id,
    providerMode = input.providerMode || env.PROVIDER_MODE;
  const asset = await saveAsset(env, output.bytes, task.user_id, projectId, output.mime);
  const artifactId = id("artifact");
  const snapshotId = id("snapshot");
  const providerKey = `provider-parts/${taskId}.json`;
  await env.BUCKET.put(providerKey, JSON.stringify(result.parts), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.batch([
    stmt(
      env,
      "INSERT INTO appearance_snapshots VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,render_key) DO NOTHING",
      snapshotId,
      task.user_id,
      projectId,
      asset.id,
      asset.id,
      `task:${taskId}`,
      await hash(taskId),
      "{}",
      asset.width,
      asset.height,
    ),
    stmt(
      env,
      "INSERT INTO artifacts VALUES(?,?,?,?,?,?) ON CONFLICT(task_id) DO NOTHING",
      artifactId,
      taskId,
      asset.id,
      snapshotId,
      JSON.stringify({
        storageKey: providerKey,
        mode: providerMode,
        modelId: "modelId" in result ? result.modelId : "fixture",
        ...(input.mediaOp
          ? {
              provenance: {
                sourceSnapshotId: input.mediaOp.source.snapshotId,
                op: input.mediaOp.op,
                params: input.mediaOp.params,
              },
            }
          : {}),
      }),
      now(),
    ),
  ]);
}
