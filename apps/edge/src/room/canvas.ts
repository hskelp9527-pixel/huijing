import {
  canvasOpsRequestSchema,
  canvasSchema,
  type Canvas,
  type CanvasOp,
} from "@loomic/shared/edge";
import { all, ApiError, hash, one, requireRow, stmt } from "../core";
import { RoomService } from "./context";
import { operationWrites } from "./operations";
export class RoomCanvas extends RoomService {
  async canvas(projectId: string, body: unknown) {
    const data = canvasOpsRequestSchema.parse(body),
      digest = await hash(JSON.stringify(data));
    const old = await one(
      this.env,
      "SELECT * FROM operations WHERE project_id=? AND client_op_id=?",
      projectId,
      data.clientOpId,
    );
    if (old) {
      if (old.request_hash !== digest)
        throw new ApiError("IDEMPOTENCY_MISMATCH", "相同操作 ID 的内容不同", 409);
      return { revision: old.after_revision };
    }
    const project = requireRow(await one(this.env, "SELECT * FROM projects WHERE id=?", projectId));
    const canvas = canvasSchema.parse(JSON.parse(project.canvas));
    const beforeElements = [...canvas.elements],
      before = canvas.revision;
    const touched = data.ops.map((op) => (op.kind === "upsert" ? op.element.id : op.elementId));
    await this.checkConflict(projectId, canvas, data.baseRevision, touched);
    for (const op of data.ops) await this.apply(projectId, canvas, op);
    canvas.revision++;
    const applied = touched.flatMap((key) => {
      const element = canvas.elements.find((e) => e.id === key);
      return element ? [{ kind: "upsert" as const, element }] : [];
    });
    await this.atomic(
      projectId,
      [
        stmt(
          this.env,
          "UPDATE projects SET canvas=? WHERE id=?",
          JSON.stringify(canvas),
          projectId,
        ),
        ...operationWrites(
          this.env,
          projectId,
          data.clientOpId,
          digest,
          "user",
          before,
          canvas,
          applied,
          beforeElements,
        ),
      ],
      [
        {
          type: "canvas.ops",
          payload: { revision: canvas.revision, ops: applied, source: "user" },
        },
      ],
    );
    return { revision: canvas.revision };
  }
  private async checkConflict(
    projectId: string,
    canvas: Canvas,
    baseRevision: number,
    touched: string[],
  ) {
    if (baseRevision > canvas.revision)
      throw new ApiError("CANVAS_CONFLICT", "画布版本已变化", 409, false, {
        revision: canvas.revision,
        serverElements: canvas.elements,
      });
    const changed = await all(
      this.env,
      "SELECT element_id FROM element_revisions WHERE project_id=? AND revision>?",
      projectId,
      baseRevision,
    );
    if (changed.some((r) => touched.includes(r.element_id)))
      throw new ApiError("CANVAS_CONFLICT", "相同元素已被修改", 409, false, {
        revision: canvas.revision,
        serverElements: canvas.elements.filter((e) => touched.includes(e.id)),
      });
  }
  private async apply(projectId: string, canvas: Canvas, op: CanvasOp) {
    const key = op.kind === "upsert" ? op.element.id : op.elementId;
    const index = canvas.elements.findIndex((e) => e.id === key),
      existing = canvas.elements[index];
    if (op.kind === "delete") {
      if (existing)
        canvas.elements[index] = { ...existing, isDeleted: true, version: existing.version + 1 };
      return;
    }
    if (op.element.fileId) {
      if (
        !(await one(
          this.env,
          "SELECT id FROM assets WHERE id=? AND project_id=?",
          op.element.fileId,
          projectId,
        ))
      )
        throw new ApiError("INVALID_INPUT", "画布图片必须引用本项目资源", 422);
      canvas.files[op.element.fileId] = { assetId: op.element.fileId };
    }
    const element = {
      ...op.element,
      version: Math.max(existing?.version || 0, op.element.version) + 1,
    };
    if (index < 0) canvas.elements.push(element);
    else canvas.elements[index] = element;
  }
}
