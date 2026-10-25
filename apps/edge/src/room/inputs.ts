import {
  pendingCallsSchema,
  providerContentSchema,
  settingsSchema,
  submissionSchema,
  toolSchemas,
  type AnswerRequest,
  type PendingCall,
  type ProviderContent,
} from "@loomic/shared/edge";
import { z } from "zod";
import { all, ApiError, hash, id, now, one, requireRow, stmt } from "../core";
import type { Row } from "../types";
import { RoomService, type EventInput } from "./context";
import { SetRuns } from "./sets";
type AnswerEffects = { writes: D1PreparedStatement[]; events: EventInput[] };
export class RunInputs extends RoomService {
  async retryModel(projectId: string, runId: string, clientOperationId: string) {
    const run = requireRow(await one(this.env, "SELECT * FROM runs WHERE id=? AND project_id=?", runId, projectId));
    if (run.kind === "set") throw new ApiError("INVALID_INPUT", "套图请重新生成整套或使用单张重出接口", 409);
    const scope = `run-retry:${runId}`;
    const old = await one(this.env, "SELECT response FROM idempotency WHERE user_id=? AND scope=? AND key=?", run.user_id, scope, clientOperationId);
    if (old) return JSON.parse(old.response);
    const error = run.error ? JSON.parse(run.error) : null;
    if (run.state !== "failed" || !error?.retryable || !["PROVIDER_ERROR", "RATE_LIMITED"].includes(error.code))
      throw new ApiError("INVALID_INPUT", "此任务不能重试文本阶段，请查看任务错误", 409);
    if (run.kind === "media" || await one(this.env, "SELECT id FROM tasks WHERE run_id=? AND state<>'committed' LIMIT 1", runId))
      throw new ApiError("INVALID_INPUT", "请通过图片任务的重试入口重试失败图片", 409);
    if (await one(this.env, "SELECT id FROM runs WHERE thread_id=? AND id<>? AND state IN ('queued','planning','running','waiting_input')", run.thread_id, runId))
      throw new ApiError("RUN_ACTIVE", "当前对话仍有进行中的任务", 409);
    const response = { runId, state: "running" };
    await this.atomic(projectId, [
      stmt(this.env, "UPDATE runs SET state='running',error=NULL,started_at=?,waiting_since=NULL WHERE id=?", Date.now(), runId),
      stmt(this.env, "INSERT INTO idempotency VALUES(?,?,?,?,?)", run.user_id, scope, clientOperationId, await hash(runId), JSON.stringify(response)),
    ], [{ type: "run.state", runId, payload: { state: "running", summary: "重新理解需求，保留已完成图片", phase: "model" } }]);
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return response;
  }
  async cancel(projectId: string, runId: string, extraWrites: D1PreparedStatement[] = []) {
    const run = requireRow(
      await one(this.env, "SELECT * FROM runs WHERE id=? AND project_id=?", runId, projectId),
    );
    if (["completed", "failed", "cancelled"].includes(run.state))
      return { runId, state: run.state };
    if (run.kind === "set") {
      const set = await one(this.env, "SELECT state FROM image_sets WHERE run_id=?", runId);
      // Vertex cannot cancel accepted image work. Do not expose a cancel/refund loop that bypasses daily admission.
      if (set?.state !== "analyzing") throw new ApiError("INVALID_INPUT", "套图已开始出图，请等待结束后再重出", 409);
    }
    const tasks = await all(
      this.env,
      "SELECT * FROM tasks WHERE run_id=? AND state NOT IN ('committed','failed','cancelled')",
      runId,
    );
    const children = await all(this.env,"SELECT id,role FROM child_runs WHERE parent_run_id=? AND state IN ('queued','running')",runId);
    await this.atomic(
      projectId,
      [
        stmt(this.env, "UPDATE runs SET state='cancelled' WHERE id=?", runId),
        stmt(this.env, "UPDATE child_runs SET state='cancelled' WHERE parent_run_id=? AND state IN ('queued','running')", runId),
        ...extraWrites,
        stmt(
          this.env,
          "UPDATE tasks SET state='cancelled',cancel_requested=1,updated_at=? WHERE run_id=? AND state NOT IN ('committed','failed','cancelled')",
          now(),
          runId,
        ),
        stmt(
          this.env,
          "UPDATE input_requests SET state='cancelled' WHERE run_id=? AND state='pending'",
          runId,
        ),
      ],
      [
        ...children.map((child) => ({type:"run.step" as const,runId,payload:{stepId:child.id,tool:"agent_delegate",role:child.role,parentRunId:runId,childRunId:child.id,childState:"cancelled",status:"failed",summary:"主任务已停止，子任务已取消"}})),
        ...tasks.map((t) => ({
          type: "task.state" as const,
          taskId: t.id,
          runId,
          payload: { state: "cancelled", slotIndex: t.slot_index },
        })),
        { type: "run.state", runId, payload: { state: "cancelled" } },
      ],
    );
    for (const child of children) this.room.childControllers?.get(child.id)?.abort();
    if (run.kind === "set") {
      const set = await one(this.env, "SELECT id FROM image_sets WHERE run_id=?", runId);
      if (set) await new SetRuns(this.room).cancel(set.id);
    }
    return { runId, state: "cancelled" };
  }
  async answer(projectId: string, requestId: string, data: AnswerRequest) {
    const input = requireRow(
      await one(
        this.env,
        "SELECT * FROM input_requests WHERE id=? AND project_id=?",
        requestId,
        projectId,
      ),
    );
    const run = requireRow(await one(this.env, "SELECT * FROM runs WHERE id=?", input.run_id));
    const digest = await hash(JSON.stringify({ requestId, ...data }));
    const previous = await one(
      this.env,
      "SELECT * FROM idempotency WHERE user_id=? AND scope='answer' AND key=?",
      run.user_id,
      data.clientOperationId,
    );
    if (previous) {
      if (previous.hash !== digest)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "回答内容不一致", 409);
      return JSON.parse(previous.response);
    }
    if (input.state !== "pending" || run.state !== "waiting_input")
      throw new ApiError("INPUT_REQUEST_CLOSED", "此问题已结束", 409);
    if (input.call && data.answer.choiceId === "cancel") {
      const call = pendingCallsSchema.element.parse(JSON.parse(input.call));
      if (call.childRunIds?.length) {
        await this.cancel(projectId, run.id, [stmt(this.env, "INSERT INTO idempotency VALUES(?,?,?,?,?)",
          run.user_id, "answer", data.clientOperationId, digest, JSON.stringify({ runId: run.id }))]);
        return { runId: run.id };
      }
    }
    const { pending, contents, effects } = await this.resumeAnswer(projectId, input, run, data);
    const response = { runId: run.id };
    await this.persistAnswer(projectId, requestId, run, data, digest, pending, contents, input.resume_phase, effects);
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return response;
  }
  private async resumeAnswer(projectId: string, input: Row, run: Row, data: AnswerRequest) {
    for (const snapshotId of data.answer.snapshotIds || [])
      if (
        !(await one(
          this.env,
          "SELECT id FROM appearance_snapshots WHERE id=? AND project_id=?",
          snapshotId,
          projectId,
        ))
      )
        throw new ApiError("FORBIDDEN", "无权引用此快照", 403);
    const payload = toolSchemas.ask_user
      .extend({
        conflicts: z.array(z.string()).optional(),
        candidates: z.record(z.unknown()).optional(),
      })
      .passthrough()
      .parse(JSON.parse(input.payload));
    if (data.answer.choiceId && !payload.choices?.some((c) => c.id === data.answer.choiceId))
      throw new ApiError("INVALID_INPUT", "选项不存在", 422);
    const pending = pendingCallsSchema.parse(JSON.parse(run.pending_calls));
    const contents = z.array(providerContentSchema).parse(JSON.parse(run.contents));
    let effects: AnswerEffects = { writes: [], events: [] };
    if (input.call) {
      const call = pendingCallsSchema.element.parse(JSON.parse(input.call));
      const target = pending.find((p) => p.key === call.key);
      if (!target) throw new ApiError("INPUT_REQUEST_CLOSED", "工具追问已结束", 409);
      if (call.childRunIds?.length) effects = await this.resumeChildren(run, input, target, data);
      else target.response = { answer: data.answer };
    } else {
      const submission = submissionSchema.parse(JSON.parse(run.frozen_submission));
      const settings = settingsSchema.parse(JSON.parse(run.effective_settings || "{}"));
      if (payload.conflicts && data.answer.choiceId === "text")
        Object.assign(settings, payload.candidates);
      // Free-text clarification is re-evaluated by the model, with locked settings visible in read_canvas.
      contents.push({
        role: "user",
        parts: [
          {
            text: `用户确认：${data.answer.text || (data.answer.choiceId === "text" ? "采用文字要求" : "采用界面设置")}。已确认设置：${JSON.stringify(settings)}`,
          },
        ],
      });
      submission.settings = settings;
      run.effective_settings = JSON.stringify(settings);
    }
    return { pending, contents, effects };
  }
  private async resumeChildren(run: Row, input: Row, call: PendingCall, data: AnswerRequest): Promise<AnswerEffects> {
    const effects: AnswerEffects = { writes: [], events: [] };
    if (!["retry", "skip"].includes(data.answer.choiceId || ""))
      throw new ApiError("INVALID_INPUT", "请选择重试、跳过或停止", 422);
    const children = await Promise.all(call.childRunIds!.map((childId) =>
      one(this.env, "SELECT * FROM child_runs WHERE id=? AND parent_run_id=?", childId, run.id)));
    if (data.answer.choiceId === "skip") {
      call.response = { ok: false, skipped: true, qualityStatus: "unchecked", answer: data.answer };
      if (children.some((child) => child?.role === "quality-review")) {
        effects.writes.push(stmt(this.env,"UPDATE runs SET quality_status='unchecked' WHERE id=?",run.id));
        effects.events.push({type:"run.step",runId:run.id,payload:{stepId:call.key,tool:"agent_delegate",status:"completed",summary:"用户跳过必需检查；结果未检查",qualityStatus:"unchecked",warning:true}});
      }
      return effects;
    }
    const failed = children.filter((child) => child && child.state !== "completed");
    if (run.tool_count + failed.length > 12)
      throw new ApiError("AGENT_LIMIT_EXCEEDED", "主任务重试委派预算已用尽", 422);
    // Child insertion, stable tool identity, answer and budget commit in one D1 transaction.
    for (const child of failed) {
      if (!child) continue;
      const retryKey = `retry:${input.id}:${child.id}`;
      const existing = await one(this.env,"SELECT id FROM child_runs WHERE parent_run_id=? AND invocation_key=?",run.id,retryKey);
      const childId = existing?.id || id("child");
      if (!existing) {
        effects.writes.push(stmt(this.env,
        "INSERT INTO child_runs(id,parent_run_id,project_id,role,invocation_key,required,state,frozen_input,started_at) VALUES(?,?,?,?,?,?,'queued',?,?)",
        childId,run.id,run.project_id,child.role,retryKey,child.required,child.frozen_input,Date.now()),
        stmt(this.env,"UPDATE runs SET tool_count=tool_count+1 WHERE id=?",run.id));
        effects.events.push({type:"run.step",runId:run.id,payload:{stepId:childId,tool:"agent_delegate",role:child.role,parentRunId:run.id,childRunId:childId,childState:"queued",status:"started",summary:"仅重试失败分析，保留已提交图片"}});
      }
      call.childRunIds = call.childRunIds!.map((value) => value === child.id ? childId : value);
    }
    delete call.response;
    return effects;
  }
  private async persistAnswer(
    projectId: string,
    requestId: string,
    run: Row,
    data: AnswerRequest,
    digest: string,
    pending: PendingCall[],
    contents: ProviderContent[],
    resumePhase: string,
    effects: AnswerEffects,
  ) {
    const response = { runId: run.id };
    await this.atomic(
      projectId,
      [
        ...effects.writes,
        stmt(
          this.env,
          "UPDATE input_requests SET state='answered',answer=? WHERE id=?",
          JSON.stringify(data.answer),
          requestId,
        ),
        stmt(
          this.env,
          "UPDATE runs SET state=?,effective_settings=?,contents=?,pending_calls=?,started_at=started_at+?,waiting_since=NULL WHERE id=?",
          resumePhase,
          run.effective_settings,
          JSON.stringify(contents),
          JSON.stringify(pending),
          run.waiting_since ? Date.now() - run.waiting_since : 0,
          run.id,
        ),
        stmt(
          this.env,
          "INSERT INTO messages(id,project_id,thread_id,run_id,role,parts,created_at) VALUES(?,?,?,?,?,?,?)",
          id("msg"),
          projectId,
          run.thread_id,
          run.id,
          "user",
          JSON.stringify([{ text: data.answer.text || data.answer.choiceId || "已补充参考" }]),
          now(),
        ),
        stmt(
          this.env,
          "INSERT INTO idempotency VALUES(?,?,?,?,?)",
          run.user_id,
          "answer",
          data.clientOperationId,
          digest,
          JSON.stringify(response),
        ),
      ],
      [
        ...effects.events,
        {
          type: "run.state",
          runId: run.id,
          payload: { state: resumePhase },
        },
      ],
    );
  }
  async ask(
    run: Row,
    payload: z.infer<typeof toolSchemas.ask_user> & {
      conflicts?: string[];
      candidates?: Partial<import("@loomic/shared/edge").GenerationSettings>;
    },
    call?: PendingCall,
  ) {
    if (await one(this.env,"SELECT id FROM input_requests WHERE run_id=? AND state='pending'",run.id)) return;
    const resumePhase = "running";
    const input = { id: id("input"), runId: run.id, choices: [], ...payload, resumePhase };
    await this.atomic(
      run.project_id,
      [
        stmt(
          this.env,
          "INSERT INTO input_requests(id,project_id,run_id,payload,call,resume_phase) VALUES(?,?,?,?,?,?)",
          input.id,
          run.project_id,
          run.id,
          JSON.stringify(input),
          call ? JSON.stringify(call) : null,
          resumePhase,
        ),
        stmt(
          this.env,
          "UPDATE runs SET state='waiting_input',resume_phase=?,waiting_since=COALESCE(waiting_since,?) WHERE id=?",
          resumePhase,
          Date.now(),
          run.id,
        ),
      ],
      [
        { type: "input.requested", runId: run.id, payload: input },
        {
          type: "run.state",
          runId: run.id,
          payload: { state: "waiting_input" },
        },
      ],
    );
  }
}
