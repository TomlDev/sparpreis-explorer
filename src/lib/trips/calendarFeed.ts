import { randomBytes, timingSafeEqual } from "node:crypto";
import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { trips } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { reminders } from "./loyalty";

/**
 * iCalendar feed for phone calendars (Google/Apple/Thunderbird subscribe to a
 * URL and can't log in): trips + reminders, protected by a long random token
 * in the URL. A new token invalidates the old link.
 */

export function calendarToken(rotate = false): string {
  let t = getSetting<string>("calendar:token");
  if (!t || rotate) {
    t = randomBytes(24).toString("base64url");
    setSetting("calendar:token", t);
  }
  return t;
}

export function tokenOk(given: string): boolean {
  const t = getSetting<string>("calendar:token");
  if (!t) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(t);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** RFC 5545 TEXT escaping: backslash, semicolon, comma, newline. */
const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
const stamp = (iso: string | Date) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: string) => d.replace(/-/g, "");
const nextDay = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};
/** RFC 5545: lines ≤ 75 octets, continuation lines start with a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > 74) {
      out.push(cur);
      cur = " " + ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n");
}

const STATUS: Record<string, string> = {
  planned: "",
  done: " ✓",
  delayed: " (verspätet)",
  aborted: " (abgebrochen)",
  not_started: " (nicht angetreten)",
  cancelled: " (Zugausfall)",
};

export function buildCalendar(baseUrl: string): string {
  const now = stamp(new Date());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sparpreis-Explorer//Reisen//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Bahnreisen", "X-WR-TIMEZONE:Europe/Berlin", "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
  for (const t of db.select().from(trips).orderBy(asc(trips.date)).all()) {
    const rides = t.legs.filter((l) => !l.isWalking);
    const desc = [
      ...t.legs.map((l) =>
        l.isWalking
          ? `Fußweg ${l.fromName} → ${l.toName}`
          : `${l.plannedDeparture ? new Date(l.plannedDeparture).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }) : "?"} ${l.lineName ?? "Zug"} ${l.fromName}${l.depPlatform ? ` Gl. ${l.depPlatform}` : ""} → ${l.toName}${l.arrPlatform ? ` Gl. ${l.arrPlatform}` : ""}${l.reservation ? ` · Platz ${l.reservation}` : ""}`,
      ),
      t.orderNumber ? `Auftrag ${t.orderNumber}` : "",
      t.ticket?.scheduleChange?.zugbindungLifted ? "Fahrplanänderung: Zugbindung aufgehoben" : "",
      `${baseUrl}/reisen/${t.id}`,
    ].filter(Boolean);
    lines.push("BEGIN:VEVENT", `UID:${t.id}@sparpreis-explorer`, `DTSTAMP:${now}`);
    const valid = (iso: string | null) => !!iso && !Number.isNaN(new Date(iso).getTime());
    const timed = valid(t.plannedDeparture);
    if (timed) {
      // Without a known arrival: 1 h default duration.
      const end = valid(t.plannedArrival) ? t.plannedArrival! : new Date(new Date(t.plannedDeparture!).getTime() + 3600_000).toISOString();
      lines.push(`DTSTART:${stamp(t.plannedDeparture!)}`, `DTEND:${stamp(end)}`);
    } else lines.push(`DTSTART;VALUE=DATE:${day(t.date)}`, `DTEND;VALUE=DATE:${day(nextDay(t.date))}`);
    lines.push(
      `SUMMARY:${esc(`🚆 ${t.originName} → ${t.destName}${STATUS[t.status] ?? ""}`)}`,
      `LOCATION:${esc(rides[0]?.fromName ?? t.originName)}`,
      `DESCRIPTION:${esc(desc.join("\n"))}`,
      `URL:${baseUrl}/reisen/${t.id}`,
    );
    if (timed && t.status === "planned")
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:Abfahrt in 60 Minuten", "TRIGGER:-PT60M", "END:VALARM");
    lines.push("END:VEVENT");
  }
  for (const r of reminders()) {
    if (r.kind === "trip") continue; // shown in the app, not worth a calendar entry
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.id}@sparpreis-explorer`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${day(r.date)}`,
      `DTEND;VALUE=DATE:${day(nextDay(r.date))}`,
      `SUMMARY:${esc(`⏰ ${r.title}`)}`,
      `DESCRIPTION:${esc(`${r.detail}\n${baseUrl}${r.href ?? "/reisen"}`)}`,
      "TRANSP:TRANSPARENT",
      // all-day: 15 h before midnight = 09:00 the day before
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(r.title)}`,
      "TRIGGER:-PT15H",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
