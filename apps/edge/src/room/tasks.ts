import { roomRequestSchemas } from "@loomic/shared/edge";
import { z } from "zod";
import { all, hash, now, one, requireRow, stmt } from "../core";
import type { Row } from "../types";
import { TaskInsertion } from "./insertion";
import { SetRuns } from "./sets";
import { setShots, shotView } from "../sets";
export class RoomTasks extends TaskInsertion {
  async claim(projectId: string, taskId: string) {
    const task = requireRow(
      await one(this.env, "SELECT * FROM tasks WHERE id=? AND project_id=?", taskId, projectId),
    );
    if (task.state !== "queued") return { claimed: false };
    if (task.provider_retry_at && task.provider_retry_at > Date.now()) return { claimed: false };
    const intent = await one(this.env, "SELECT * FROM submit_intents WHERE task_id=?", taskId);
    if (intent && ["sent", "unknown", "acknowledged"].includes(intent.state)) {
      await this.failUnknownClaim(task);
      return { claimed: false };
    }
    await this.atomic(
      projectId,
      [
        stmt(this.env, "UPDATE tasks SET state='submitted',provider_retry_at=NULL,updated_at=? WHERE id=?", now(), taskId),
        stmt(
          this.env,
          "INSERT INTO submit_intents VALUES(?,0,?,?,'prepared',?) ON CONFLICT(task_id) DO UPDATE SET state='prepared',updated_at=excluded.updated_at",
          taskId,
          taskId,
          await hash(task.input),
          now(),
        ),
      ],
      [
        {
          type: "task.state",
          runId: task.run_id,
          taskId,
          payload: { state: "submitted", slotIndex: task.slot_index },
        },
      ],
    );
    return { claimed: true };
  }
  async defer(data: z.infer<(typeof roomRequestSchemas)["defer-task"]>) {
    const task = requireRow(await one(this.env, "SELECT * FROM tasks WHERE id=? AND project_id=?", data.taskId, data.projectId));
    if (!["submitted", "running"].includes(task.state)) return { ok: false };
    const intent = await one(this.env, "SELECT state FROM submit_intents WHERE task_id=?", task.id);
    // Only known-rejected requests or requests not sent to Vertex may be resubmitted.
    if (intent && !["rejected", "prepared"].includes(intent.state)) return { ok: false };
    const retryAt = Date.now() + data.delayMs;
    const setId = JSON.parse(task.input).setId;
    const shot = setId ? (await setShots(this.env, setId)).find(s => s.task_id === task.id) : undefined;
    await this.atomic(data.projectId, [
      stmt(this.env, `UPDATE tasks SET state='queued',error=NULL,provider_retry_at=?,provider_wait_ms=provider_wait_ms+?,
        provider_retry_attempt=provider_retry_attempt+?,updated_at=? WHERE id=?`, retryAt, data.delayMs, data.upstream ? 1 : 0, now(), task.id),
      stmt(this.env, "UPDATE outbox SET sent_at=NULL WHERE task_id=?", task.id),
    ], [{ type: "task.state", runId: task.run_id, taskId: task.id,
      payload: { state: "queued", slotIndex: task.slot_index, retryAt: new Date(retryAt).toISOString() } },
      ...(shot ? [{ type: "set.shot" as const, taskId: task.id,
        payload: { setId, ...shotView({ ...shot, state: "queued", error: null, provider_retry_at: retryAt }) } }] : []),
    ]);
    // Outbox is committed before the old message is acknowledged; alarm/recovery finishes a failed send.
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return { ok: true };
  }
  async dispatch(projectId: string) {
    const rows = await all(
      this.env,
      "SELECT o.task_id,t.provider_retry_at FROM outbox o JOIN tasks t ON t.id=o.task_id WHERE t.project_id=? AND t.state='queued' AND o.sent_at IS NULL ORDER BY t.slot_index",
      projectId,
    );
    for (const row of rows) {
      await this.env.MEDIA_QUEUE.send({ taskId: row.task_id, projectId }, { delaySeconds: Math.max(0, Math.ceil(((row.provider_retry_at || 0) - Date.now()) / 1000)) });
      await stmt(
        this.env,
        "UPDATE outbox SET sent_at=? WHERE task_id=? AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND COALESCE(provider_retry_at,0)=?)",
        Date.now(),
        row.task_id,
        row.task_id,
        row.provider_retry_at || 0,
      ).run();
    }
  }
  async submit(data: z.infer<(typeof roomRequestSchemas)["submit"]>) {
    const task = requireRow(
      await one(
        this.env,
        "SELECT * FROM tasks WHERE id=? AND project_id=?",
        data.taskId,
        data.projectId,
      ),
    );
    if (task.cancel_requested || ["cancelled", "failed", "committed"].includes(task.state))
      return { ok: false };
    await this.atomic(
      data.projectId,
      [
        stmt(
          this.env,
          "UPDATE submit_intents SET state='sent',attempt=attempt+1,updated_at=? WHERE task_id=?",
          now(),
          task.id,
        ),
        stmt(this.env, "UPDATE tasks SET state='running',updated_at=? WHERE id=?", now(), task.id),
      ],
      [
        {
          type: "task.state",
          runId: task.run_id,
          taskId: task.id,
          payload: { state: "running", slotIndex: task.slot_index },
        },
      ],
    );
    return { ok: true };
  }
  async updateState(data: z.infer<(typeof roomRequestSchemas)["task-state"]>) {
    const task = requireRow(
      await one(
        this.env,
        "SELECT * FROM tasks WHERE id=? AND project_id=?",
        data.taskId,
        data.projectId,
      ),
    );
    if (["cancelled", "committed", "failed"].includes(task.state)) return { ok: false };
    await this.atomic(
      data.projectId,
      [
        stmt(
          this.env,
          "UPDATE tasks SET state=?,error=?,updated_at=? WHERE id=?",
          data.state,
          data.error ? JSON.stringify(data.error) : null,
          now(),
          task.id,
        ),
      ],
      [
        {
          type: "task.state",
          taskId: task.id,
          runId: task.run_id,
          payload: {
            state: data.state,
            slotIndex: task.slot_index,
            ...(data.error ? { error: data.error } : {}),
          },
        },
      ],
    );
    await this.ctx.storage.setAlarm(Date.now() + 20);
    const setId = JSON.parse(task.input).setId;
    if (setId && (data.state === "failed" || data.state === "cancelled")) await new SetRuns(this.room).refresh(setId);
    return { ok: true };
  }
  private async failUnknownClaim(task: Row) {
    const projectId = task.project_id,
      taskId = task.id;
    await this.atomic(
      projectId,
      [
        stmt(
          this.env,
          "UPDATE tasks SET state='failed',error=? WHERE id=?",
          JSON.stringify({
            code: "PROVIDER_SUBMIT_UNKNOWN",
            message: "无法确认上次提交，请手动重试",
            retryable: false,
          }),
          taskId,
        ),
      ],
      [
        {
          type: "task.state",
          runId: task.run_id,
          taskId,
          payload: {
            state: "failed",
            slotIndex: task.slot_index,
            error: {
              code: "PROVIDER_SUBMIT_UNKNOWN",
              message: "无法确认上次提交，请手动重试",
              retryable: false,
            },
          },
        },
      ],
    );
  }
}
