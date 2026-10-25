import { childRoleSchema, canvasSchema, providerContentSchema, functionCallSchema, type ProviderContent, type ChildRole } from "@loomic/shared/edge";
import { z } from "zod";
import { AgentModelAdapter, AGENT_ROLE_REGISTRY, parseChildResult, qualityStatus, type AgentImage } from "../agent-model";
import { all, ApiError, configuredInt, id, one, publicError, requireRow, stmt } from "../core";
import { assetBytes } from "../images";
import { tools } from "../tools";
import type { Row } from "../types";
import { RoomService, active } from "./context";
import { AgentOCR } from "./ocr";

export const delegateArgs = z.object({
  objective:z.string().min(1).max(20000), role:childRoleSchema,
  referenceSnapshotIds:z.array(z.string().min(1)).max(16).default([]), required:z.boolean(),
}).strict();
const frozenSchema = delegateArgs.extend({ allowedShapeIds:z.array(z.string()), modelId:z.string(), allowedTools:z.array(z.string()), snapshots:z.array(z.object({ id:z.string(), assetId:z.string(), mime:z.string(), width:z.number(), height:z.number() })) });

/** Child identities are separate from the thread's unique active main run. */
export class ChildRuns extends RoomService {
  async create(run: Row, key: string, raw: unknown) {
    if (await one(this.env, "SELECT id FROM child_runs WHERE id=?", run.id))
      throw new ApiError("FORBIDDEN", "子任务不能继续委派", 403);
    const args = delegateArgs.parse(raw);
    const old = await one(this.env, "SELECT * FROM child_runs WHERE parent_run_id=? AND invocation_key=?", run.id, key);
    if (old) return old.id;
    if (!active(requireRow(await one(this.env,"SELECT * FROM runs WHERE id=?",run.id))))
      throw new ApiError("INVALID_INPUT", "主任务已停止", 409);
    const count = await one(this.env, "SELECT COUNT(*) n FROM child_runs WHERE parent_run_id=? AND state IN ('queued','running')", run.id);
    if ((count?.n || 0) >= 2) throw new ApiError("AGENT_LIMIT_EXCEEDED", "同一主任务最多两个活跃子任务", 422);
    const allowed = await this.allowedSnapshots(run);
    if (args.referenceSnapshotIds.some((s) => !allowed.includes(s)))
      throw new ApiError("FORBIDDEN", "子任务只能引用本轮授权快照", 403);
    const adapter = new AgentModelAdapter(this.env);
    const snapshots = await Promise.all(args.referenceSnapshotIds.map(async (snapshotId) => {
      const row = requireRow(await one(this.env, "SELECT s.id,s.asset_id,a.mime,a.width,a.height FROM appearance_snapshots s JOIN assets a ON a.id=s.asset_id WHERE s.id=? AND s.project_id=? AND s.user_id=?", snapshotId, run.project_id, run.user_id));
      return { id:row.id, assetId:row.asset_id, mime:row.mime, width:row.width, height:row.height };
    }));
    const input = { ...args, modelId:adapter.roleModelId(args.role), snapshots,
      allowedTools:[...AGENT_ROLE_REGISTRY[args.role].tools],
      allowedShapeIds:await this.ctx.storage.get<string[]>(`agent-allowed:${run.id}`) || [] };
    const childId = id("child");
    await this.atomic(run.project_id, [stmt(this.env,
      "INSERT INTO child_runs(id,parent_run_id,project_id,role,invocation_key,required,state,frozen_input,started_at) VALUES(?,?,?,?,?,?,'queued',?,?)",
      childId,run.id,run.project_id,args.role,key,args.required ? 1 : 0,JSON.stringify(input),Date.now())],
      [this.event(run, childId,args.role,"started","子任务已排队")]);
    return childId;
  }
  async allowedSnapshots(run:Row) {
    const submission = JSON.parse(run.frozen_submission) as { references?:{snapshotId:string}[] };
    const returned = await this.ctx.storage.get<string[]>(`agent-snapshots:${run.id}`) || [];
    const result = await all(this.env,"SELECT a.snapshot_id FROM artifacts a JOIN tasks t ON t.id=a.task_id WHERE t.run_id=?",run.id);
    return [...new Set([...(submission.references || []).map((r)=>r.snapshotId),...returned,...result.map((r)=>r.snapshot_id)])];
  }
  async tick(run:Row) {
    const children = await all(this.env,"SELECT * FROM child_runs WHERE parent_run_id=? AND state IN ('queued','running')",run.id);
    await Promise.all(children.map((child)=>this.execute(run,child)));
  }
  private async execute(run:Row, child:Row) {
    const controller = new AbortController();
    this.room.childControllers?.set(child.id, controller);
    const budget = configuredInt(this.env.CHILD_TIMEOUT_MS || "45000", 1);
    const remaining = Math.max(0, budget - (Date.now() - child.started_at));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.executeBody(run, child, controller),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ApiError("AGENT_LIMIT_EXCEEDED", "子任务超时，已跳过检查", 422, false, { skipped: true, timeoutMs: budget }));
          }, remaining);
        }),
      ]);
    } catch (error) {
      // The timeout is advisory for both required and optional reviews; it never asks the user to unblock a Run.
      const timedOut = Date.now() - child.started_at >= budget;
      const failure = timedOut ? new ApiError("AGENT_LIMIT_EXCEEDED", "子任务超时，已跳过检查", 422, false, { skipped: true, timeoutMs: budget }) : error;
      await this.finish(run, child, "failed", publicError(failure).body());
    } finally {
      clearTimeout(timer);
      this.room.childControllers?.delete(child.id);
    }
  }
  private async executeBody(run:Row, child:Row, controller:AbortController) {
    try {
      const input = frozenSchema.parse(JSON.parse(child.frozen_input));
      await this.lock(async()=>{
        const parent = requireRow(await one(this.env,"SELECT * FROM runs WHERE id=?",run.id));
        if (!active(parent)) return;
        if(child.state === "queued") await this.atomic(run.project_id,
          [stmt(this.env,"UPDATE child_runs SET state='running' WHERE id=? AND state='queued'",child.id)],
          [this.event(run,child.id,input.role,"started","子任务正在独立分析",false,"running")]);
      });
      let contents = z.array(providerContentSchema).parse(JSON.parse(child.contents));
      const adapter = new AgentModelAdapter(this.env);
      adapter.assertRoleCapabilities(input.role,input.modelId,input.snapshots.length>0);
      const images:AgentImage[] = await Promise.all(input.snapshots.map(async(s)=>{
        const asset = requireRow(await one(this.env,"SELECT * FROM assets WHERE id=? AND project_id=?",s.assetId,run.project_id));
        return {...s,data:await assetBytes(this.env,asset)};
      }));
      for (let rounds=0;rounds<14;rounds++) {
        const current = requireRow(await one(this.env,"SELECT * FROM child_runs WHERE id=?",child.id));
        if (controller.signal.aborted || !["queued","running"].includes(current.state) || !active(requireRow(await one(this.env,"SELECT * FROM runs WHERE id=?",run.id)))) return;
        if (Date.now()-current.started_at>=600000 || current.tool_count>12)
          throw new ApiError("AGENT_LIMIT_EXCEEDED","子任务达到 12 次工具或 10 分钟预算",422);
        let content:ProviderContent;
        content = await adapter.step({runId:child.id,parentRunId:run.id,role:input.role,objective:input.objective,
          referenceSnapshots:images,messages:contents,tools:tools.filter((t)=>input.allowedTools.includes(t.name)),modelId:input.modelId,userId:run.user_id,signal:controller.signal,
          beforeSend:async()=>{
            if (!active(requireRow(await one(this.env,"SELECT * FROM runs WHERE id=?",run.id)))) controller.abort();
            if (controller.signal.aborted) throw new ApiError("INVALID_INPUT","子任务已取消或超时",409);
          }});
        if (controller.signal.aborted) return;
        const calls = content.parts.filter((p)=>p.functionCall).map((p)=>functionCallSchema.parse(p.functionCall));
        if (!calls.length) {
          const result = parseChildResult(content,input.referenceSnapshotIds,input.role);
          if(input.role==="quality-review" && qualityStatus(result)==="unable_to_judge")
            throw new ApiError("PROVIDER_ERROR","质量检查无法判断，需要 OCR 或人工核对",422,true);
          await this.finish(run,child,"completed",{childRunId:child.id,parentRunId:run.id,role:input.role,inputSnapshotIds:input.referenceSnapshotIds,ok:true,data:result});
          return;
        }
        if(current.tool_count+calls.length>12) throw new ApiError("AGENT_LIMIT_EXCEEDED","子任务工具调用超限",422);
        contents.push(content);
        const responses:Record<string,unknown>[]=[];
        for(const call of calls) {
          if(!input.allowedTools.includes(call.name)) throw new ApiError("FORBIDDEN","子任务不允许调用此工具或创建媒体任务",403);
          let response:unknown;
          try {
            if(call.name==="media_ocr") response=await new AgentOCR(this.room).read(run,call.args,input.referenceSnapshotIds,input.role);
            else {
              const canvas=canvasSchema.parse(JSON.parse(requireRow(await one(this.env,"SELECT * FROM projects WHERE id=?",run.project_id)).canvas));
              response={ok:true,data:{revision:canvas.revision,elements:canvas.elements.filter((e)=>input.allowedShapeIds.includes(e.id)),snapshots:input.snapshots}};
            }
          }catch(e){response={ok:false,...publicError(e).body()};}
          responses.push({functionResponse:{name:call.name,...(call.id?{id:call.id}:{}),response}});
        }
        contents.push({role:"user",parts:responses});
        await this.lock(async()=>{
          await stmt(this.env,"UPDATE child_runs SET contents=?,tool_count=tool_count+? WHERE id=? AND state='running'",JSON.stringify(contents),calls.length,child.id).run();
        });
      }
      throw new ApiError("AGENT_LIMIT_EXCEEDED","子任务执行轮次超限",422);
    } catch(error) {
      // The outer deadline owns aborted completion, avoiding late provider responses overwriting skipped status.
      if (!controller.signal.aborted) throw error;
    }
  }
  private async finish(run:Row,child:Row,state:"completed"|"failed",output:unknown) {
    await this.lock(async()=>{
      const latest=requireRow(await one(this.env,"SELECT * FROM child_runs WHERE id=?",child.id));
      const parent=requireRow(await one(this.env,"SELECT * FROM runs WHERE id=?",run.id));
      if(!["queued","running"].includes(latest.state) || !active(parent)) return;
      const skipped = state === "failed" && (output as { error?: { details?: { skipped?: boolean } } }).error?.details?.skipped;
      await this.atomic(run.project_id,[stmt(this.env,"UPDATE child_runs SET state=?,output=?,error=? WHERE id=?",state,state==="completed"?JSON.stringify(output):null,state==="failed"?JSON.stringify(output):null,child.id)],
        [this.event(run,child.id,child.role as ChildRole,state==="failed"?"failed":"completed",skipped?"子任务超时，已跳过":state==="failed"?"子任务失败":"子任务完成",!!skipped || state==="failed"&&!child.required,skipped?"skipped":state),
          { type: "run.timing", runId: run.id, payload: { phase: "review", label: `${child.role} ${state}`, startedAt: new Date(child.started_at).toISOString(), durationMs: Date.now() - child.started_at } }]);
    });
  }
  event(run:Row,childRunId:string,role:ChildRole,status:"started"|"completed"|"failed",summary:string,warning=false,childState=status==="started"?"queued":status) {
    return {type:"run.step" as const,runId:run.id,payload:{stepId:childRunId,tool:"agent_delegate",role,parentRunId:run.id,childRunId,childState,status,summary,warning}};
  }
}
