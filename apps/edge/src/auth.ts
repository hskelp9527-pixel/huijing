import type { Context } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { ApiError, hash, id, now, one, stmt } from "./core";
import type { Bindings } from "./types";

const lifetime = 30 * 86400;

/** Only a signed, unexpired session can recover a guest's ownership identity. */
export async function guestIdentity(c: Context<Bindings>) {
  const secret = c.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new ApiError("INTERNAL_ERROR", "访客会话签名密钥未配置", 503);
  const token = await getSignedCookie(c, secret, "session");
  if (token) {
    const user = await one(c.env,
      "SELECT u.id,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.is_guest=1",
      await hash(token), Date.now());
    if (user) return { user: { id: user.id, name: user.name, isGuest: true as const }, token };
  }
  const user = { id: id("guest"), name: "访客", isGuest: true as const };
  const fresh = crypto.randomUUID() + crypto.randomUUID();
  await c.env.DB.batch([
    // Legacy required columns remain for migration compatibility; no credentials are accepted.
    stmt(c.env, "INSERT INTO users(id,email,name,password_hash,created_at,is_guest) VALUES(?,?,?,'',?,1)",
      user.id, `${user.id}@guest.invalid`, user.name, now()),
    stmt(c.env, "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      await hash(fresh), user.id, Date.now() + lifetime * 1000),
  ]);
  await setSignedCookie(c, "session", fresh, secret, {
    httpOnly: true,
    secure: c.env.APP_ENV !== "development",
    sameSite: "Lax",
    path: "/",
    maxAge: lifetime,
  });
  return { user, token: fresh };
}
