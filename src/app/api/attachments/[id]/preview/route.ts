import { execFile } from "node:child_process";
import fs from "node:fs";
import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { ensureReady } from "@/lib/bootstrap";
import { getAttachment } from "@/lib/trips/repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Pages of a PDF attachment as PNG (iOS Safari shows only the first page of an embedded PDF). ?pages → { pages: n } */
export async function GET(req: Request, { params }: Ctx) {
  ensureReady();
  const a = getAttachment((await params).id);
  if (!a || a.mime !== "application/pdf" || !fs.existsSync(a.abs)) return NextResponse.json({ error: "nicht gefunden" }, { status: 404 });
  const q = new URL(req.url).searchParams;
  if (q.has("pages")) {
    const doc = await PDFDocument.load(fs.readFileSync(a.abs), { ignoreEncryption: true });
    return NextResponse.json({ pages: doc.getPageCount() });
  }
  const page = Math.max(1, Math.min(20, Number(q.get("page")) || 1));
  try {
    const png = await new Promise<Buffer>((resolve, reject) =>
      execFile(
        "pdftoppm",
        ["-png", "-r", "110", "-f", String(page), "-l", String(page), "-singlefile", a.abs],
        { encoding: "buffer", timeout: 30_000, maxBuffer: 20 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(out as Buffer)),
      ),
    );
    return new NextResponse(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return NextResponse.json({ error: "Vorschau nicht möglich" }, { status: 500 });
  }
}
