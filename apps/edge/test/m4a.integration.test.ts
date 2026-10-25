import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capabilitiesResponseSchema, edgeEventSchema, messagesResponseSchema, projectResponseSchema, type EdgeEvent } from "@loomic/shared/edge";
import { generateKeyBetween } from "fractional-indexing";
import { harness, submission, until } from "./harness";
import { pixels, png, source } from "./media-helpers";

describe("M4a 联调恢复契约", () => {
  let h: Awaited<ReturnType<typeof harness>>, cookie: string;
  beforeAll(async () => { h = await harness({ GUEST_DAILY_IMAGES: "100" }); cookie = (await h.guest()).cookie; });
  afterAll(async () => h.close());
  const get = async (path: string) => (await h.request(path, "GET", undefined, cookie)).json<any>();
  const finished = (runId: string) => until(() => h.db.prepare("SELECT * FROM runs WHERE id=?").bind(runId).first<any>(), r => ["completed", "failed"].includes(r.state), 30000);

  it("白名单开放三档，非法图片模型在创建 Run 前拒绝", async () => {
    const caps = capabilitiesResponseSchema.parse(await get("/api/capabilities"));
    expect(caps.models).toEqual(["gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-3.1-flash-lite-image"]);
    expect(caps.mediaLimits).toMatchObject({ maxPixels: 4194304, maxSide: 4096 });
    const r = await h.request("/api/projects/start", "POST", { ...submission("生成一张图", 1), settings: { modelId: "unavailable" } }, cookie);
    expect(r.status).toBe(422);
  });

  it("刷新后恢复 references、两套设置、步骤、耗时与 queued slot；fixture 按蓝色、16:9、2K 出图", async () => {
    const s = await source(h, cookie);
    const project = projectResponseSchema.parse(await get(`/api/projects/${s.projectId}`));
    const threadId = project.threads[0].id;
    const settings = { count: 1, aspectRatio: "16:9", quality: "high", modelId: "gemini-3.1-flash-lite-image" };
    const body = { clientMessageId: crypto.randomUUID(), parts: [{ type: "text", text: "生成一张蓝色陶瓷杯" }],
      references: [{ snapshotId: s.source.snapshotId, purpose: "style", order: 2 }], settings,
      settingsExplicitKeys: ["aspectRatio", "quality", "modelId"], viewportCenter: { x: 10, y: 20 } };
    const { runId } = await (await h.request(`/api/threads/${threadId}/messages`, "POST", body, cookie)).json<any>();
    const run = await finished(runId); expect(run.state, run.error).toBe("completed");
    const response = messagesResponseSchema.parse(await get(`/api/threads/${threadId}/messages`));
    const user = response.items.find(m => m.role === "user")!;
    expect(user.references).toEqual([{ ...body.references[0], thumbnailUrl: `/api/assets/${s.asset.id}` }]);
    expect((await h.request(user.references![0].thumbnailUrl!, "GET", undefined, cookie)).status).toBe(200);
    expect(user.settings).toEqual(settings); expect(user.effectiveSettings).toEqual(settings);
    expect(response.runs[0].steps?.some(step => step.tool === "generate_images" && step.status === "completed")).toBe(true);
    expect(response.runs[0].timings?.map(t => t.phase)).toEqual(expect.arrayContaining(["read_canvas", "tool", "image", "ingest"]));
    const task = response.tasks[0]; expect(task.slot).toEqual({ x: 10, y: 212, w: 360, h: 202.5 });
    expect(task.artifact!.asset).toMatchObject({ width: 2048, height: 1152, mime: "image/png" });
    const decoded = await pixels(await (await h.request(task.artifact!.asset.url, "GET", undefined, cookie)).arrayBuffer());
    const center = ((decoded.height / 2) * decoded.width + decoded.width / 2) * 4;
    expect([...decoded.data.subarray(center, center + 4)]).toEqual([38, 112, 230, 255]);
    const events: EdgeEvent[] = (await get(`/api/projects/${s.projectId}/events`)).items.map((e: unknown) => edgeEventSchema.parse(e));
    expect(events.filter(e => e.type === "thread.created")).toHaveLength(1);
    const queued = events.find(e => e.type === "task.state" && e.payload.state === "queued");
    expect(queued?.payload).toMatchObject({ slot: task.slot });
    const created = events.filter(e => e.type === "message.created");
    expect(new Set(created.map(e => e.payload.messageId)).size).toBe(response.items.length);
    expect(created).toHaveLength(response.items.length);
    const finalProject = projectResponseSchema.parse(await get(`/api/projects/${s.projectId}`));
    const generated = finalProject.canvas.elements.find(e => e.id === `element_${task.id}`)!;
    expect(typeof generated.index).toBe("string");
    expect(() => generateKeyBetween(String(generated.index), null)).not.toThrow();
  });

  it("media 挂指定对话；无 threadId 建系统线程；幂等返回完整身份，跨项目线程拒绝", async () => {
    const s = await source(h, cookie), foreign = await source(h, cookie);
    const project = await get(`/api/projects/${s.projectId}`), other = await get(`/api/projects/${foreign.projectId}`);
    const body = { clientOpId: crypto.randomUUID(), projectId: s.projectId, threadId: project.threads[0].id, source: s.source, op: "edit", params: { prompt: "蓝色" } };
    const r = await h.request("/api/media/ops", "POST", body, cookie);
    expect(r.status, await r.clone().text()).toBe(201);
    const result = await r.json<any>(); expect(result.threadId).toBe(body.threadId); expect(result.runId).toMatch(/^run_/);
    expect(await (await h.request("/api/media/ops", "POST", body, cookie)).json()).toEqual(result);
    await finished(result.runId);
    expect((await get(`/api/projects/${s.projectId}`)).threads).toHaveLength(1);
    const wrong = await h.request("/api/media/ops", "POST", { ...body, clientOpId: crypto.randomUUID(), threadId: other.threads[0].id }, cookie);
    expect(wrong.status).toBe(403);
    const fallback = await (await h.request("/api/media/ops", "POST", { ...body, clientOpId: crypto.randomUUID(), threadId: undefined }, cookie)).json<any>();
    await finished(fallback.runId);
    expect((await get(`/api/projects/${s.projectId}`)).threads.find((t: any) => t.id === fallback.threadId)).toMatchObject({ isSystem: true });
  });

  it("1024² 扩到 2048² 保留源像素，超过 4MP 明确拒绝", async () => {
    const original = png(1024, 1024);
    const s = await source(h, cookie, original);
    const body = { clientOpId: crypto.randomUUID(), projectId: s.projectId, source: s.source, op: "expand",
      params: { margin: { left: 512, right: 512, top: 512, bottom: 512 } } };
    const r = await h.request("/api/media/ops", "POST", body, cookie);
    expect(r.status, await r.clone().text()).toBe(201);
    const { taskId, runId } = await r.json<any>(); expect((await finished(runId)).state).toBe("completed");
    const task = await get(`/api/tasks/${taskId}`);
    expect(task.artifact.asset).toMatchObject({ width: 2048, height: 2048 });
    const decoded = await pixels(await (await h.request(task.artifact.asset.url, "GET", undefined, cookie)).arrayBuffer());
    const input = await pixels(new Uint8Array(original).buffer);
    for (let y = 0; y < 1024; y++) {
      const offset = ((y + 512) * 2048 + 512) * 4;
      expect(Buffer.compare(Buffer.from(decoded.data.subarray(offset, offset + 4096)), Buffer.from(input.data.subarray(y * 4096, (y + 1) * 4096)))).toBe(0);
    }
    const large = await h.request("/api/media/ops", "POST", { ...body, clientOpId: crypto.randomUUID(), params: { margin: { ...body.params.margin, right: 513 } } }, cookie);
    expect(large.status).toBe(422); expect((await large.json<any>()).error).toMatchObject({ code: "MEDIA_LIMIT_EXCEEDED", message: expect.stringContaining("不会被自动缩小") });
  });

  it("文本失败的重试恢复原 Run 和图片，重复重试不新建任务", async () => {
    const result = await (await h.request("/api/projects/start", "POST", submission("生成一张红色杯子", 1), cookie)).json<any>();
    await finished(result.runId);
    await h.db.prepare("UPDATE runs SET state='failed',error=? WHERE id=?").bind(JSON.stringify({ code: "PROVIDER_ERROR", message: "文本模型异常，请重试", retryable: true }), result.runId).run();
    const body = { clientOperationId: crypto.randomUUID() };
    const r = await h.request(`/api/runs/${result.runId}/retry`, "POST", body, cookie);
    expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ runId: result.runId });
    expect((await finished(result.runId)).state).toBe("completed");
    const again = await h.request(`/api/runs/${result.runId}/retry`, "POST", body, cookie); expect(again.status).toBe(200);
    expect((await h.db.prepare("SELECT count(*) n FROM tasks WHERE run_id=?").bind(result.runId).first<any>()).n).toBe(1);
  });
});

it("模型白名单可独立于 fallback 链配置", async () => {
  const h = await harness({ IMAGE_MODEL_ALLOWLIST: "gemini-3-pro-image" });
  try {
    const { cookie } = await h.guest();
    expect((await (await h.request("/api/capabilities", "GET", undefined, cookie)).json<any>()).models).toEqual(["gemini-3-pro-image"]);
    const r = await h.request("/api/projects/start", "POST", { ...submission("图", 1), settings: { modelId: "gemini-3.1-flash-image" } }, cookie);
    expect(r.status).toBe(422);
  } finally { await h.close(); }
});
