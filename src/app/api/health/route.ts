import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { pricingMode, routingProviderName } from "@/lib/config";
import { impersonateHealth } from "@/lib/rail/impersonate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public liveness probe. Internals (which providers, whether the DB
 *  impersonation works) only for a logged-in session — no recon for strangers. */
export async function GET(req: Request) {
  const token = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!(await verifySessionToken(token))) {
    return NextResponse.json({ ok: true });
  }
  const impersonate = await impersonateHealth();
  return NextResponse.json({
    ok: true,
    routing: routingProviderName(),
    pricing: pricingMode(),
    impersonate,
    ts: Date.now(),
  });
}
