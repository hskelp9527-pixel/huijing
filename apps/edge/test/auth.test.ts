import { describe, expect, it } from "vitest";
import { meResponseSchema } from "@loomic/shared/edge";
import { harness } from "./harness";

describe("匿名访客身份", () => {
  it("首次访问签发30天签名cookie，复用身份；伪造、过期cookie不能取回旧身份", async () => {
    const h = await harness({ APP_ENV: "production" });
    try {
      const first = await h.request("/api/me");
      expect(first.status).toBe(200);
      const header = first.headers.get("set-cookie")!;
      expect(header).toContain("HttpOnly");
      expect(header).toContain("Secure");
      expect(header).toContain("SameSite=Lax");
      expect(header).toContain("Max-Age=2592000");
      const cookie = header.split(";")[0];
      const me = meResponseSchema.parse(await first.json());
      expect(me.user.isGuest).toBe(true);
      const again = await h.request("/api/me", "GET", undefined, cookie);
      expect((await again.json<any>()).user.id).toBe(me.user.id);
      expect(again.headers.get("set-cookie")).toBeNull();
      const forged = await h.request("/api/me", "GET", undefined, cookie + "tampered");
      expect((await forged.json<any>()).user.id).not.toBe(me.user.id);
      await h.db.prepare("UPDATE sessions SET expires_at=0 WHERE user_id=?").bind(me.user.id).run();
      const expired = await h.request("/api/me", "GET", undefined, cookie);
      expect((await expired.json<any>()).user.id).not.toBe(me.user.id);
    } finally { await h.close(); }
  });
  it("开发可用HTTP，生产缺签名密钥失败关闭；旧认证接口均已删除", async () => {
    const h = await harness({ APP_ENV: "development" });
    try {
      expect((await h.request("/api/me")).headers.get("set-cookie")).not.toContain("Secure");
      for (const path of ["register", "login", "logout", "session"])
        expect((await h.request(`/api/auth/${path}`, path === "session" ? "GET" : "POST")).status).toBe(404);
    } finally { await h.close(); }
    const broken = await harness({ APP_ENV: "production", SESSION_SECRET: "" });
    try { expect((await broken.request("/api/me")).status).toBe(503); }
    finally { await broken.close(); }
  });
});
