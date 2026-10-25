import { gateRequestSchema } from "@loomic/shared/edge";
import { DurableObject } from "cloudflare:workers";
import { all, configuredInt, one, quota, quotaDay, stmt } from "./core";
import type { Env } from "./types";
import { imageCapacity, updateCapacity, type ImageCapacity } from "./provider-capacity";

/** All callers use idFromName("global"): admission and settlement survive worker/DO restarts. */
export class ProviderGate extends DurableObject<Env> {
  async fetch(request: Request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const data = gateRequestSchema.parse(await request.json());
      const path = new URL(request.url).pathname;
      const leases = (await this.ctx.storage.get<Record<string, { kind: string; expires: number }>>("leases")) || {};
      if (path === "/reserve-set") {
        if (!data.userId || !data.ids || new Set(data.ids).size !== data.ids.length)
          return Response.json({ error: "invalid" }, { status: 400 });
        const usage = await quota(this.env, data.userId, data.ipSubject || "local");
        if (usage.globalRemaining < data.ids.length || (data.setAdmissionId && usage.setsRemaining === 0)) return Response.json({ error: {
          code: usage.globalRemaining < data.ids.length ? "QUOTA_EXCEEDED_GLOBAL" : "QUOTA_EXCEEDED_IP",
          message: usage.globalRemaining < data.ids.length ? `整套需要 ${data.ids.length} 张额度，全站当前还能生成 ${usage.globalRemaining} 张` : "此 IP 今日套图额度已用尽，请明日再来",
          retryable: false, details: { ...usage, requested: data.ids.length, availableImages: usage.globalRemaining },
        } }, { status: 403 });
        // Global DO serializes bulk admission with every individual image admission.
        await this.env.DB.batch([...(data.setAdmissionId ? [stmt(this.env,
          "INSERT INTO set_admissions(id,day,ip_subject,user_id) VALUES(?,?,?,?)", data.setAdmissionId, quotaDay(), data.ipSubject || "local", data.userId)] : []), ...data.ids.map(taskId => stmt(this.env,
          "INSERT INTO quota_reservations(task_id,day,user_id,state,ip_subject,kind,reserved_at,set_admission_id) VALUES(?,?,?,'reserved',?,'image',?,?)",
          taskId, quotaDay(), data.userId, data.ipSubject || "local", Date.now(), data.setAdmissionId || null))]);
        return Response.json({ ok: true });
      }
      if (path === "/refund-admission") {
        await stmt(this.env, "DELETE FROM set_admissions WHERE id=?", data.id).run();
        return Response.json({ ok: true });
      }
      if (path === "/renew") {
        if (!leases[data.id]) return Response.json({ error: "missing lease" }, { status: 409 });
        leases[data.id].expires = Date.now() + 240000;
        await this.ctx.storage.put("leases", leases);
        return Response.json({ ok: true });
      }
      if (path === "/refund-set") {
        const record = await one(this.env, "SELECT * FROM quota_reservations WHERE task_id=?", data.id);
        if (record && record.state !== "released") await this.env.DB.batch([
          ...(record.state === "counted" && record.kind === "image" ? [record.user_id, "*"].map(subject => stmt(this.env,
            "UPDATE quota_usage SET used=MAX(0,used-1) WHERE day=? AND subject=?", record.day, subject)) : []),
          stmt(this.env, "UPDATE quota_reservations SET state='released' WHERE task_id=?", data.id),
        ]);
        // A completely rate-limited admission delivered nothing: return the daily set allowance too.
        if (record?.set_admission_id && !await one(this.env, `SELECT q.task_id FROM quota_reservations q
          LEFT JOIN tasks t ON t.id=q.task_id WHERE q.set_admission_id=? AND
          (t.id IS NULL OR t.state<>'failed' OR COALESCE(json_extract(t.error,'$.code'),'')<>'RATE_LIMITED') LIMIT 1`, record.set_admission_id))
          await stmt(this.env, "DELETE FROM set_admissions WHERE id=?", record.set_admission_id).run();
        delete leases[data.id];
        await this.ctx.storage.put("leases", leases);
        return Response.json({ ok: true });
      }
      if (path === "/acquire") {
        const timestamp = Date.now();
        for (const key of Object.keys(leases)) if (leases[key].expires <= timestamp) delete leases[key];
        if (!data.kind || !data.userId) return Response.json({ error: "invalid" }, { status: 400 });
        // A counted/unknown image must never be submitted again under the same task ID.
        const previous = await one(this.env, "SELECT * FROM quota_reservations WHERE task_id=?", data.id);
        if (previous?.state === "counted") return Response.json({ error: "settled" }, { status: 409 });
        if (leases[data.id]) return Response.json({ error: "busy" }, { status: 429 });
        const configured = configuredInt(data.kind === "image" ? this.env.VERTEX_IMAGE_CONCURRENCY ?? "1" : this.env.VERTEX_TEXT_CONCURRENCY, 1);
        const capacity = (await this.ctx.storage.get<ImageCapacity>("image-capacity")) || imageCapacity(configured);
        const max = data.kind === "image" ? Math.min(configured, capacity.limit) : configured;
        if (data.kind === "image" && data.setId && await one(this.env, `SELECT s.task_id FROM set_shots s
          JOIN tasks t ON t.id=s.task_id LEFT JOIN submit_intents i ON i.task_id=t.id
          WHERE s.set_id=? AND s.shot_id='main' AND t.id<>? AND t.state IN ('queued','submitted')
          AND (i.state IS NULL OR i.state='prepared') LIMIT 1`, data.setId, data.id))
          return Response.json({ error: "main first" }, { status: 429 });
        if (Object.values(leases).filter(l => l.kind === data.kind).length >= max)
          return Response.json({ error: "busy" }, { status: 429 });
        const run = data.runId
          ? await one(this.env, "SELECT quota_ip FROM runs WHERE id=? AND user_id=?", data.runId, data.userId)
          : await one(this.env, "SELECT r.quota_ip FROM tasks t JOIN runs r ON r.id=t.run_id WHERE t.id=? AND t.user_id=?", data.id, data.userId);
        const ip = run?.quota_ip || data.ipSubject || "local";
        const day = quotaDay();
        const usage = await quota(this.env, data.userId, ip);
        const pending = await all(this.env,
          "SELECT user_id,ip_subject,COUNT(*) n FROM quota_reservations WHERE day=? AND kind=? AND state IN ('reserved','counted') AND task_id<>? GROUP BY user_id,ip_subject",
          day, data.kind, data.id);
        const personal = pending.filter(r => r.user_id === data.userId).reduce((n,r) => n + Number(r.n), 0);
        const ipUsed = pending.filter(r => r.ip_subject === ip).reduce((n,r) => n + Number(r.n), 0);
        const globalUsed = pending.reduce((n,r) => n + Number(r.n), 0);
        const limit = configuredInt(data.kind === "image" ? this.env.GUEST_DAILY_IMAGES ?? this.env.GLOBAL_DAILY_IMAGES ?? "150" : this.env.GUEST_DAILY_RUNS ?? "30");
        const globalLimit = configuredInt(this.env.GLOBAL_DAILY_IMAGES ?? "150");
        const globalExceeded = data.kind === "image" && globalUsed >= globalLimit;
        // Bulk set tasks were admitted atomically against set count + global image capacity.
        // They must remain runnable even when a legacy per-image IP limit is exhausted.
        const prepaidSet = data.kind === "image" && Number(previous?.reserved_at || 0) > 0 && previous?.state === "reserved";
        if (!prepaidSet && (globalExceeded || ipUsed >= limit || (data.kind === "image" && personal >= limit)))
          return Response.json({ error: {
            code: globalExceeded ? "QUOTA_EXCEEDED_GLOBAL" : "QUOTA_EXCEEDED_IP",
            message: globalExceeded ? "今日全站图片额度已用尽，请明日再来" : data.kind === "image" ? "此访客或 IP 的今日图片额度已用尽" : "此 IP 的今日文本调用额度已用尽",
            retryable: false, details: usage,
          } }, { status: 403 });
        await stmt(this.env,
          "INSERT INTO quota_reservations(task_id,day,user_id,state,ip_subject,kind) VALUES(?,?,?,'reserved',?,?) ON CONFLICT(task_id) DO UPDATE SET day=excluded.day,state='reserved',ip_subject=excluded.ip_subject,kind=excluded.kind WHERE state='released'",
          data.id, day, data.userId, ip, data.kind).run();
        // Reservations never expire on a lease timeout: recovery must settle uncertain submissions.
        leases[data.id] = { kind: data.kind, expires: timestamp + 240000 };
        await this.ctx.storage.put("leases", leases);
        return Response.json({ ok: true });
      }
      if (path === "/release") {
        delete leases[data.id];
        await this.ctx.storage.put("leases", leases);
        const record = await one(this.env, "SELECT * FROM quota_reservations WHERE task_id=?", data.id);
        if (record?.kind === "image" && data.outcome) {
          const max = configuredInt(this.env.VERTEX_IMAGE_CONCURRENCY ?? "1", 1);
          const capacity = (await this.ctx.storage.get<ImageCapacity>("image-capacity")) || imageCapacity(max);
          await this.ctx.storage.put("image-capacity", updateCapacity(capacity, max, data.outcome, Date.now()));
        }
        if (record?.state === "reserved") {
          await this.env.DB.batch([
            ...(data.count && record.kind === "image" ? [record.user_id, "*"].map(subject => stmt(this.env,
              "INSERT INTO quota_usage(day,subject,used) SELECT ?,?,1 WHERE EXISTS (SELECT 1 FROM quota_reservations WHERE task_id=? AND state='reserved') ON CONFLICT(day,subject) DO UPDATE SET used=used+1",
              record.day, subject, data.id)) : []),
            stmt(this.env, "UPDATE quota_reservations SET state=? WHERE task_id=? AND state='reserved'", data.count ? "counted" : Number(record.reserved_at || 0) > 0 ? "reserved" : "released", data.id),
          ]);
        }
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    });
  }
}
