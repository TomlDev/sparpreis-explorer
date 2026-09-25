/**
 * Minimal single-user auth: a password (APP_PASSWORD) exchanged for a signed
 * session cookie. HMAC-SHA256 via Web Crypto so it works in both the proxy
 * and Node route handlers. No database, no third parties.
 */

export const SESSION_COOKIE = "bf_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days (cookie AND token)
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Signing key. Fails closed in production: without a real AUTH_SECRET no
 *  session can be created or verified (a well-known fallback key would let
 *  anyone forge cookies). */
function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV !== "production") return "insecure-dev-secret-change-me";
  throw new Error("AUTH_SECRET fehlt oder ist zu kurz (mind. 32 Zeichen)");
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function createSessionToken(username: string, now = Date.now()): Promise<string> {
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ u: username, iat: now })));
  const sig = b64urlEncode(await hmac(payload));
  return `${payload}.${sig}`;
}

/** Valid = correct signature AND issued within the last SESSION_MAX_AGE, so a
 *  leaked cookie stops working server-side too (not just in the browser). */
export async function verifySessionToken(
  token: string | undefined | null,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  try {
    const expected = await hmac(payload);
    if (!timingSafeEqual(b64urlDecode(sig), expected)) return false;
    const { iat } = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as { iat?: unknown };
    if (typeof iat !== "number") return false;
    return iat <= now + CLOCK_SKEW_MS && now - iat <= SESSION_MAX_AGE * 1000;
  } catch {
    return false;
  }
}

export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}

export function clearedSessionCookie() {
  return { ...sessionCookie(""), value: "", maxAge: 0 };
}

/** Constant-time password check that doesn't leak the length either (both
 *  sides are hashed to fixed-size digests before comparing). */
export async function checkPassword(input: string): Promise<boolean> {
  const expected = process.env.APP_PASSWORD || "";
  if (!expected) return false;
  const digest = async (s: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return timingSafeEqual(await digest(input), await digest(expected));
}
