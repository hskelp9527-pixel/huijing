import { roomRequestSchemas } from "@loomic/shared/edge";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { ApiError, one, publicError, requireRow } from "./core";
import { RoomCanvas } from "./room/canvas";
import { ClientResults } from "./room/client-results";
import { type EventInput, type RoomContext } from "./room/context";
import { RunDriver } from "./room/driver";
import { RoomEvents } from "./room/events";
import { RoomMedia } from "./room/media";
import { RoomTasks } from "./room/tasks";
import type { Env } from "./types";
import { AgentModelAdapter } from "./agent-model";
import { AgentCanvas } from "./room/agent-canvas";
import { retryTask } from "./retry";
import { expireProject } from "./cleanup";
import { SetRuns } from "./room/sets";
import { patchAnalysisRequestSchema, regenerateSetRequestSchema } from "@loomic/shared/edge";
export class ProjectRoom extends DurableObject<Env> {
  private driving = false;
  private roleCapabilities = new AgentModelAdapter(this.env).availability();
  protected context: RoomContext = {
    env: this.env,
    ctx: this.ctx,
    atomic: (...args) => this.atomic(...args),
    lock: (fn) => this.lock(fn),
    childControllers: new Map(),
  };
  private events = new RoomEvents(this.context);
  private canvas = new RoomCanvas(this.context);
  private tasks = new RoomTasks(this.context);
  private runs = new RunDriver(this.context);
  private atomic(projectId: string, writes: D1PreparedStatement[], events: EventInput[] = []) {
    return this.events.atomic(projectId, writes, events);
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { value: await fn() };
      } catch (error) {
        return { error };
      }
    });
    if ("error" in result) throw result.error;
    return result.value as T;
  }
  async fetch(request: Request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/ws") return await this.lock(() => this.events.connect(url));
      const raw: unknown = await request.json();
      return await this.lock(async () => {
        const result = await this.route(url.pathname.slice(1), raw);
        return Response.json(result);
      });
    } catch (error) {
      const e =
        error instanceof z.ZodError || error instanceof SyntaxError
          ? new ApiError("INVALID_INPUT", "请求格式无效", 422)
          : publicError(error);
      return Response.json(e.body(), { status: e.status });
    }
  }
  private async route(path: string, raw: unknown): Promise<unknown> {
    const { projectId } = roomRequestSchemas.wake.parse(raw);
    await this.ctx.storage.put("projectId", projectId);
    switch (path) {
      case "set-init": return new SetRuns(this.context).initialize(z.object({ setId: z.string() }).parse(raw).setId);
      case "set-analysis": {
        const data = z.object({ setId: z.string(), patch: patchAnalysisRequestSchema }).parse(raw);
        return new SetRuns(this.context).patchAnalysis(data.setId, data.patch);
      }
      case "set-regenerate-all": {
        const data = regenerateSetRequestSchema.extend({ setId: z.string(), projectId: z.string() }).parse(raw);
        return new SetRuns(this.context).regenerateAll(data.setId, data.scope, data.clientOperationId);
      }
      case "set-regenerate": {
        const data = z.object({ setId: z.string(), shotId: z.string(), clientOperationId: z.string().optional() }).parse(raw);
        return new SetRuns(this.context).regenerate(data.setId, data.shotId, data.clientOperationId);
      }
      case "expire": {
        const result = await expireProject(this.env, projectId);
        if (result.deleted) {
          for (const ws of this.ctx.getWebSockets()) ws.close(1000, "项目已过期");
          await this.ctx.storage.deleteAlarm();
          await this.ctx.storage.deleteAll();
        }
        return result;
      }
      case "wake":
        return this.wake(projectId);
      case "snapshot": {
        await this.events.recordCreated(projectId);
        const p = requireRow(await one(this.env, "SELECT * FROM projects WHERE id=?", projectId));
        return { canvas: JSON.parse(p.canvas), eventCursor: p.event_seq };
      }
      case "quota": {
        const data = roomRequestSchemas.quota.parse(raw);
        await this.atomic(
          projectId,
          [],
          [{ type: "quota.updated", runId: data.runId, payload: data.quota }],
        );
        return { ok: true };
      }
      case "step": return this.recordStep(projectId, raw);
      case "timing": return this.recordTiming(projectId, raw);
      case "retry-task": return this.retryTask(raw);
      case "retry-run": {
        const data = z.object({ runId: z.string(), clientOperationId: z.string().min(1) }).parse(raw);
        return this.runs.retryModel(projectId, data.runId, data.clientOperationId);
      }
      case "client-result": {
        const data = roomRequestSchemas["client-result"].parse(raw);
        return new ClientResults(this.context).register(data.userId, data.body);
      }
      case "media-op": {
        const data = roomRequestSchemas["media-op"].parse(raw);
        return new RoomMedia(this.context).enqueue(data.userId, data.body, data.quotaIp);
      }
      case "canvas":
        return this.canvas.canvas(projectId, roomRequestSchemas.canvas.parse(raw).body);
      case "agent-undo": {
        const data = z.object({ runId: z.string(), operationId: z.string(), clientOperationId: z.string() }).parse(raw);
        const run = requireRow(await one(this.env, "SELECT * FROM runs WHERE id=? AND project_id=?",data.runId,projectId));
        return new AgentCanvas(this.context).undo(run,data.operationId,data.clientOperationId);
      }
      case "cancel":
        return this.runs.cancel(projectId, roomRequestSchemas.cancel.parse(raw).runId);
      case "answer": {
        const data = roomRequestSchemas.answer.parse(raw);
        return this.runs.answer(projectId, data.requestId, data.body);
      }
      case "claim": return this.tasks.claim(projectId, roomRequestSchemas.claim.parse(raw).taskId);
      case "defer-task": return this.tasks.defer(roomRequestSchemas["defer-task"].parse(raw));
      case "commit": return this.tasks.commit(projectId, roomRequestSchemas.commit.parse(raw).taskId);
      case "submit": return this.tasks.submit(roomRequestSchemas.submit.parse(raw));
      case "task-state":
        return this.tasks.updateState(roomRequestSchemas["task-state"].parse(raw));
      default:
        throw new ApiError("NOT_FOUND", "接口不存在", 404);
    }
  }
  private async recordTiming(projectId: string, raw: unknown) {
    const data = z.object({ runId: z.string(), taskId: z.string().optional(), timing: z.object({
      phase: z.enum(["image", "ingest", "review"]), durationMs: z.number().nonnegative(), startedAt: z.string(), label: z.string(),
    }) }).parse(raw);
    await this.atomic(projectId, [], [{ type: "run.timing", runId: data.runId, taskId: data.taskId, payload: data.timing }]);
    return { ok: true };
  }
  private async recordStep(projectId: string, raw: unknown) {
    const data = roomRequestSchemas.step.parse(raw);
    await this.atomic(projectId, [], [{ type: "run.step", runId: data.runId, taskId: data.taskId,
      payload: { stepId: data.taskId || data.runId, tool: data.tool, status: "started", summary: data.summary } }]);
    return { ok: true };
  }
  private retryTask(raw: unknown) {
    const data = z.object({ userId: z.string(), taskId: z.string(), clientOperationId: z.string().min(1), quotaIp: z.string().default("local") }).parse(raw);
    return retryTask(this.env, data.userId, data.taskId, data.clientOperationId, this.context, data.quotaIp);
  }
  private async wake(projectId: string) {
    await this.events.recordCreated(projectId);
    await this.ctx.storage.put("role-capabilities", this.roleCapabilities);
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return { ok: true };
  }
  async alarm() {
    if (this.driving) {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
      return;
    }
    this.driving = true;
    try {
      const projectId = await this.ctx.storage.get<string>("projectId");
      if (projectId) await Promise.all([this.runs.tick(projectId), new SetRuns(this.context).tick(projectId)]);
    } finally {
      this.driving = false;
    }
  }
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") {
      const projectId = await this.ctx.storage.get<string>("projectId");
      if (projectId) await this.env.DB.prepare("UPDATE projects SET last_accessed_at=? WHERE id=? AND deleting=0").bind(new Date().toISOString(), projectId).run();
      ws.send("pong");
    }
  }
  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code === 1005 || code === 1006 ? 1000 : code, "");
  }
}
