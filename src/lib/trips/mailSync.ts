import { ImapFlow } from "imapflow";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { decrypt, encrypt } from "./crypto";
import { importDocument } from "./importer";

/**
 * Pulls DB booking mails from one IMAP folder and imports them as trips.
 * Read-only: the mailbox is opened with EXAMINE, nothing is flagged, moved or
 * deleted — processed messages are remembered here (UID + UIDVALIDITY).
 */

export interface MailConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  folder: string;
  /** Only mails newer than this many days are looked at (first sync). */
  sinceDays: number;
}

export interface MailStatus {
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastMessage: string | null;
  imported: number;
  uidValidity: string | null;
  seen: number[];
}

const CFG = "mail:config";
const PW = "mail:password:enc";
const STATUS = "mail:status";

export const DEFAULT_MAIL: MailConfig = { enabled: false, host: "", port: 993, user: "", folder: "INBOX", sinceDays: 180 };
const EMPTY_STATUS: MailStatus = { lastRunAt: null, lastOk: null, lastMessage: null, imported: 0, uidValidity: null, seen: [] };

export const getMailConfig = (): MailConfig => ({ ...DEFAULT_MAIL, ...(getSetting<Partial<MailConfig>>(CFG) ?? {}) });
export const getMailStatus = (): MailStatus => ({ ...EMPTY_STATUS, ...(getSetting<Partial<MailStatus>>(STATUS) ?? {}) });
export const hasMailPassword = () => !!getSetting<string>(PW);

export function setMailConfig(c: Partial<MailConfig> & { password?: string }): MailConfig {
  const cur = getMailConfig();
  const next: MailConfig = {
    enabled: typeof c.enabled === "boolean" ? c.enabled : cur.enabled,
    host: typeof c.host === "string" ? c.host.trim().slice(0, 200) : cur.host,
    port: typeof c.port === "number" && c.port > 0 && c.port < 65536 ? Math.round(c.port) : cur.port,
    user: typeof c.user === "string" ? c.user.trim().slice(0, 200) : cur.user,
    folder: typeof c.folder === "string" && c.folder.trim() ? c.folder.trim().slice(0, 300) : cur.folder,
    sinceDays: typeof c.sinceDays === "number" ? Math.min(3650, Math.max(1, Math.round(c.sinceDays))) : cur.sinceDays,
  };
  // Changing account or folder starts over (UIDs are per mailbox).
  if (next.host !== cur.host || next.user !== cur.user || next.folder !== cur.folder) setSetting(STATUS, { ...getMailStatus(), uidValidity: null, seen: [] });
  setSetting(CFG, next);
  if (typeof c.password === "string" && c.password) setSetting(PW, encrypt(c.password));
  return next;
}

export function forgetMailAccount(): void {
  setSetting(CFG, DEFAULT_MAIL);
  setSetting(PW, null);
  setSetting(STATUS, EMPTY_STATUS);
}

