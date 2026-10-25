import { describe, it, expect } from "vitest";
import { harness, submission, until } from "./harness";
import { readFile } from "node:fs/promises";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
);
describe("resources and security boundaries", () => {
  it("上传解码、SHA256 去重、草稿快照认领、跨用户资源拒绝、MIME伪造和损坏图片拒绝", async () => {
    const h = await harness();
    try {
      const a = await h.guest(),
        b = await h.guest();
      async function upload(data: Uint8Array, mime = "image/png") {
        const form = new FormData();
        form.append("file", new File([data], "image.png", { type: mime }));
        const encoded = new Request("https://app.test", {
          method: "POST",
          body: form,
        });
        return h.mf.dispatchFetch("https://app.test/api/uploads", {
          method: "POST",
          headers: {
            cookie: a.cookie,
            "content-type": encoded.headers.get("content-type")!,
          },
          body: new Uint8Array(await encoded.arrayBuffer()),
        });
      }
      const r = await upload(png);
      expect(r.status, await r.clone().text()).toBe(201);
      const asset = ((await r.json()) as any).asset;
      expect(asset.width).toBe(1);
      expect(asset.height).toBe(1);
      expect(((await (await upload(png)).json()) as any).asset.id).toBe(
        asset.id,
      );
      expect(
        (await h.request(`/api/assets/${asset.id}`, "GET", undefined, b.cookie))
          .status,
      ).toBe(403);
      expect((await upload(png, "image/jpeg")).status).toBe(422);
      expect((await upload(png.subarray(0, 25))).status).toBe(422);
      for (const [file, mime] of [
        ["sample.jpg", "image/jpeg"],
        ["sample.webp", "image/webp"],
      ]) {
        const result = await upload(
          await readFile(`test/fixtures/${file}`),
          mime,
        );
        expect(result.status, await result.clone().text()).toBe(201);
        const image = ((await result.json()) as any).asset;
        expect(image.mime).toBe(mime);
        expect([image.width, image.height]).toEqual([12, 7]);
      }
      const snapRequest = { sourceAssetId: asset.id, renderKey: "test-render" };
      const concurrent = await Promise.all([
        h.request(
          "/api/snapshots",
          "POST",
          { ...snapRequest, renderKey: "parallel-render" },
          a.cookie,
        ),
        h.request(
          "/api/snapshots",
          "POST",
          { ...snapRequest, renderKey: "parallel-render" },
          a.cookie,
        ),
      ]);
      expect(concurrent.every((r) => r.status < 300)).toBe(true);
      expect((await concurrent[0].json<any>()).snapshot.id).toBe(
        (await concurrent[1].json<any>()).snapshot.id,
      );
      const snapshot = (
        await (
          await h.request("/api/snapshots", "POST", snapRequest, a.cookie)
        ).json<any>()
      ).snapshot;
      expect(
        (await h.request("/api/snapshots", "POST", snapRequest, a.cookie))
          .status,
      ).toBe(200);
      expect(
        (
          await h.request(
            "/api/snapshots",
            "POST",
            { ...snapRequest, appearance: { flipX: true } },
            a.cookie,
          )
        ).status,
      ).toBe(422);
      const body = {
        ...submission("生成一张杯子", 1),
        references: [{ snapshotId: snapshot.id, purpose: "subject", order: 0 }],
      };
      const s = await (
        await h.request("/api/projects/start", "POST", body, a.cookie)
      ).json<any>();
      expect(
        (
          await h.db
            .prepare("SELECT project_id FROM assets WHERE id=?")
            .bind(asset.id)
            .first<any>()
        ).project_id,
      ).toBe(s.projectId);
      const forbidden = await h.request(
        "/api/projects/start",
        "POST",
        { ...body, submissionId: crypto.randomUUID() },
        b.cookie,
      );
      expect(forbidden.status).toBe(403);
      await until(
        () =>
          h.db
            .prepare("SELECT state FROM runs WHERE id=?")
            .bind(s.runId)
            .first<any>(),
        (r) => r.state === "completed",
      );
    } finally {
      await h.close();
    }
  });
  it("同源检查、无开放代理/URL抓取工具", async () => {
    const h = await harness();
    try {
      const { cookie } = await h.guest();
      expect(
        (
          await h.request("/api/projects", "POST", {}, cookie, {
            Origin: "https://evil.example",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await h.request(
            "/api/proxy-image?url=http://169.254.169.254",
            "GET",
            undefined,
            cookie,
          )
        ).status,
      ).toBe(404);
    } finally {
      await h.close();
    }
  });
  it("4 张图在图片并发上限2下全部完成", async () => {
    const h = await harness();
    try {
      const { cookie } = await h.guest();
      const s = await (
        await h.request(
          "/api/projects/start",
          "POST",
          submission("生成四张图 [fixture:delay=100]", 4),
          cookie,
        )
      ).json<any>();
      const run = await until(
        () =>
          h.db
            .prepare("SELECT * FROM runs WHERE id=?")
            .bind(s.runId)
            .first<any>(),
        (r) => ["completed", "failed"].includes(r.state),
      );
      expect(run.state, run.error).toBe("completed");
      expect(
        (
          await h.db
            .prepare("SELECT COUNT(*) n FROM insertions WHERE project_id=?")
            .bind(s.projectId)
            .first<any>()
        ).n,
      ).toBe(4);
    } finally {
      await h.close();
    }
  });
  it("未知提交不会自动重提；手动重试新 taskId、相同操作 ID 幂等", async () => {
    const h = await harness();
    try {
      const { cookie } = await h.guest();
      const s = await (
        await h.request(
          "/api/projects/start",
          "POST",
          submission("生成一张图 [fixture:unknown]", 1),
          cookie,
        )
      ).json<any>();
      await until(
        () =>
          h.db
            .prepare("SELECT * FROM runs WHERE id=?")
            .bind(s.runId)
            .first<any>(),
        (r) => r.state === "failed",
      );
      const task = await h.db
        .prepare("SELECT * FROM tasks WHERE run_id=?")
        .bind(s.runId)
        .first<any>();
      expect(JSON.parse(task.error).code).toBe("PROVIDER_SUBMIT_UNKNOWN");
      expect(
        (
          await h.db
            .prepare("SELECT state FROM submit_intents WHERE task_id=?")
            .bind(task.id)
            .first<any>()
        ).state,
      ).toBe("unknown");
      const key = { clientOperationId: crypto.randomUUID() };
      const a = await (
        await h.request(`/api/tasks/${task.id}/retry`, "POST", key, cookie)
      ).json<any>();
      const b = await (
        await h.request(`/api/tasks/${task.id}/retry`, "POST", key, cookie)
      ).json<any>();
      expect(a).toEqual(b);
      expect(a.taskId).not.toBe(task.id);
      await until(
        () =>
          h.db
            .prepare("SELECT * FROM runs WHERE id=?")
            .bind(a.runId)
            .first<any>(),
        (r) => r.state === "failed",
      );
      expect(
        (
          await h.db
            .prepare("SELECT COUNT(*) n FROM tasks WHERE retry_of_task_id=?")
            .bind(task.id)
            .first<any>()
        ).n,
      ).toBe(1);
    } finally {
      await h.close();
    }
  });
});
