import { fromZonedTime } from "date-fns-tz";
import type { TicketInfo, TripLeg } from "@/db/schema";

/**
 * Reads DB booking documents into trips:
 *  - the calendar attachment (.ics) of the booking mail — every leg incl.
 *    walks, lines and platforms (best source for the itinerary),
 *  - the ticket PDF text — tariff, price, BahnCard, Zugbindung, validity and
 *    (if there is no .ics) the legs from its connection table,
 *  - the HTML mail body as a fallback for order number / tariff / price.
 */

const TZ = "Europe/Berlin";

export interface ParsedJourney {
  direction: "outbound" | "return" | null;
  legs: TripLeg[];
}

export interface ParsedBooking {
  orderNumber: string | null;
  price: number | null;
  klasse: number | null;
  roundTrip: boolean;
  ticket: TicketInfo;
  journeys: ParsedJourney[];
}

/** Line label → our product names ("ICE 927", "STR 301", "STB U9", "RE 2"). */
export function productOf(line: string | null | undefined): string | undefined {
  const l = (line ?? "").trim().toUpperCase();
  if (!l) return undefined;
  if (/^ICE\b/.test(l)) return "nationalExpress";
  if (/^(IC|EC|ECE|RJX?|NJ|EN|TGV|FLX|IR)\b/.test(l)) return "national";
  if (/^(RE|IRE)\b|^RE\d/.test(l)) return "regionalExpress";
  if (/^S\s?\d|^S\b/.test(l)) return "suburban";
  if (/^(STR|TRAM)\b/.test(l)) return "tram";
  if (/^(STB|U)\s?\w|^U\d/.test(l)) return "subway";
  if (/^(BUS|SEV)\b/.test(l)) return "bus";
  if (/^(FÄHRE|F)\b/.test(l)) return "ferry";
  return "regional"; // RB and private operators (NWB, ERB, VIA, ME, …)
}


const berlin = (date: string, time: string) => fromZonedTime(`${date}T${time}:00`, TZ).toISOString();
const ymd = (d: string) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(d);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const addDay = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// .ics (calendar attachment of the booking mail)
// ---------------------------------------------------------------------------

function icsEvents(ics: string): Record<string, string>[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const events: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of unfolded.split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i > 0) cur[line.slice(0, i).split(";")[0]] = line.slice(i + 1);
    }
  }
  return events;
}

const icsText = (v: string) => v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");

