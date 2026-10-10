import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { forgetDbAccount, getDbAccountStatus, getDbUser, hasDbPassword, setDbAccount } from "@/lib/trips/dbAccount";
import { syncDbAccount } from "@/lib/trips/dbSync";

export const runtime = "nodejs";

/** The password never leaves the server. */
function view() {
  return { user: getDbUser(), hasPassword: hasDbPassword(), status: getDbAccountStatus() };
}

export async function GET() {
  ensureReady();
  return NextResponse.json(view());
}

export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  switch (b.action) {
    case "save":
      if (typeof b.user !== "string" || !b.user.trim()) return NextResponse.json({ error: "E-Mail/Benutzername fehlt", ...view() }, { status: 400 });
      setDbAccount(b.user, typeof b.password === "string" && b.password ? b.password : undefined);
      return NextResponse.json(view());
    case "sync":
      if (!getDbUser() || !hasDbPassword()) return NextResponse.json({ error: "Erst Benutzername und Passwort speichern.", ...view() }, { status: 400 });
      await syncDbAccount();
      return NextResponse.json(view());
    case "forget":
      forgetDbAccount();
      return NextResponse.json(view());
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
