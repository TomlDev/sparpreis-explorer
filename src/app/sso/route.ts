import { NextResponse } from "next/server";
import { createSessionToken, sessionCookie } from "@/lib/auth";
import { ensureReady } from "@/lib/bootstrap";
import { clientIp, loginLimiter } from "@/lib/loginRateLimit";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { verifySso } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEY = "ssoUsed";

/** Coming from the home portal: check the one-time token, start a session, on to the app. */
export async function GET(req: Request) {
  const secret = process.env.SSO_SECRET;
  if (!secret) return new NextResponse("Not found", { status: 404 });
  ensureReady();
  const ip = clientIp(req.headers);
  // relative: behind Apache req.url is the local address
  const go = (path: string) => new NextResponse(null, { status: 303, headers: { location: path, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  const toLogin = () => go("/login");
  if (loginLimiter.isBlocked(ip)) return toLogin();

  const p = verifySso(new URL(req.url).searchParams.get("token") ?? "", secret);
  // each token only once (kept until it has expired anyway)
  const now = Math.floor(Date.now() / 1000);
  const used = Object.fromEntries(Object.entries(getSetting<Record<string, number>>(KEY) ?? {}).filter(([, exp]) => exp >= now - 60));
  if (!p || used[p.jti]) {
    loginLimiter.recordFailure(ip);
    setSetting(KEY, used);
    return toLogin();
  }
  setSetting(KEY, { ...used, [p.jti]: p.exp });

  loginLimiter.recordSuccess(ip);
  const res = go("/");
  res.cookies.set(sessionCookie(await createSessionToken(process.env.APP_USERNAME || "user")));
  return res;
}
