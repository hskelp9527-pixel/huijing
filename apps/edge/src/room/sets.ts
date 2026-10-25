import { setTemplateSchema, taskInputSchema, textStyleFor, type ProductAnalysis, type PatchAnalysisRequest, type SellingPoint, type CanvasElement } from "@loomic/shared/edge";
import { all, ApiError, id, now, one, publicError, requireRow, stmt } from "../core";
import { analyzeProduct } from "../product-analysis";
import { artifactView } from "../images";
import { loadSet, parseAnalysis, refundSetTask, refundSetAdmission, reserveSet, setShots, setView, shotView, type SetRecord, type ShotRecord } from "../sets";
import { RoomService } from "./context";
import { canvasWrites, frameElement, setCanvas, textContent, textElements, textHeight } from "./set-canvas";
import { imageElement } from "./elements";
import { indexAt } from "./indexes";

/** Set analysis and provider I/O run outside the room write lock. All canvas mutations hold it. */
export class SetRuns extends RoomService {
  async initialize(setId: string) {
    const set = await loadSet(this.env, setId);
    const template = setTemplateSchema.parse(JSON.parse(set.template));
    const canvas = await setCanvas(this.env, set.project_id);
    const shots = await setShots(this.env, setId);
    const frames = shots.map(row => frameElement(set, row, template.shots[row.ordinal])).filter(frame => !canvas.elements.some(element => element.id === frame.id));
    if (frames.length) {
      const patch = await canvasWrites(this.env, set.project_id, canvas, frames);
      await this.atomic(set.project_id, patch.writes, [patch.event, { type: "set.state", payload: { setId, state: set.state } },
        ...shots.map(row => ({ type: "set.shot" as const, payload: { setId, ...shotView(row) } }))]);
    }
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return { ok: true };
  }
  async tick(projectId: string) {
    const sets = (await stmt(this.env, "SELECT * FROM image_sets WHERE project_id=? AND state IN ('analyzing','generating')", projectId).all<SetRecord>()).results;
    for (const set of sets) {
      try {
        if (set.state === "analyzing") {
          await this.lock(() => this.initialize(set.id));
          if (set.analysis_started_at) throw new ApiError("PROVIDER_ERROR", "商品分析执行中断，请重新生成套图", 502, true);
          await this.lock(async () => {
            await stmt(this.env, "UPDATE image_sets SET analysis_started_at=? WHERE id=?", Date.now(), set.id).run();
            await this.ctx.storage.setAlarm(Date.now() + 200000);
          });
          const supplied = set.supplied_points ? JSON.parse(set.supplied_points) as SellingPoint[] : undefined;
          const analysis: ProductAnalysis = supplied ? {
            productName: set.lang === "zh" ? "商品" : "Product", category: set.lang === "zh" ? "用户提供的商品" : "User supplied product",
            audience: set.lang === "zh" ? "日常使用人群" : "Everyday users", sellingPoints: supplied,
          } : await analyzeProduct(this.env, { assetIds: JSON.parse(set.source_asset_ids), userId: set.user_id, runId: set.run_id, note: set.note, lang: set.lang });
          await this.lock(() => this.enqueue(set, analysis));
        }
        await this.dispatch(projectId);
        await this.lock(() => this.refresh(set.id));
      } catch (error) {
        await this.lock(() => this.fail(set.id, error));
      }
    }
  }
  private async enqueue(set: SetRecord, analysis: ProductAnalysis) {
    const latest = await loadSet(this.env, set.id);
    if (latest.state !== "analyzing") return;
    const template = setTemplateSchema.parse(JSON.parse(set.template));
    const shots = await setShots(this.env, set.id);
    const canvas = await setCanvas(this.env, set.project_id);
    const texts = shots.flatMap(row => {
      const frame = canvas.elements.find(element => element.id === row.frame_element_id) || frameElement(set, row, template.shots[row.ordinal]);
      return textElements(set, row, template.shots[row.ordinal], frame, analysis);
    });
    const writes = [
      stmt(this.env, "UPDATE image_sets SET analysis=?,state='generating',updated_at=? WHERE id=?", JSON.stringify(analysis), now(), set.id),
      ...shots.flatMap(row => [
        ...this.taskWrites(set, row.shot_id, row.ordinal, row.task_id, analysis),
        stmt(this.env, "UPDATE set_shots SET text_element_ids=? WHERE set_id=? AND shot_id=?", JSON.stringify(texts.filter(text => text.frameId === row.frame_element_id).map(text => text.id)), set.id, row.shot_id),
      ]),
    ];
    const patch = await canvasWrites(this.env, set.project_id, canvas, texts, writes);
    await this.atomic(set.project_id, patch.writes, [patch.event,
      { type: "set.analyzed", payload: { setId: set.id, analysis } },
      { type: "set.state", payload: { setId: set.id, state: "generating" } },
      ...shots.map(row => ({ type: "set.shot" as const, taskId: row.task_id, payload: { setId: set.id, ...shotView({ ...row, text_element_ids: JSON.stringify(texts.filter(text => text.frameId === row.frame_element_id).map(text => text.id)) }) } })),
    ]);
  }
  private taskWrites(set: SetRecord, shotId: string, ordinal: number, taskId: string, analysis: ProductAnalysis) {
    const template = setTemplateSchema.parse(JSON.parse(set.template));
    const shot = template.shots[ordinal];
    const point = analysis.sellingPoints[shot.sellingPointIndex ?? 0];
    const substitutions: Record<string, string> = { product: analysis.productName, point: `${point.title}: ${point.detail}`,
      audience: analysis.audience, scene: `a realistic everyday setting appropriate for ${analysis.productName} and ${analysis.audience}` };
    const basePrompt = shot.prompt.replace(/\{(product|point|scene|audience)\}/g, (_, key) => substitutions[key]);
    const diversity: Partial<Record<typeof shot.kind, string>> = {
      scene: "Create a visibly NEW composition, never copy the source framing. Change the background to a believable usage environment AND change camera height or viewing angle; use a wider environmental shot with realistic product scale. Preserve the visible product identity without guessing hidden features.",
      detail: "Create a visibly NEW composition, never copy the source framing. Move the camera much closer: show a 2–3x macro crop of a specific ALREADY VISIBLE rim, seam, fastener or texture, with shallow depth of field and part of the product outside the frame. Do not return a whole-product shot. Change the crop and viewing distance while preserving the visible feature exactly.",
      compare: "Create a visibly NEW composition, never copy the source framing. Place the intact product on a different tabletop with a new background, diagonal placement and a modestly changed camera elevation. Change background AND camera framing; do not reuse the source silhouette placement, product scale or empty-space arrangement. Do not invent unseen features or competing products.",
    };
    const prompt = `${basePrompt} ${diversity[shot.kind] || ""} Visible or user-supplied product facts (never render these words): ${JSON.stringify(analysis.sellingPoints)}. User context (preferences only; never render as text): ${JSON.stringify(set.note)}. Keep all unverified claims out of the image. Output one text-free photo.`;
    const input = taskInputSchema.parse({ setId: set.id, shotId, prompt, settings: { aspectRatio: shot.aspectRatio, count: 1 },
      settingsExplicitKeys: ["aspectRatio"], snapshotIds: [], assetIds: JSON.parse(set.source_asset_ids) });
    return [stmt(this.env, "INSERT INTO tasks(id,project_id,run_id,user_id,tool_invocation_id,operation,slot_index,state,input,created_at,updated_at) VALUES(?,?,?,?,?,'generate',?,'queued',?,?,?)",
      taskId, set.project_id, set.run_id, set.user_id, taskId, ordinal, JSON.stringify(input), now(), now()),
      stmt(this.env, "INSERT INTO outbox(task_id) VALUES(?)", taskId)];
  }
  private async dispatch(projectId: string) {
    const rows = await all(this.env, "SELECT o.task_id,t.provider_retry_at FROM outbox o JOIN tasks t ON t.id=o.task_id WHERE t.project_id=? AND t.state='queued' AND o.sent_at IS NULL ORDER BY CASE WHEN json_extract(t.input,'$.shotId')='main' THEN 0 ELSE 1 END,t.slot_index", projectId);
    for (const row of rows) {
      await this.env.MEDIA_QUEUE.send({ taskId: row.task_id, projectId }, { delaySeconds: Math.max(0, Math.ceil(((row.provider_retry_at || 0) - Date.now()) / 1000)) });
      await stmt(this.env, "UPDATE outbox SET sent_at=? WHERE task_id=? AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND COALESCE(provider_retry_at,0)=?)", Date.now(), row.task_id, row.task_id, row.provider_retry_at || 0).run();
    }
  }
  async refresh(setId: string) {
    const set = await loadSet(this.env, setId);
    if (set.state === "analyzing" || (!set.analysis && set.state === "failed")) return;
    const shots = await setShots(this.env, setId);
    const pending = shots.some(row => !row.state || !["committed", "failed", "cancelled"].includes(row.state));
    const success = shots.filter(row => row.state === "committed").length;
    const state = pending ? "generating" : success === shots.length ? "completed" : success ? "partial" : "failed";
    for (const row of shots) if (row.state === "failed" || row.state === "cancelled") await refundSetTask(this.env, row.task_id);
    if (state === set.state) return;
    await this.atomic(set.project_id, [
      stmt(this.env, "UPDATE image_sets SET state=?,updated_at=? WHERE id=?", state, now(), setId),
      stmt(this.env, "UPDATE runs SET state=? WHERE id=? AND state<>'cancelled'", state === "generating" ? "running" : state === "failed" ? "failed" : "completed", set.run_id),
    ], [{ type: "set.state", payload: { setId, state } }]);
    return state;
  }
  private async fail(setId: string, error: unknown) {
    const set = await loadSet(this.env, setId);
    const e = publicError(error).body().error;
    // Once images are dispatched, transport failure of Queue.send must be recovered by outbox.
    if (set.state !== "analyzing") { await this.ctx.storage.setAlarm(Date.now() + 1000); return; }
    const shots = await setShots(this.env, setId);
    for (const shot of shots) await refundSetTask(this.env, shot.task_id);
    await this.atomic(set.project_id, [stmt(this.env, "UPDATE image_sets SET state='failed',error=?,updated_at=? WHERE id=?", JSON.stringify(e), now(), setId),
      stmt(this.env, "UPDATE runs SET state='failed',error=? WHERE id=?", JSON.stringify(e), set.run_id)],
      [{ type: "set.state", payload: { setId, state: "failed", error: e } },
        ...shots.map(row => ({ type: "set.shot" as const, payload: { setId, ...shotView(row), state: "failed", error: e } }))]);
  }
  async commitTask(projectId: string, taskId: string) {
    const task = requireRow(await one(this.env, "SELECT * FROM tasks WHERE id=? AND project_id=?", taskId, projectId));
    const input = taskInputSchema.parse(JSON.parse(task.input));
    if (!input.setId) throw new ApiError("INVALID_INPUT", "任务不是套图任务", 409);
    const set = await loadSet(this.env, input.setId);
    const shot = (await setShots(this.env, set.id)).find(row => row.shot_id === input.shotId);
    if (!shot || shot.task_id !== taskId || task.cancel_requested || task.state === "cancelled") return { inserted: false };
    const prior = await one(this.env, "SELECT * FROM insertions WHERE task_id=?", taskId);
    if (prior) return { inserted: false, revision: prior.canvas_revision };
    if (task.state !== "ingesting") return { inserted: false };
    const artifact = requireRow(await one(this.env, "SELECT * FROM artifacts WHERE task_id=?", taskId));
    const view = await artifactView(this.env, artifact);
    const canvas = await setCanvas(this.env, projectId);
    const template = setTemplateSchema.parse(JSON.parse(set.template));
    const frame = canvas.elements.find(element => element.id === shot.frame_element_id) || frameElement(set, shot, template.shots[shot.ordinal]);
    const imageId = `image_${set.id}_${shot.shot_id}`;
    const previous = canvas.elements.find(element => element.id === imageId);
    const scale = Math.min(frame.width / view.asset.width, frame.height / view.asset.height);
    const image: CanvasElement = { ...imageElement(taskId, view.asset, { setId: set.id, shotId: shot.shot_id, taskId, artifactId: artifact.id, snapshotId: view.snapshotId }),
      id: imageId, frameId: frame.id, width: view.asset.width * scale, height: view.asset.height * scale,
      x: frame.x + (frame.width - view.asset.width * scale) / 2, y: frame.y + (frame.height - view.asset.height * scale) / 2,
      version: (previous?.version || 0) + 1 };
    // Reserve the image's index before the first text layer. Stable ID preserves layer edits on retry.
    const position = canvas.elements.findIndex(element => element.frameId === frame.id && element.type === "text");
    image.index = previous?.index || indexAt([...canvas.elements.slice(0, position < 0 ? canvas.elements.length : position), image,
      ...canvas.elements.slice(position < 0 ? canvas.elements.length : position)], position < 0 ? canvas.elements.length : position);
    canvas.files[view.asset.id] = { assetId: view.asset.id };
    const patch = await canvasWrites(this.env, projectId, canvas, [image], [
      stmt(this.env, "INSERT INTO insertions VALUES(?,?,?,?,?)", taskId, projectId, artifact.id, JSON.stringify([imageId]), canvas.revision + 1),
      stmt(this.env, "UPDATE tasks SET state='committed',output=?,updated_at=? WHERE id=?", JSON.stringify(view), now(), taskId),
      stmt(this.env, "UPDATE set_shots SET image_element_id=? WHERE set_id=? AND shot_id=?", imageId, set.id, shot.shot_id),
      stmt(this.env, "UPDATE projects SET cover_url=COALESCE(cover_url,?) WHERE id=?", view.asset.url, projectId),
    ]);
    await this.atomic(projectId, patch.writes, [patch.event,
      { type: "task.state", runId: task.run_id, taskId, payload: { state: "committed", slotIndex: task.slot_index } },
      { type: "artifact.committed", runId: task.run_id, taskId, payload: { artifact: view, elementIds: [imageId], revision: canvas.revision } },
      { type: "set.shot", taskId, payload: { setId: set.id, ...shotView({ ...shot, state: "committed", image_element_id: imageId }) } },
    ]);
    await this.refresh(set.id);
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return { inserted: true, revision: canvas.revision };
  }
  async patchAnalysis(setId: string, patchAnalysis: PatchAnalysisRequest) {
    const set = await loadSet(this.env, setId);
    if (!set.analysis) throw new ApiError("INVALID_INPUT", "请等待商品分析完成", 409);
    const previous = parseAnalysis(set);
    const analysis = { ...previous, ...patchAnalysis };
    const template = setTemplateSchema.parse(JSON.parse(set.template));
    const rows = await setShots(this.env, setId);
    const canvas = await setCanvas(this.env, set.project_id);
    const changes = rows.flatMap(row => template.shots[row.ordinal].textSlots.flatMap((slot, index) => {
      const textId = `text_${set.id}_${row.shot_id}_${index}`;
      const element = canvas.elements.find(item => item.id === textId);
      if (!element || element.isDeleted) return [];
      // Compare with the previous generated content, not originalText (the editor changes both).
      if (element.text !== textContent(previous, slot.source, slot.maxChars)) return [];
      const text = textContent(analysis, slot.source, slot.maxChars);
      if (element.text === text) return [];
      const style = textStyleFor(slot.role, canvas.elements.find(item => item.id === row.frame_element_id)?.width || 360);
      return [{ ...element, text, originalText: text,
        height: textHeight(text, element.width, Number(element.fontSize || style.fontSize), Number(element.lineHeight || style.lineHeight)), version: element.version + 1 }];
    }));
    const patch = await canvasWrites(this.env, set.project_id, canvas, changes,
      [stmt(this.env, "UPDATE image_sets SET analysis=?,updated_at=? WHERE id=?", JSON.stringify(analysis), now(), setId)]);
    await this.atomic(set.project_id, patch.writes, [patch.event, { type: "set.analyzed", payload: { setId, analysis } }]);
    return setView(this.env, setId);
  }
  async regenerate(setId: string, shotId: string, clientOperationId?: string) {
    const set = await loadSet(this.env, setId);
    const row = (await setShots(this.env, setId)).find(shot => shot.shot_id === shotId);
    if (!row) throw new ApiError("NOT_FOUND", "单张不存在", 404);
    if (!set.analysis) throw new ApiError("INVALID_INPUT", "请先整套重出以重新分析商品", 409);
    return this.regenerateSelected(set, [row], `shot:${shotId}`, clientOperationId, true);
  }
  async regenerateAll(setId: string, scope: "failed" | "all", clientOperationId?: string) {
    const set = await loadSet(this.env, setId);
    const rows = await setShots(this.env, setId);
    const selected = scope === "all" ? rows : rows.filter(row => ["failed", "cancelled"].includes(row.state || "") || (!row.state && set.state === "failed"));
    return this.regenerateSelected(set, selected, scope, clientOperationId, false);
  }
  private async regenerateSelected(set: SetRecord, rows: ShotRecord[], selection: string, clientOperationId: string | undefined, single: boolean) {
    const setId = set.id;
    const key = clientOperationId || id("regenerate");
    const operationScope = `set-regenerate:${setId}`;
    const replay = await one(this.env, "SELECT hash,response FROM idempotency WHERE user_id=? AND scope=? AND key=?", set.user_id, operationScope, key);
    if (replay) {
      if (replay.hash !== selection) throw new ApiError("IDEMPOTENCY_MISMATCH", "clientOperationId 已用于其他重出范围", 409);
      return JSON.parse(replay.response);
    }
    if ((!single && ["analyzing", "generating"].includes(set.state)) || rows.some(row => row.state ? !["committed", "failed", "cancelled"].includes(row.state) : set.state !== "failed"))
      throw new ApiError("RUN_ACTIVE", "图片仍在生成，请等待结束", 409);
    if (single && set.single_regenerations >= 3) throw new ApiError("QUOTA_EXCEEDED_IP", "每套最多单张重出 3 次", 429);
    const run = requireRow(await one(this.env, "SELECT * FROM runs WHERE id=?", set.run_id));
    if (await one(this.env, "SELECT id FROM runs WHERE thread_id=? AND id<>? AND state IN ('queued','planning','running','waiting_input')", set.thread_id, set.run_id))
      throw new ApiError("RUN_ACTIVE", "当前对话仍有进行中的任务，请等待结束", 409);
    const tasks = rows.map(row => ({ ...row, task_id: id("task") }));
    const admissionId = single || !tasks.length ? undefined : id("set-admission");
    const response = single ? { setId, shotId: tasks[0].shot_id, taskId: tasks[0].task_id } : { setId, shots: tasks.map(row => ({ shotId: row.shot_id, taskId: row.task_id })) };
    if (tasks.length) await reserveSet(this.env, set.user_id, run.quota_ip, tasks.map(row => row.task_id), admissionId);
    const nextState = set.analysis ? "generating" : "analyzing";
    try {
      await this.atomic(set.project_id, [
        ...tasks.flatMap(row => [
          ...(set.analysis ? this.taskWrites(set, row.shot_id, row.ordinal, row.task_id, parseAnalysis(set)) : []),
          stmt(this.env, "UPDATE set_shots SET task_id=? WHERE set_id=? AND shot_id=?", row.task_id, setId, row.shot_id),
        ]),
        ...(tasks.length ? [stmt(this.env, "UPDATE image_sets SET state=?,error=NULL,analysis_started_at=NULL,single_regenerations=single_regenerations+?,updated_at=? WHERE id=?", nextState, single ? 1 : 0, now(), setId),
          stmt(this.env, "UPDATE runs SET state='running',started_at=?,error=NULL WHERE id=?", Date.now(), set.run_id)] : []),
        stmt(this.env, "INSERT INTO idempotency VALUES(?,?,?,?,?)", set.user_id, operationScope, key, selection, JSON.stringify(response)),
      ], tasks.length ? [{ type: "set.state", payload: { setId, state: nextState } },
        ...tasks.map(row => ({ type: "set.shot" as const, taskId: row.task_id, payload: { setId, ...shotView({ ...row, state: "queued", error: null }) } }))] : []);
    } catch (error) {
      await Promise.all(tasks.map(row => refundSetTask(this.env, row.task_id)));
      if (admissionId) await refundSetAdmission(this.env, admissionId);
      throw error;
    }
    if (tasks.length) await this.ctx.storage.setAlarm(Date.now() + 20);
    return response;
  }
  async cancel(setId: string) {
    const set = await loadSet(this.env, setId);
    if (["completed", "partial", "failed"].includes(set.state)) return;
    const shots = await setShots(this.env, setId);
    const error = { code: "INVALID_INPUT", message: "套图已停止，未完成图片额度已退回", retryable: false };
    for (const shot of shots) if (shot.state !== "committed") await refundSetTask(this.env, shot.task_id);
    const state = shots.some(shot => shot.state === "committed") ? "partial" : "failed";
    await this.atomic(set.project_id, [stmt(this.env, "UPDATE image_sets SET state=?,error=?,updated_at=? WHERE id=?", state, JSON.stringify(error), now(), setId)],
      [{ type: "set.state", payload: { setId, state, error } }, ...shots.filter(shot => !shot.state).map(shot => ({ type: "set.shot" as const, payload: { setId, ...shotView(shot), state: "failed", error } }))]);
  }
}
