import { describe, expect, it } from "vitest";
import { edgeErrorSchema } from "@loomic/shared/edge";
import { harness, submission, until } from "./harness";

describe("D1 + 单一 DO 并发额度", () => {
  async function gate(h: Awaited<ReturnType<typeof harness>>) {
    const ns = await h.mf.getDurableObjectNamespace("PROVIDER_GATE");
    const stub = ns.get(ns.idFromName("global"));
    return async (path: string, data: object) => stub.fetch(`https://gate/${path}`, { method: "POST", body: JSON.stringify(data) });
  }
  it("50个并发图片准入只放行10个；清cookie或换IP仍受更严额度，重复结算不重复计数", async () => {
    const h = await harness({ GUEST_DAILY_IMAGES: "10", GLOBAL_DAILY_IMAGES: "150", VERTEX_IMAGE_CONCURRENCY: "64" });
    try {
      const call = await gate(h);
      const replies = await Promise.all(Array.from({ length: 50 }, (_,i) => call("acquire", { id: `image-${i}`, kind: "image", userId: `guest-${i}`, ipSubject: "same-ip" })));
      expect(replies.filter(r => r.ok)).toHaveLength(10);
      expect(replies.filter(r => r.status === 403)).toHaveLength(40);
      const accepted = replies.flatMap((r,i) => r.ok ? [i] : []);
      await Promise.all(accepted.flatMap(i => [call("release", { id: `image-${i}`, count: true }), call("release", { id: `image-${i}`, count: true })]));
      expect((await h.db.prepare("SELECT used FROM quota_usage WHERE subject='*'").first<any>()).used).toBe(10);
      const denied = await call("acquire", { id: "new-cookie", kind: "image", userId: "new-guest", ipSubject: "same-ip" });
      expect(edgeErrorSchema.parse(await denied.json()).error).toMatchObject({ code: "QUOTA_EXCEEDED_IP", details: { resetAt: expect.stringMatching(/T00:00:00.000Z$/) } });
      // One cookie on many IPs cannot evade its personal limit either.
      for (let i=0;i<10;i++) {
        expect((await call("acquire", { id: `personal-${i}`, kind: "image", userId: "traveller", ipSubject: `ip-${i}` })).ok).toBe(true);
        await call("release", { id: `personal-${i}`, count: true });
      }
      expect((await call("acquire", { id: "extra", kind: "image", userId: "traveller", ipSubject: "another-ip" })).status).toBe(403);
      expect((await call("acquire", { id: `image-${accepted[0]}`, kind: "image", userId: "guest", ipSubject: "fresh" })).status).toBe(409);
    } finally { await h.close(); }
  });
  it("跨IP、跨访客40个并发只放行全站7张；未计费失败释放预留", async () => {
    const h = await harness({ GUEST_DAILY_IMAGES: "10", GLOBAL_DAILY_IMAGES: "7", VERTEX_IMAGE_CONCURRENCY: "64" });
    try {
      const call = await gate(h);
      const replies = await Promise.all(Array.from({ length: 40 }, (_,i) => call("acquire", { id: `global-${i}`, kind: "image", userId: `u-${i}`, ipSubject: `ip-${i}` })));
      expect(replies.filter(r => r.ok)).toHaveLength(7);
      expect(edgeErrorSchema.parse(await replies.find(r => r.status === 403)!.json()).error.code).toBe("QUOTA_EXCEEDED_GLOBAL");
      const admitted = replies.findIndex(r => r.ok);
      await call("release", { id: `global-${admitted}`, count: false });
      expect((await call("acquire", { id: "after-429", kind: "image", userId: "u-new", ipSubject: "ip-new" })).ok).toBe(true);
      expect((await h.db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE state='counted'").first<any>()).n).toBe(0);
    } finally { await h.close(); }
  });
  it("文本50个并发只放行30次，按UTC日重置，429释放后可以重试", async () => {
    const h = await harness({ GUEST_DAILY_RUNS: "30", VERTEX_TEXT_CONCURRENCY: "64" });
    try {
      const call = await gate(h);
      const replies = await Promise.all(Array.from({ length: 50 }, (_,i) => call("acquire", { id: `text-${i}`, kind: "text", userId: `guest-${i}`, ipSubject: "text-ip" })));
      expect(replies.filter(r => r.ok)).toHaveLength(30);
      expect(replies.filter(r => r.status === 403)).toHaveLength(20);
      const accepted = replies.findIndex(r => r.ok);
      await call("release", { id: `text-${accepted}`, count: false });
      expect((await call("acquire", { id: `text-${accepted}`, kind: "text", userId: "guest", ipSubject: "text-ip" })).ok).toBe(true);
      await call("release", { id: `text-${accepted}`, count: true });
      await h.db.prepare("UPDATE quota_reservations SET day='2000-01-01'").run();
      expect((await call("acquire", { id: "tomorrow", kind: "text", userId: "guest", ipSubject: "text-ip" })).ok).toBe(true);
    } finally { await h.close(); }
  });
  it("真实路由冻结可信CF IP；XFF和新cookie不能绕过，429失败不消耗额度", async () => {
    const h = await harness({ GUEST_DAILY_IMAGES: "1" });
    try {
      const a = await h.guest(), b = await h.guest();
      const ip = { "CF-Connecting-IP": "192.0.2.1" };
      const send = async (text: string) => {
        const result = await (await h.request("/api/projects/start", "POST", submission(text, 1), a.cookie, ip)).json<any>();
        return until(() => h.db.prepare("SELECT state,error FROM runs WHERE id=?").bind(result.runId).first<any>(), r => ["completed", "failed"].includes(r.state));
      };
      expect((await send("生成一张杯子 [fixture:429]")).state).toBe("failed");
      expect((await send("生成一张杯子")).state).toBe("completed");
      const me = await (await h.request("/api/me", "GET", undefined, b.cookie, { ...ip, "X-Forwarded-For": "192.0.2.99" })).json<any>();
      expect(me.quota.remaining).toBe(0);
      expect((await h.request("/api/projects/start", "POST", submission("生成一张图", 1), b.cookie, ip)).status).toBe(429);
      const other = { "CF-Connecting-IP": "192.0.2.2" };
      expect((await (await h.request("/api/me", "GET", undefined, b.cookie, other)).json<any>()).quota.remaining).toBe(1);
      expect((await (await h.request("/api/me", "GET", undefined, a.cookie, other)).json<any>()).quota.remaining).toBe(0);
    } finally { await h.close(); }
  });

});
