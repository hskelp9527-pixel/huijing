import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { WebSocket } from "ws";
const origin = process.env.SMOKE_ORIGIN || "http://127.0.0.1:8787";
const directory = new URL("../../../docs/evidence/be-m1/", import.meta.url);
await mkdir(directory, { recursive: true });
const started = Date.now();
let cookie;
const events = [];
let ws;
let sequence = 0;
const settings = {
  count: 1,
  quality: process.env.SMOKE_QUALITY || "standard",
  modelId: process.env.SMOKE_MODEL_ID || "auto",
};
const statePath = new URL("../.local/smoke-state.json", import.meta.url);
async function request(path, method = "GET", body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}
async function until(test, timeout = 360000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await test();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("等待事件超时");
}
try {
  const resume = process.argv.includes("--resume")
    ? JSON.parse(await readFile(statePath, "utf8"))
    : null;
  if (resume) cookie = resume.cookie;
  else {
    const auth = await request("/api/me");
    cookie = auth.headers.get("set-cookie")?.split(";")[0];
  }
  const capabilities = await (await request("/api/capabilities")).json();
  if (capabilities.mode !== "vertex")
    throw new Error("真实冒烟必须为 vertex 模式");
  const first =
    resume?.first ||
    (await (
      await request("/api/projects/start", "POST", {
        submissionId: crypto.randomUUID(),
        parts: [{ type: "text", text: "生成一张红色陶瓷杯，灰色背景" }],
        settings,
        references: [],
        settingsExplicitKeys: [],
      })
    ).json());
  if (resume) {
    Object.assign(settings, resume.settings);
    const history = await (
      await request(`/api/threads/${first.threadId}/messages`)
    ).json();
    const oldRun = history.runs.find((r) => r.id === first.runId);
    if (oldRun?.state === "failed") {
      const task = history.tasks.find(
        (t) => t.runId === first.runId && t.state === "failed",
      );
      if (!task) throw new Error("没有可手动重试的首轮任务");
      first.runId = (
        await (
          await request(`/api/tasks/${task.id}/retry`, "POST", {
            clientOperationId: crypto.randomUUID(),
          })
        ).json()
      ).runId;
      await writeFile(statePath, JSON.stringify({ cookie, first, settings }), {
        mode: 0o600,
      });
    }
  }
  if (!resume)
    await writeFile(statePath, JSON.stringify({ cookie, first, settings }), {
      mode: 0o600,
    });
  ws = new WebSocket(
    `${origin.replace(/^http/, "ws")}/api/projects/${first.projectId}/ws?cursor=0`,
    { headers: { cookie } },
  );
  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.seq > sequence) {
      sequence = event.seq;
      events.push(event);
    }
  });
  const firstArtifact = await until(() => {
    const failed = events.find(
      (e) =>
        e.runId === first.runId &&
        e.type === "run.state" &&
        e.payload.state === "failed",
    );
    if (failed) throw new Error(`首轮失败: ${JSON.stringify(failed.payload)}`);
    return events.find(
      (e) => e.runId === first.runId && e.type === "artifact.committed",
    );
  });
  await until(() =>
    events.some(
      (e) =>
        e.runId === first.runId &&
        e.type === "run.state" &&
        e.payload.state === "completed",
    ),
  );
  const firstMs = Date.now() - started;
  const red = firstArtifact.payload.artifact.asset;
  await writeFile(
    new URL(`red-cup.${red.mime === "image/jpeg" ? "jpg" : "png"}`, directory),
    Buffer.from(await (await request(red.url)).arrayBuffer()),
  );
  const secondStarted = Date.now();
  const second = await (
    await request(`/api/threads/${first.threadId}/messages`, "POST", {
      clientMessageId: crypto.randomUUID(),
      parts: [{ type: "text", text: "把杯子改成蓝色" }],
      references: [],
      settings,
      settingsExplicitKeys: [],
    })
  ).json();
  const secondArtifact = await until(() => {
    const failed = events.find(
      (e) =>
        e.runId === second.runId &&
        e.type === "run.state" &&
        e.payload.state === "failed",
    );
    if (failed) throw new Error(`编辑失败: ${JSON.stringify(failed.payload)}`);
    return events.find(
      (e) => e.runId === second.runId && e.type === "artifact.committed",
    );
  });
  await until(() =>
    events.some(
      (e) =>
        e.runId === second.runId &&
        e.type === "run.state" &&
        e.payload.state === "completed",
    ),
  );
  const images = [];
  for (const [index, event] of [firstArtifact, secondArtifact].entries()) {
    const asset = event.payload.artifact.asset;
    const extension =
      asset.mime === "image/jpeg"
        ? "jpg"
        : asset.mime === "image/webp"
          ? "webp"
          : "png";
    const name = `${index === 0 ? "red-cup" : "blue-cup"}.${extension}`;
    await writeFile(
      new URL(name, directory),
      Buffer.from(await (await request(asset.url)).arrayBuffer()),
    );
    images.push({ file: name, ...asset });
  }
  const project = await (
    await request(`/api/projects/${first.projectId}`)
  ).json();
  if (
    project.canvas.elements.filter((e) => e.type === "image" && !e.isDeleted)
      .length !== 2
  )
    throw new Error("画布图片数量不是2");
  await writeFile(
    new URL("canvas.json", directory),
    JSON.stringify(project.canvas, null, 2),
  );
  await writeFile(
    new URL("smoke-summary.json", directory),
    JSON.stringify(
      {
        ok: true,
        settings,
        startedAt: new Date(started).toISOString(),
        totalMs: Date.now() - started,
        firstMs,
        editMs: Date.now() - secondStarted,
        projectId: first.projectId,
        runIds: [first.runId, second.runId],
        images,
        eventTypes: events.map((e) => e.type),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ok: true,
      totalMs: Date.now() - started,
      firstMs,
      editMs: Date.now() - secondStarted,
      images: images.map((i) => i.file),
    }),
  );
  await rm(statePath, { force: true });
} catch (error) {
  await writeFile(
    new URL("smoke-summary.json", directory),
    JSON.stringify(
      { ok: false, totalMs: Date.now() - started, error: error.message },
      null,
      2,
    ),
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  ws?.close();
  await writeFile(
    new URL("events.ndjson", directory),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
}
