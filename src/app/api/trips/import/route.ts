import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { importDocument } from "@/lib/trips/importer";

export const runtime = "nodejs";

/** Import DB booking mails (.eml), ticket PDFs or .ics files (multipart "file", several allowed). */
export async function POST(req: Request) {
  ensureReady();
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "kein Upload" }, { status: 400 });
  const results = [];
  for (const f of form.getAll("file")) {
    if (!(f instanceof File)) continue;
    if (f.size > 20 * 1024 * 1024) {
      results.push({ file: f.name, error: "Datei zu groß" });
      continue;
    }
    try {
      const r = await importDocument({ name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()) }, /\.eml$/i.test(f.name) ? "email" : /\.ics$/i.test(f.name) ? "ics" : "pdf");
      results.push({ file: f.name, ...r });
    } catch (e) {
      results.push({ file: f.name, error: (e as Error).message });
    }
  }
  return NextResponse.json({ results });
}
