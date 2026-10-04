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


/** "ICE 927" → 927, "RE42 (10102)" → 10102, "STB U9" → undefined. */
export const trainNumberOf = (line: string | null | undefined) =>
  line ? (/\((\d+)\)/.exec(line)?.[1] ?? /\s(\d+)$/.exec(line)?.[1]) : undefined;

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
  // "…_Hinrueckfahrt_.ics" holds outbound + return as two events (chronological).
  const events = icsEvents(ics).sort((a, b) => (a.DTSTART ?? "").localeCompare(b.DTSTART ?? ""));
  const roundTrip = events.length > 1 || /hin-?\s*und\s*r(ü|ue)ck|hinr(ü|ue)ck/i.test(filename);
  for (const [idx, ev] of events.entries()) {
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
      // Between "A ➞ B" and "● ab": the line ("ICE 1033") and possibly a
      // "[Reservierung: 2 Sitzplätze, Wg. 2, Pl. 31 33]" line.
      const between = lines.slice(1, dep).filter((l) => !l.includes("➞"));
      const line = between.find((l) => !l.startsWith("[")) ?? null;
      const seat = between.map((l) => /Wg\.\s*\d+,\s*Pl\.\s*[\d ]+/.exec(l)?.[0]?.trim()).find(Boolean) ?? null;
      legs.push({
        product: productOf(line),
        lineName: line ?? undefined,
        trainNumber: trainNumberOf(line),
        fromName: d.station,
        toName: a.station,
        plannedDeparture: at(d.time),
        plannedArrival: at(a.time),
        isWalking: !line,
        depPlatform: d.platform,
        arrPlatform: a.platform,
        reservation: seat,
      });
    }
    if (!legs.length) continue;
    const dir = roundTrip
      ? idx === 0
        ? "outbound"
        : "return"
      : /r(ü|ue)ckfahrt/i.test(filename)
        ? "return"
        : /hinfahrt/i.test(filename)
          ? "outbound"
          : null;
    out.push({ direction: dir, legs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ticket PDF text
// ---------------------------------------------------------------------------

const euro = (s: string | undefined) => (s ? Number(s.replace(/\./g, "").replace(",", ".")) : null);

const PLATFORM = /^\d{1,2}[a-z]?(?:\/[a-z])?(?:\s+[A-G](?:-[A-G])?)?$/i;
const PLATFORM_PREFIX = /^(\d{1,2}[a-z]?(?:\/[a-z])?(?:\s+[A-G](?:-[A-G])?)?)\s+(?=[A-ZÄÖÜ])/;
/** Reservation details, "ticket not valid here" notes, page footers. */
const NOTE = /Res\.-Nr\.|\bSitzpl|Wg\.\s*\d|Großraum|Ruhebereich|Fenster|\bGang\b|Abteil|\bHandy\b|Fahrkarte|erforderlich|Ticketcode|Seite \d+ \/ \d+|Reservierungspflicht/i;
const NOTE_START = /\s+(?:\d+ Sitzpl|Die Fahrkarte|Reservierung|Wg\.\s*\d)/;

/** Wrapped station names: "Gütenbach Neueck, Triberg" + "im Schwarzwald",
 *  "Bahnhof, Gutach im" + "Breisgau", "Altenessen Bahnhof, Essen" + "(Ruhr)". */
function stationNames(lines: string[]): [string, string] {
  const groups: string[] = [];
  for (const l of lines) {
    const prev = groups[groups.length - 1];
    const glue = prev !== undefined && (/(,| im| am| an der| in| bei| ob der|-)$/.test(prev) || /^[(a-zäöü]/.test(l));
    if (glue) groups[groups.length - 1] = `${prev} ${l}`;
    else groups.push(l);
  }
  if (groups.length >= 2) return [groups[0], groups.slice(1).join(" ")];
  return [groups[0] ?? "?", "?"];
}

/** Legs from the "Ihre Reiseverbindung" table (no walks there). */
function pdfLegs(section: string, year: string): TripLeg[] {
  const lines = section.split("\n").map((l) => l.trim()).filter(Boolean);
  const isDate = (l?: string) => !!l && /^\d{2}\.\d{2}\.$/.test(l);
  const ab = (l?: string) => (l ? /^ab (\d{1,2}:\d{2})(?:\s+(.+))?$/.exec(l) : null);
  const an = (l?: string) => (l ? /^an (\d{1,2}:\d{2})(?:\s+(.+))?$/.exec(l) : null);
  const anchors: number[] = [];
  for (let i = 0; i + 3 < lines.length; i++) if (isDate(lines[i]) && isDate(lines[i + 1]) && ab(lines[i + 2]) && an(lines[i + 3])) anchors.push(i);

  const legs: TripLeg[] = [];
  const date = (dm: string) => `${year}-${dm.slice(3, 5)}-${dm.slice(0, 2)}`;
  let start = 0;
  for (const [k, i] of anchors.entries()) {
    const next = anchors[k + 1] ?? lines.length;
    const [from, to] = stationNames(lines.slice(start, i).filter((l) => !NOTE.test(l)));
    const d = ab(lines[i + 2])!;
    const a = an(lines[i + 3])!;
    const slots: (string | null)[] = [d[2] && PLATFORM.test(d[2]) ? d[2] : null, a[2] && PLATFORM.test(a[2]) ? a[2] : null];
    const put = (p: string) => {
      const free = slots.findIndex((x) => x == null);
      if (free >= 0) slots[free] = p;
    };
    let j = i + 4;
    while (j < next && PLATFORM.test(lines[j])) put(lines[j++]);
    let raw = j < next ? lines[j] : null;
    if (raw && !NOTE.test(raw.split(NOTE_START)[0] ?? "")) j++;
    else raw = null;
    let line = raw;
    const pre = line ? PLATFORM_PREFIX.exec(line) : null;
    if (line && pre) {
      put(pre[1]);
      line = line.slice(pre[0].length);
    }
    if (line) line = line.split(NOTE_START)[0].trim();
    const seat = raw ? /Wg\.\s*\d+,\s*Pl\.\s*[\d ]+/.exec(raw)?.[0]?.trim() : undefined;
    legs.push({
      product: productOf(line),
      lineName: line ?? undefined,
      trainNumber: trainNumberOf(line),
      fromName: from,
      toName: to,
      plannedDeparture: berlin(date(lines[i]), d[1].padStart(5, "0")),
      plannedArrival: berlin(date(lines[i + 1]), a[1].padStart(5, "0")),
      isWalking: false,
      depPlatform: slots[0],
      arrPlatform: slots[1],
      reservation: seat || null,
    });
    // The next leg's station names start after this leg's product line (notes are filtered).
    start = j;
  }
  return legs;
}

/** "Bochum Hbf Bleibach" → ["Bochum Hbf", "Bleibach"] using the
 *  stations of the parsed legs; "Bochum+City Stuttgart+City" works without. */
function splitRoute(route: string, journeys: ParsedJourney[]): { from: string | null; to: string | null } {
  const words = route.split(/\s+/);
  const names = new Set(journeys.flatMap((j) => j.legs.flatMap((l) => [l.fromName, l.toName])).map((n) => n.toLowerCase()));
  const known = (part: string) => {
    const p = part.toLowerCase().replace(/\+city$/, "");
    return [...names].some((n) => n === p || n.startsWith(`${p},`) || n.startsWith(`${p} `) || n.endsWith(` ${p}`) || n.includes(p));
  };
  for (let k = 1; k < words.length; k++) {
    const from = words.slice(0, k).join(" ");
    const to = words.slice(k).join(" ");
    if (known(from) && known(to)) return { from, to };
  }
  // No leg info: unambiguous only with exactly two tokens ("Bochum+City Stuttgart+City").
  return words.length === 2 ? { from: words[0], to: words[1] } : { from: null, to: null };
}

export function parseTicketText(text: string): ParsedBooking {
  const get = (re: RegExp) => re.exec(text)?.[1]?.trim() ?? null;
  const tariff =
    get(/^((?:Super |Flex|Spar)[^\n]*(?:preis|Preis)[^\n]*)$/m) ??
    get(/^([^\n]*(?:Sparpreis|Flexpreis)[^\n]*)$/m) ??
    // other tariffs (e.g. "bwEINFACH (Einfache Fahrt)"): the line before "Klasse …"
    get(/\n([^\n]{3,60}\((?:Einfache Fahrt|Hin- und Rückfahrt)\))\nKlasse\s/);
  const head = text.split("Ihre Reiseverbindung")[0];
  // "Hinfahrt Bochum Hbf Bleibach mit ICE" (+ wrapped continuation line)
  const routeLine = /^(?:Einfache Fahrt|Hin- und Rückfahrt|Hinfahrt)\s+(.+)$(?:\n((?:im|am|an|in|bei)\s.+))?/m.exec(head);
  const route = routeLine ? `${routeLine[1]}${routeLine[2] ? ` ${routeLine[2]}` : ""}`.replace(/\s+mit\s+\S+$/, "").trim() : null;
  // Zugbindung: one block per direction, "ICE 101, 05:48 Uhr am 06.10.2026" per line.
  const zug = [...head.matchAll(/^(?:Zugbindung\s+)?([A-Z]{1,5}\s?\d{1,5}, \d{1,2}:\d{2} Uhr am \d{2}\.\d{2}\.\d{4})\s*$/gm)].map((m) => m[1]);
  const ticket: TicketInfo = {
    tariff,
    bahncard: get(/mit\s+\d+\s+(BC\s?\d+(?:\s?Business)?)/),
    travellers: get(/Reisender?\s+(\d+ Person[^\n]*?)(?:\s+mit\s|$)/m),
    from: null,
    to: null,
    zugbindung: zug,
    validity: get(/Gültigkeit:\s*([^\n]+)/) ?? get(/^Gültig (?:am|vom|ab)\s+([^\n]+)/m),
    bookedAt: get(/Gebucht am\s+([^\n.]+(?:\.\d{4})?[^\n]*?Uhr)/),
    traveller: null,
  };
  const roundTrip = /Hin- und Rückfahrt/.test(tariff ?? "") || /Hin- und Rückfahrt/.test(route?.[1] ?? "");
  // A reservation-only document starts with "Reservierung" instead of "Online-Ticket".
  const reservationOnly = !tariff && /^\s*(CIV \d+\s*)?Reservierung\s*$/m.test(text.split("Ihre Reiseverbindung")[0]);
  if (reservationOnly) {
    ticket.tariff = "Sitzplatzreservierung (kein Fahrschein)";
    ticket.reservationOnly = true;
  }

  // One connection table per direction: "Ihre Reiseverbindung … - Einfache Fahrt am 05.10.2026".
  const journeys: ParsedJourney[] = [];
  const re = /Ihre Reiseverbindung[^\n]*?-\s*(Einfache Fahrt|Hinfahrt|Rückfahrt)[^\n]*?(\d{2}\.\d{2}\.(\d{4}))[^\n]*\n([\s\S]*?)(?=Ihre Reiseverbindung|Wichtige Nutzungshinweise|$)/g;
  for (const m of text.matchAll(re)) {
    const legs = pdfLegs(m[4].replace(/^Halt Datum Zeit[^\n]*\n/, ""), m[3]);
    if (legs.length) journeys.push({ direction: m[1] === "Rückfahrt" ? "return" : m[1] === "Hinfahrt" ? "outbound" : null, legs });
  }
  if (route) Object.assign(ticket, splitRoute(route, journeys));
  if (reservationOnly) ticket.reservationPrice = euro(get(/Gesamtpreis\s+([\d.]+,\d{2})\s*€/) ?? undefined);
  return {
    orderNumber: get(/Auftragsnummer:?\s*(\d{6,})/),
    price: reservationOnly ? null : euro(get(/Gesamtpreis\s+([\d.]+,\d{2})\s*€/) ?? undefined),
    klasse: /1\.\s*Klasse/.test(get(/Klasse\s+([^\n]+)/) ?? "") ? 1 : /2\.\s*Klasse/.test(text) ? 2 : null,
    roundTrip,
    ticket,
    journeys,
  };
}

/** Fallback facts from the HTML booking confirmation. */
/** Readable text of an HTML mail (line breaks kept). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&uuml;/g, "ü")
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&szlig;/g, "ß")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ");
}

export function parseBookingHtml(html: string): Partial<ParsedBooking> & { tariff?: string | null } {
  const text = htmlToText(html);
  const reservation = /Sitzplatzreservierung/.test(text) && !/Leistungen/.test(text);
  return {
    orderNumber: /Auftragsnummer\s+(\d{6,})/.exec(text)?.[1] ?? null,
    price: reservation ? null : euro(/Gesamtbetrag:\s*([\d.]+,\d{2})\s*EUR/.exec(text)?.[1]),
    tariff: reservation
      ? "Sitzplatzreservierung (kein Fahrschein)"
      : (/Leistungen\s*\n\s*([^\n,]+(?:preis|Preis)[^\n]*?)(?:,|\n)/.exec(text)?.[1]?.trim() ?? null),
    klasse: /1\. Klasse/.test(text) ? 1 : /2\. Klasse/.test(text) ? 2 : null,
  };
}
