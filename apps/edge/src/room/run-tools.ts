import {
  canvasSchema,
  settingsSchema,
  submissionSchema,
  toolSchemas,
  type Canvas,
  type PendingCall,
} from "@loomic/shared/edge";
import { z } from "zod";
import { all, ApiError, id, now, one, publicError, stmt } from "../core";
import { worldBounds } from "../placement";
import type { Row } from "../types";
import { type EventInput } from "./context";
import { RunInputs } from "./inputs";
import { ChildRuns, delegateArgs } from "./children";
import { AgentCanvas } from "./agent-canvas";
import { AgentOCR } from "./ocr";
import { allowsAutomaticRevision } from "../agent-policy";
import { freezeSlots } from "../slots";
export class RunTools extends RunInputs {
  protected async executeCall(run: Row, pending: PendingCall[], call: PendingCall) {
    const toolStarted = Date.now();
    let waiting = false;
    const name = z.enum(["read_canvas", "generate_images", "edit_image", "ask_user", "agent_delegate", "canvas_apply", "media_ocr"]).parse(call.functionCall.name);
    await this.atomic(
      run.project_id,
      [],
      name === "agent_delegate" ? [] : [
        {
          type: "run.step",
          runId: run.id,
          payload: {
            stepId: call.key,
            tool: name,
            status: "started",
            summary: {
              read_canvas: "读取画布",
              generate_images: `生成 ${JSON.parse(run.effective_settings).count} 张图`,
              edit_image: "编辑图片",
              ask_user: "补充必要信息",
              agent_delegate: "委派子任务",
              canvas_apply: "调整画布排版",
              media_ocr: "读取浏览器 OCR 结果",
            }[name],
          },
        },
      ],
    );
    if (name === "read_canvas") {
      call.response = await this.readCanvas(run);
    } else if(name === "agent_delegate") {
      const args=delegateArgs.parse(call.functionCall.args);
      call.childRunIds=[await new ChildRuns(this.room).create(run,call.key,args)];
      waiting=true;
    } else if(name === "canvas_apply" || name === "media_ocr") {
      try {
        call.response=name==="canvas_apply"
          ? {ok:true,data:await new AgentCanvas(this.room).apply(run,call.key,call.functionCall.args)}
          : await new AgentOCR(this.room).read(run,call.functionCall.args,await new ChildRuns(this.room).allowedSnapshots(run));
      }catch(error){
        const e=error instanceof z.ZodError ? new ApiError("INVALID_INPUT","工具参数不符合契约",422) : publicError(error); call.response={ok:false,...e.body()};
        await this.atomic(run.project_id,[],[{type:"run.step",runId:run.id,payload:{stepId:call.key,tool:name,status:"failed",summary:e.message}}]);
      }
    } else if (name === "ask_user") {
      await stmt(this.env, "UPDATE runs SET pending_calls=? WHERE id=?", JSON.stringify(pending), run.id).run();
      await this.ask(run, toolSchemas.ask_user.parse(call.functionCall.args), call);
      return true;
    } else {
      await this.queueTasks(run, pending, call, name);
      waiting = true;
    }
    await this.atomic(
      run.project_id,
      [
        stmt(
          this.env,
          "UPDATE runs SET pending_calls=? WHERE id=?",
          JSON.stringify(pending),
          run.id,
        ),
      ],
      name === "agent_delegate" ? [] : [
        {
          type: "run.step",
          runId: run.id,
          payload: {
            stepId: call.key,
            tool: name,
            status: call.response?.ok === false ? "failed" : "completed",
            summary: call.response?.ok === false ? "工具返回错误，未执行成功" : call.taskIds ? "图片任务已排队" : call.childRunIds ? "子任务已排队" : "工具已完成",
          },
        },
      ],
    );
    await this.timing(run, "tool", `工具 ${name}`, toolStarted);
    return waiting;
  }
  protected async readCanvas(run: Row) {
    const started = Date.now();
    const project = (await one(this.env, "SELECT * FROM projects WHERE id=?", run.project_id))!;
    const canvas: Canvas = canvasSchema.parse(JSON.parse(project.canvas));
    const snapshots = await all(
      this.env,
      "SELECT id,asset_id,width,height FROM appearance_snapshots WHERE project_id=? ORDER BY rowid",
      run.project_id,
    );
    await this.ctx.storage.put(`agent-allowed:${run.id}`,canvas.elements.filter((e)=>!e.isDeleted).map((e)=>e.id));
    await this.ctx.storage.put(`agent-snapshots:${run.id}`,snapshots.map((s)=>s.id));
    await this.timing(run, "read_canvas", "读取画布元数据（无图片像素）", started);
    return {
      revision: canvas.revision,
      elements: canvas.elements
        .filter((e) => !e.isDeleted)
        .map((e) => ({
          id: e.id,
          type: e.type,
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
          version: e.version,
          locked: e.locked,
          fileId: e.fileId,
          snapshotId: z.object({ snapshotId: z.string().optional() }).optional().parse(e.customData)
            ?.snapshotId,
        })),
      snapshots: snapshots.map((s) => ({
        id: s.id,
        assetId: s.asset_id,
        width: s.width,
        height: s.height,
      })),
      settings: settingsSchema.parse(JSON.parse(run.effective_settings)),
    };
  }
  private async queueTasks(
    run: Row,
    pending: PendingCall[],
    call: PendingCall,
    name: "edit_image" | "generate_images",
  ) {
    const { count, input, priorTasks } = await this.taskContext(run, call, name);
    call.taskIds = [];
    const writes: D1PreparedStatement[] = [];
    const taskEvents: EventInput[] = [];
    const slots = await freezeSlots(this.env, run.project_id, input, count);
    for (let slot = 0; slot < count; slot++) {
      const taskId = id("task");
      call.taskIds.push(taskId);
      writes.push(
        stmt(
          this.env,
          "INSERT INTO tasks(id,project_id,run_id,user_id,tool_invocation_id,operation,slot_index,state,input,created_at,updated_at,retry_of_task_id) VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)",
          taskId,
          run.project_id,
          run.id,
          run.user_id,
          call.key,
          name === "edit_image" ? "edit" : "generate",
          slot,
          JSON.stringify({ ...input, slot: slots[slot] }),
          now(),
          now(),
          priorTasks[slot]?.id ?? null,
        ),
        stmt(this.env, "INSERT INTO outbox(task_id) VALUES(?)", taskId),
      );
      taskEvents.push({
        type: "task.state",
        runId: run.id,
        taskId,
        payload: { state: "queued", slotIndex: slot, slot: slots[slot] },
      });
    }
    writes.push(
      stmt(
        this.env,
        "UPDATE runs SET state='running',pending_calls=?,waiting_since=?,revision_count=revision_count+? WHERE id=?",
        JSON.stringify(pending),
        Date.now(),
        priorTasks.length ? 1 : 0,
        run.id,
      ),
    );
    await this.atomic(run.project_id, writes, [
      { type: "run.state", runId: run.id, payload: { state: "running" } },
      ...taskEvents,
    ]);
  }
  private async taskContext(run: Row, call: PendingCall, name: "edit_image" | "generate_images") {
    const args =
      name === "edit_image"
        ? toolSchemas.edit_image.parse(call.functionCall.args)
        : toolSchemas.generate_images.parse(call.functionCall.args);
    const priorTasks = await all(this.env, "SELECT * FROM tasks WHERE run_id=?", run.id);
    if (priorTasks.length) {
      const submission=JSON.parse(run.frozen_submission) as {parts:{type:string;text?:string}[]};
      const text=submission.parts.map((p)=>p.text||"").join(" ");
      if(run.revision_count>=1 || !allowsAutomaticRevision(text))
        throw new ApiError("INVALID_INPUT","只有明确允许自动迭代时可修订一轮；已提交图片保留",422);
      if(priorTasks.some((t)=>t.state!=="committed")) throw new ApiError("INVALID_INPUT","已有任务尚未完成",422);
      const check=await one(this.env,"SELECT * FROM child_runs WHERE parent_run_id=? AND role='quality-review' AND state='completed' ORDER BY rowid DESC LIMIT 1",run.id);
      if(!check || !JSON.parse(check.output).data.issues.some((issue:{status?:string})=>issue.status==="revise"))
        throw new ApiError("INVALID_INPUT","尚无质量检查修订建议",422);
    }
    const settings = settingsSchema.parse(JSON.parse(run.effective_settings));
    const count = name === "edit_image" ? 1 : "count" in args ? args.count : 1;
    if (name === "generate_images" && count !== settings.count)
      throw new ApiError("INVALID_INPUT", "工具数量与已确认设置不符", 422);
    const submission = submissionSchema.parse(JSON.parse(run.frozen_submission));
    const snapshotIds =
      name === "edit_image"
        ? ["snapshotId" in args ? args.snapshotId : ""]
        : ("snapshotIds" in args ? args.snapshotIds : undefined) ||
          submission.references.map((r) => r.snapshotId);
    const snapshots: Row[] = [];
    for (const snapshotId of snapshotIds) {
      const snapshot = await one(
        this.env,
        "SELECT * FROM appearance_snapshots WHERE id=? AND project_id=?",
        snapshotId,
        run.project_id,
      );
      if (!snapshot) throw new ApiError("FORBIDDEN", "快照不属于当前项目", 403);
      snapshots.push(snapshot);
    }
    const p = (await one(this.env, "SELECT * FROM projects WHERE id=?", run.project_id))!;
    const canvas: Canvas = canvasSchema.parse(JSON.parse(p.canvas));
    const source =
      name === "edit_image"
        ? canvas.elements.find((e) => e.fileId === snapshots[0].asset_id && !e.isDeleted)
        : undefined;
    const input = {
      prompt: args.prompt,
      settings,
      settingsExplicitKeys: submission.settingsExplicitKeys,
      snapshotIds,
      providerMode: this.env.PROVIDER_MODE,
      assetIds: submission.parts.filter((p) => p.type === "image").map((p) => p.assetId).filter(id => !snapshots.some(s => s.asset_id === id)),
      anchor: source ? worldBounds(source) : null,
      viewportCenter: submission.viewportCenter || { x: 0, y: 0 },
    };
    return { count, input, priorTasks };
  }
}
