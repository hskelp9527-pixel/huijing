import { canvasSchema, settingsSchema, type MediaOpRequest } from "@loomic/shared/edge";
import { assertBudget, ApiError, hash, id, now, one, owned, stmt } from "../core";
import { mediaPrompt, prepareMedia } from "../media-pixels";
import { worldBounds } from "../placement";
import { RoomService } from "./context";
import { freezeSlots } from "../slots";
import { assertImageModel } from "../models";
export class RoomMedia extends RoomService {
  async enqueue(userId: string, data: MediaOpRequest, quotaIp = "local") {
    const project = await owned(this.env, "projects", data.projectId, userId);
    assertImageModel(this.env, data.settings.modelId);
    const digest = await hash(JSON.stringify(data));
    const previous = await one(
      this.env,
      "SELECT * FROM idempotency WHERE user_id=? AND scope='media-op' AND key=?",
      userId,
      data.clientOpId,
    );
    if (previous) {
      if (previous.hash !== digest)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "相同操作 ID 的内容不同", 409);
      const response = JSON.parse(previous.response);
      if (response.runId && response.threadId) return response;
      const task = (await one(this.env, "SELECT run_id FROM tasks WHERE id=?", response.taskId))!;
      const run = (await one(this.env, "SELECT thread_id FROM runs WHERE id=?", task.run_id))!;
      return { ...response, runId: task.run_id, threadId: run.thread_id };
    }
    await assertBudget(this.env, userId, quotaIp, "image");
    if (data.threadId && !(await one(this.env, "SELECT id FROM threads WHERE id=? AND project_id=?", data.threadId, project.id)))
      throw new ApiError("FORBIDDEN", "对话不属于当前项目", 403);
    if (data.threadId && await one(this.env, "SELECT id FROM runs WHERE thread_id=? AND state IN ('queued','planning','running','waiting_input')", data.threadId))
      throw new ApiError("RUN_ACTIVE", "当前对话仍有进行中的任务", 409);
    const prepared = await prepareMedia(this.env, data, userId);
    this.validateRegions(data, prepared.source);
    const canvas = canvasSchema.parse(JSON.parse(project.canvas));
    const source = canvas.elements.find((e) => e.id === data.source.elementId && !e.isDeleted);
    const snapshot = await owned(this.env, "appearance_snapshots", data.source.snapshotId, userId);
    if (!source || ![snapshot.asset_id, snapshot.source_asset_id].includes(source.fileId || ""))
      throw new ApiError("INVALID_INPUT", "源元素与快照不匹配", 422);
    const submission = {
      parts: [{ type: "text", text: mediaPrompt(data) }],
      references: [],
      settings: settingsSchema.parse({ ...data.settings, count: 1 }),
      settingsExplicitKeys: data.settingsExplicitKeys,
    };
    const input = {
      prompt: mediaPrompt(data),
      settings: submission.settings,
      settingsExplicitKeys: data.settingsExplicitKeys,
      snapshotIds: [],
      assetIds: [],
      anchor: worldBounds(source),
      viewportCenter: { x: 0, y: 0 },
      providerMode: this.env.PROVIDER_MODE,
      mediaOp: data,
    };
    const slot = (await freezeSlots(this.env, project.id, input, 1, prepared.input))[0];
    const { writes, runId, taskId, threadId } = this.jobWrites(data, userId, digest, { ...input, slot }, submission);
    writes.push(stmt(this.env, "UPDATE runs SET quota_ip=? WHERE id=?", quotaIp, runId));
    await this.atomic(data.projectId, writes, [
      ...(!data.threadId ? [{ type: "thread.created" as const, payload: { thread: { id: threadId, projectId: data.projectId, title: "图片后处理", createdAt: now(), isSystem: true } } }] : []),
      { type: "run.state", runId, payload: { state: "running" } },
      { type: "task.state", runId, taskId, payload: { state: "queued", slotIndex: 0, slot } },
    ]);
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return { taskId, runId, threadId };
  }
  private jobWrites(
    data: MediaOpRequest,
    userId: string,
    digest: string,
    input: unknown,
    submission: { settings: unknown },
  ) {
    const runId = id("run"),
      threadId = data.threadId || id("thread"),
      taskId = id("task"),
      key = `${runId}:media`;
    const writes = [
      ...(!data.threadId ? [stmt(
        this.env,
        "INSERT INTO threads(id,project_id,title,created_at,is_system) VALUES(?,?,?,?,1)",
        threadId,
        data.projectId,
        "图片后处理",
        now(),
      )] : []),
      stmt(
        this.env,
        "INSERT INTO runs(id,project_id,thread_id,user_id,state,frozen_submission,effective_settings,pending_calls,started_at,created_at,kind) VALUES(?,?,?,?,'running',?,?,?,?,?,'media')",
        runId,
        data.projectId,
        threadId,
        userId,
        JSON.stringify(submission),
        JSON.stringify(submission.settings),
        JSON.stringify([
          { key, functionCall: { name: "edit_image", args: {} }, taskIds: [taskId] },
        ]),
        Date.now(),
        now(),
      ),
      stmt(
        this.env,
        "INSERT INTO tasks(id,project_id,run_id,user_id,tool_invocation_id,operation,slot_index,state,input,created_at,updated_at) VALUES(?,?,?,?,?,'edit',0,'queued',?,?,?)",
        taskId,
        data.projectId,
        runId,
        userId,
        key,
        JSON.stringify(input),
        now(),
        now(),
      ),
      stmt(this.env, "INSERT INTO outbox(task_id) VALUES(?)", taskId),
      stmt(
        this.env,
        "INSERT INTO idempotency VALUES(?,'media-op',?,?,?)",
        userId,
        data.clientOpId,
        digest,
        JSON.stringify({ taskId, runId, threadId }),
      ),
    ];
    return { writes, runId, taskId, threadId };
  }
  private validateRegions(data: MediaOpRequest, source: { width: number; height: number }) {
    const boxes =
      data.op === "replace_text"
        ? data.params.regions
        : data.op === "move_object"
          ? [data.params.srcBox, data.params.dstBox]
          : [];
    if (boxes.some((b) => b.x + b.width > source.width || b.y + b.height > source.height))
      throw new ApiError("INVALID_INPUT", "区域坐标超出快照", 422);
    if (data.op === "expand" && Object.values(data.params.margin).every((x) => x === 0))
      throw new ApiError("INVALID_INPUT", "至少扩展一边", 422);
  }
}
