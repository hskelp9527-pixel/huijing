import http from "node:http";
// Fixed upstream, fixed method/path, loopback only. This is not a general URL proxy.
// Set HTTPS_PROXY in the launching environment when a local proxy is needed.
http
  .createServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      !/^\/v1\/publishers\/google\/models\/[a-zA-Z0-9._-]+:generateContent$/.test(
        req.url || "",
      )
    ) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    let length = 0;
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 30 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const upstream = await fetch(
        `https://aiplatform.googleapis.com${req.url}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": req.headers["x-goog-api-key"] || "",
          },
          body: Buffer.concat(chunks),
          signal: AbortSignal.timeout(190000),
          redirect: "error",
        },
      );
      res.writeHead(upstream.status, {
        "content-type": "application/json",
        ...(upstream.headers.has("retry-after")
          ? { "retry-after": upstream.headers.get("retry-after") }
          : {}),
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      res
        .writeHead(502)
        .end('{"error":{"message":"upstream transport failed"}}');
    }
  })
  .listen(8790, "127.0.0.1", () =>
    console.log(
      "Vertex 开发转发就绪：127.0.0.1:8790（固定上游；不记录请求头和正文）",
    ),
  );
