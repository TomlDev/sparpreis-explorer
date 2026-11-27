import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * One-time login from the home portal (other domain, own cookie). Token:
 * base64url(JSON {sub, aud, exp, jti}) + "." + base64url(HMAC-SHA256(payloadB64, SSO_SECRET)),
 * same format as the portal's src/lib/sso.ts. Checked here: signature, aud, exp
 * (at most 120 s ahead); that a jti is used only once is checked by the caller.
 */
export interface SsoPayload {
  sub: string;
  aud: string;
  exp: number;
  jti: string;
}

export const SSO_AUD = "bahn";

export function verifySso(token: string, secret: string, nowMs = Date.now(), aud = SSO_AUD): SsoPayload | null {
  if (!secret || secret.length < 32) return null;
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const expected = createHmac("sha256", secret).update(p).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const x = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as SsoPayload;
    const now = Math.floor(nowMs / 1000);
    if (x.aud !== aud || typeof x.exp !== "number" || x.exp < now || x.exp > now + 120) return null;
    if (typeof x.jti !== "string" || x.jti.length < 8) return null;
    return x;
  } catch {
    return null;
  }
}
