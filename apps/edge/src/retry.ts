import { pendingCallsSchema, taskInputSchema } from "@loomic/shared/edge";
import { assertBudget, ApiError, hash, id, now, one, owned, stmt } from "./core";
import type { Env } from "./types";
import type { RoomContext } from "./room/context";
import { freezeSlots } from "./slots";
export async function retryTask(env: Env, userId: string, taskId: string, key: string, room: RoomContext, quotaIp = "local") {
  const task = await owned(env, "tasks", taskId, userId);
  const digest = await hash(taskId);
  const scope = "task-retry";
  const previous = await one(
    env,
    "SELECT * FROM idempotency WHERE user_id=? AND scope=? AND key=?",
    userId,
    scope,
    key,
  );
  if (previous) {
    if (previous.hash !== digest)
      throw new ApiError("IDEMPOTENCY_MISMATCH", "重试 ID 已用于其他任务", 409);
    return JSON.parse(previous.response);
  }
  await assertBudget(env, userId, quotaIp, "image");
  if (!["failed", "cancelled"].includes(task.state))
    throw new ApiError("INVALID_INPUT", "只能重试失败或已取消的任务", 409);
  const original = (await one(env, "SELECT * FROM runs WHERE id=?", task.run_id))!;
  if (!["completed", "failed", "cancelled"].includes(original.state))
    throw new ApiError("RUN_ACTIVE", "请等待当前 Run 结束后重试", 409);
  const calls = pendingCallsSchema.parse(JSON.parse(original.pending_calls));
  const prior = calls.find((c) => c.taskIds?.includes(taskId));
  if (!prior) throw new ApiError("INVALID_INPUT", "没有可恢复的工具调用记录", 409);
  const runId = id("run"),
    newTaskId = id("task"),
    toolKey = `${runId}:retry`;
  const response = { taskId: newTaskId, runId };
  const pending = [{ key: toolKey, functionCall: prior.functionCall, taskIds: [newTaskId] }];
  const input = taskInputSchema.parse(JSON.parse(task.input));
  const slot = (await freezeSlots(env, task.project_id, input, 1,
    input.slot ? { width: input.slot.w, height: input.slot.h } : undefined))[0];
  try {
    await room.atomic(task.project_id, [
      stmt(
        env,
        "INSERT INTO runs(id,project_id,thread_id,user_id,state,frozen_submission,effective_settings,contents,pending_calls,started_at,created_at,retry_of_run_id,waiting_since,kind) VALUES(?,?,?,?,'running',?,?,?,?,?,?,?,?,?)",
        runId,
        task.project_id,
        original.thread_id,
        userId,
        original.frozen_submission,
        original.effective_settings,
        original.contents,
        JSON.stringify(pending),
        Date.now(),
        now(),
        original.id,
        Date.now(),
        original.kind,
      ),
      stmt(
        env,
        "INSERT INTO tasks(id,project_id,run_id,user_id,tool_invocation_id,operation,slot_index,state,input,created_at,updated_at,retry_of_task_id) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)",
        newTaskId,
        task.project_id,
        runId,
        userId,
        toolKey,
        task.operation,
        task.slot_index,
        JSON.stringify({ ...input, slot }),
        now(),
        now(),
        taskId,
      ),
      stmt(env, "UPDATE runs SET quota_ip=? WHERE id=?", quotaIp, runId),
      stmt(env, "INSERT INTO outbox(task_id) VALUES(?)", newTaskId),
      stmt(
        env,
        "INSERT INTO idempotency VALUES(?,?,?,?,?)",
        userId,
        scope,
        key,
        digest,
        JSON.stringify(response),
      ),
    ], [
      { type: "run.state", runId, payload: { state: "running" } },
      { type: "task.state", runId, taskId: newTaskId, payload: { state: "queued", slotIndex: task.slot_index, slot } },
    ]);
  } catch (error) {
    const raced = await one(
      env,
      "SELECT * FROM idempotency WHERE user_id=? AND scope=? AND key=?",
      userId,
      scope,
      key,
    );
    if (raced) {
      if (raced.hash !== digest)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "重试 ID 内容不符", 409);
      return JSON.parse(raced.response);
    }
    if (
      await one(
        env,
        "SELECT id FROM runs WHERE thread_id=? AND state IN ('queued','planning','running','waiting_input')",
        original.thread_id,
      )
    )
      throw new ApiError("RUN_ACTIVE", "当前对话仍有进行中的任务", 409);
    throw error;
  }
  await room.ctx.storage.setAlarm(Date.now() + 20);
  return response;
}
