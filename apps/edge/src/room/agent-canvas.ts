import {
  agentCanvasApplySchema,
  canvasSchema,
  type AgentCanvasApply,
  type AgentCanvasCommand,
  type AgentShapeRef,
  type Canvas,
  type CanvasElement,
  type CanvasOp,
} from "@loomic/shared/edge";
import { all, ApiError, hash, id, now, one, requireRow, stmt } from "../core";
import type { Row } from "../types";
import { RoomService, type EventInput } from "./context";
import { appendIndex, ensureIndexes, indexAt } from "./indexes";

/** DO serialization replaces leases; a user edit reserves its elements for five seconds. */
export const AGENT_USER_EDIT_WINDOW_MS = 5000;
type Skip = { elementId: string; reason: "USER_EDITING"; message: string };
export interface AgentCanvasResult {
  operationIds: string[];
  canvasRevision: number;
  changedShapes: CanvasElement[];
  createdShapeIds: string[];
  skipped: Skip[];
  conflicts: string[];
  serverElements: CanvasElement[];
}
type OperationChanges = {
  before: CanvasElement[];
  after: CanvasOp[];
  response?: AgentCanvasResult;
  runId?: string;
  initiatorClientId?: string;
  inverseOps?: CanvasOp[];
  beforeOrder?: string[];
  afterOrder?: string[];
};

