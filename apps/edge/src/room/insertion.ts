import {
  canvasSchema,
  taskInputSchema,
  type Canvas,
  type CanvasElement,
} from "@loomic/shared/edge";
import { z } from "zod";
import { all, hash, now, one, requireRow, stmt } from "../core";
import { artifactView } from "../images";
import { placeBatch } from "../placement";
import type { Row } from "../types";
import { RoomService } from "./context";
import { imageElement } from "./elements";
import { operationWrites } from "./operations";
import { appendIndex, ensureIndexes } from "./indexes";
import { SetRuns } from "./sets";
export class TaskInsertion extends RoomService {
  async commit(projectId: string, taskId: string) {
    const task = requireRow(
      await one(this.env, "SELECT * FROM tasks WHERE id=? AND project_id=?", taskId, projectId),
    );
    if (JSON.parse(task.input).setId) return new SetRuns(this.room).commitTask(projectId, taskId);
    const old = await one(this.env, "SELECT * FROM insertions WHERE task_id=?", taskId);
    if (old) return { inserted: false, revision: old.canvas_revision };
    const artifact = requireRow(
      await one(this.env, "SELECT * FROM artifacts WHERE task_id=?", taskId),
    );
    if (task.cancel_requested || task.state === "cancelled")
      return { inserted: false, cancelled: true };
    if (task.state !== "ingesting") return { inserted: false };
    const project = requireRow(await one(this.env, "SELECT * FROM projects WHERE id=?", projectId));
    const canvas = canvasSchema.parse(JSON.parse(project.canvas)),
      oldElements = [...canvas.elements];
    const view = await artifactView(this.env, artifact);
    const element = imageElement(taskId, view.asset, {
      taskId,
      artifactId: artifact.id,
      snapshotId: view.snapshotId,
      slotIndex: task.slot_index,
    });
    element.index = appendIndex(canvas.elements);
    const actual = await this.place(task, canvas, element);
    const before = canvas.revision++;
    canvas.elements = [
      ...canvas.elements.map(e => actual.find(a => a.id === e.id) || e),
      ...actual.filter(e => !canvas.elements.some(old => old.id === e.id)),
    ];
    ensureIndexes(canvas.elements, new Set(actual.map(e => e.id)));
    canvas.files[view.asset.id] = { assetId: view.asset.id };
    const ops = actual.map((element) => ({ kind: "upsert" as const, element }));
    await this.atomic(
      projectId,
      [
        stmt(
          this.env,
          "INSERT INTO insertions VALUES(?,?,?,?,?)",
          taskId,
          projectId,
          artifact.id,
          JSON.stringify([element.id]),
          canvas.revision,
        ),
        stmt(
          this.env,
          "UPDATE projects SET canvas=?,cover_url=COALESCE(cover_url,?) WHERE id=?",
          JSON.stringify(canvas),
          view.asset.url,
          projectId,
        ),
        stmt(
          this.env,
          "UPDATE tasks SET state='committed',output=?,updated_at=? WHERE id=?",
          JSON.stringify(view),
          now(),
          taskId,
        ),
        ...operationWrites(
          this.env,
          projectId,
          `task:${taskId}`,
          await hash(taskId),
          "task",
          before,
          canvas,
          ops,
          oldElements,
        ),
      ],
      this.commitEvents(task, view, actual.find(e => e.id === element.id)!, canvas, ops),
    );
    await this.ctx.storage.setAlarm(Date.now() + 20);
    return { inserted: true, revision: canvas.revision };
  }
  private commitEvents(
    task: Row,
    view: Awaited<ReturnType<typeof artifactView>>,
    element: CanvasElement,
    canvas: Canvas,
    ops: import("@loomic/shared/edge").CanvasOp[],
  ): import("./context").EventInput[] {
    const taskId = task.id;
    return [
      {
        type: "canvas.ops",
        runId: task.run_id,
        taskId,
        payload: { revision: canvas.revision, ops, source: "task" },
      },
      {
        type: "task.state",
        runId: task.run_id,
        taskId,
        payload: { state: "committed", slotIndex: task.slot_index, slot: { x: element.x, y: element.y, w: element.width, h: element.height } },
      },
      {
        type: "artifact.committed",
        runId: task.run_id,
        taskId,
        payload: { artifact: view, elementIds: [element.id], revision: canvas.revision },
      },
    ];
  }
  private async place(task: Row, canvas: Canvas, element: CanvasElement) {
    const siblings = await all(
      this.env,
      "SELECT id,slot_index,input FROM tasks WHERE run_id=? AND tool_invocation_id=? ORDER BY slot_index",
      task.run_id,
      task.tool_invocation_id,
    );
    const edited = new Set(
      (
        await all(
          this.env,
          "SELECT er.element_id FROM element_revisions er JOIN operations o ON o.project_id=er.project_id AND o.after_revision=er.revision WHERE er.project_id=? AND o.source='user'",
          task.project_id,
        )
      ).map((r) => r.element_id),
    );
    const batch = siblings.map((s) => {
      const slot = JSON.parse(s.input).slot;
      if (s.id === task.id) return element;
      const existing = canvas.elements.find((e) => e.id === `element_${s.id}`);
      if (existing && edited.has(existing.id)) {
        const meta = z.record(z.unknown()).optional().parse(existing.customData);
        const width = Number(meta?.naturalWidth) || 360,
          height = Number(meta?.naturalHeight) || 360;
        const scale = 360 / Math.max(width, height);
        return {
          ...existing,
          id: `reserved_${s.id}`,
          width: width * scale,
          height: height * scale,
        };
      }
      return (
        existing || {
          id: `element_${s.id}`,
          type: "image",
          x: 0,
          y: 0,
          width: slot?.w || 360,
          height: slot?.h || 360,
          version: 1,
        }
      );
    });
    const input = taskInputSchema.parse(JSON.parse(task.input));
    const frozen = siblings[0] ? JSON.parse(siblings[0].input).slot : undefined;
    return placeBatch(batch, canvas.elements, frozen ? undefined : input.anchor ?? undefined,
      frozen ? { x: frozen.x, y: frozen.y } : input.viewportCenter)
      .filter((e) => e.id === element.id || canvas.elements.some((old) => old.id === e.id))
      .map((e) => ({ ...e, version: e.id === element.id ? 1 : e.version + 1 }));
  }
}
