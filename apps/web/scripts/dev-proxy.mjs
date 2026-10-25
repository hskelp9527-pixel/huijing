// 本地联调：把 /api/*（含 WebSocket）代理到本机 `wrangler dev`（默认 127.0.0.1:8787），其余请求交给 Next 开发服务器。
// 浏览器只看到 http://localhost:3000 一个源，所以后端的同源 Origin 检查和 HttpOnly cookie 都照常工作。
//   终端 1：pnpm dev:edge                 （后端；真实模型加 --var PROVIDER_MODE:vertex，见 docs/接口.md）
//   终端 2：pnpm --filter @loomic/web dev:http
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.PORT ?? 3000);
const NEXT_PORT = Number(process.env.NEXT_INTERNAL_PORT ?? PORT + 1);
const API = new URL(process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8787");

const next = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "-p", String(NEXT_PORT)],
  {
    stdio: "inherit",
    env: { ...process.env, NEXT_PUBLIC_API_MODE: "http" },
  },
);
next.on("exit", (code) => process.exit(code ?? 0));

const targetFor = (url = "") =>
  url.startsWith("/api/")
    ? { host: API.hostname, port: Number(API.port || 80) }
    : { host: "127.0.0.1", port: NEXT_PORT };

const server = http.createServer((req, res) => {
  const t = targetFor(req.url);
  // 保持原始 Host/Origin，后端据此做同源校验
  const up = http.request(
    { ...t, method: req.method, path: req.url, headers: req.headers },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", (e) => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      `代理失败：${t.host}:${t.port} 不可达（${e.message}）。后端 wrangler dev 是否已启动？`,
    );
  });
  req.pipe(up);
});

server.on("upgrade", (req, socket, head) => {
  const t = targetFor(req.url);
  const up = net.connect(t.port, t.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
});

server.listen(PORT, () =>
  console.log(
    `[dev-proxy] http://localhost:${PORT}  →  /api/* → ${API.origin}，其余 → Next(:${NEXT_PORT})`,
  ),
);
for (const sig of ["SIGINT", "SIGTERM"])
  process.on(sig, () => {
    next.kill();
    process.exit(0);
  });
