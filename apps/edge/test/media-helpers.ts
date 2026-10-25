import { deflateSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import decodePNG, { init } from "@jsquash/png/decode.js";
import { expect, vi } from "vitest";
import type { harness } from "./harness";
export type Harness = Awaited<ReturnType<typeof harness>>;
export function png(width: number, height: number, pixels?: number[]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      rows.set(
        pixels?.slice((y * width + x) * 4, (y * width + x + 1) * 4) || [
          x * 30,
          y * 40,
          70,
          x === 3 && y === 2 ? 117 : 255,
        ],
        y * (1 + width * 4) + 1 + x * 4,
      );
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function chunk(name: string, bytes: Buffer) {
  const body = Buffer.concat([Buffer.from(name), bytes]);
  let crc = 0xffffffff;
  for (const value of body) {
    crc ^= value;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length);
  body.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}
export async function pixels(bytes: ArrayBuffer) {
  vi.stubGlobal(
    "ImageData",
    class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    },
  );
  await init(await readFile(resolve("node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm")));
  return (await decodePNG(bytes)) as { width: number; height: number; data: Uint8ClampedArray };
}
export async function upload(
  h: Harness,
  cookie: string,
  projectId: string,
  bytes = png(4, 3),
  mime = "image/png",
) {
  const form = new FormData();
  form.set("projectId", projectId);
  form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), "image");
  const r = await postForm(h, cookie, form);
  expect(r.status, await r.clone().text()).toBe(201);
  return ((await r.json()) as { asset: { id: string; width: number; height: number } }).asset;
}
export async function source(h: Harness, cookie: string, bytes = png(4, 3)) {
  const { project } = await (await h.request("/api/projects", "POST", {}, cookie)).json<{
    project: { id: string };
  }>();
  const asset = await upload(h, cookie, project.id, bytes);
  const { snapshot } = await (
    await h.request(
      "/api/snapshots",
      "POST",
      { sourceAssetId: asset.id, projectId: project.id, renderKey: crypto.randomUUID() },
      cookie,
    )
  ).json<{ snapshot: { id: string } }>();
  const elementId = `element-${crypto.randomUUID()}`;
  expect(
    (
      await h.request(
        `/api/projects/${project.id}/canvas/ops`,
        "POST",
        {
          clientOpId: crypto.randomUUID(),
          baseRevision: 0,
          ops: [
            {
              kind: "upsert",
              element: {
                id: elementId,
                type: "image",
                x: 0,
                y: 0,
                width: 240,
                height: 180,
                version: 1,
                fileId: asset.id,
              },
            },
          ],
        },
        cookie,
      )
    ).status,
  ).toBe(200);
  return { projectId: project.id, source: { elementId, snapshotId: snapshot.id }, asset };
}

export async function postForm(h: Harness, cookie: string, form: FormData) {
  const encoded = new Request("https://app.test", { method: "POST", body: form });
  return h.mf.dispatchFetch("https://app.test/api/uploads", {
    method: "POST",
    headers: { cookie, "content-type": encoded.headers.get("content-type")! },
    body: new Uint8Array(await encoded.arrayBuffer()),
  });
}
