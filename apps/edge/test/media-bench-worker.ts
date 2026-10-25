// Test-only DO exercises the real Worker WASM codecs and expansion pipeline.
import app, { ProjectRoom as BaseRoom, ProviderGate } from "../src/index";
import { decodePixels, encodePixels } from "../src/images";
import { expanded, restoreMedia } from "../src/media-pixels";
import type { Env } from "../src/types";
import { init as initPNG } from "@jsquash/png/decode.js";
export { ProviderGate };
export class ProjectRoom extends BaseRoom {
  override async fetch(request: Request) {
    if (new URL(request.url).pathname !== "/bench") return super.fetch(request);
    const { side, outputWidth, outputHeight, fit } = await request.json() as { side: number; outputWidth: number; outputHeight: number; fit: boolean };
    const data = new Uint8ClampedArray(side * side * 4);
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) data.set([x % 256, y % 256, (x + y) % 256, 255], (y * side + x) * 4);
    const source = { width: side, height: side, data, mime: "image/png" };
    const margins = { left: 0, top: 0, right: outputWidth - side, bottom: outputHeight - side };
    const input = expanded(source, margins);
    const encoded = await encodePixels(input);
    const generated = fit ? await encodePixels(source) : encoded;
    const restored = await restoreMedia({ op: "expand", params: { margin: margins } } as any, { source, input, mask: undefined, references: [] }, generated, "image/png");
    source.data = new Uint8ClampedArray(0);
    input.data = new Uint8ClampedArray(0);
    const decoded = await decodePixels(restored.bytes);
    // An awaited storage write advances the Worker clock after synchronous CPU work.
    await this.ctx.storage.put("bench", decoded.width);
    const module = await initPNG() as unknown as { memory: WebAssembly.Memory };
    return Response.json({ width: decoded.width, height: decoded.height, pngBytes: restored.bytes.length, pngWasmMemoryBytes: module.memory.buffer.byteLength, lastSourcePixel: [...decoded.data.subarray(((side - 1) * decoded.width + side - 1) * 4, ((side - 1) * decoded.width + side - 1) * 4 + 4)] });
  }
}
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/bench") return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName("bench")).fetch(request);
    return app.fetch(request, env, ctx);
  },
};
