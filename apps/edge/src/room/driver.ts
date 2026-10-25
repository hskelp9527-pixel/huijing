import {
  functionCallSchema,
  pendingCallsSchema,
  providerContentSchema,
  submissionSchema,
  type PendingCall,
  type ProviderContent,
} from "@loomic/shared/edge";
import { z } from "zod";
import { all, ApiError, hash, id, now, one, publicError, requireRow, stmt } from "../core";
import { FixtureProvider } from "../providers/fixture";
import { VertexProvider } from "../providers/vertex";
import { textSettings, tools } from "../tools";
import type { Row } from "../types";
import { active } from "./context";
import { RunTools } from "./run-tools";
import { RoomTasks } from "./tasks";
import { ChildRuns } from "./children";
import { directIntent, wantsQualityReview } from "../direct";
import { qualityStatus } from "../agent-model";
export class RunDriver extends RunTools {
  async drive(runId: string) {
    for (let rounds = 0; rounds < 16; rounds++) {
      const run = requireRow(await one(this.env, "SELECT * FROM runs WHERE id=?", runId));
      if (!active(run)) return;
      if ((!run.waiting_since && Date.now() - run.started_at > 600000) || run.tool_count > 12)
        throw new ApiError("PROVIDER_ERROR", "此轮执行已达到预算上限", 422);
      if (run.state === "queued") {
        await this.plan(run);
        continue;
      }
      const pending = pendingCallsSchema.parse(JSON.parse(run.pending_calls));
      if (pending.length) {
        await new ChildRuns(this.room).tick(run);
        const waiting = await this.resolvePending(run, pending);
        await new RoomTasks(this.room).dispatch(run.project_id);
        if (waiting) return;
        continue;
      }
      if (run.kind === "media") {
        await this.acceptContent(run, { role: "model", parts: [{ text: "图片处理已完成。" }] });
        return;
      }
      if (run.direct_mode) {
        if (await this.ensureReviews(run)) continue;
        await this.acceptContent(run, { role: "model", parts: [{ text: run.quality_status === "unchecked"
          ? "图片已生成并加入画布。" : "图片已生成，检查结果已记录。" }] });
        return;
      }
      if(await this.ensureReviews(run)) continue;
      // Provider I/O stays outside the mutation gate so cancellation stays responsive.
      await this.ctx.storage.setAlarm(Date.now() + 200000);
      const provider =
        this.env.PROVIDER_MODE === "fixture" ? new FixtureProvider() : new VertexProvider(this.env);
      const modelStarted = Date.now();
      const hasTasks = !!await one(this.env, "SELECT id FROM tasks WHERE run_id=? LIMIT 1", run.id);
      const label = hasTasks ? "检查结果" : "理解需求";
      await this.lock(() => this.atomic(run.project_id, [], [{ type: "run.state", runId: run.id,
        payload: { state: run.state, phase: "model", summary: label } }]));
      let content: ProviderContent;
      try { content = await provider.agent(
        z.array(providerContentSchema).parse(JSON.parse(run.contents)),
        tools,
        run.user_id,
        {
          runId: run.id,
          onFallback: async () => {
            await this.lock(async () => {
              const latest = requireRow(
                await one(this.env, "SELECT * FROM runs WHERE id=?", runId),
              );
              if (active(latest))
                await this.atomic(
                  run.project_id,
                  [],
                  [
                    {
                      type: "run.step",
                      runId,
                      payload: {
                        stepId: runId,
                        tool: "read_canvas",
                        status: "started",
                        summary: "文本模型暂时不可用，已切换备用模型重试",
                      },
                    },
                  ],
                );
            });
          },
        },
      ); } finally {
        await this.lock(() => this.timing(run, "model", label, modelStarted));
      }
      await this.acceptContent(run, content);
    }
    await this.ctx.storage.setAlarm(Date.now() + 100);
  }
  private async ensureReviews(run:Row) {
    return this.lock(async()=>{
      const latest=requireRow(await one(this.env,"SELECT * FROM runs WHERE id=?",run.id));
      if(!active(latest)) return false;
      const children=new ChildRuns(this.room);
      const submission=submissionSchema.parse(JSON.parse(latest.frozen_submission));
      const text=submission.parts.filter((p)=>p.type==="text").map((p)=>p.text).join(" ");
      const userText = this.env.PROVIDER_MODE === "fixture" ? text.replace(/\[fixture:[^\]]*\]/g,"") : text;
      const specs:{key:string;role:"reference-review"|"concept"|"quality-review";ids:string[];required:boolean}[]=[];
      if(!run.direct_mode && submission.references.length) specs.push({key:"auto-reference",role:"reference-review",ids:submission.references.map((r)=>r.snapshotId),required:true});
      if(text.includes("[fixture:delegate=concept]") && this.env.PROVIDER_MODE==="fixture")
        specs.push({key:"auto-concept",role:"concept",ids:submission.references.map((r)=>r.snapshotId),required:true});
      const tasks=await all(this.env,"SELECT * FROM tasks WHERE run_id=? ORDER BY rowid",run.id);
      if(tasks.length && tasks.every((t)=>t.state==="committed") && (!run.direct_mode || wantsQualityReview(userText))) {
        const artifacts=tasks.map((t)=>JSON.parse(t.output) as {snapshotId:string});
        specs.push({key:`auto-quality:${latest.revision_count}`,role:"quality-review",ids:[...submission.references.map((r)=>r.snapshotId),...artifacts.slice(-submission.settings.count).map((a)=>a.snapshotId)],required:wantsQualityReview(userText)});
      }
      const pending:PendingCall[]=[];
      for(const spec of specs) {
        const existing=await one(this.env,"SELECT * FROM child_runs WHERE parent_run_id=? AND invocation_key=?",run.id,spec.key);
        if(existing?.reported) continue;
        if(latest.tool_count+pending.length>=12) throw new ApiError("AGENT_LIMIT_EXCEEDED","主任务委派工具预算已用尽",422);
        await this.readCanvas(latest);
        const args={objective:`${text}\n角色任务：${spec.role}。${spec.role==="quality-review"?"按目标语义、主体保持、构图约束、明显缺陷四项各0–2评分。只返回分析，不执行修订。":"分析指定参考与需求，提出建议。"}`,role:spec.role,referenceSnapshotIds:[...new Set(spec.ids)],required:spec.required};
        const childId=existing?.id || await children.create(latest,spec.key,args);
        pending.push({key:spec.key,functionCall:{name:"agent_delegate",args},childRunIds:[childId]});
      }
      if(!pending.length)return false;
      await stmt(this.env,"UPDATE runs SET pending_calls=?,tool_count=tool_count+? WHERE id=?",JSON.stringify(pending),pending.length,run.id).run();
      return true;
    });
  }
  private async plan(run: Row) {
    await this.lock(async () => {
      run = (await one(this.env, "SELECT * FROM runs WHERE id=?", run.id))!;
      if (run.state !== "queued") return;
      const submission = submissionSchema.parse(JSON.parse(run.frozen_submission));
      const text = submission.parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      const candidates = textSettings(text);
      const effective = {
        ...submission.settings,
        ...Object.fromEntries(
          Object.entries(candidates).filter(
            ([key]) => !submission.settingsExplicitKeys.some((explicit) => explicit === key),
          ),
        ),
      };
      const contents = [
        {
          role: "user",
          parts: [
            {
              text: `${text}\n已确认生成设置：${JSON.stringify(effective)}\n引用快照：${JSON.stringify(submission.references)}`,
            },
          ],
        },
      ];
      const canvas = text.trim() ? await this.readCanvas({ ...run, effective_settings: JSON.stringify(effective) }) : undefined;
      if (canvas) contents[0].parts.push({ text: `服务端已读取画布，可直接使用 snapshotId，无需重复读取：${JSON.stringify(canvas)}` });
      // Fixtures that explicitly exercise delegation/revision keep using the full orchestration path.
      const fixtureWorkflow = this.env.PROVIDER_MODE === "fixture" && /\[fixture:(?:delegate|quality|force-revision|child|layout)/.test(text);
      const intent = fixtureWorkflow ? null : directIntent(text);
      const referenceIds = submission.references.map(r => r.snapshotId);
      const visibleSnapshots = [...new Set(canvas?.elements.filter(e => e.type === "image").map(e => e.snapshotId).filter((id): id is string => !!id) || [])];
      const uploads = submission.parts.filter(p => p.type === "image");
      let editSnapshot = referenceIds.length === 1 ? referenceIds[0] : !referenceIds.length && !uploads.length && visibleSnapshots.length === 1 ? visibleSnapshots[0] : undefined;
      if (intent === "edit" && !referenceIds.length && uploads.length === 1) {
        const asset = requireRow(await one(this.env, "SELECT * FROM assets WHERE id=? AND project_id=? AND user_id=?", uploads[0].assetId, run.project_id, run.user_id));
        const renderKey = `direct-asset:${asset.id}`;
        let snapshot = await one(this.env, "SELECT id FROM appearance_snapshots WHERE user_id=? AND render_key=?", run.user_id, renderKey);
        if (!snapshot) {
          const snapshotId = id("snapshot");
          await stmt(this.env, "INSERT INTO appearance_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)", snapshotId, run.user_id, run.project_id,
            asset.id, asset.id, renderKey, await hash(asset.id), "{}", asset.width, asset.height).run();
          snapshot = { id: snapshotId } as Row;
        }
        editSnapshot = snapshot.id;
      }
      const direct = !!intent && (intent !== "edit" || !!editSnapshot);
      const pending = direct ? [{ key: `${run.id}:direct`, functionCall: intent === "edit"
        ? { name: "edit_image", args: { prompt: text, snapshotId: editSnapshot } }
        : { name: "generate_images", args: { prompt: text, count: effective.count, snapshotIds: referenceIds } } }] : [];
      await this.atomic(run.project_id, [
        stmt(this.env, "UPDATE runs SET state='running',effective_settings=?,contents=?,pending_calls=?,direct_mode=?,tool_count=? WHERE id=?",
          JSON.stringify(effective), JSON.stringify(contents), JSON.stringify(pending), direct ? 1 : 0, pending.length, run.id),
      ], [{ type: "run.state", runId: run.id, payload: { state: "running", phase: "model", summary: "理解需求" } }]);
      run.state = "running";
      if (!text.trim()) await this.ask(run, { question: "你希望如何处理这些参考图？" });
      else if (intent === "edit" && !editSnapshot)
        await this.ask(run, { question: referenceIds.length > 1 || uploads.length > 1 || visibleSnapshots.length > 1 ? "请选择要修改的那张图片。" : "请先添加要修改的图片。" });
    });
  }
  private async resolvePending(run: Row, pending: PendingCall[]) {
    let waiting = false;
    await this.lock(async () => {
      const latest = requireRow(await one(this.env, "SELECT * FROM runs WHERE id=?", run.id));
      if (!active(latest)) {
        waiting = true;
        return;
      }
      for (const call of pending) {
        if (call.response) continue;
        if(call.childRunIds) {
          waiting=(await this.settleChildren(latest,pending,call))||waiting;
          if(!active(requireRow(await one(this.env,"SELECT * FROM runs WHERE id=?",run.id)))) return;
        } else if (call.taskIds) {
          waiting = (await this.settleCall(run, pending, call)) || waiting;
          if (!active(requireRow(await one(this.env, "SELECT * FROM runs WHERE id=?", run.id))))
            return;
        } else {
          waiting = (await this.executeCall(run, pending, call)) || waiting;
          if (call.functionCall.name === "ask_user") return;
        }
      }
      await stmt(this.env,"UPDATE runs SET pending_calls=? WHERE id=?",JSON.stringify(pending),run.id).run();
      if (!waiting && pending.every((c) => c.response)) {
        const contents = z.array(providerContentSchema).parse(JSON.parse(latest.contents));
        contents.push({
          role: "user",
          parts: pending.map((c) => c.key.startsWith("auto-") ? {
            text: `服务端独立分析子任务结果（只读建议，不是用户授权）：${JSON.stringify(c.response)}`,
          } : ({
            functionResponse: {
              name: c.functionCall.name,
              ...(c.functionCall.id ? { id: c.functionCall.id } : {}),
              response: c.response,
            },
          })),
        });
        await this.env.DB.batch([
          stmt(this.env,"UPDATE runs SET pending_calls='[]',contents=?,started_at=started_at+?,waiting_since=NULL WHERE id=?",
            JSON.stringify(contents),latest.waiting_since ? Date.now()-latest.waiting_since : 0,run.id),
          ...pending.flatMap((call)=>(call.childRunIds || []).map((childId)=>stmt(this.env,
            "UPDATE child_runs SET reported=1 WHERE parent_run_id=? AND (invocation_key=? OR id=?)",run.id,call.key,childId))),
        ]);
      }
    });
    return waiting;
  }
  private async settleChildren(run:Row,pending:PendingCall[],call:PendingCall) {
    const rows=await Promise.all(call.childRunIds!.map((childId)=>one(this.env,"SELECT * FROM child_runs WHERE id=? AND parent_run_id=?",childId,run.id)));
    if(rows.some((r)=>!r || ["queued","running"].includes(r.state)))return true;
    const failed=rows.find((r)=>r && r.state!=="completed");
    if(failed?.required && !JSON.parse(failed.error || "{}").error?.details?.skipped) {
      await stmt(this.env,"UPDATE runs SET pending_calls=? WHERE id=?",JSON.stringify(pending),run.id).run();
      await this.ask(run,{question:`必需的 ${failed.role} 子任务未完成。重试只执行分析，已提交图片会保留。`,choices:[{id:"retry",label:"重试分析"},{id:"skip",label:"跳过并继续（未检查）"},{id:"cancel",label:"停止"}]},call);
      return true;
    }
    call.response=failed?{ok:false,warning:true,qualityStatus:"unchecked",...JSON.parse(failed.error||"{}")}:{ok:true,children:rows.map((r)=>JSON.parse(r!.output))};
    if(rows.some((r)=>r?.role==="quality-review")) {
      const status=failed?"unchecked":qualityStatus(JSON.parse(rows.find((r)=>r?.role==="quality-review")!.output).data);
      await stmt(this.env,"UPDATE runs SET quality_status=? WHERE id=?",status,run.id).run();
      // ChildRuns already emits the role-specific step; do not add a second anonymous delegate row.
    }
    return false;
  }
  private async settleCall(run: Row, pending: PendingCall[], call: PendingCall) {
    const tasks = await all(
      this.env,
      "SELECT * FROM tasks WHERE run_id=? AND tool_invocation_id=? ORDER BY slot_index",
      run.id,
      call.key,
    );
    if (tasks.some((t) => !["committed", "failed", "cancelled"].includes(t.state))) return true;
    call.response = {
      tasks: tasks.map((t) => ({
        taskId: t.id,
        state: t.state,
        artifact: t.output ? JSON.parse(t.output) : null,
        error: t.error ? JSON.parse(t.error) : null,
      })),
    };
    const failedTask = tasks.find((t) => t.state === "failed");
    if (!failedTask) return false;
    const messageId = id("msg");
    const parts = [
      {
        type: "text",
        text: tasks.some((t) => t.state === "committed")
          ? "部分图片生成失败，已完成的结果已保留。可手动重试失败项。"
          : "图片生成失败。请查看任务错误后手动重试。",
      },
    ];
    await this.atomic(
      run.project_id,
      [
        stmt(
          this.env,
          "UPDATE runs SET state='failed',error=?,pending_calls=? WHERE id=?",
          failedTask.error,
          JSON.stringify(pending),
          run.id,
        ),
        stmt(
          this.env,
          "INSERT INTO messages(id,project_id,thread_id,run_id,role,parts,created_at) VALUES(?,?,?,?,?,?,?)",
          messageId,
          run.project_id,
          run.thread_id,
          run.id,
          "assistant",
          JSON.stringify(parts),
          now(),
        ),
      ],
      [
        { type: "message.final", runId: run.id, payload: { messageId, parts } },
        {
          type: "run.state",
          runId: run.id,
          payload: { state: "failed", error: JSON.parse(failedTask.error) },
        },
      ],
    );
    return true;
  }
  private async acceptContent(run: Row, content: ProviderContent) {
    await this.lock(async () => {
      const latest = (await one(this.env, "SELECT * FROM runs WHERE id=?", run.id))!;
      if (!active(latest)) return;
      const contents = z.array(providerContentSchema).parse(JSON.parse(latest.contents));
      contents.push(content);
      const calls = content.parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({
          functionCall: functionCallSchema.parse(p.functionCall),
          key: `${run.id}:${latest.tool_count + i}`,
        }));
      if (calls.length) {
        if (latest.tool_count + calls.length > 12)
          throw new ApiError("PROVIDER_ERROR", "工具调用已达到预算", 422);
        const messageId = id("msg");
        await this.atomic(run.project_id, [
          stmt(
            this.env,
            "UPDATE runs SET contents=?,pending_calls=?,tool_count=tool_count+? WHERE id=?",
            JSON.stringify(contents),
            JSON.stringify(calls),
            calls.length,
            run.id,
          ),
          stmt(
            this.env,
            "INSERT INTO messages(id,project_id,thread_id,run_id,role,parts,created_at) VALUES(?,?,?,?,?,?,?)",
            messageId,
            run.project_id,
            run.thread_id,
            run.id,
            "assistant",
            JSON.stringify(content.parts),
            now(),
          ),
        ], [{ type: "message.created", runId: run.id, payload: { messageId, threadId: run.thread_id, role: "assistant", createdAt: now() } }]);
      } else {
        await this.finish(latest, contents, content);
      }
    });
  }
  private async finish(run: Row, contents: ProviderContent[], content: ProviderContent) {
    const tasks = await all(this.env, "SELECT * FROM tasks WHERE run_id=?", run.id);
    const children = await all(this.env,"SELECT id FROM child_runs WHERE parent_run_id=? AND state IN ('queued','running')",run.id);
    if (children.length || tasks.some((task) => !["committed","failed","cancelled"].includes(task.state)))
      throw new ApiError("INVALID_INPUT","全部子任务和媒体任务终态前不能结束主任务",409);
    const failed = tasks.some((t) => t.state === "failed");
    const state = failed ? "failed" : "completed";
    const messageId = id("msg");
    const parts = content.parts
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => ({ type: "text" as const, text: String(p.text) }));
    await this.atomic(
      run.project_id,
      [
        stmt(
          this.env,
          "UPDATE runs SET state=?,contents=? WHERE id=?",
          state,
          JSON.stringify(contents),
          run.id,
        ),
        stmt(
          this.env,
          "INSERT INTO messages(id,project_id,thread_id,run_id,role,parts,created_at) VALUES(?,?,?,?,?,?,?)",
          messageId,
          run.project_id,
          run.thread_id,
          run.id,
          "assistant",
          JSON.stringify(content.parts),
          now(),
        ),
      ],
      [
        { type: "message.final", runId: run.id, payload: { messageId, parts } },
        { type: "run.state", runId: run.id, payload: { state } },
      ],
    );
  }
  async tick(projectId: string) {
    const runs = await all(
      this.env,
      "SELECT * FROM runs WHERE project_id=? AND kind<>'set' AND state IN ('queued','planning','running')",
      projectId,
    );
    await Promise.all(runs.map(async(run) => {
      try {
        await this.drive(run.id);
      } catch (error) {
        const e =
          error instanceof z.ZodError
            ? new ApiError("INVALID_INPUT", "模型工具参数不符合契约", 422)
            : publicError(error);
        await this.lock(async () => {
          const latest = (await one(this.env, "SELECT * FROM runs WHERE id=?", run.id))!;
          if (!active(latest)) return;
          await this.atomic(
            projectId,
            [
              stmt(
                this.env,
                "UPDATE runs SET state='failed',error=? WHERE id=?",
                JSON.stringify(e.body().error),
                run.id,
              ),
              stmt(this.env,"UPDATE child_runs SET state='cancelled' WHERE parent_run_id=? AND state IN ('queued','running')",run.id),
              stmt(
                this.env,
                "UPDATE tasks SET state='cancelled',cancel_requested=1 WHERE run_id=? AND state NOT IN ('committed','failed','cancelled')",
                run.id,
              ),
            ],
            [
              {
                type: "run.state",
                runId: run.id,
                payload: { state: "failed", error: e.body().error },
              },
            ],
          );
        });
      }
    }));
  }
}
