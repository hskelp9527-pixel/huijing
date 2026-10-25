import {
  MAX_PROJECT_ELEMENTS,
  answerRequestSchema,
  agentCanvasUndoRequestSchema,
  clientResultRequestSchema,
  createProjectRequestSchema,
  createThreadRequestSchema,
  mediaOpRequestSchema,
  messageRequestSchema,
  patchProjectRequestSchema,
  providerContentSchema,
  retryTaskRequestSchema,
  snapshotRequestSchema,
  startRequestSchema,
  createSetRequestSchema, patchAnalysisRequestSchema, regenerateSetRequestSchema, regenerateShotRequestSchema, publicTemplates,
} from "@loomic/shared/edge";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { cleanupGuests } from "./cleanup";
import { guestIdentity } from "./auth";
import {
  all,
  ApiError,
  assetView,
  hash,
  id,
  now,
  one,
  owned,
  projectView,
  publicError,
  quota,
  requireRow,
  room,
  roomCall,
  stmt,
  threadOwned,
  threadView,
} from "./core";
import { saveAsset } from "./images";
import { imageModels } from "./models";
import { MAX_MEDIA_PIXELS, MAX_MEDIA_SIDE } from "./media-pixels";
import { addMessage, start } from "./submissions";
import { saveSvg } from "./svg";
import { consumeTask, recover } from "./tasks";
import type { Bindings, Env } from "./types";
import { createSet, loadSet, setView } from "./sets";
export { ProviderGate } from "./gate";
export { ProjectRoom } from "./room";
const app = new Hono<Bindings>();
app.use(
  "/api/*",
  bodyLimit({
    maxSize: 21 * 1024 * 1024,
    onError: (c) => c.json(new ApiError("INVALID_INPUT", "请求超过大小上限", 413).body(), 413),
  }),
);
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin)
    throw new ApiError("FORBIDDEN", "仅允许同源请求", 403);
  const identity = await guestIdentity(c);
  c.set("user", identity.user);
  c.set("quotaIp", c.req.header("CF-Connecting-IP") ? await hash(c.req.header("CF-Connecting-IP")!) : "local");
  c.set("initiatorClientId", `client:${await hash(`agent-client:${identity.token}`)}`);
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});
app.get("/api/me", async (c) =>
  c.json({ user: c.get("user"), quota: await quota(c.env, c.get("user").id, c.get("quotaIp")) }),
);
app.get("/api/health", async (c) => {
  await stmt(c.env, "SELECT 1").first();
  return c.json({ ok: true });
});
app.get("/api/templates", c => c.json(publicTemplates()));
app.post("/api/sets", async c => c.json(await createSet(c.env, c.get("user").id, c.get("quotaIp"), createSetRequestSchema.parse(await c.req.json())), 201));
app.get("/api/sets/:id", async c => c.json(await setView(c.env, c.req.param("id"), c.get("user").id)));
app.patch("/api/sets/:id/:analysisRoute{analysis|selling-points}", async c => {
  const set = await loadSet(c.env, c.req.param("id"), c.get("user").id);
  const body = patchAnalysisRequestSchema.parse(await c.req.json());
  return c.json(await roomCall(c.env, set.project_id, "set-analysis", { setId: set.id, patch: body }));
});
app.post("/api/sets/:id/regenerate", async c => {
  const set = await loadSet(c.env, c.req.param("id"), c.get("user").id);
  const body = regenerateSetRequestSchema.parse(await c.req.json());
  return c.json(await roomCall(c.env, set.project_id, "set-regenerate-all", { setId: set.id, ...body }), 202);
});
app.post("/api/sets/:id/shots/:shotId/regenerate", async c => {
  const set = await loadSet(c.env, c.req.param("id"), c.get("user").id);
  const text = await c.req.text();
  const body = regenerateShotRequestSchema.parse(text ? JSON.parse(text) : {});
  return c.json(await roomCall(c.env, set.project_id, "set-regenerate", { setId: set.id, shotId: c.req.param("shotId"), ...body }), 202);
});
app.get("/api/capabilities", (c) =>
  c.json({
    mode: c.env.PROVIDER_MODE,
    maxProjectElements: MAX_PROJECT_ELEMENTS,
    operations: [
      "generate",
      "edit",
      "replace_text",
      "multiview",
      "move_object",
      "expand",
      "erase_ai",
    ],
    clientOperations: ["remove_bg", "erase", "ocr", "vectorize", "upscale"],
    mediaLimits: { maxPixels: MAX_MEDIA_PIXELS, maxSide: MAX_MEDIA_SIDE, maxBytes: 8 * 1024 * 1024 },
    models: imageModels(c.env),
    maxCount: 4,
  }),
);
app.get("/api/projects", async (c) =>
  c.json({
    items: (
      await all(
        c.env,
        "SELECT p.*,(SELECT id FROM image_sets WHERE project_id=p.id LIMIT 1) set_id FROM projects p WHERE user_id=? AND deleting=0 ORDER BY updated_at DESC LIMIT 100",
        c.get("user").id,
      )
    ).map(projectView),
  }),
);
app.post("/api/projects/start", async (c) => {
  const { submissionId, ...submission } = startRequestSchema.parse(await c.req.json());
  const result = await start(c.env, c.get("user").id, submissionId, submission, c.get("initiatorClientId"), c.get("quotaIp"));
  return c.json(result.response, result.created ? 201 : 200);
});
app.post("/api/projects", async (c) => {
  const body = createProjectRequestSchema.parse(await c.req.json());
  const projectId = id("project"),
    threadId = id("thread");
  await c.env.DB.batch([
    stmt(
      c.env,
      "INSERT INTO projects(id,user_id,title,created_at,updated_at,last_thread_id) VALUES(?,?,?,?,?,?)",
      projectId,
      c.get("user").id,
      body.title || "新项目",
      now(),
      now(),
      threadId,
    ),
    stmt(c.env, "INSERT INTO threads(id,project_id,title,created_at) VALUES(?,?,?,?)", threadId, projectId, "新对话", now()),
  ]);
  await roomCall(c.env, projectId, "wake");
  return c.json(
    {
      project: projectView((await one(c.env, "SELECT * FROM projects WHERE id=?", projectId))!),
    },
    201,
  );
});
app.get("/api/projects/:id", async (c) => {
  const p = await owned(c.env, "projects", c.req.param("id"), c.get("user").id);
  p.set_id = (await one(c.env, "SELECT id FROM image_sets WHERE project_id=? LIMIT 1", p.id))?.id;
  const snapshot = await roomCall(c.env, p.id, "snapshot");
  return c.json({
    project: projectView(p),
    ...snapshot,
    threads: (
      await all(c.env, "SELECT * FROM threads WHERE project_id=? ORDER BY created_at", p.id)
    ).map(threadView),
  });
});
app.patch("/api/projects/:id", async (c) => {
  const p = await owned(c.env, "projects", c.req.param("id"), c.get("user").id);
  const body = patchProjectRequestSchema.parse(await c.req.json());
  await stmt(
    c.env,
    "UPDATE projects SET title=?,updated_at=? WHERE id=?",
    body.title,
    now(),
    p.id,
  ).run();
  return c.json({
    project: projectView({ ...p, title: body.title, updated_at: now() }),
  });
});
app.post("/api/projects/:id/canvas/ops", async (c) => {
  const p = await owned(c.env, "projects", c.req.param("id"), c.get("user").id);
  return c.json(await roomCall(c.env, p.id, "canvas", { body: await c.req.json() }));
});
app.post("/api/projects/:id/agent-operations/:operationId/undo", async (c) => {
  const project = await owned(c.env,"projects",c.req.param("id"),c.get("user").id);
  const operation = requireRow(await one(c.env,"SELECT * FROM operations WHERE id=? AND project_id=? AND source='agent'",c.req.param("operationId"),project.id));
  const changes = z.object({runId:z.string()}).parse(JSON.parse(operation.changes));
  const body = agentCanvasUndoRequestSchema.parse(await c.req.json());
  const run = requireRow(await one(c.env,"SELECT initiator_client_id FROM runs WHERE id=?",changes.runId));
  if(run.initiator_client_id !== c.get("initiatorClientId"))
    throw new ApiError("FORBIDDEN","只能由发起该排版的访客客户端撤销",403);
  return c.json(await roomCall(c.env,project.id,"agent-undo",{runId:changes.runId,operationId:operation.id,...body}));
});
app.get("/api/projects/:id/ws", async (c) => {
  const p = await owned(c.env, "projects", c.req.param("id"), c.get("user").id);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    throw new ApiError("INVALID_INPUT", "需要 WebSocket Upgrade", 426);
  const url = new URL("https://room/ws");
  url.searchParams.set("projectId", p.id);
  url.searchParams.set("cursor", c.req.query("cursor") || "0");
  return room(c.env, p.id).fetch(new Request(url, c.req.raw));
});
app.get("/api/projects/:id/events", async (c) => {
  const p = await owned(c.env, "projects", c.req.param("id"), c.get("user").id);
  const cursor = Number(c.req.query("cursor") || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0)
    throw new ApiError("INVALID_INPUT", "cursor 无效", 422);
  return c.json({
    items: (
      await all(
        c.env,
        "SELECT data FROM events WHERE project_id=? AND seq>? ORDER BY seq LIMIT 1000",
        p.id,
        cursor,
      )
    ).map((r) => JSON.parse(r.data)),
  });
});
app.post("/api/threads", async (c) => {
  const body = createThreadRequestSchema.parse(await c.req.json());
  await owned(c.env, "projects", body.projectId, c.get("user").id);
  const threadId = id("thread");
  await c.env.DB.batch([
    stmt(c.env, "INSERT INTO threads(id,project_id,title,created_at) VALUES(?,?,?,?)", threadId, body.projectId, "新对话", now()),
    stmt(c.env, "UPDATE projects SET last_thread_id=? WHERE id=?", threadId, body.projectId),
  ]);
  await roomCall(c.env, body.projectId, "wake");
  return c.json(
    {
      thread: threadView((await one(c.env, "SELECT * FROM threads WHERE id=?", threadId))!),
    },
    201,
  );
});
app.post("/api/threads/:id/messages", async (c) => {
  const thread = await threadOwned(c.env, c.req.param("id"), c.get("user").id);
  const { clientMessageId, ...submission } = messageRequestSchema.parse(await c.req.json());
  const result = await addMessage(c.env, c.get("user").id, thread, clientMessageId, submission, c.get("initiatorClientId"), c.get("quotaIp"));
  return c.json(result.response, result.created ? 201 : 200);
});
app.get("/api/threads/:id/messages", async (c) => {
  const thread = await threadOwned(c.env, c.req.param("id"), c.get("user").id);
  const before = c.req.query("before");
  const boundary = before
    ? await one(c.env, "SELECT ordinal FROM messages WHERE id=? AND thread_id=?", before, thread.id)
    : null;
  if (before && !boundary) throw new ApiError("INVALID_INPUT", "分页游标无效", 422);
  const rows = await all(
    c.env,
    "SELECT m.*,r.frozen_submission,r.effective_settings FROM messages m LEFT JOIN runs r ON r.id=m.run_id WHERE m.thread_id=? AND m.ordinal<? ORDER BY m.ordinal DESC LIMIT 100",
    thread.id,
    boundary?.ordinal || Number.MAX_SAFE_INTEGER,
  );
  const runs = await all(
    c.env,
    "SELECT * FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 100",
    thread.id,
  );
  const tasks = await all(
    c.env,
    "SELECT t.* FROM tasks t JOIN runs r ON r.id=t.run_id WHERE r.thread_id=? ORDER BY t.created_at",
    thread.id,
  );
  const diagnostics = (await all(c.env, `SELECT e.data FROM events e JOIN runs r ON json_extract(e.data,'$.runId')=r.id AND e.project_id=r.project_id
    WHERE r.thread_id=? AND json_extract(e.data,'$.type') IN ('run.step','run.timing') ORDER BY e.seq`, thread.id)).map(r => JSON.parse(r.data));
  const snapshots = await all(c.env, "SELECT s.id,s.asset_id FROM appearance_snapshots s WHERE s.project_id=?", thread.project_id);
  const canvas = JSON.parse((await one(c.env, "SELECT canvas FROM projects WHERE id=?", thread.project_id))!.canvas);
  return c.json({
    items: rows.reverse().map((r) => {
      const frozen = r.frozen_submission ? JSON.parse(r.frozen_submission) : null;
      return ({
      id: r.id,
      runId: r.run_id,
      role: r.role,
      parts: z
        .array(providerContentSchema.shape.parts.element)
        .parse(JSON.parse(r.parts))
        .filter((p) => !p.thought && p.text),
      createdAt: r.created_at,
      ...(r.role === "user" && frozen ? {
        references: frozen.references.map((ref: { snapshotId: string }) => {
          const snapshot = snapshots.find(s => s.id === ref.snapshotId);
          return { ...ref, thumbnailUrl: snapshot ? `/api/assets/${snapshot.asset_id}` : null };
        }),
        settings: frozen.settings,
        settingsExplicitKeys: frozen.settingsExplicitKeys,
        effectiveSettings: { ...frozen.settings, ...JSON.parse(r.effective_settings || "{}") },
      } : {}),
    }); }),
    runs: runs.map(r => ({ id: r.id, state: r.state, executionMode: r.direct_mode ? "direct" : "tools", error: r.error ? JSON.parse(r.error) : null,
      steps: diagnostics.filter(e => e.runId === r.id && e.type === "run.step").map(e => ({ ...e.payload, seq: e.seq, at: e.at })),
      timings: diagnostics.filter(e => e.runId === r.id && e.type === "run.timing").map(e => ({ ...e.payload, seq: e.seq, at: e.at, ...(e.taskId ? { taskId: e.taskId } : {}) })),
    })),
    tasks: await Promise.all(
      tasks.map(async (t) => ({
        id: t.id,
        runId: t.run_id,
        state: t.state,
        slotIndex: t.slot_index,
        ...(() => {
          const element = canvas.elements.find((e: { id: string }) => e.id === `element_${t.id}`);
          const slot = t.state === "committed" && element ? { x: element.x, y: element.y, w: element.width, h: element.height } : JSON.parse(t.input).slot;
          return slot ? { slot } : {};
        })(),
        artifact: t.output ? JSON.parse(t.output) : null,
        error: t.error ? JSON.parse(t.error) : null,
      })),
    ),
    inputRequests: (
      await all(
        c.env,
        "SELECT i.payload FROM input_requests i JOIN runs r ON r.id=i.run_id WHERE r.thread_id=? AND i.state='pending'",
        thread.id,
      )
    ).map((r) => JSON.parse(r.payload)),
    before: rows.length === 100 ? rows[0].id : null,
  });
});
app.post("/api/runs/:id/cancel", async (c) => {
  const run = await owned(c.env, "runs", c.req.param("id"), c.get("user").id);
  return c.json(await roomCall(c.env, run.project_id, "cancel", { runId: run.id }));
});
app.post("/api/runs/:id/retry", async (c) => {
  const run = await owned(c.env, "runs", c.req.param("id"), c.get("user").id);
  const body = retryTaskRequestSchema.parse(await c.req.json());
  return c.json(await roomCall(c.env, run.project_id, "retry-run", { runId: run.id, ...body }));
});
app.post("/api/input-requests/:id/answers", async (c) => {
  const input = requireRow(
    await one(c.env, "SELECT * FROM input_requests WHERE id=?", c.req.param("id")),
  );
  await owned(c.env, "projects", input.project_id, c.get("user").id);
  return c.json(
    await roomCall(c.env, input.project_id, "answer", {
      requestId: input.id,
      body: answerRequestSchema.parse(await c.req.json()),
    }),
  );
});
app.post("/api/uploads", async (c) => {
  const form = await c.req.raw.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new ApiError("INVALID_INPUT", "请选择图片文件", 422);
  if (!["image/png", "image/jpeg", "image/webp", "image/svg+xml"].includes(file.type))
    throw new ApiError("INVALID_INPUT", "仅支持 PNG、JPEG、WebP 和静态 SVG", 422);
  const projectId = form.get("projectId");
  if (projectId && typeof projectId !== "string")
    throw new ApiError("INVALID_INPUT", "projectId 无效", 422);
  if (projectId) await owned(c.env, "projects", projectId as string, c.get("user").id);
  const asset =
    file.type === "image/svg+xml"
      ? await saveSvg(
          c.env,
          new Uint8Array(await file.arrayBuffer()),
          c.get("user").id,
          projectId as string | null,
        )
      : await saveAsset(
          c.env,
          new Uint8Array(await file.arrayBuffer()),
          c.get("user").id,
          projectId as string | null,
          file.type,
        );
  return c.json({ asset: assetView(asset) }, 201);
});
app.post("/api/snapshots", async (c) => {
  const isMultipart = c.req.header("content-type")?.includes("multipart/form-data");
  let file: File | undefined;
  let raw: unknown;
  if (isMultipart) {
    const form = await c.req.raw.formData();
    raw = JSON.parse(String(form.get("metadata") || "{}"));
    const value = form.get("file");
    if (value instanceof File) file = value;
  } else raw = await c.req.json();
  const data = snapshotRequestSchema.parse(raw);
  const source = await owned(c.env, "assets", data.sourceAssetId, c.get("user").id);
  const projectId = data.projectId || source.project_id || null;
  if (projectId) await owned(c.env, "projects", projectId, c.get("user").id);
  if (source.project_id && source.project_id !== projectId)
    throw new ApiError("FORBIDDEN", "源图属于其他项目", 403);
  if (Object.keys(data.appearance).length && !file)
    throw new ApiError("INVALID_INPUT", "外观修改需要上传渲染后的 PNG", 422);
  if (file && file.type !== "image/png") throw new ApiError("INVALID_INPUT", "快照必须为 PNG", 422);
  const digest = await hash(
    JSON.stringify(data) + (file ? await hash(new Uint8Array(await file.arrayBuffer())) : ""),
  );
  const previous = await one(
    c.env,
    "SELECT * FROM appearance_snapshots WHERE user_id=? AND render_key=?",
    c.get("user").id,
    data.renderKey,
  );
  if (previous) {
    if (previous.request_hash !== digest)
      throw new ApiError("IDEMPOTENCY_MISMATCH", "renderKey 对应的内容不同", 409);
    return c.json({
      snapshot: {
        id: previous.id,
        assetId: previous.asset_id,
        renderKey: previous.render_key,
        width: previous.width,
        height: previous.height,
      },
    });
  }
  const asset = file
    ? await saveAsset(
        c.env,
        new Uint8Array(await file.arrayBuffer()),
        c.get("user").id,
        projectId,
        "image/png",
      )
    : source;
  const snapshotId = id("snapshot");
  await stmt(
    c.env,
    "INSERT INTO appearance_snapshots VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,render_key) DO NOTHING",
    snapshotId,
    c.get("user").id,
    projectId,
    source.id,
    asset.id,
    data.renderKey,
    digest,
    JSON.stringify(data.appearance),
    asset.width,
    asset.height,
  ).run();
  const canonical = (await one(
    c.env,
    "SELECT * FROM appearance_snapshots WHERE user_id=? AND render_key=?",
    c.get("user").id,
    data.renderKey,
  ))!;
  if (canonical.request_hash !== digest)
    throw new ApiError("IDEMPOTENCY_MISMATCH", "renderKey 对应的内容不同", 409);
  return c.json(
    {
      snapshot: {
        id: canonical.id,
        assetId: canonical.asset_id,
        renderKey: data.renderKey,
        width: asset.width,
        height: asset.height,
      },
    },
    201,
  );
});
app.get("/api/assets/:id", async (c) => {
  const asset = await owned(c.env, "assets", c.req.param("id"), c.get("user").id);
  const object = await c.env.BUCKET.get(asset.storage_key);
  if (!object) throw new ApiError("NOT_FOUND", "图片文件不存在", 404);
  return new Response(object.body, {
    headers: {
      "content-type": asset.mime,
      "content-length": String(object.size),
      etag: object.httpEtag,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
});
app.get("/api/tasks/:id", async (c) => {
  const task = await owned(c.env, "tasks", c.req.param("id"), c.get("user").id);
  return c.json({
    taskId: task.id,
    state: task.state,
    artifact: task.output ? JSON.parse(task.output) : null,
    error: task.error ? JSON.parse(task.error) : null,
  });
});
app.post("/api/tasks/:id/retry", async (c) => {
  const task = await owned(c.env, "tasks", c.req.param("id"), c.get("user").id);
  const body = retryTaskRequestSchema.parse(await c.req.json());
  return c.json(
    await roomCall(c.env, task.project_id, "retry-task", { userId: c.get("user").id, taskId: task.id, clientOperationId: body.clientOperationId, quotaIp: c.get("quotaIp") }),
    201,
  );
});
app.post("/api/media/ops", async (c) => {
  const data = mediaOpRequestSchema.parse(await c.req.json());
  await owned(c.env, "projects", data.projectId, c.get("user").id);
  return c.json(
    await roomCall(c.env, data.projectId, "media-op", { userId: c.get("user").id, body: data, quotaIp: c.get("quotaIp") }),
    201,
  );
});
app.post("/api/media/client-results", async (c) => {
  const data = clientResultRequestSchema.parse(await c.req.json());
  await owned(c.env, "projects", data.projectId, c.get("user").id);
  return c.json(
    await roomCall(c.env, data.projectId, "client-result", {
      userId: c.get("user").id,
      body: data,
    }),
    201,
  );
});
app.notFound((c) =>
  c.req.path === "/api" || c.req.path.startsWith("/api/")
    ? c.json(new ApiError("NOT_FOUND", "接口不存在", 404).body(), 404)
    : c.env.ASSETS
      ? c.env.ASSETS.fetch(c.req.raw)
      : c.text("API 已就绪，静态前端尚未构建。", 200),
);
app.onError((error, c) => {
  const e =
    error instanceof z.ZodError || error instanceof SyntaxError
      ? new ApiError("INVALID_INPUT", "请求格式无效", 422)
      : publicError(error);
  return c.json(e.body(), e.status as ContentfulStatusCode);
});
export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ taskId: string; projectId: string }>, env: Env) {
    await Promise.all(batch.messages.map(async message => {
      try {
        await consumeTask(env, message.body.taskId, message.body.projectId);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 10 });
      }
    }));
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(_controller.cron === "17 3 * * *" ? cleanupGuests(env) : recover(env));
  },
};