function client(cfg: MailConfig): ImapFlow {
  const blob = getSetting<string>(PW);
  if (!cfg.host || !cfg.user || !blob) throw new Error("Server, Benutzer und Passwort eintragen.");
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993, // implicit TLS; 143 upgrades via STARTTLS
    auth: { user: cfg.user, pass: decrypt(blob) },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

/** imapflow errors → something a person can act on. */
export function friendlyMailError(e: unknown): string {
  const err = e as Error & { authenticationFailed?: boolean; code?: string; responseText?: string };
  if (err.authenticationFailed)
    return "Anmeldung fehlgeschlagen – Benutzer/Passwort prüfen (bei GMX/WEB.DE muss „POP3/IMAP Abruf“ erlaubt sein, bei 2FA ein App-Passwort).";
  if (err.code === "ENOTFOUND") return "Server nicht gefunden – IMAP-Server prüfen.";
  if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "ECONNRESET")
    return "Keine Verbindung zum Server – Server und Port prüfen (meist 993).";
  if (/Mailbox doesn't exist|No such mailbox|NONEXISTENT|not found/i.test(err.responseText ?? err.message)) return "Ordner nicht gefunden – Ordner neu auswählen.";
  return (err.responseText || err.message || "Fehler").slice(0, 300);
}

/** Folder list for the settings picker (also tests the login). */
export async function listFolders(cfg = getMailConfig()): Promise<string[]> {
  const c = client(cfg);
  try {
    await c.connect();
  } catch (e) {
    throw new Error(friendlyMailError(e));
  }
  try {
    const list = await c.list();
    return list.map((f) => f.path).sort((a, b) => a.localeCompare(b, "de"));
  } finally {
    await c.logout().catch(() => {});
  }
}

const DB_SENDER = /@(?:[\w.-]+\.)?(deutschebahn\.com|bahn\.de)>?$/i;
const DB_SUBJECT = /Buchungsbest[äa]tigung|Deutsche Bahn|Fahrgastrechte|Auftrag:?\s*\d{6,}/i;
const DB_PARTS = /BAHN_\d{4}-\d{2}-\d{2}|Ticket_\d{6,}|(Auszahlung|Ablehnung)-\d{2}V\d+|message\/rfc822/i;

/** A DB booking — sent by DB itself, or forwarded (e.g. by a GMX filter rule),
 *  where the sender is you but subject/attachments still give it away. */
export function looksLikeBooking(from: string, subject: string, structure: unknown): boolean {
  return DB_SENDER.test(from) || DB_SUBJECT.test(subject) || DB_PARTS.test(JSON.stringify(structure ?? ""));
}

declare global {
  // eslint-disable-next-line no-var
  var __mailSyncRunning: boolean | undefined;
}

export async function syncMail(): Promise<MailStatus> {
  if (globalThis.__mailSyncRunning) return getMailStatus();
  globalThis.__mailSyncRunning = true;
  const cfg = getMailConfig();
  const status = getMailStatus();
  let imported = 0;
  let claimUpdates = 0;
  const problems: string[] = [];
  try {
    const c = client(cfg);
    await c.connect();
    try {
      const box = await c.mailboxOpen(cfg.folder, { readOnly: true });
      const validity = String(box.uidValidity);
      const seen = new Set(status.uidValidity === validity ? status.seen : []);
      const since = new Date(Date.now() - cfg.sinceDays * 86_400_000);
      const uids = ((await c.search({ since }, { uid: true })) || []).filter((u) => !seen.has(u));
      for (const uid of uids) {
        const head = await c.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true });
        seen.add(uid);
        if (!head) continue;
        const from = head.envelope?.from?.[0]?.address ?? "";
        if (!looksLikeBooking(from, head.envelope?.subject ?? "", head.bodyStructure)) continue;
        const msg = await c.fetchOne(String(uid), { uid: true, envelope: true, source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        try {
          const r = await importDocument({ name: `${uid}.eml`, type: "message/rfc822", bytes: msg.source }, "email");
          imported += r.created.length;
          claimUpdates += r.claims?.length ?? 0;
        } catch (e) {
          // Not every DB mail is a booking (newsletters, invoices, …).
          const m = (e as Error).message;
          if (!/Keine Verbindung/.test(m)) problems.push(`${msg.envelope?.subject ?? uid}: ${m}`);
        }
      }
      setSetting(STATUS, {
        lastRunAt: Date.now(),
        lastOk: problems.length === 0,
        lastMessage: [
          `${uids.length} neue Mails geprüft, ${imported} Fahrt(en) importiert`,
          ...(claimUpdates ? [`${claimUpdates} Antrag/Anträge aktualisiert`] : []),
          ...problems.slice(0, 3),
        ].join(" · "),
        imported: status.imported + imported,
        uidValidity: validity,
        seen: [...seen].slice(-5000),
      } satisfies MailStatus);
    } finally {
      await c.logout().catch(() => {});
    }
  } catch (e) {
    setSetting(STATUS, { ...status, lastRunAt: Date.now(), lastOk: false, lastMessage: friendlyMailError(e) });
  } finally {
    globalThis.__mailSyncRunning = false;
  }
  return getMailStatus();
}

declare global {
  // eslint-disable-next-line no-var
  var __mailSyncTimer: NodeJS.Timeout | undefined;
}

/** Background poll every 15 minutes while enabled (started from bootstrap). */
export function startMailPolling(): void {
  if (globalThis.__mailSyncTimer) return;
  globalThis.__mailSyncTimer = setInterval(() => {
    try {
      if (getMailConfig().enabled && hasMailPassword()) void syncMail();
    } catch {
      /* never crash the server from the poller */
    }
  }, 15 * 60_000);
  globalThis.__mailSyncTimer.unref?.();
}
