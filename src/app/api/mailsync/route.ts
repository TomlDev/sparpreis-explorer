import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import {
  addMailAccount,
  forgetMailAccount,
  getMailConfig,
  getMailStatus,
  hasMailPassword,
  listFolders,
  listMailAccounts,
  resetMailSeen,
  setMailConfig,
  syncMail,
} from "@/lib/trips/mailSync";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { getProfile } from "@/lib/trips/profile";

/** The claim address the user said is forwarded to a mailbox read here (alias, redirect). */
const FORWARDED = "mail:claimEmailForwarded";

export const runtime = "nodejs";

function account(id: string) {
  const { seen, ...status } = getMailStatus(id);
  return { id, config: getMailConfig(id), hasPassword: hasMailPassword(id), status: { ...status, seenCount: seen.length } };
}

function view() {
  const accounts = listMailAccounts().map(account);
  // DB answers online claims at the e-mail address given there — is that mailbox read?
  const claimEmail = getProfile().email.trim().toLowerCase() || null;
  const read = accounts.filter((a) => a.config.host && a.hasPassword).map((a) => a.config.user.trim().toLowerCase());
  // only for the address it was confirmed for: a new address asks again
  const forwarded = !!claimEmail && getSetting<string>(FORWARDED) === claimEmail;
  return { accounts, claimEmail, claimEmailForwarded: forwarded, claimEmailRead: !claimEmail || read.includes(claimEmail) || forwarded };
}

export async function GET() {
  ensureReady();
  return NextResponse.json(view());
}

/** add | save | folders (also tests the login) | sync | rescan | forget — per mailbox (`account`, "" = the first). */
export async function POST(req: Request) {
  ensureReady();
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const acc = typeof b.account === "string" ? b.account : "";
  try {
    switch (b.action) {
      case "add":
        return NextResponse.json({ ...view(), added: addMailAccount() });
      case "save":
        setMailConfig(
          {
            enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
            host: typeof b.host === "string" ? b.host : undefined,
            port: typeof b.port === "number" ? b.port : undefined,
            user: typeof b.user === "string" ? b.user : undefined,
            folder: typeof b.folder === "string" ? b.folder : undefined,
            sinceDays: typeof b.sinceDays === "number" ? b.sinceDays : undefined,
            password: typeof b.password === "string" ? b.password : undefined,
          },
          acc,
        );
        return NextResponse.json(view());
      case "folders":
        return NextResponse.json({ ...view(), folders: await listFolders(acc) });
      case "sync":
        await syncMail(acc);
        return NextResponse.json(view());
      case "rescan":
        resetMailSeen(acc);
        await syncMail(acc);
        return NextResponse.json(view());
      case "claimForwarded":
        setSetting(FORWARDED, b.value === true ? getProfile().email.trim().toLowerCase() || null : null);
        return NextResponse.json(view());
      case "forget":
        forgetMailAccount(acc);
        return NextResponse.json(view());
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, ...view() }, { status: 400 });
  }
}
