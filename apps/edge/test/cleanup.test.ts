import { describe, expect, it } from "vitest";
import { harness, submission, until } from "./harness";

describe("访客项目保留期", () => {
  it("7天未访问项目和R2产物可重入清理；新访问、活跃任务和其他访客项目保留", async () => {
    const h = await harness();
    try {
      const { cookie } = await h.guest();
      const expired = await (await h.request("/api/projects/start", "POST", submission("生成一张杯子", 1), cookie)).json<any>();
      await until(() => h.db.prepare("SELECT state FROM runs WHERE id=?").bind(expired.runId).first<any>(), r => r.state === "completed");
      const generatedTask = await h.db.prepare("SELECT id FROM tasks WHERE run_id=?").bind(expired.runId).first<any>();
      const assets = (await h.db.prepare("SELECT storage_key FROM assets WHERE project_id=?").bind(expired.projectId).all<any>()).results;
      expect(assets.length).toBeGreaterThan(0);
      const bucket = await h.mf.getR2Bucket("BUCKET");
      expect(await bucket.head(assets[0].storage_key)).not.toBeNull();
      const fresh = (await (await h.request("/api/projects", "POST", {}, cookie)).json<any>()).project.id;
      const busyProject = (await (await h.request("/api/projects", "POST", {}, cookie)).json<any>()).project.id;
      const thread = await h.db.prepare("SELECT id FROM threads WHERE project_id=?").bind(busyProject).first<any>();
      const guest = await (await h.request("/api/me", "GET", undefined, cookie)).json<any>();
      await h.db.prepare("INSERT INTO runs(id,project_id,thread_id,user_id,state,frozen_submission,started_at,created_at) VALUES('busy',?,?,?,'waiting_input','{}',0,?)")
        .bind(busyProject, thread.id, guest.user.id, new Date().toISOString()).run();
      await h.db.prepare("INSERT INTO tasks(id,project_id,run_id,user_id,tool_invocation_id,operation,slot_index,state,input,created_at,updated_at) VALUES('busy-task',?,'busy',?,'busy-tool','generate',0,'running','{}',?,?)")
        .bind(busyProject, guest.user.id, new Date().toISOString(), new Date().toISOString()).run();
      const busy = { projectId: busyProject };
      await h.db.prepare("UPDATE projects SET last_accessed_at='2000-01-01T00:00:00.000Z'").run();
      // Reading the project is a visit; background recovery/events do not extend retention.
      expect((await h.request(`/api/projects/${fresh}`, "GET", undefined, cookie)).status).toBe(200);
      const ns = await h.mf.getDurableObjectNamespace("PROJECT_ROOM");
      const expire = (id: string) => ns.get(ns.idFromName(id)).fetch("https://room/expire", { method: "POST", body: JSON.stringify({ projectId: id }) });
      expect(await (await expire(fresh)).json()).toEqual({ deleted: false });
      expect(await (await expire(busy.projectId)).json()).toEqual({ deleted: false });
      const result = await expire(expired.projectId);
      expect(result.status, await result.clone().text()).toBe(200);
      expect(await result.json()).toEqual({ deleted: true });
      expect(await (await expire(expired.projectId)).json()).toEqual({ deleted: false });
      expect(await bucket.head(assets[0].storage_key)).toBeNull();
      expect(await bucket.head(`provider-parts/${generatedTask.id}.json`)).toBeNull();
      expect(await h.db.prepare("SELECT id FROM projects WHERE id=?").bind(expired.projectId).first()).toBeNull();
      expect((await h.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE state='counted' AND kind='image'").first<any>()).n).toBe(1);
      expect((await h.request(`/api/projects/${expired.projectId}`, "GET", undefined, cookie)).status).toBe(404);
    } finally { await h.close(); }
  });
  it("保留其他访客对历史共享对象的引用，清掉陈旧waiting_input项目", async () => {
    const h = await harness();
    try {
      const a = await h.guest(), b = await h.guest();
      const make = async (cookie: string) => (await (await h.request("/api/projects", "POST", {}, cookie)).json<any>()).project.id;
      const old = await make(a.cookie), keep = await make(b.cookie);
      const bucket = await h.mf.getR2Bucket("BUCKET");
      await bucket.put("images/legacy-shared", "shared-pixels");
      for (const [asset, project, user] of [["old-asset", old, a.user.id], ["keep-asset", keep, b.user.id]])
        await h.db.prepare("INSERT INTO assets VALUES(?,?,?,'images/legacy-shared','image/png',13,'test-hash',1,1,?)").bind(asset, user, project, new Date().toISOString()).run();
      const thread = await h.db.prepare("SELECT id FROM threads WHERE project_id=?").bind(old).first<any>();
      await h.db.prepare("INSERT INTO runs(id,project_id,thread_id,user_id,state,frozen_submission,started_at,created_at) VALUES('stale-question',?,?,?,'waiting_input','{}',0,'2000-01-01')").bind(old, thread.id, a.user.id).run();
      await h.db.prepare("UPDATE projects SET last_accessed_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(old).run();
      const ns = await h.mf.getDurableObjectNamespace("PROJECT_ROOM");
      const response = await ns.get(ns.idFromName(old)).fetch("https://room/expire", { method: "POST", body: JSON.stringify({ projectId: old }) });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({ deleted: true });
      expect(await bucket.head("images/legacy-shared")).not.toBeNull();
      expect((await h.request("/api/assets/keep-asset", "GET", undefined, b.cookie)).status).toBe(200);
      expect((await h.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await h.close(); }
  });

});
