import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mediaResultResponseSchema, taskDetailResponseSchema } from "@loomic/shared/edge";
import { harness, until } from "./harness";
import { pixels, png, source, upload, postForm, type Harness } from "./media-helpers";
describe("媒体操作与浏览器登记", () => {
  let h: Harness, cookie: string, other: string;
  beforeAll(async () => {
    h = await harness();
    cookie = (await h.guest()).cookie;
    other = (await h.guest()).cookie;
  });
  afterAll(async () => {
    await h.close();
  });
  async function task(taskId: string) {
    return until(
      async () =>
        taskDetailResponseSchema.parse(
          await (await h.request(`/api/tasks/${taskId}`, "GET", undefined, cookie)).json(),
        ),
      (r) => ["committed", "failed"].includes(r.state),
    );
  }
  it.each([
    ["edit", { prompt: "把主体改为蓝色" }],
    [
      "replace_text",
      { regions: [{ x: 0, y: 0, width: 3, height: 2, text: "原文", newText: "新文字" }] },
    ],
    ["multiview", { azimuth: 45, elevation: 10 }],
    [
      "move_object",
      { srcBox: { x: 0, y: 0, width: 2, height: 2 }, dstBox: { x: 2, y: 1, width: 2, height: 2 } },
    ],
  ])("%s 产物记录来源并只插入一次", async (op, params) => {
    const s = await source(h, cookie);
    const body = {
      clientOpId: crypto.randomUUID(),
      projectId: s.projectId,
      source: s.source,
      op,
      params,
    };
    const r = await h.request("/api/media/ops", "POST", body, cookie);
    expect(r.status, await r.clone().text()).toBe(201);
    const response = await r.json<{ taskId: string; runId: string; threadId: string }>();
    const { taskId } = response;
    expect(response.runId).toMatch(/^run_/);
    expect(response.threadId).toMatch(/^thread_/);
    expect(await (await h.request("/api/media/ops", "POST", body, cookie)).json()).toEqual(response);
    const result = await task(taskId);
    expect(result.state, JSON.stringify(result.error)).toBe("committed");
    expect(result.artifact?.provenance).toMatchObject({
      sourceSnapshotId: s.source.snapshotId,
      op,
      params,
    });
    expect(result.artifact?.modelId).toBe("fixture");
    const project = await (
      await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)
    ).json<{ canvas: { elements: unknown[] } }>();
    expect(project.canvas.elements).toHaveLength(2);
    if (op === "replace_text") {
      const row = await h.db
        .prepare("SELECT input FROM tasks WHERE id=?")
        .bind(taskId)
        .first<{ input: string }>();
      expect(JSON.parse(row!.input).prompt).toContain('"originalText":"原文"');
      expect(JSON.parse(row!.input).prompt).toContain('"x":0');
    }
  });
  it("expand 先扩画布，输出原区域 RGBA 逐字节相同", async () => {
    const s = await source(h, cookie);
    const r = await h.request(
      "/api/media/ops",
      "POST",
      {
        clientOpId: crypto.randomUUID(),
        projectId: s.projectId,
        source: s.source,
        op: "expand",
        params: { margin: { left: 2, right: 1, top: 1, bottom: 2 } },
      },
      cookie,
    );
    expect(r.status, await r.clone().text()).toBe(201);
    const result = await task((await r.json<{ taskId: string }>()).taskId);
    expect(result.state, JSON.stringify(result.error)).toBe("committed");
    const output = await pixels(
      await (await h.request(result.artifact!.asset!.url, "GET", undefined, cookie)).arrayBuffer(),
    );
    const original = await pixels(new Uint8Array(png(4, 3)).buffer);
    expect([output.width, output.height]).toEqual([7, 6]);
    for (let y = 0; y < 3; y++)
      expect([...output.data.slice(((y + 1) * 7 + 2) * 4, ((y + 1) * 7 + 6) * 4)]).toEqual([
        ...original.data.slice(y * 16, y * 16 + 16),
      ]);
    expect([...output.data.slice(0, 4)]).toEqual([255, 0, 255, 255]);
  });
  it("erase_ai 仅 mask 白色区改变，非 mask 保留原 RGBA", async () => {
    const s = await source(h, cookie),
      maskPixels = Array(48).fill(0);
    maskPixels.splice(0, 4, 255, 255, 255, 255);
    const mask = await upload(h, cookie, s.projectId, png(4, 3, maskPixels));
    const r = await h.request(
      "/api/media/ops",
      "POST",
      {
        clientOpId: crypto.randomUUID(),
        projectId: s.projectId,
        source: s.source,
        op: "erase_ai",
        params: { maskAssetId: mask.id },
      },
      cookie,
    );
    expect(r.status, await r.clone().text()).toBe(201);
    const result = await task((await r.json<{ taskId: string }>()).taskId);
    expect(result.state, JSON.stringify(result.error)).toBe("committed");
    const output = await pixels(
      await (await h.request(result.artifact!.asset!.url, "GET", undefined, cookie)).arrayBuffer(),
    );
    const original = await pixels(new Uint8Array(png(4, 3)).buffer);
    expect([...output.data.slice(4)]).toEqual([...original.data.slice(4)]);
    expect([...output.data.slice(0, 4)]).toEqual([255, 0, 255, 255]);
  });
  it("越界参数、超限扩图、异主快照和遮罩均拒绝", async () => {
    const s = await source(h, cookie),
      foreign = await source(h, other);
    const base = { clientOpId: crypto.randomUUID(), projectId: s.projectId, source: s.source };
    for (const extra of [
      {
        op: "move_object",
        params: {
          srcBox: { x: 3, y: 0, width: 2, height: 2 },
          dstBox: { x: 0, y: 0, width: 2, height: 2 },
        },
      },
      { op: "expand", params: { margin: { top: 4096, bottom: 0, left: 0, right: 0 } } },
      { op: "erase_ai", params: { maskAssetId: foreign.asset.id } },
      { source: foreign.source, op: "edit", params: { prompt: "编辑" } },
    ]) {
      const r = await h.request("/api/media/ops", "POST", { ...base, ...extra }, cookie);
      expect([403, 404, 422]).toContain(r.status);
      if (extra.op === "expand")
        expect((await r.json<{ error: { code: string } }>()).error.code).toBe(
          "MEDIA_LIMIT_EXCEEDED",
        );
    }
  });
  it("同用户跨项目结果和尺寸错误遮罩拒绝", async () => {
    const s = await source(h, cookie),
      otherProject = await source(h, cookie);
    const r = await h.request(
      "/api/media/client-results",
      "POST",
      {
        clientOpId: crypto.randomUUID(),
        projectId: s.projectId,
        sourceSnapshotId: s.source.snapshotId,
        op: "erase",
        params: {},
        engine: { name: "lama", version: "1", modelSha256: "a".repeat(64) },
        result: { assetId: otherProject.asset.id },
      },
      cookie,
    );
    expect(r.status).toBe(403);
    const mask = await upload(h, cookie, s.projectId, png(3, 3));
    const erased = await h.request(
      "/api/media/ops",
      "POST",
      {
        clientOpId: crypto.randomUUID(),
        projectId: s.projectId,
        source: s.source,
        op: "erase_ai",
        params: { maskAssetId: mask.id },
      },
      cookie,
    );
    expect(erased.status).toBe(422);
  });
  const engine = { name: "browser", version: "1.0", modelSha256: "a".repeat(64) };
  async function client(
    s: Awaited<ReturnType<typeof source>>,
    op: string,
    result: unknown,
    clientOpId = crypto.randomUUID(),
  ) {
    return h.request(
      "/api/media/client-results",
      "POST",
      {
        clientOpId,
        projectId: s.projectId,
        sourceSnapshotId: s.source.snapshotId,
        op,
        params: {},
        engine,
        result,
      },
      cookie,
    );
  }
  it.each(["remove_bg", "erase", "upscale", "ocr", "vectorize"])(
    "浏览器 %s 登记、来源链、画布和额度",
    async (op) => {
      const s = await source(h, cookie);
      let result: unknown = { assetId: s.asset.id };
      if (op === "upscale")
        result = { assetId: (await upload(h, cookie, s.projectId, png(8, 6))).id };
      if (op === "ocr")
        result = { ocrRegions: [{ x: 0, y: 0, width: 3, height: 2, text: "原文" }] };
      if (op === "vectorize")
        result = {
          svgAssetId: (
            await upload(
              h,
              cookie,
              s.projectId,
              Buffer.from(
                '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><path d="M0 0L4 3" fill="#fff"/></svg>',
              ),
              "image/svg+xml",
            )
          ).id,
        };
      const before = await (await h.request("/api/me", "GET", undefined, cookie)).json<{
        quota: { used: number };
      }>();
      const key = crypto.randomUUID(),
        r = await client(s, op, result, key);
      expect(r.status, await r.clone().text()).toBe(201);
      const registered = mediaResultResponseSchema.parse(await r.json());
      expect(registered.artifact.provenance).toMatchObject({
        sourceSnapshotId: s.source.snapshotId,
        op,
        engine,
      });
      expect(registered.elementIds).toHaveLength(op === "ocr" ? 0 : 1);
      expect(registered.revision).toBe(op === "ocr" ? 1 : 2);
      expect(await (await client(s, op, result, key)).json()).toEqual(registered);
      expect(
        (
          await (
            await h.request("/api/me", "GET", undefined, cookie)
          ).json<{ quota: { used: number } }>()
        ).quota.used,
      ).toBe(before.quota.used);
      const mismatch = await h.request(
        "/api/media/client-results",
        "POST",
        {
          clientOpId: key,
          projectId: s.projectId,
          sourceSnapshotId: s.source.snapshotId,
          op,
          params: { changed: true },
          engine,
          result,
        },
        cookie,
      );
      expect(mismatch.status).toBe(409);
    },
  );
  it("浏览器结果校验归属、alpha、比例、OCR 坐标与结果类型", async () => {
    const s = await source(h, cookie),
      foreign = await source(h, other);
    const badRatio = await upload(h, cookie, s.projectId, png(8, 5));
    expect((await client(s, "upscale", { assetId: badRatio.id })).status).toBe(422);
    expect((await client(s, "erase", { assetId: foreign.asset.id })).status).toBe(403);
    expect(
      (await client(s, "ocr", { ocrRegions: [{ x: 0, y: 0, width: 50, height: 1, text: "越界" }] }))
        .status,
    ).toBe(422);
    expect((await client(s, "ocr", { assetId: s.asset.id })).status).toBe(422);
    const jpeg = await upload(
      h,
      cookie,
      s.projectId,
      await import("node:fs/promises").then((fs) => fs.readFile("test/fixtures/sample.jpg")),
      "image/jpeg",
    );
    expect((await client(s, "remove_bg", { assetId: jpeg.id })).status).toBe(422);
    const form = new FormData();
    form.set(
      "file",
      new Blob(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><script>alert(1)</script></svg>',
        ],
        { type: "image/svg+xml" },
      ),
      "x.svg",
    );
    const bad = await postForm(h, cookie, form);
    expect(bad.status).toBe(422);
  });
});

