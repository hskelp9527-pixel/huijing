import type { Canvas, CanvasElement, CanvasOp } from "@loomic/shared/edge";
import { id, now, stmt } from "../core";
import type { Env } from "../types";
export function operationWrites(
  env: Env,
  projectId: string,
  clientOpId: string,
  digest: string,
  source: "user" | "task",
  before: number,
  canvas: Canvas,
  ops: CanvasOp[],
  old: CanvasElement[],
) {
  const touched = ops.map((op) => (op.kind === "upsert" ? op.element.id : op.elementId));
  return [
    stmt(
      env,
      "INSERT INTO operations VALUES(?,?,?,?,?,?,?,?,?)",
      id("op"),
      projectId,
      clientOpId,
      digest,
      source,
      before,
      canvas.revision,
      JSON.stringify({ before: old.filter((e) => touched.includes(e.id)), after: ops }),
      now(),
    ),
    ...touched.map((elementId) =>
      stmt(
        env,
        "INSERT INTO element_revisions VALUES(?,?,?) ON CONFLICT(project_id,element_id) DO UPDATE SET revision=excluded.revision",
        projectId,
        elementId,
        canvas.revision,
      ),
    ),
  ];
}
