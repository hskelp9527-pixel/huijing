import { expect, it } from "vitest";
import { harness, submission, until } from "./harness";
it("必需质量检查整体超时会跳过；Run结束、图保留且无重复无角色委派步骤", async () => {
  const h = await harness({ CHILD_TIMEOUT_MS: "300" });
  try {
    const { cookie } = await h.guest();
    const response = await h.request("/api/projects/start", "POST", submission("生成一张杯子并检查质量 [fixture:child-delay=3000]", 1), cookie);
    const s = await response.json<any>();
    const run = await until(() => h.db.prepare("SELECT * FROM runs WHERE id=?").bind(s.runId).first<any>(), r => ["completed","failed","waiting_input"].includes(r.state));
    expect(run.state, run.error).toBe("completed"); expect(run.quality_status).toBe("unchecked");
    const child = await h.db.prepare("SELECT * FROM child_runs WHERE parent_run_id=? AND role='quality-review'").bind(s.runId).first<any>();
    expect(child.state).toBe("failed"); expect(JSON.parse(child.error)).toMatchObject({ error: { details: { skipped: true, timeoutMs: 300 } } });
    const events = (await h.db.prepare("SELECT data FROM events WHERE project_id=?").bind(s.projectId).all<any>()).results.map(r => JSON.parse(r.data));
    expect(events.some(e => e.payload.childState === "skipped" && e.payload.role === "quality-review")).toBe(true);
    expect(events.filter(e => e.type === "run.step" && e.payload.tool === "agent_delegate" && !e.payload.role)).toHaveLength(0);
    expect((await h.db.prepare("SELECT state FROM tasks WHERE run_id=?").bind(s.runId).first<any>())!.state).toBe("committed");
    expect((await h.db.prepare("SELECT COUNT(*) n FROM input_requests WHERE run_id=?").bind(s.runId).first<any>())!.n).toBe(0);
  } finally { await h.close(); }
});
