import type { EdgeEvent } from "@loomic/shared/edge";
import type { Env, Row } from "../types";
export type EventInput = {
  type: EdgeEvent["type"];
  payload: unknown;
  runId?: string;
  taskId?: string;
};
export interface RoomContext {
  env: Env;
  ctx: DurableObjectState;
  atomic(projectId: string, writes: D1PreparedStatement[], events?: EventInput[]): Promise<void>;
  lock<T>(fn: () => Promise<T>): Promise<T>;
  childControllers?: Map<string, AbortController>;
}
export class RoomService {
  constructor(protected room: RoomContext) {}
  get env() {
    return this.room.env;
  }
  get ctx() {
    return this.room.ctx;
  }
  atomic(projectId: string, writes: D1PreparedStatement[], events: EventInput[] = []) {
    return this.room.atomic(projectId, writes, events);
  }
  lock<T>(fn: () => Promise<T>) {
    return this.room.lock(fn);
  }
  timing(run: Row, phase: "read_canvas" | "model" | "tool" | "image" | "ingest" | "review", label: string, started: number) {
    return this.atomic(run.project_id, [], [{ type: "run.timing", runId: run.id,
      payload: { phase, label, startedAt: new Date(started).toISOString(), durationMs: Math.max(0, Date.now() - started) } }]);
  }
}
export const active = (run: Row) =>
  !["completed", "failed", "cancelled", "waiting_input"].includes(run.state);
