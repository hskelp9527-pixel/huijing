// Invoked by deploy.mjs only for an actual deployment. Credentials come from
// this child process's environment; its stdout contains public resource IDs only.
import { pathToFileURL } from "node:url";

export async function ensureResources(names, env, request = fetch) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(account || "") || !token)
    throw new Error("Cloudflare 凭据缺失或账号 ID 格式无效");
  for (const name of Object.values(names))
    if (!/^[a-z0-9-]{3,63}$/.test(name)) throw new Error("资源名称无效");
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  async function api(path, method = "GET", body, allowMissing = false) {
    const response = await request(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (allowMissing && response.status === 404) return null;
    // Never print API bodies, headers or token-bearing request errors.
    if (!response.ok) throw new Error(`Cloudflare ${method} ${path.split("?")[0]}: HTTP ${response.status}`);
    const data = await response.json();
    if (!data.success) throw new Error("Cloudflare 资源请求失败（未记录响应正文）");
    return data;
  }
  async function find(path, field, name) {
    for (let page = 1; page <= 10000; page++) {
      const data = await api(`${path}?page=${page}&per_page=100`);
      if (!Array.isArray(data.result)) throw new Error("Cloudflare 列表格式无效");
      const matches = data.result.filter((item) => item[field] === name);
      if (matches.length > 1) throw new Error("资源重名，无法唯一匹配");
      if (matches.length) return matches[0];
      if (data.result.length < 100 || page >= (data.result_info?.total_pages ?? Infinity)) return null;
    }
    throw new Error("Cloudflare 列表超出分页上限");
  }
  // Failed queries abort; authorization failures must never be treated as absence.
  let database = await find("/d1/database", "name", names.database);
  let bucket = (await api(`/r2/buckets/${names.bucket}`, "GET", undefined, true))?.result;
  let queue = await find("/queues", "queue_name", names.queue);
  // On a concurrent-create conflict, re-read once; never silently create replacements.
  async function create(path, body, reread) {
    try { return (await api(path, "POST", body)).result; }
    catch (error) {
      const existing = await reread();
      if (!existing) throw error;
      return existing;
    }
  }
  database ??= await create("/d1/database", { name: names.database }, () => find("/d1/database", "name", names.database));
  bucket ??= await create("/r2/buckets", { name: names.bucket }, async () =>
    (await api(`/r2/buckets/${names.bucket}`, "GET", undefined, true))?.result);
  queue ??= await create("/queues", { queue_name: names.queue }, () => find("/queues", "queue_name", names.queue));
  if (!/^[a-f0-9-]{36}$/i.test(database.uuid || "") || !queue.queue_id || bucket.name !== names.bucket)
    throw new Error("Cloudflare 返回的资源 ID 无效");
  return { databaseId: database.uuid, bucketName: bucket.name, queueId: queue.queue_id, queueName: queue.queue_name };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] !== "--apply") throw new Error("资源准备需要显式 --apply");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify(await ensureResources(JSON.parse(input), process.env)));
  } catch {
    // The parent reports the failed step; no raw fetch exception can escape here.
    console.error("Cloudflare 资源准备失败；请检查资源权限和账号状态。未输出凭据或响应正文。");
    process.exitCode = 1;
  }
}
