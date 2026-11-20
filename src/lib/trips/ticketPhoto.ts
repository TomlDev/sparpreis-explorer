import { execFile } from "node:child_process";
import { berlinToIso } from "@/lib/time";
import type { TicketInfo, TripLeg } from "@/db/schema";
import { productOf, trainNumberOf } from "./importDb";

/**
 * Tickets as photos: a screenshot of the ticket in DB Navigator ("Reisedetails →
 * Ticket") or a photo of a paper ticket. The text is read with tesseract (local,
 * nothing leaves the server), then parsed like a ticket.
 */

export const isImage = (f: { name?: string | null; type?: string }) =>
  /^image\//.test(f.type ?? "") || /\.(png|jpe?g|webp|heic|heif|tiff?)$/i.test(f.name ?? "");

const MAX_IMAGE = 20 * 1024 * 1024;

/** Text of an image (German), via the tesseract CLI reading from stdin. */
export function ocrImage(bytes: Buffer): Promise<string> {
  if (bytes.length > MAX_IMAGE) return Promise.reject(new Error("Foto zu groß."));
  // HEIC: tesseract can't read it (iOS sends JPEG when a photo is picked in the browser)
  if (bytes.subarray(4, 12).toString("latin1").includes("ftyphei")) return Promise.reject(new Error("HEIC-Foto – bitte als JPEG oder PNG (Screenshot) hochladen."));
  return new Promise((resolve, reject) => {
    const p = execFile("tesseract", ["stdin", "stdout", "-l", "deu"], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" }, (err, out) => {
      if (err) return reject(new Error((err as NodeJS.ErrnoException).code === "ENOENT" ? "Texterkennung (tesseract) fehlt auf dem Server." : "Foto konnte nicht gelesen werden."));
      resolve(out);
    });
    p.stdin?.on("error", () => {});
    p.stdin?.end(bytes);
  });
}

export interface NavigatorTicket {
  direction: "outbound" | "return";
  orderNumber: string | null;
  /** price of this direction ("Gesamtpreis" on the direction's ticket screen) */
  price: number | null;
  klasse: number | null;
  from: string | null;
  to: string | null;
  /** travel day (yyyy-MM-dd): first bound train, else the validity start */
  date: string | null;
  zugbindungLifted: boolean;
  /** bound trains: "ICE 278" at 15:27 on 2026-11-21 */
  trains: { line: string; date: string; time: string }[];
  ticket: TicketInfo;
}

const ymd = (d: string) => d.split(".").reverse().join("-");
const euro = (s: string) => Number(s.replace(/\./g, "").replace(",", "."));

/** The ticket screen of DB Navigator (one direction), as OCR text. */
export function parseNavigatorTicket(raw: string): NavigatorTicket | null {
  const text = raw.replace(/\r/g, "").slice(0, 20_000);
  const dir = /Fahrkarte \((Hin|Rück|Ruck)fahrt\)|Verbindung (Hin|Rück|Ruck)fahrt/i.exec(text);
  if (!dir) return null;
  const direction = /^hin/i.test(dir[1] ?? dir[2]) ? "outbound" : "return";
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const after = (re: RegExp) => {
    const i = lines.findIndex((l) => re.test(l));
    return i >= 0 ? (lines[i + 1] ?? null) : null;
  };
  const tariff = after(/Fahrkarte \((Hin|Rück|Ruck)fahrt\)/i);
  const klasse = /\b([12])\.\s*Klasse/.exec(text)?.[1];
  const people = /(\d+ Person(?:en)? \([^)]*\))(?:\s*mit\s*\d*\s*(BC\s?\d{2,3}|BahnCard \d{2,3}))?/.exec(text);
  const route = after(/^Verbindung (Hin|Rück|Ruck)fahrt/i);
  const [from, to] = route?.includes(" - ") ? route.split(" - ").map((s) => s.trim()) : [null, null];
  const von = /Von:\s*(\d{2}\.\d{2}\.\d{4}),?\s*(\d{1,2}:\d{2})/.exec(text);
  const bis = /Bis:\s*(\d{2}\.\d{2}\.\d{4}),?\s*(\d{1,2}:\d{2})/.exec(text);
  const trains = [...text.matchAll(/\b((?:ICE|IC|EC|ECE|IRE|RE|RB|S|FLX|NJ|EN|TGV|RJX?)\s?\d{1,5}),\s*(\d{1,2}:\d{2}) Uhr am (\d{2}\.\d{2}\.\d{4})/g)].map((m) => ({
    line: m[1].replace(/^([A-Z]+)(\d)/, "$1 $2"),
    time: m[2].padStart(5, "0"),
    date: ymd(m[3]),
  }));
  const lifted = /Zugbindung:?\s*aufgehoben/i.test(text);
  const price = /Gesamtpreis:?\s*([\d.]+,\d{2})/.exec(text)?.[1];
  const booked = /Gebucht am:?\s*(\d{2}\.\d{2}\.\d{4}(?:\s*um\s*\d{1,2}:\d{2}\s*Uhr)?)/.exec(text)?.[1];
  const orderNumber = /Auftrags-?\s*Nr\.?:?\s*(\d{9,})/.exec(text)?.[1] ?? null;
  if (!orderNumber && !trains.length && !route) return null;
  const tariffFull = tariff && !/^\d\.\s*Klasse/.test(tariff) ? `${tariff} (Hin- und Rückfahrt)` : null;
  return {
    direction,
    orderNumber,
    price: price ? euro(price) : null,
    klasse: klasse ? Number(klasse) : null,
    from,
    to,
    date: trains[0]?.date ?? (von ? ymd(von[1]) : null),
    zugbindungLifted: lifted,
    trains,
    ticket: {
      tariff: tariffFull,
      bahncard: people?.[2]?.replace(/\s+/g, "").replace(/^BahnCard/, "BC") ?? null,
      travellers: people?.[1] ?? null,
      from,
      to,
      zugbindung: lifted ? [] : trains.map((t) => `${t.line}, ${t.time} Uhr am ${t.date.split("-").reverse().join(".")}`),
      validity: von && bis ? `${von[1]} ${von[2]} Uhr bis ${bis[1]} ${bis[2]} Uhr` : null,
      bookedAt: booked ?? null,
      directionPrice: price ? euro(price) : null,
    },
  };
}

/**
 * Legs from a ticket screen: the bound trains with their departure (the screen has
 * no transfer stations), or one leg for the whole way when the Zugbindung is lifted.
 */
export function navigatorLegs(n: NavigatorTicket): TripLeg[] {
  const from = n.from ?? "?";
  const to = n.to ?? "?";
  if (!n.trains.length) return [{ fromName: from, toName: to, plannedDeparture: null, plannedArrival: null }];
  return n.trains.map((t, i) => ({
    lineName: t.line,
    product: productOf(t.line),
    trainNumber: trainNumberOf(t.line),
    fromName: i === 0 ? from : "Umstieg",
    toName: i === n.trains.length - 1 ? to : "Umstieg",
    plannedDeparture: berlinToIso(t.date, t.time),
    plannedArrival: null,
  }));
}
