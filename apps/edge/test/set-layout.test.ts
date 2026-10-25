import { expect, it } from "vitest";
import { SET_TEMPLATES, gateRequestSchema, setTemplateSchema } from "@loomic/shared/edge";
import { frameElement } from "../src/room/set-canvas";
import type { SetRecord, ShotRecord } from "../src/sets";
it("新增8张9:16模板只需数据，批量额度接纳且两行frame不相交", () => {
  const template = setTemplateSchema.parse({ ...SET_TEMPLATES[0], id: "data-only-template", shots: Array.from({ length: 8 }, (_, index) => ({ ...SET_TEMPLATES[0].shots[0], id: String(index), aspectRatio: "9:16" })) });
  expect(gateRequestSchema.safeParse({ id: "test", ids: template.shots.map(shot => shot.id) }).success).toBe(true);
  const set: SetRecord = { id: "set", project_id: "project", thread_id: "thread", run_id: "run", user_id: "user", template_id: template.id,
    template: JSON.stringify(template), source_asset_ids: "[]", note: "", lang: "en", state: "analyzing", analysis: null, supplied_points: null, analysis_started_at: null, error: null, single_regenerations: 0 };
  const frames = template.shots.map((shot, ordinal) => {
    const row: ShotRecord = { set_id: set.id, shot_id: shot.id, ordinal, task_id: `task-${ordinal}`, frame_element_id: `frame-${ordinal}`, image_element_id: null, text_element_ids: "[]" };
    return frameElement(set, row, shot);
  });
  expect(frames).toHaveLength(8);
  for (const top of frames.slice(0, 4)) for (const bottom of frames.slice(4)) expect(bottom.y).toBeGreaterThan(top.y + top.height);
});