export class AgentCanvas extends RoomService {
  /** Caller holds ProjectRoom.lock, exactly as user canvas edits do. Never call outside that gate. */
  async apply(run: Row, invocationId: string, args: unknown): Promise<AgentCanvasResult> {
    if (run.role && run.role !== "orchestrator")
      throw new ApiError("FORBIDDEN", "子任务不能修改画布", 403);
    const data = agentCanvasApplySchema.parse(args);
    const clientOperationId = `agent-canvas:${invocationId}`;
    const digest = await hash(JSON.stringify({ runId: run.id, ...data }));
    const previous = await one(
      this.env,
      "SELECT * FROM operations WHERE project_id=? AND client_op_id=?",
      run.project_id,
      clientOperationId,
    );
    if (previous) {
      if (previous.request_hash !== digest)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "相同排版操作 ID 的内容不同", 409);
      const stored = JSON.parse((previous as unknown as { changes: string }).changes) as OperationChanges;
      if (!stored.response || stored.runId !== run.id)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "排版操作的来源不一致", 409);
      return stored.response;
    }
    const latestRun = requireRow(await one(this.env, "SELECT * FROM runs WHERE id=?", run.id));
    if (latestRun.parent_run_id || (latestRun.role && latestRun.role !== "orchestrator"))
      throw new ApiError("FORBIDDEN", "子任务不能修改画布", 403);
    if (["completed", "failed", "cancelled", "waiting_input"].includes(latestRun.state))
      throw new ApiError("CANVAS_CONFLICT", "此轮任务当前不能修改画布", 409);
    const prepared = await this.prepare(run, data);
    return this.commit(run, invocationId, clientOperationId, digest, prepared);
  }
  private async prepare(run: Row, data: AgentCanvasApply) {
    const project = requireRow(await one(this.env, "SELECT * FROM projects WHERE id=?", run.project_id));
    const canvas = canvasSchema.parse(JSON.parse(project.canvas));
    const before = structuredClone(canvas);
    if (data.baseCanvasRevision > canvas.revision)
      throw this.conflict(canvas, [], "画布版本已变化，请重新读取画布");
    const allowed = new Set(await this.ctx.storage.get<string[]>(`agent-allowed:${run.id}`) || []);
    const local = new Map<string, string>();
    const allocated = new Set<string>();
    const touched = new Set<string>();
    const targets = new Set<string>();
    // Allocate all local references before validation, including references to later creations.
    for (const command of data.commands) {
      if (command.kind !== "createText" && command.kind !== "createFrame") continue;
      if (local.has(command.localKey))
        throw new ApiError("INVALID_INPUT", "新对象 localKey 重复", 422);
      const shapeId = id("element");
      local.set(command.localKey, shapeId);
      allocated.add(shapeId);
    }
    const resolve = (ref: AgentShapeRef) => {
      const shapeId = "id" in ref ? ref.id : local.get(ref.localKey);
      if (!shapeId || (!allowed.has(shapeId) && !allocated.has(shapeId)))
        throw new ApiError("FORBIDDEN", "只能操作本轮读取过的画布对象或本次新对象", 403);
      if (!allocated.has(shapeId)) targets.add(shapeId);
      return shapeId;
    };
    for (const command of data.commands) {
      if ("target" in command) resolve(command.target);
      if ("targets" in command) command.targets.forEach(resolve);
      if (command.kind === "reparent" && command.frame) resolve(command.frame);
    }
    const changedRows = await all(
      this.env,
      "SELECT element_id FROM element_revisions WHERE project_id=? AND revision>?",
      run.project_id,
      data.baseCanvasRevision,
    );
    const conflicts = [...targets].filter((shapeId) => {
      const shape = canvas.elements.find((e) => e.id === shapeId && !e.isDeleted);
      if (!shape) return true;
      const expected = data.expectedShapeRevisions[shapeId];
      return (expected !== undefined && expected !== shape.version) ||
        changedRows.some((r) => r.element_id === shapeId);
    });
    const recent = await this.recentUserShapes(run.project_id);
    const skipped: Skip[] = [...targets].filter((shapeId) => recent.has(shapeId)).map((elementId) => ({
      elementId, reason: "USER_EDITING", message: "用户最近正在编辑此对象，已保留服务端修改并跳过排版。",
    }));
    const skippedIds = new Set(skipped.map((s) => s.elementId));
    const hardConflicts = conflicts.filter((shapeId) => !skippedIds.has(shapeId));
    if (hardConflicts.length)
      throw this.conflict(canvas, hardConflicts, "目标对象已变化，请重新读取后确认排版");
    for (const shapeId of targets) {
      const shape = canvas.elements.find((e) => e.id === shapeId && !e.isDeleted);
      if (shape?.locked)
        throw new ApiError("CANVAS_CONFLICT", "锁定对象不能由 Agent 修改，请先由用户解锁", 409, false, {
          reason: "ELEMENT_LOCKED", elementId: shapeId, revision: canvas.revision, serverElements: [shape],
        });
    }
    const references = (command: AgentCanvasCommand) => {
      const ids: string[] = [];
      if ("target" in command) ids.push(resolve(command.target));
      if ("targets" in command) ids.push(...command.targets.map(resolve));
      if (command.kind === "reparent" && command.frame) ids.push(resolve(command.frame));
      return ids;
    };
    // Validate an entire command group against one authoritative version; no partial persistent writes.
    for (const command of data.commands) {
      if (references(command).some((shapeId) => skippedIds.has(shapeId))) continue;
      this.command(canvas, command, resolve, local, touched, run);
    }
    return {canvas,before,touched,allocated,skipped,conflicts,skippedIds};
  }
  private async commit(run: Row, invocationId: string, clientOperationId: string, digest: string,
    prepared: Awaited<ReturnType<AgentCanvas["prepare"]>>) {
    const {canvas,before,touched,allocated,skipped,conflicts,skippedIds} = prepared;
    ensureIndexes(canvas.elements, touched);
    const changedShapes = canvas.elements.filter((shape) => touched.has(shape.id));
    for (const shape of changedShapes) {
      const old = before.elements.find((e) => e.id === shape.id);
      shape.version = (old?.version || 0) + 1;
      shape.versionNonce = crypto.getRandomValues(new Uint32Array(1))[0];
      shape.updated = Date.now();
    }
    if (changedShapes.length) canvas.revision++;
    const operationId = id("op");
    const response: AgentCanvasResult = {
      operationIds: [operationId], canvasRevision: canvas.revision, changedShapes,
      createdShapeIds: changedShapes.filter((e) => allocated.has(e.id)).map((e) => e.id),
      skipped, conflicts,
      serverElements: before.elements.filter((e) => skippedIds.has(e.id)),
    };
    const ops: CanvasOp[] = changedShapes.map((element) => ({ kind: "upsert", element }));
    const initiatorClientId = run.initiator_client_id || `user:${run.user_id}`;
    const inverseOps: CanvasOp[] = [...touched].map((shapeId) => {
      const original = before.elements.find((e) => e.id === shapeId);
      return original ? { kind: "upsert", element: original } : { kind: "delete", elementId: shapeId };
    });
    const changes = {
      before: before.elements.filter((e) => touched.has(e.id)), after: ops,
      inverseOps, beforeOrder: before.elements.map((e) => e.id), afterOrder: canvas.elements.map((e) => e.id),
      source: "agent", runId: run.id, initiatorClientId, clientOperationId, response,
    };
    const events: EventInput[] = [];
    if (ops.length) events.push({
      type: "canvas.ops", runId: run.id,
      payload: { revision: canvas.revision, ops, source: "agent", runId: run.id, initiatorClientId,
        elementOrder: canvas.elements.map((e) => e.id) },
    });
    if (skipped.length) events.push({
      type: "run.step", runId: run.id,
      payload: { stepId: invocationId, tool: "canvas_apply", status: "completed",
        summary: `用户正在编辑 ${skipped.length} 个对象，已跳过相关排版并保留服务端版本。` },
    });
    await this.atomic(run.project_id, [
      stmt(this.env, "UPDATE projects SET canvas=? WHERE id=?", JSON.stringify(canvas), run.project_id),
      stmt(this.env, "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)", operationId, run.project_id,
        clientOperationId, digest, "agent", before.revision, canvas.revision, JSON.stringify(changes), now()),
      ...changedShapes.map((shape) => stmt(this.env,
        "INSERT INTO element_revisions VALUES(?,?,?) ON CONFLICT(project_id,element_id) DO UPDATE SET revision=excluded.revision",
        run.project_id, shape.id, canvas.revision)),
    ], events);
    return response;
  }

  /** Route authenticates project owner and loads the original run; caller holds the DO mutation gate. */
  async undo(run: Row, operationId: string, clientOperationId: string): Promise<AgentCanvasResult> {
    if (!clientOperationId || clientOperationId.length > 180)
      throw new ApiError("INVALID_INPUT", "撤销操作 ID 无效", 422);
    const replayId = `agent-undo:${clientOperationId}`;
    const initiatorClientId = run.initiator_client_id || `user:${run.user_id}`;
    const digest = await hash(JSON.stringify({ runId: run.id, operationId, initiatorClientId }));
    const previous = await one(this.env,
      "SELECT * FROM operations WHERE project_id=? AND client_op_id=?", run.project_id, replayId);
    if (previous) {
      if (previous.request_hash !== digest)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "相同撤销 ID 的内容不同", 409);
      return (JSON.parse((previous as unknown as { changes: string }).changes) as OperationChanges).response!;
    }
    const operation = requireRow(await one(this.env,
      "SELECT * FROM operations WHERE project_id=? AND id=?", run.project_id, operationId));
    const saved = JSON.parse((operation as unknown as { changes: string }).changes) as OperationChanges;
    if (!saved.inverseOps || saved.runId !== run.id || saved.initiatorClientId !== initiatorClientId)
      throw new ApiError("FORBIDDEN", "只能撤销由本客户端发起的 Agent 排版", 403);
    const project = requireRow(await one(this.env, "SELECT * FROM projects WHERE id=?", run.project_id));
    const canvas = canvasSchema.parse(JSON.parse(project.canvas));
    const before = structuredClone(canvas);
    const touched = new Set(saved.after.map((op) => op.kind === "upsert" ? op.element.id : op.elementId));
    const changed = await all(this.env,
      "SELECT element_id FROM element_revisions WHERE project_id=? AND revision>?",
      run.project_id, operation.after_revision);
    const conflicts = [...touched].filter((shapeId) => {
      const shape = canvas.elements.find((e) => e.id === shapeId);
      const after = saved.after.find((op) => op.kind === "upsert" && op.element.id === shapeId);
      return !shape || after?.kind !== "upsert" || shape.version !== after.element.version ||
        changed.some((r) => r.element_id === shapeId);
    });
    if (conflicts.length) throw this.conflict(canvas, conflicts, "对象在排版后已被修改，无法直接撤销");
    const reordered = saved.beforeOrder && saved.afterOrder &&
      saved.beforeOrder.filter((shapeId) => saved.afterOrder!.includes(shapeId)).join("\n") !==
      saved.afterOrder.filter((shapeId) => saved.beforeOrder!.includes(shapeId)).join("\n");
    if (reordered && saved.afterOrder!.join("\n") !== canvas.elements.map((e) => e.id).join("\n"))
      throw this.conflict(canvas, [], "画布层级在排版后已变化，无法直接撤销");
    for (const op of saved.inverseOps) {
      const shapeId = op.kind === "upsert" ? op.element.id : op.elementId;
      const index = canvas.elements.findIndex((e) => e.id === shapeId);
      const current = canvas.elements[index];
      canvas.elements[index] = {
        ...(op.kind === "upsert" ? op.element : { ...current, isDeleted: true }),
        version: current.version + 1, updated: Date.now(),
        versionNonce: crypto.getRandomValues(new Uint32Array(1))[0],
      };
    }
    if (reordered) {
      const order = new Map(saved.beforeOrder!.map((shapeId, i) => [shapeId, i]));
      canvas.elements.sort((a, b) => (order.get(a.id) ?? order.size) - (order.get(b.id) ?? order.size));
    }
    ensureIndexes(canvas.elements, touched);
    if (touched.size) canvas.revision++;
    const undoId = id("op");
    const changedShapes = canvas.elements.filter((shape) => touched.has(shape.id));
    const ops: CanvasOp[] = changedShapes.map((element) => ({ kind: "upsert", element }));
    const response: AgentCanvasResult = { operationIds: [undoId], canvasRevision: canvas.revision,
      changedShapes, createdShapeIds: [], skipped: [], conflicts: [], serverElements: [] };
    await this.atomic(run.project_id, [
      stmt(this.env, "UPDATE projects SET canvas=? WHERE id=?", JSON.stringify(canvas), run.project_id),
      stmt(this.env, "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)", undoId, run.project_id, replayId,
        digest, "user", before.revision, canvas.revision, JSON.stringify({
          before: before.elements.filter((e) => touched.has(e.id)), after: ops,
          runId: run.id, initiatorClientId, undoOf: operationId, response,
        }), now()),
      ...changedShapes.map((shape) => stmt(this.env,
        "INSERT INTO element_revisions VALUES(?,?,?) ON CONFLICT(project_id,element_id) DO UPDATE SET revision=excluded.revision",
        run.project_id, shape.id, canvas.revision)),
    ], ops.length ? [{ type: "canvas.ops", runId: run.id, payload: {
      revision: canvas.revision, ops, source: "user", elementOrder: canvas.elements.map((e) => e.id),
    } }] : []);
    return response;
  }

  private conflict(canvas: Canvas, shapeIds: string[], message: string) {
    return new ApiError("CANVAS_CONFLICT", message, 409, false, {
      revision: canvas.revision, serverElements: shapeIds.length ?
        canvas.elements.filter((e) => shapeIds.includes(e.id)) : canvas.elements,
    });
  }

  private async recentUserShapes(projectId: string) {
    const operations = await all(this.env,
      "SELECT changes FROM operations WHERE project_id=? AND source='user' AND created_at>=?",
      projectId, new Date(Date.now() - AGENT_USER_EDIT_WINDOW_MS).toISOString());
    const shapes = new Set<string>();
    for (const operation of operations) {
      const changes = JSON.parse((operation as unknown as { changes: string }).changes) as OperationChanges;
      for (const shape of changes.before || []) shapes.add(shape.id);
      for (const op of changes.after || []) shapes.add(op.kind === "upsert" ? op.element.id : op.elementId);
    }
    return shapes;
  }

  private command(canvas: Canvas, command: AgentCanvasCommand, resolve: (ref: AgentShapeRef) => string,
    local: Map<string, string>, touched: Set<string>, run: Row) {
    const element = (ref: AgentShapeRef) => {
      const shape = canvas.elements.find((e) => e.id === resolve(ref) && !e.isDeleted);
      if (!shape) throw new ApiError("INVALID_INPUT", "排版目标不存在；新对象必须先创建", 422);
      if (shape.locked) throw new ApiError("CANVAS_CONFLICT", "锁定对象不能修改", 409);
      touched.add(shape.id);
      return shape;
    };
    if (command.kind === "createText" || command.kind === "createFrame") {
      const shape = this.newElement(local.get(command.localKey)!, command.kind === "createText" ? "text" : "frame",
        command.x, command.y, command.width || 240, command.height || (command.kind === "createText" ? command.fontSize * 1.25 : 100));
      shape.index = appendIndex(canvas.elements);
      if (command.kind === "createText") Object.assign(shape, {
        text: command.text, originalText: command.text, fontSize: command.fontSize, fontFamily: 1,
        textAlign: command.textAlign, verticalAlign: "top", lineHeight: 1.25, autoResize: false, containerId: null,
      });
      else shape.name = command.name;
      canvas.elements.push(shape);
      touched.add(shape.id);
      return;
    } else if (command.kind === "align" || command.kind === "distribute") {
      this.align(command, command.targets.map(element));
      return;
    }
    const shape = element(command.target);
    switch (command.kind) {
      case "updateGeometry":
        if (shape.type === "frame" && canvas.elements.some((e) => !e.isDeleted && e.frameId === shape.id))
          throw new ApiError("INVALID_INPUT", "请分别移动 frame 中的对象后调整 frame 几何", 422);
        for (const key of ["x", "y", "width", "height", "angle"] as const)
          { const value = command[key]; if (value !== undefined) shape[key] = value; }
        break;
      case "updateText":
        if (shape.type !== "text") throw new ApiError("INVALID_INPUT", "只能修改原生文本对象", 422);
        shape.text = command.text; shape.originalText = command.text;
        break;
      case "reparent": {
        const frame = command.frame ? element(command.frame) : null;
        if (frame && (frame.type !== "frame" || frame.id === shape.id))
          throw new ApiError("INVALID_INPUT", "父对象必须是另一个 frame", 422);
        if (shape.type === "frame") throw new ApiError("INVALID_INPUT", "不支持嵌套 frame", 422);
        shape.frameId = frame?.id || null;
        break;
      }
      case "reorder": {
        const index = canvas.elements.findIndex((e) => e.id === shape.id);
        canvas.elements.splice(index, 1);
        const destination = command.placement === "front" ? canvas.elements.length :
          command.placement === "back" ? 0 : command.placement === "forward" ?
            Math.min(canvas.elements.length, index + 1) : Math.max(0, index - 1);
        canvas.elements.splice(destination, 0, shape);
        shape.index = indexAt(canvas.elements, destination);
        break;
      }
      case "setVisibility":
      case "softDelete": {
        const frozen = JSON.parse(run.frozen_submission) as { parts?: { type: string; text?: string }[] };
        const text = (frozen.parts || []).filter((p) => p.type === "text").map((p) => p.text || "").join("\n");
        if ((command.kind === "softDelete" || !command.visible) &&
          (!/(删除|隐藏|移除|delete|hide|remove)/i.test(text) || !text.includes(shape.id) ||
            /(?:不要|不许|禁止|无需)\s*(?:删除|隐藏|移除)|(?:do not|don't|never)\s+(?:delete|hide|remove)/i.test(text)))
          throw new ApiError("FORBIDDEN", "删除或隐藏对象需要用户明确要求并指定对象 ID", 403);
        if (command.kind === "softDelete") {
          if (shape.type === "frame" && canvas.elements.some((e) => !e.isDeleted && e.frameId === shape.id))
            throw new ApiError("INVALID_INPUT", "删除 frame 前必须先显式处理其包含对象", 422);
          shape.isDeleted = true;
        }
        else {
          const custom = shape.customData as Record<string, unknown> | undefined;
          const storedOpacity = typeof custom?.agentVisibleOpacity === "number" ? custom.agentVisibleOpacity : 100;
          shape.customData = { ...custom, agentVisibleOpacity: command.visible || custom?.agentHidden ? storedOpacity : shape.opacity ?? 100,
            agentHidden: !command.visible };
          shape.opacity = command.visible ? storedOpacity : 0;
        }
        break;
      }
      case "setLocked": shape.locked = command.locked; break;
    }
  }

  private align(command: Extract<AgentCanvasCommand, {kind:"align"|"distribute"}>, shapes: CanvasElement[]) {
      if (new Set(shapes.map((e) => e.id)).size !== shapes.length)
        throw new ApiError("INVALID_INPUT", "排版目标不能重复", 422);
      const left = Math.min(...shapes.map((e) => e.x)), top = Math.min(...shapes.map((e) => e.y));
      const right = Math.max(...shapes.map((e) => e.x + e.width)), bottom = Math.max(...shapes.map((e) => e.y + e.height));
      if (command.kind === "align") for (const shape of shapes) {
        switch (command.alignment) {
          case "left": shape.x = left; break;
          case "center": shape.x = (left + right - shape.width) / 2; break;
          case "right": shape.x = right - shape.width; break;
          case "top": shape.y = top; break;
          case "middle": shape.y = (top + bottom - shape.height) / 2; break;
          case "bottom": shape.y = bottom - shape.height; break;
        }
      } else {
        const horizontal = command.axis === "horizontal";
        shapes.sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
        const total = shapes.reduce((sum, e) => sum + (horizontal ? e.width : e.height), 0);
        const gap = command.gap ?? ((horizontal ? right - left : bottom - top) - total) / (shapes.length - 1);
        let cursor = horizontal ? left : top;
        for (const shape of shapes) {
          if (horizontal) shape.x = cursor; else shape.y = cursor;
          cursor += (horizontal ? shape.width : shape.height) + gap;
        }
      }
  }

  private newElement(shapeId: string, type: string, x: number, y: number, width: number, height: number): CanvasElement {
    return {
      id: shapeId, type, x, y, width, height, version: 1, angle: 0,
      strokeColor: "#1b1b1f", backgroundColor: "transparent", fillStyle: "solid",
      strokeWidth: 1, strokeStyle: "solid", roughness: 0, opacity: 100,
      groupIds: [], frameId: null, roundness: null, seed: crypto.getRandomValues(new Uint32Array(1))[0],
      versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null,
      locked: false, customData: {},
    };
  }
}