export function parseIcs(ics: string, filename = ""): ParsedJourney[] {
  const out: ParsedJourney[] = [];
  for (const ev of icsEvents(ics)) {
    const desc = icsText(ev.DESCRIPTION ?? "");
    const date = ymd(/Datum:\s*(\d{2}\.\d{2}\.\d{4})/.exec(desc)?.[1] ?? "") ?? (ev.DTSTART ? `${ev.DTSTART.slice(0, 4)}-${ev.DTSTART.slice(4, 6)}-${ev.DTSTART.slice(6, 8)}` : null);
    if (!date) continue;
    const legs: TripLeg[] = [];
    let day = date;
    let last = "00:00";
    const at = (time: string) => {
      if (time < last) day = addDay(day); // past midnight
      last = time;
      return berlin(day, time);
    };
    for (const block of desc.split(/\n\s*\n/)) {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      const dep = lines.findIndex((l) => /^●\s*ab\s+\d{1,2}:\d{2}/.test(l));
      const arr = lines.findIndex((l) => /^○\s*an\s+\d{1,2}:\d{2}/.test(l));
      if (dep < 0 || arr < 0) continue;
      const parse = (l: string) => {
        const m = /^[●○]\s*(?:ab|an)\s+(\d{1,2}:\d{2})\s+(.*?)(?:\s+▷\s*Gleis\s+(.+))?$/.exec(l)!;
        return { time: m[1].padStart(5, "0"), station: m[2].trim(), platform: m[3]?.trim() ?? null };
      };
      const d = parse(lines[dep]);
      const a = parse(lines[arr]);
      const line = lines.slice(1, dep).find((l) => !l.includes("➞")) ?? null;
      legs.push({
        product: productOf(line),
        lineName: line ?? undefined,
        trainNumber: line ? /(\d+)$/.exec(line)?.[1] : undefined,
        fromName: d.station,
        toName: a.station,
        plannedDeparture: at(d.time),
        plannedArrival: at(a.time),
        isWalking: !line,
        depPlatform: d.platform,
        arrPlatform: a.platform,
      });
    }
    if (!legs.length) continue;
    const dir = /R[üu]ckfahrt/i.test(filename + (ev.SUMMARY ?? "")) ? "return" : /Hinfahrt/i.test(filename) ? "outbound" : null;
    out.push({ direction: dir, legs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ticket PDF text
// ---------------------------------------------------------------------------

const euro = (s: string | undefined) => (s ? Number(s.replace(/\./g, "").replace(",", ".")) : null);

/** Legs from the "Ihre Reiseverbindung" table (no walks there). */
function pdfLegs(section: string, year: string): TripLeg[] {
  const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);
  const legs: TripLeg[] = [];
  let pending: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const isDate = (l?: string) => !!l && /^\d{2}\.\d{2}\.$/.test(l);
    if (isDate(lines[i]) && isDate(lines[i + 1]) && /^ab \d{1,2}:\d{2}$/.test(lines[i + 2] ?? "") && /^an \d{1,2}:\d{2}$/.test(lines[i + 3] ?? "")) {
      // Station names may wrap ("Hauptbf (Arnulf-Klett-Platz)," + "Stuttgart").
      const names: string[] = [];
      for (const l of pending.filter((l) => !/\bWg\.\s*\d|\bPl\.\s*\d|^Reservierung|Sitzplatz|Platzreservierung/.test(l))) {
        if (names.length && names[names.length - 1].endsWith(",")) names[names.length - 1] += ` ${l}`;
        else names.push(l);
      }
      const [from, to] = names.length >= 2 ? [names.slice(0, -1).join(" "), names[names.length - 1]] : [names[0] ?? "?", "?"];
      const date = (dm: string) => `${year}-${dm.slice(3, 5)}-${dm.slice(0, 2)}`;
      // Platforms are short numbers; the product line follows ("ICE 927", "STR 301").
      let j = i + 4;
      const platforms: string[] = [];
      while (j < lines.length && /^\d{1,2}[a-z]?$/i.test(lines[j]) && platforms.length < 2) platforms.push(lines[j++]);
      const line = lines[j] ?? null;
      legs.push({
        product: productOf(line),
        lineName: line ?? undefined,
        trainNumber: line ? /(\d+)$/.exec(line)?.[1] : undefined,
        fromName: from.replace(/,$/, ""),
        toName: to.replace(/,$/, ""),
        plannedDeparture: berlin(date(lines[i]), lines[i + 2].slice(3).padStart(5, "0")),
        plannedArrival: berlin(date(lines[i + 1]), lines[i + 3].slice(3).padStart(5, "0")),
        isWalking: false,
        depPlatform: platforms[0] ?? null,
        arrPlatform: platforms[1] ?? null,
      });
      pending = [];
      i = j;
      continue;
    }
    pending.push(lines[i]);
  }
  return legs;
}

export function parseTicketText(text: string): ParsedBooking {
  const get = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? null;
  const tariff = get(/^((?:Super |Flex|Spar)[^\n]*(?:preis|Preis)[^\n]*)$/m) ?? get(/^([^\n]*(?:Sparpreis|Flexpreis)[^\n]*)$/m);
  const route = /^(Einfache Fahrt|Hin- und Rückfahrt|Hinfahrt|Rückfahrt)\s+(.+?)\s{1,}(\S.*)$/m.exec(text);
  const zug: string[] = [];
  const zb = /Zugbindung\s+([\s\S]*?)(?:\n(?:Eine Stornierung|City-Ticket|Gesamtpreis|Storno|Umtausch)|$)/.exec(text);
  if (zb) for (const l of zb[1].split("\n")) if (/\d{1,2}:\d{2} Uhr/.test(l)) zug.push(l.trim());
  const ticket: TicketInfo = {
    tariff,
    bahncard: get(/mit\s+\d+\s+(BC\s?\d+(?:\s?Business)?)/),
    travellers: get(/Reisender?\s+(\d+ Person[^\n]*?)(?:\s+mit\s|$)/m),
    from: route?.[2]?.trim() ?? null,
    to: route?.[3]?.trim() ?? null,
    zugbindung: zug,
    validity: get(/Gültigkeit:\s*([^\n]+)/),
    bookedAt: get(/Gebucht am\s+([^\n.]+(?:\.\d{4})?[^\n]*?Uhr)/),
    traveller: null,
  };
  const roundTrip = /Hin- und Rückfahrt/.test(tariff ?? "") || /Hin- und Rückfahrt/.test(route?.[1] ?? "");

  // One connection table per direction: "Ihre Reiseverbindung … - Einfache Fahrt am 05.10.2026".
  const journeys: ParsedJourney[] = [];
  const re = /Ihre Reiseverbindung[^\n]*?-\s*(Einfache Fahrt|Hinfahrt|Rückfahrt)[^\n]*?(\d{2}\.\d{2}\.(\d{4}))[^\n]*\n([\s\S]*?)(?=Ihre Reiseverbindung|Wichtige Nutzungshinweise|$)/g;
  for (const m of text.matchAll(re)) {
    const legs = pdfLegs(m[4].replace(/^Halt Datum Zeit[^\n]*\n/, ""), m[3]);
    if (legs.length) journeys.push({ direction: m[1] === "Rückfahrt" ? "return" : m[1] === "Hinfahrt" ? "outbound" : null, legs });
  }
  return {
    orderNumber: get(/Auftragsnummer:?\s*(\d{6,})/),
    price: euro(get(/Gesamtpreis\s+([\d.]+,\d{2})\s*€/) ?? undefined),
    klasse: /1\.\s*Klasse/.test(get(/Klasse\s+([^\n]+)/) ?? "") ? 1 : /2\.\s*Klasse/.test(text) ? 2 : null,
    roundTrip,
    ticket,
    journeys,
  };
}

/** Fallback facts from the HTML booking confirmation. */
export function parseBookingHtml(html: string): Partial<ParsedBooking> & { tariff?: string | null } {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ");
  return {
    orderNumber: /Auftragsnummer\s+(\d{6,})/.exec(text)?.[1] ?? null,
    price: euro(/Gesamtbetrag:\s*([\d.]+,\d{2})\s*EUR/.exec(text)?.[1]),
    tariff: /Leistungen\s*\n\s*([^\n,]+(?:preis|Preis)[^\n]*?)(?:,|\n)/.exec(text)?.[1]?.trim() ?? null,
    klasse: /1\. Klasse/.test(text) ? 1 : /2\. Klasse/.test(text) ? 2 : null,
  };
}
