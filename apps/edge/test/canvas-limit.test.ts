import { expect, it } from "vitest";
import { MAX_PROJECT_ELEMENTS } from "@loomic/shared/edge";
import { harness } from "./harness";

it("项目元素总量D1统一限额；到达上限仍允许修改既有元素，新增整批回滚", async () => {
  const h = await harness();
  try {
    const { cookie } = await h.guest();
    const project = (await (await h.request("/api/projects", "POST", {}, cookie)).json<any>()).project;
    const elements = Array.from({ length: MAX_PROJECT_ELEMENTS }, (_,i) => ({
      id: `element-${i}`, type: "rectangle", x: i, y: 0, width: 1, height: 1, version: 1,
    }));
    await h.db.prepare("UPDATE projects SET canvas=? WHERE id=?").bind(JSON.stringify({ revision: 0, elements, files: {} }), project.id).run();
    const path = `/api/projects/${project.id}/canvas/ops`;
    const denied = await h.request(path, "POST", { clientOpId: "over", baseRevision: 0, ops: [
      { kind: "upsert", element: { ...elements[0], x: 999 } },
      { kind: "upsert", element: { ...elements[0], id: "one-more" } },
    ] }, cookie);
    expect(denied.status).toBe(422);
    expect((await denied.json<any>()).error.code).toBe("CANVAS_LIMIT_EXCEEDED");
    const read = await (await h.request(`/api/projects/${project.id}`, "GET", undefined, cookie)).json<any>();
    expect(read.canvas.elements).toHaveLength(MAX_PROJECT_ELEMENTS);
    expect(read.canvas.elements[0].x).toBe(0);
    expect(read.canvas.revision).toBe(0);
    const modified = await h.request(path, "POST", { clientOpId: "modify", baseRevision: 0, ops: [{ kind: "upsert", element: { ...elements[0], x: 10 } }] }, cookie);
    expect(modified.status, await modified.clone().text()).toBe(200);
    // D1 trigger also blocks non-HTTP writers (Agent and Task commit use this same table).
    await expect(h.db.prepare("UPDATE projects SET canvas=? WHERE id=?").bind(JSON.stringify({ revision: 2, elements: [...elements, { ...elements[0], id: "extra" }], files: {} }), project.id).run()).rejects.toThrow("project_canvas_limit");
  } finally { await h.close(); }
});
