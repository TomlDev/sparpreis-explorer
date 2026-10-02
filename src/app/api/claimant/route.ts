import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getProfile, ibanValid, maskIban, setProfile, type ClaimantProfile } from "@/lib/trips/profile";

export const runtime = "nodejs";

/** Personal data for claims. The IBAN is never sent back in full. */
function view(p: ClaimantProfile) {
  return { profile: { ...p, iban: "" }, ibanMasked: maskIban(p.iban), ibanValid: ibanValid(p.iban) };
}

export async function GET() {
  ensureReady();
  return NextResponse.json(view(getProfile()));
}

export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Partial<ClaimantProfile>;
  // Empty IBAN field = keep the stored one.
  if (typeof b.iban === "string" && !b.iban.trim()) delete b.iban;
  if (b.iban && !ibanValid(b.iban)) return NextResponse.json({ error: "IBAN ungültig (Prüfziffer)" }, { status: 400 });
  return NextResponse.json(view(setProfile(b)));
}
