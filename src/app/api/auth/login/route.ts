import { NextResponse } from "next/server";
import { checkPassword, createSessionToken, sessionCookie } from "@/lib/auth";
import { clientIp, loginLimiter } from "@/lib/loginRateLimit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let password = "";
  try {
    const body = await req.json();
    password = String(body?.password ?? "");
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const ip = clientIp(req.headers);
  if (loginLimiter.isBlocked(ip)) {
    return NextResponse.json({ error: "Zu viele Versuche, bitte später erneut." }, { status: 429 });
  }

  if (!(await checkPassword(password))) {
    loginLimiter.recordFailure(ip);
    return NextResponse.json({ error: "Falsches Passwort" }, { status: 401 });
  }

  loginLimiter.recordSuccess(ip);
  const token = await createSessionToken(process.env.APP_USERNAME || "user");
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookie(token));
  return res;
}