describe("浏览器每日额度并发", () => {
  it("跨项目并发只接受每日上限次数，重复 ID 不计次数", async () => {
    const h = await harness({ QUOTA_CLIENT_OPS_DAILY: "1" });
    try {
      const { cookie } = await h.guest(),
        a = await source(h, cookie),
        b = await source(h, cookie);
      const bodies = [a, b].map((s) => ({
        clientOpId: crypto.randomUUID(),
        projectId: s.projectId,
        op: "ocr",
        sourceSnapshotId: s.source.snapshotId,
        params: {},
        engine: { name: "ocr", version: "1", modelSha256: "b".repeat(64) },
        result: { ocrRegions: [] },
      }));
      const responses = await Promise.all(
        bodies.map((body) => h.request("/api/media/client-results", "POST", body, cookie)),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([201, 429]);
      const accepted = responses.findIndex((r) => r.status === 201);
      expect(
        (await h.request("/api/media/client-results", "POST", bodies[accepted], cookie)).status,
      ).toBe(201);
      expect(
        (await h.db.prepare("SELECT COUNT(*) n FROM media_artifacts").first<{ n: number }>())!.n,
      ).toBe(1);
      await h.db.prepare("UPDATE client_ops SET day='2000-01-01'").run();
      expect(
        (
          await h.request(
            "/api/media/client-results",
            "POST",
            { ...bodies[accepted], clientOpId: crypto.randomUUID() },
            cookie,
          )
        ).status,
      ).toBe(201);
    } finally {
      await h.close();
    }
  });
});

describe("媒体模型结果边界", () => {
  it("消除模型尺寸变化时，适配填充不能覆盖待保留的原图缓冲区", async () => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "unit-test-placeholder" });
    try {
      const { cookie } = await h.guest(), s = await source(h, cookie);
      const maskPixels = Array(48).fill(0); maskPixels.splice(0, 4, 255, 255, 255, 255);
      const mask = await upload(h, cookie, s.projectId, png(4, 3, maskPixels));
      h.mock.get("https://aiplatform.googleapis.com").intercept({ method: "POST", path: /gemini-3-pro-image:generateContent$/ })
        .reply(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png(1, 1, [255, 0, 255, 255]).toString("base64") } }] } }] });
      const response = await h.request("/api/media/ops", "POST", { clientOpId: crypto.randomUUID(), projectId: s.projectId, source: s.source, op: "erase_ai", params: { maskAssetId: mask.id } }, cookie);
      const { taskId } = await response.json<any>();
      const result = await until(async () => (await h.request(`/api/tasks/${taskId}`, "GET", undefined, cookie)).json<any>(), r => ["failed", "committed"].includes(r.state));
      expect(result.state, JSON.stringify(result.error)).toBe("committed");
      const decoded = await pixels(await (await h.request(result.artifact.asset.url, "GET", undefined, cookie)).arrayBuffer());
      const original = await pixels(new Uint8Array(png(4, 3)).buffer);
      expect([...decoded.data.subarray(4)]).toEqual([...original.data.subarray(4)]);
      expect([...decoded.data.subarray(0, 4)]).toEqual([255, 0, 255, 255]);
    } finally { await h.close(); }
  });
  it.each([false, true])("上游尺寸不同（超限=%s）：先检查上限，再适配填充", async (oversized) => {
    const h = await harness({ PROVIDER_MODE: "vertex", VERTEX_API_KEY: "unit-test-placeholder" });
    try {
      h.mock
        .get("https://aiplatform.googleapis.com")
        .intercept({ method: "POST", path: /gemini-3-pro-image:generateContent$/ })
        .reply(200, {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: (oversized ? png(2049, 2048) : png(1, 1)).toString("base64"),
                    },
                  },
                ],
              },
            },
          ],
        });
      const { cookie } = await h.guest(),
        s = await source(h, cookie);
      const r = await h.request(
        "/api/media/ops",
        "POST",
        {
          clientOpId: crypto.randomUUID(),
          projectId: s.projectId,
          source: s.source,
          op: "expand",
          params: { margin: { left: 2, right: 1, top: 1, bottom: 2 } },
        },
        cookie,
      );
      expect(r.status, await r.clone().text()).toBe(201);
      const { taskId } = await r.json<{ taskId: string }>();
      const result = await until(
        async () =>
          taskDetailResponseSchema.parse(
            await (await h.request(`/api/tasks/${taskId}`, "GET", undefined, cookie)).json(),
          ),
        (t) => ["failed", "committed"].includes(t.state),
      );
      if (oversized) expect(result.error).toMatchObject({ code: "MEDIA_LIMIT_EXCEEDED" });
      else {
        expect(result.state, JSON.stringify(result.error)).toBe("committed");
        const output = await pixels(
          await (
            await h.request(result.artifact!.asset.url, "GET", undefined, cookie)
          ).arrayBuffer(),
        );
        expect([output.width, output.height]).toEqual([7, 6]);
        const original = await pixels(new Uint8Array(png(4, 3)).buffer);
        for (let y = 0; y < 3; y++)
          expect([...output.data.slice(((y + 1) * 7 + 2) * 4, ((y + 1) * 7 + 6) * 4)]).toEqual([
            ...original.data.slice(y * 16, y * 16 + 16),
          ]);
      }
      const project = await (
        await h.request(`/api/projects/${s.projectId}`, "GET", undefined, cookie)
      ).json<{ canvas: { elements: unknown[] } }>();
      expect(project.canvas.elements).toHaveLength(oversized ? 1 : 2);
    } finally {
      await h.close();
    }
  });
});
