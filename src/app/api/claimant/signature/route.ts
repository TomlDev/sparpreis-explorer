import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { deleteSignature, getSignature, MAX_SIGNATURE_UPLOAD, saveSignature } from "@/lib/trips/signature";

export const runtime = "nodejs";

/** The stored signature as PNG (404 when none). */
export async function GET() {
  ensureReady();
  const png = getSignature();
  if (!png) return NextResponse.json({ error: "keine Unterschrift" }, { status: 404 });
  return new NextResponse(new Uint8Array(png), {
    headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" },
  });
}

export async function HEAD() {
  ensureReady();
  return new NextResponse(null, { status: getSignature() ? 200 : 404 });
}

/** Upload a photo / screenshot of the signature (multipart field "file"). */
export async function POST(req: Request) {
  ensureReady();
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Kein Bild" }, { status: 400 });
  if (file.size > MAX_SIGNATURE_UPLOAD) return NextResponse.json({ error: "Bild zu groß (max. 8 MB)" }, { status: 413 });
  try {
    await saveSignature(Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    return NextResponse.json({ error: /Unterschrift/.test(msg) ? msg : "Bild konnte nicht gelesen werden" }, { status: 400 });
  }
}

export async function DELETE() {
  ensureReady();
  deleteSignature();
  return NextResponse.json({ ok: true });
}
