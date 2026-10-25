import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { edgeEventSchema, settingsSchema } from "@loomic/shared/edge";
import { harness, submission, until } from "./harness";
import { source, upload, png, type Harness } from "./media-helpers";

describe("M2b AG01–AG05 Workers fixture integration", () => {
  let h: Harness, cookie: string, userId: string;
  beforeAll(async () => {
    h = await harness({}, "test/agent-worker.ts");
    const auth = await h.guest(); cookie = auth.cookie; userId = auth.user.id;
  });
  afterAll(async () => { await h?.close(); });
  const rows = async (sql: string, ...args: unknown[]) => (await h.db.prepare(sql).bind(...args).all<any>()).results;
  const row = async (sql: string, ...args: unknown[]) => (await h.db.prepare(sql).bind(...args).first<any>())!;
  async function run(runId: string) {
    return until(() => row("SELECT * FROM runs WHERE id=?",runId),
      (r) => ["completed","failed","cancelled","waiting_input"].includes(r.state));
  }
  async function events(projectId: string) {
    const result = await (await h.request(`/api/projects/${projectId}/events`,"GET",undefined,cookie)).json<any>();
    result.items.forEach((event: unknown) => edgeEventSchema.parse(event));
    return result.items as any[];
  }
  async function seed(text = "生成一张杯子", reuse?: Awaited<ReturnType<typeof source>>) {
    const s = reuse || await source(h,cookie);
    const threadId = crypto.randomUUID(), runId = crypto.randomUUID();
    await h.db.prepare("INSERT INTO threads(id,project_id,title,created_at) VALUES(?,?,?,?)").bind(threadId,s.projectId,"fixture",new Date().toISOString()).run();
    const {submissionId:_submissionId,...request}=submission(text,1);
    const frozen = {...request,references:[{snapshotId:s.source.snapshotId,purpose:"subject",order:0}]};
    await h.db.prepare("INSERT INTO runs(id,project_id,thread_id,user_id,state,frozen_submission,effective_settings,started_at,created_at,initiator_client_id) VALUES(?,?,?,?,'planning',?,?,?,?,?)")
      .bind(runId,s.projectId,threadId,userId,JSON.stringify(frozen),JSON.stringify(settingsSchema.parse({count:1})),Date.now(),new Date().toISOString(),`user:${userId}`).run();
    return {...s,threadId,runId};
  }
  async function hook(s: {projectId:string;runId:string}, path: string, extra: Record<string,unknown> = {}) {
    const ns = await h.mf.getDurableObjectNamespace("PROJECT_ROOM");
    const response = await ns.get(ns.idFromName(s.projectId)).fetch(`https://room/fixture/${path}`,{method:"POST",body:JSON.stringify({...s,...extra})});
    return response as Omit<typeof response,"json"> & { json<T = any>(): Promise<T> };
  }
  async function child(s: Awaited<ReturnType<typeof seed>>, role = "concept", objective = "分析方案", required = true) {
    const response = await hook(s,"delegate",{key:crypto.randomUUID(),args:{role,objective,required,referenceSnapshotIds:[s.source.snapshotId]}});
    expect(response.status,await response.clone().text()).toBe(200);
    return response.json() as Promise<string>;
  }
  async function start(text: string) {
    const response = await h.request("/api/projects/start","POST",submission(text,1),cookie);
    expect(response.status,await response.clone().text()).toBe(201);
    return response.json<any>();
  }
  async function answer(s: {runId:string}, choiceId: string, clientOperationId = crypto.randomUUID()) {
    const input = await row("SELECT * FROM input_requests WHERE run_id=? AND state='pending'",s.runId);
    const body = {clientOperationId,answer:{choiceId}};
    return {input,body,response:await h.request(`/api/input-requests/${input.id}/answers`,"POST",body,cookie)};
  }
  it("AG01 三图排一行加标题，提交后丢失工具结果再重放，唯一 Operation/标题且发起用户可撤销", async () => {
    const s = await source(h,cookie);
    const p = await (await h.request(`/api/projects/${s.projectId}`,"GET",undefined,cookie)).json<any>();
    const original = p.canvas.elements[0];
    await h.request(`/api/projects/${s.projectId}/canvas/ops`,"POST",{clientOpId:crypto.randomUUID(),baseRevision:p.canvas.revision,
      ops:[1,2].map((i)=>({kind:"upsert",element:{...original,id:`image-${i}`,x:i*400,y:i*70}}))},cookie);
    await h.db.prepare("UPDATE operations SET created_at='2000-01-01T00:00:00.000Z' WHERE project_id=?").bind(s.projectId).run();
    const before = JSON.parse((await row("SELECT canvas FROM projects WHERE id=?",s.projectId)).canvas);
    const assetBefore = await row("SELECT sha256,storage_key FROM assets WHERE id=?",s.asset.id);
    const thread = await (await h.request("/api/threads","POST",{projectId:s.projectId},cookie)).json<any>();
    const response = await h.request(`/api/threads/${thread.thread.id}/messages`,"POST",{clientMessageId:crypto.randomUUID(),parts:[{type:"text",text:"三图排成一行并加标题 [fixture:layout]"}],references:[],settings:{count:1},settingsExplicitKeys:[]},cookie);
    const started = {...s,runId:(await response.json<any>()).runId};
    expect((await run(started.runId)).state).toBe("completed");
    const operations = await rows("SELECT * FROM operations WHERE project_id=? AND source='agent'",s.projectId);
    expect(operations).toHaveLength(1);
    const op = operations[0], changes = JSON.parse(op.changes);
    expect(op.client_op_id).toMatch(/^agent-canvas:/);
    expect(changes).toMatchObject({runId:started.runId,initiatorClientId:expect.stringMatching(/^client:/)});
    const completed = await row("SELECT * FROM runs WHERE id=?",started.runId);
    const contents = JSON.parse(completed.contents);
    const call = contents.flatMap((c:any)=>c.parts).find((part:any)=>part.functionCall?.name==="canvas_apply").functionCall;
    // Crash window: canvas transaction committed, but pending tool response was lost.
    await h.db.prepare("UPDATE runs SET state='running',pending_calls=? WHERE id=?")
      .bind(JSON.stringify([{key:op.client_op_id.slice("agent-canvas:".length),functionCall:call}]),started.runId).run();
    const ns = await h.mf.getDurableObjectNamespace("PROJECT_ROOM");
    await ns.get(ns.idFromName(s.projectId)).fetch("https://room/wake",{method:"POST",body:JSON.stringify({projectId:s.projectId})});
    expect((await run(started.runId)).state).toBe("completed");
    const after = JSON.parse((await row("SELECT canvas FROM projects WHERE id=?",s.projectId)).canvas);
    expect(after.elements.filter((e:any)=>e.type==="text")).toHaveLength(1);
    expect(after.elements.filter((e:any)=>e.type==="image").map((e:any)=>e.y+e.height/2)).toEqual([160,160,160]);
    expect(after.revision).toBe(op.after_revision);
    expect(await rows("SELECT id FROM operations WHERE project_id=? AND source='agent'",s.projectId)).toHaveLength(1);
    expect(await row("SELECT sha256,storage_key FROM assets WHERE id=?",s.asset.id)).toEqual(assetBefore);
    const body = {clientOperationId:crypto.randomUUID()};
    const undo = await h.request(`/api/projects/${s.projectId}/agent-operations/${op.id}/undo`,"POST",body,cookie);
    expect(undo.status,await undo.clone().text()).toBe(200);
    expect(await (await h.request(`/api/projects/${s.projectId}/agent-operations/${op.id}/undo`,"POST",body,cookie)).json()).toEqual(await undo.json());
    const restored = JSON.parse((await row("SELECT canvas FROM projects WHERE id=?",s.projectId)).canvas);
    expect(restored.elements.filter((e:any)=>e.type==="image").map((e:any)=>({id:e.id,x:e.x,y:e.y,fileId:e.fileId})))
      .toEqual(before.elements.map((e:any)=>({id:e.id,x:e.x,y:e.y,fileId:e.fileId})));
    expect(restored.elements.filter((e:any)=>e.type==="text"&&!e.isDeleted)).toHaveLength(0);
  });
  it("AG02 两个 Thread 各有两活跃子 Run，第三个/深度2拒绝，冻结身份与只读范围", async () => {
    const a = await seed(), b = await seed("另一线程",a);
    await hook(a,"read"); await hook(b,"read");
    const ids = await Promise.all([child(a),child(a,"reference-review"),child(b),child(b,"quality-review")]);
    expect(await rows("SELECT * FROM child_runs WHERE project_id=? AND state='queued'",a.projectId)).toHaveLength(4);
    const c = await hook(a,"delegate",{key:"third",args:{role:"concept",objective:"第三个",required:true}});
    expect(await c.json()).toMatchObject({error:{code:"AGENT_LIMIT_EXCEEDED"}});
    const frozen = JSON.parse((await row("SELECT frozen_input FROM child_runs WHERE id=?",ids[0])).frozen_input);
    expect(frozen).toMatchObject({role:"concept",objective:"分析方案",referenceSnapshotIds:[a.source.snapshotId],allowedTools:["read_canvas"],allowedShapeIds:[a.source.elementId]});
    const nested = await hook({...a,runId:ids[0]},"delegate",{key:"nested",args:{role:"concept",objective:"嵌套",required:true}});
    expect(await nested.json()).toMatchObject({error:{code:"FORBIDDEN"}});
    await hook(a,"tick"); await hook(b,"tick");
    expect(await rows("SELECT * FROM child_runs WHERE project_id=? AND state='completed'",a.projectId)).toHaveLength(4);
    const steps = (await events(a.projectId)).filter((event)=>event.payload.childRunId);
    expect(steps).toHaveLength(12);
    expect(steps.filter((event)=>event.payload.childState==="running")).toHaveLength(4);
    expect(steps.every((e)=>e.payload.parentRunId===e.runId && e.payload.role)).toBe(true);
  });
  it.each([["[fixture:child-tools=13]","AGENT_LIMIT_EXCEEDED"],["[fixture:child-tool=generate_images]","FORBIDDEN"]])("AG02/AG04 子工具预算与越权调用 %s", async (objective,code) => {
    const s=await seed(); const childId=await child(s,"concept",objective);
    await hook(s,"tick");
    const result=await row("SELECT * FROM child_runs WHERE id=?",childId);
    expect(result.state).toBe("failed"); expect(JSON.parse(result.error)).toMatchObject({error:{code}});
    expect(await rows("SELECT * FROM tasks WHERE run_id=?",s.runId)).toHaveLength(0);
  });
  it("AG02 子 Run 超过10分钟明确报错", async () => {
    const s=await seed(), childId=await child(s);
    await h.db.prepare("UPDATE child_runs SET started_at=? WHERE id=?").bind(Date.now()-600001,childId).run();
    await hook(s,"tick");
    expect(JSON.parse((await row("SELECT error FROM child_runs WHERE id=?",childId)).error)).toMatchObject({error:{code:"AGENT_LIMIT_EXCEEDED"}});
  });
  it("AG02 委派已持久化但父 pending 尚未保存时恢复，子结果只交付一次且无孤儿", async () => {
    const s=await seed("生成一张杯子");
    const response=await hook(s,"delegate",{key:"auto-reference",args:{role:"reference-review",objective:"冻结参考解析",required:true,referenceSnapshotIds:[s.source.snapshotId]}});
    const childId=await response.json();
    // Crash before runs.pending_calls/tool_count could be saved; alarm reconstructs the handoff.
    expect(JSON.parse((await row("SELECT pending_calls FROM runs WHERE id=?",s.runId)).pending_calls)).toEqual([]);
    const ns=await h.mf.getDurableObjectNamespace("PROJECT_ROOM");
    await ns.get(ns.idFromName(s.projectId)).fetch("https://room/wake",{method:"POST",body:JSON.stringify({projectId:s.projectId})});
    const result=await run(s.runId); expect(result.state,JSON.stringify({error:result.error,contents:JSON.parse(result.contents),pending:JSON.parse(result.pending_calls)})).toBe("completed");
    const references=await rows("SELECT * FROM child_runs WHERE parent_run_id=? AND role='reference-review'",s.runId);
    expect(references).toHaveLength(1); expect(references[0]).toMatchObject({id:childId,state:"completed",reported:1});
    expect(await rows("SELECT id FROM child_runs WHERE parent_run_id=? AND state IN ('queued','running')",s.runId)).toHaveLength(0);
    expect(result.tool_count).toBe(4);
  });
  it("AG02 必需 concept 失败询问继续或重试，可选质量失败仅 warning", async () => {
    const required=await start("生成一张杯子 [fixture:delegate=concept] [fixture:child-error=concept]");
    expect((await run(required.runId)).state).toBe("waiting_input");
    expect(await rows("SELECT * FROM tasks WHERE run_id=?",required.runId)).toHaveLength(0);
    expect((await answer(required,"skip")).response.status).toBe(200);
    expect((await run(required.runId)).state).toBe("completed");
    const optional=await start("生成一张杯子 [fixture:child-error=quality-review]");
    expect((await run(optional.runId)).state).toBe("completed");
    expect((await events(optional.projectId)).some((e)=>e.payload.role==="quality-review"&&e.payload.warning===true)).toBe(true);
    expect((await row("SELECT quality_status FROM runs WHERE id=?",optional.runId)).quality_status).toBe("unchecked");
  });
  it("AG03 名称蓝色但输入红色像素，reference/quality 的独立结果含实际 inlineData 证据", async () => {
    const s=await seed("蓝色图片（实际是红色）");
    const asset=await upload(h,cookie,s.projectId,png(1,1,[255,0,0,255]));
    const {snapshot}=await (await h.request("/api/snapshots","POST",{projectId:s.projectId,sourceAssetId:asset.id,renderKey:crypto.randomUUID()},cookie)).json<any>();
    await h.db.prepare("UPDATE runs SET frozen_submission=? WHERE id=?").bind(JSON.stringify({...submission("名称蓝色，审查像素",1),references:[{snapshotId:snapshot.id,purpose:"subject",order:0}]}),s.runId).run();
    const red={...s,source:{...s.source,snapshotId:snapshot.id}};
    const ids=[await child(red,"reference-review"),await child(red,"quality-review")];
    await hook(red,"tick");
    for(const childId of ids) {
      const output=JSON.parse((await row("SELECT output FROM child_runs WHERE id=?",childId)).output);
      expect(output.parentRunId).toBe(s.runId);
      expect(output.data.recommendations.join(" ")).toContain("firstPixelRGBA=255,0,0,255");
      expect(output.data.recommendations.join(" ")).toContain("actualPixels=1x1");
    }
  });
  it("AG03 无视觉模型启动可诊断，子任务明确失败，不假装检查通过", async () => {
    const s=await seed(); const childId=await child(s,"reference-review");
    const frozen=JSON.parse((await row("SELECT frozen_input FROM child_runs WHERE id=?",childId)).frozen_input);
    frozen.modelId="text-only";
    await h.db.prepare("UPDATE child_runs SET frozen_input=? WHERE id=?").bind(JSON.stringify(frozen),childId).run();
    await hook(s,"tick");
    const result=await row("SELECT * FROM child_runs WHERE id=?",childId);
    expect(result.output).toBeNull(); expect(JSON.parse(result.error)).toMatchObject({error:{code:"UNSUPPORTED_CAPABILITY"}});
  });
  it("AG03 浏览器 OCR 不可用/未完成不等于无文字；成功空结果、区域和模型版本可追溯，concept无权", async () => {
    const s=await seed(); const args={snapshotId:s.source.snapshotId};
    const read=()=>hook(s,"ocr",{args,allowed:[s.source.snapshotId],role:"reference-review"});
    expect(await (await read()).json()).toMatchObject({error:{code:"OCR_UNAVAILABLE"}});
    // Browser timeout creates no successful client-result; a second read still cannot claim no text.
    expect(await (await read()).json()).toMatchObject({error:{code:"OCR_UNAVAILABLE"}});
    const client=(regions:unknown[])=>h.request("/api/media/client-results","POST",{clientOpId:crypto.randomUUID(),projectId:s.projectId,sourceSnapshotId:s.source.snapshotId,op:"ocr",params:{},engine:{name:"browser-ocr",version:"1",modelSha256:"a".repeat(64)},result:{ocrRegions:regions}},cookie);
    expect((await client([])).status).toBe(201);
    expect(await (await read()).json()).toMatchObject({ok:true,data:{snapshotId:s.source.snapshotId,regions:[],ocrModelVersion:`browser-ocr:1:${"a".repeat(64)}`}});
    expect((await client([{x:0,y:0,width:2,height:1,text:"真实文字",confidence:0.9}])).status).toBe(201);
    const found=await (await read()).json<any>();
    expect(found.data.regions[0]).toMatchObject({text:"真实文字",confidence:0.9,quad:[[0,0],[0.5,0],[0.5,1/3],[0,1/3]]});
    expect(await (await hook(s,"ocr",{args,allowed:[s.source.snapshotId],role:"concept"})).json()).toMatchObject({error:{code:"FORBIDDEN"}});
    expect(await (await hook(s,"ocr",{args,allowed:[],role:"quality-review"})).json()).toMatchObject({error:{code:"FORBIDDEN"}});
    expect(await rows("SELECT * FROM tasks WHERE run_id=?",s.runId)).toHaveLength(0);
  });
  it.each([false,true])("AG04 修订建议默认保留，自动迭代授权=%s 时最多一轮、计额度并关联原Task", async (allowed) => {
    const s=await start(`生成一张杯子 ${allowed?"允许自动迭代":""} [fixture:quality-revise]`);
    const result=await run(s.runId); expect(result.state,result.error).toBe("completed");
    const tasks=await rows("SELECT * FROM tasks WHERE run_id=? ORDER BY rowid",s.runId);
    expect(tasks).toHaveLength(allowed?2:1);
    expect(tasks.every((task)=>task.state==="committed")).toBe(true);
    expect(result.revision_count).toBe(allowed?1:0);
    expect(result.quality_status).toBe("revise");
    if(allowed) {
      expect(tasks[1].retry_of_task_id).toBe(tasks[0].id);
      const reservations=await rows("SELECT * FROM quota_reservations WHERE task_id IN (?,?)",tasks[0].id,tasks[1].id);
      expect(reservations.map((reservation)=>reservation.state)).toEqual(["counted","counted"]);
    }
  });
  it("AG04 不允许自动迭代时，即使主模型试图再次生成也拒绝；不消耗第二次额度", async () => {
    const s=await start("生成一张杯子，不允许自动迭代 [fixture:quality-revise] [fixture:force-revision]");
    const result=await run(s.runId);
    expect(result.state).toBe("failed");
    expect(JSON.parse(result.error)).toMatchObject({code:"INVALID_INPUT"});
    const tasks=await rows("SELECT id,state FROM tasks WHERE run_id=?",s.runId);
    expect(tasks).toHaveLength(1); expect(tasks[0].state).toBe("committed");
    expect(await rows("SELECT * FROM quota_reservations WHERE task_id=? AND state='counted'",tasks[0].id)).toHaveLength(1);
  });
  it.each(["retry","skip","cancel"])("AG04 committed后必需审查失败 %s，resumePhase=running，回答幂等且不重新生图", async (choice) => {
    const s=await start("生成一张杯子并检查质量 [fixture:child-error=quality-review]");
    expect((await run(s.runId)).state).toBe("waiting_input");
    const tasks=await rows("SELECT * FROM tasks WHERE run_id=?",s.runId);
    expect(tasks.map((task)=>task.state)).toEqual(["committed"]);
    if(choice==="retry") {
      // Restore provider availability while retaining all frozen IDs and image assets.
      const failed=await row("SELECT * FROM child_runs WHERE parent_run_id=? AND role='quality-review'",s.runId);
      const frozen=JSON.parse(failed.frozen_input); frozen.objective=frozen.objective.replace("[fixture:child-error=quality-review]","");
      await h.db.prepare("UPDATE child_runs SET frozen_input=? WHERE id=?").bind(JSON.stringify(frozen),failed.id).run();
    }
    const {input,body,response}=await answer(s,choice);
    expect(JSON.parse(input.payload).resumePhase).toBe("running"); expect(input.resume_phase).toBe("running");
    expect(response.status,await response.clone().text()).toBe(200);
    expect(await (await h.request(`/api/input-requests/${input.id}/answers`,"POST",body,cookie)).json()).toEqual(await response.json());
    expect((await run(s.runId)).state).toBe(choice==="cancel"?"cancelled":"completed");
    const after=await rows("SELECT * FROM tasks WHERE run_id=?",s.runId);
    expect(after.map((task)=>({id:task.id,state:task.state,output:task.output}))).toEqual(tasks.map((task)=>({id:task.id,state:task.state,output:task.output})));
    const closed=await h.request(`/api/input-requests/${input.id}/answers`,"POST",{...body,clientOperationId:crypto.randomUUID()},cookie);
    expect(closed.status).toBe(409); expect(await closed.json()).toMatchObject({error:{code:"INPUT_REQUEST_CLOSED"}});
    const final=await row("SELECT * FROM runs WHERE id=?",s.runId);
    expect(final.quality_status).toBe(choice==="retry"?"pass":"unchecked");
    if(choice==="retry") expect(await rows("SELECT * FROM child_runs WHERE parent_run_id=? AND role='quality-review'",s.runId)).toHaveLength(2);
  });
  it("AG04 停止级联子 Run 和未完成媒体任务，迟到结果不能复活", async () => {
    const s=await seed(); const childId=await child(s,"reference-review","[fixture:child-delay=1000]");
    await h.db.prepare("INSERT INTO tasks(id,project_id,run_id,user_id,tool_invocation_id,operation,slot_index,state,input,created_at,updated_at) VALUES(?,?,?,?,?,'generate',0,'queued','{}',?,?)")
      .bind("cancel-task",s.projectId,s.runId,userId,"cancel-tool",new Date().toISOString(),new Date().toISOString()).run();
    const ticking=hook(s,"tick");
    await until(()=>row("SELECT state FROM child_runs WHERE id=?",childId),(child)=>child.state==="running");
    expect((await h.request(`/api/runs/${s.runId}/cancel`,"POST",{},cookie)).status).toBe(200);
    await ticking;
    expect((await row("SELECT state FROM child_runs WHERE id=?",childId)).state).toBe("cancelled");
    expect((await events(s.projectId)).some((event)=>event.payload.childRunId===childId&&event.payload.childState==="cancelled")).toBe(true);
    expect((await row("SELECT state FROM tasks WHERE id='cancel-task'")).state).toBe("cancelled");
    expect((await row("SELECT state FROM runs WHERE id=?",s.runId)).state).toBe("cancelled");
    expect((await events(s.projectId)).filter((e)=>e.payload.childRunId===childId&&e.payload.status==="completed")).toHaveLength(0);
  });
  it("AG05 同元素用户最近编辑则跳过，过期 revision 冲突/锁定/伪造ID均拒绝，整批不部分写入", async () => {
    const s=await seed(); const read=await (await hook(s,"read")).json<any>();
    const args={baseCanvasRevision:read.revision,expectedShapeRevisions:{[s.source.elementId]:read.elements[0].version},commands:[{kind:"updateGeometry",target:{id:s.source.elementId},x:999}]};
    const skipped=await (await hook(s,"apply",{key:"recent",args})).json<any>();
    expect(skipped.skipped).toMatchObject([{elementId:s.source.elementId,reason:"USER_EDITING"}]);
    expect(skipped.changedShapes).toEqual([]);
    expect((await events(s.projectId)).some((event)=>event.payload.summary?.includes("已跳过"))).toBe(true);
    await h.db.prepare("UPDATE operations SET created_at='2000-01-01T00:00:00.000Z' WHERE project_id=?").bind(s.projectId).run();
    const project=await row("SELECT canvas FROM projects WHERE id=?",s.projectId); const canvas=JSON.parse(project.canvas);
    await h.request(`/api/projects/${s.projectId}/canvas/ops`,"POST",{clientOpId:crypto.randomUUID(),baseRevision:canvas.revision,ops:[{kind:"upsert",element:{...canvas.elements[0],x:321,locked:true}}]},cookie);
    await h.db.prepare("UPDATE operations SET created_at='2000-01-01T00:00:00.000Z' WHERE project_id=?").bind(s.projectId).run();
    expect(await (await hook(s,"apply",{key:"stale",args})).json()).toMatchObject({error:{code:"CANVAS_CONFLICT"}});
    const latest=JSON.parse((await row("SELECT canvas FROM projects WHERE id=?",s.projectId)).canvas);
    expect(await (await hook(s,"apply",{key:"locked",args:{...args,baseCanvasRevision:latest.revision,expectedShapeRevisions:{},commands:[{kind:"createText",localKey:"never",text:"不可出现",x:0,y:0},...args.commands]}})).json()).toMatchObject({error:{code:"CANVAS_CONFLICT",details:{reason:"ELEMENT_LOCKED"}}});
    expect(await (await hook(s,"apply",{key:"invented",args:{...args,commands:[{kind:"updateGeometry",target:{id:"invented"},x:100}]}})).json()).toMatchObject({error:{code:"FORBIDDEN"}});
    expect(JSON.parse((await row("SELECT canvas FROM projects WHERE id=?",s.projectId)).canvas)).toEqual(latest);
    expect(latest.elements[0].x).toBe(321);
  });
  it("AG01/AG05 frame分组和层级写入同一Operation；不相关对象更新可合并，幂等内容改变拒绝", async () => {
    const s=await seed();
    await h.db.prepare("UPDATE operations SET created_at='2000-01-01T00:00:00.000Z' WHERE project_id=?").bind(s.projectId).run();
    const read=await (await hook(s,"read")).json<any>();
    // New user object is unrelated to the agent's frozen target, so stale global revision is mergeable.
    await h.request(`/api/projects/${s.projectId}/canvas/ops`,"POST",{clientOpId:crypto.randomUUID(),baseRevision:read.revision,ops:[{kind:"upsert",element:{id:"unrelated",type:"rectangle",x:500,y:500,width:10,height:10,version:1}}]},cookie);
    const args={baseCanvasRevision:read.revision,expectedShapeRevisions:{[s.source.elementId]:read.elements[0].version},commands:[
      {kind:"createFrame",localKey:"group",name:"产品组",x:-10,y:-10,width:260,height:200},
      {kind:"reparent",target:{id:s.source.elementId},frame:{localKey:"group"}},
      {kind:"reorder",target:{id:s.source.elementId},placement:"front"}]};
    const applied=await hook(s,"apply",{key:"grouping",args}); expect(applied.status,await applied.clone().text()).toBe(200);
    const result=await applied.json<any>(); expect(result.operationIds).toHaveLength(1); expect(result.createdShapeIds).toHaveLength(1);
    expect(result.changedShapes.every((element:any) => typeof element.index === "string")).toBe(true);
    expect(await (await hook(s,"apply",{key:"grouping",args})).json()).toEqual(result);
    const changed=await hook(s,"apply",{key:"grouping",args:{...args,commands:[{kind:"updateGeometry",target:{id:s.source.elementId},x:42}]}});
    expect(await changed.json()).toMatchObject({error:{code:"IDEMPOTENCY_MISMATCH"}});
    const canvas=JSON.parse((await row("SELECT canvas FROM projects WHERE id=?",s.projectId)).canvas);
    expect(canvas.elements.find((element:any)=>element.id===s.source.elementId).frameId).toBe(result.createdShapeIds[0]);
    expect(canvas.elements.at(-1).id).toBe(s.source.elementId);
    const changedEvent=(await events(s.projectId)).filter((event)=>event.type==="canvas.ops"&&event.payload.source==="agent").at(-1);
    expect(changedEvent.payload.elementOrder).toEqual(canvas.elements.map((element:any)=>element.id));
    const refused=await hook(s,"apply",{key:"child-denied-hide",args:{baseCanvasRevision:canvas.revision,commands:[{kind:"softDelete",target:{id:s.source.elementId}}]}});
    expect(await refused.json()).toMatchObject({error:{code:"FORBIDDEN"}});
  });
});
