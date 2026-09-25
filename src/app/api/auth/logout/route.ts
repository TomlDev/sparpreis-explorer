import { NextResponse } from "next/server";
import { clearedSessionCookie } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedSessionCookie());
  return res;
}
