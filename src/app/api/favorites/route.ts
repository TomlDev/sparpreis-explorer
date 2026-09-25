import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { favorites } from "@/db/schema";
import { newId, now } from "@/db/util";
import { ensureReady } from "@/lib/bootstrap";

export const runtime = "nodejs";

export async function GET() {
  ensureReady();
  const rows = db.select().from(favorites).orderBy(desc(favorites.createdAt)).all();
  return NextResponse.json({ favorites: rows });
}

export async function POST(req: Request) {
  ensureReady();
  const body = await req.json().catch(() => ({}));
  const id = newId("fav");
  db.insert(favorites)
    .values({
      id,
      kind: body.kind === "segment" ? "segment" : "journey",
      label: String(body.label ?? "Favorit"),
      refKey: body.refKey ?? null,
      data: body.data ?? null,
      createdAt: now(),
    })
    .run();
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: Request) {
  ensureReady();
  const id = new URL(req.url).searchParams.get("id");
  if (id) db.delete(favorites).where(eq(favorites.id, id)).run();
  return NextResponse.json({ ok: true });
}
