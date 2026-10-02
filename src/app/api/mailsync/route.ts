import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { setSetting } from "@/lib/repo/settings";
import {
  forgetMailAccount,
  getMailConfig,
  getMailStatus,
  hasMailPassword,
  listFolders,
  setMailConfig,
  syncMail,
} from "@/lib/trips/mailSync";

export const runtime = "nodejs";

function view() {
  const { seen, ...status } = getMailStatus();
  return { config: getMailConfig(), hasPassword: hasMailPassword(), status: { ...status, seenCount: seen.length } };
}

export async function GET() {
  ensureReady();
  return NextResponse.json(view());
}

/** save | folders (also tests the login) | sync | rescan | forget */
export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    switch (b.action) {
      case "save":
        setMailConfig({
          enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
          host: typeof b.host === "string" ? b.host : undefined,
          port: typeof b.port === "number" ? b.port : undefined,
          user: typeof b.user === "string" ? b.user : undefined,
          folder: typeof b.folder === "string" ? b.folder : undefined,
          sinceDays: typeof b.sinceDays === "number" ? b.sinceDays : undefined,
          password: typeof b.password === "string" ? b.password : undefined,
        });
        return NextResponse.json(view());
      case "folders":
        return NextResponse.json({ folders: await listFolders() });
      case "sync":
        await syncMail();
        return NextResponse.json(view());
      case "rescan":
        setSetting("mail:status", { ...getMailStatus(), seen: [] });
        await syncMail();
        return NextResponse.json(view());
      case "forget":
        forgetMailAccount();
        return NextResponse.json(view());
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, ...view() }, { status: 400 });
  }
}
