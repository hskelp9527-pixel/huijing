import { edgeEventSchema } from "@loomic/shared/edge";
import { all, ApiError, now, one, requireRow, stmt, threadView } from "../core";
import { RoomService, type EventInput } from "./context";
import { shotView, type ShotRecord } from "../sets";
export class RoomEvents extends RoomService {
  /** Recover creation notifications after a crash between HTTP writes and room wake. */
  async recordCreated(projectId: string) {
    const threads = await all(this.env, `SELECT t.* FROM threads t WHERE t.project_id=? AND NOT EXISTS
      (SELECT 1 FROM events e WHERE e.project_id=t.project_id AND json_extract(e.data,'$.type')='thread.created' AND json_extract(e.data,'$.payload.thread.id')=t.id) ORDER BY t.rowid`, projectId);
    const messages = await all(this.env, `SELECT m.* FROM messages m WHERE m.project_id=? AND NOT EXISTS
      (SELECT 1 FROM events e WHERE e.project_id=m.project_id AND json_extract(e.data,'$.type')='message.created' AND json_extract(e.data,'$.payload.messageId')=m.id) ORDER BY m.ordinal`, projectId);
    if (!threads.length && !messages.length) return;
    await this.atomic(projectId, [], [
      ...threads.map(t => ({ type: "thread.created" as const, payload: { thread: threadView(t) } })),
      ...messages.map(m => ({ type: "message.created" as const, runId: m.run_id || undefined,
        payload: { messageId: m.id, threadId: m.thread_id, role: m.role, createdAt: m.created_at } })),
    ]);
  }
  async atomic(projectId: string, writes: D1PreparedStatement[], events: EventInput[] = []) {
    events = [...events];
    for (const event of [...events]) {
      if (event.type === "task.state" && event.taskId) {
        const payload = event.payload as Record<string, unknown>;
        const task = await one(this.env, "SELECT input FROM tasks WHERE id=?", event.taskId);
        const slot = task ? JSON.parse(task.input).slot : undefined;
        if (slot && !payload.slot) event.payload = { ...payload, slot };
        if (!events.some(item => item.type === "set.shot" && item.taskId === event.taskId)) {
          const shot = await stmt(this.env, "SELECT * FROM set_shots WHERE task_id=?", event.taskId).first<ShotRecord>();
          if (shot) events.push({ type: "set.shot", taskId: event.taskId, payload: { setId: shot.set_id, ...shotView({ ...shot, state: String(payload.state), error: payload.error ? JSON.stringify(payload.error) : null }) } });
        }
      }
      if (event.type === "message.final" && event.runId) {
        const run = requireRow(await one(this.env, "SELECT thread_id FROM runs WHERE id=?", event.runId));
        events.push({ type: "message.created", runId: event.runId,
          payload: { messageId: (event.payload as { messageId: string }).messageId, threadId: run.thread_id, role: "assistant", createdAt: now() } });
      }
    }
    const project = requireRow(await one(this.env, "SELECT * FROM projects WHERE id=?", projectId));
    const envelopes = events.map((event, index) =>
      edgeEventSchema.parse({
        ...event,
        projectId,
        at: now(),
        seq: project.event_seq + index + 1,
      }),
    );
    await this.env.DB.batch([
      ...writes,
      ...envelopes.map((e) =>
        stmt(this.env, "INSERT INTO events VALUES(?,?,?)", projectId, e.seq, JSON.stringify(e)),
      ),
      stmt(
        this.env,
        "UPDATE projects SET event_seq=event_seq+?,updated_at=? WHERE id=?",
        envelopes.length,
        now(),
        projectId,
      ),
    ]);
    for (const event of envelopes)
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify(event));
        } catch {
          /* replay from D1 on reconnect */
        }
      }
  }
  async connect(url: URL) {
    const projectId = url.searchParams.get("projectId")!;
    await this.recordCreated(projectId);
    const cursor = Number(url.searchParams.get("cursor") || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new ApiError("INVALID_INPUT", "cursor 无效", 422);
    const project = requireRow(await one(this.env, "SELECT * FROM projects WHERE id=?", projectId));
    if (cursor > project.event_seq) throw new ApiError("INVALID_INPUT", "cursor 超出事件范围", 422);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // Joining and replay share the same write gate, so no live event can overtake replay.
    const events = await all(
      this.env,
      "SELECT data FROM events WHERE project_id=? AND seq>? ORDER BY seq",
      projectId,
      cursor,
    );
    for (const event of events) pair[1].send(event.data);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
