import fs from "node:fs";
import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { deleteAttachment, getAttachment } from "@/lib/trips/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  ensureReady();
  const a = getAttachment((await params).id);
  if (!a || !fs.existsSync(a.abs)) return NextResponse.json({ error: "nicht gefunden" }, { status: 404 });
  const download = new URL(req.url).searchParams.has("download");
  return new NextResponse(new Uint8Array(fs.readFileSync(a.abs)), {
    headers: {
      "Content-Type": a.mime,
      "Content-Length": String(a.size),
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  ensureReady();
  deleteAttachment((await params).id);
  return NextResponse.json({ deleted: true });
}
