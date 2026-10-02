import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getTrip, MAX_UPLOAD, saveAttachment } from "@/lib/trips/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };
const KINDS = new Set(["screenshot", "ticket", "receipt", "other"]);

/** Upload screenshots / receipts (multipart: file[], kind, caption). */
export async function POST(req: Request, { params }: Ctx) {
  ensureReady();
  const id = (await params).id;
  if (!getTrip(id)) return NextResponse.json({ error: "Fahrt nicht gefunden" }, { status: 404 });
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD * 5) return NextResponse.json({ error: "zu groß" }, { status: 413 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "kein Upload" }, { status: 400 });
  const kind = String(form.get("kind") ?? "screenshot");
  const caption = form.get("caption") ? String(form.get("caption")).slice(0, 500) : null;
  const saved = [];
  try {
    for (const f of form.getAll("file")) {
      if (!(f instanceof File)) continue;
      saved.push(
        saveAttachment(id, { name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) }, KINDS.has(kind) ? kind : "other", caption),
      );
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, saved }, { status: 400 });
  }
  return NextResponse.json({ saved });
}
