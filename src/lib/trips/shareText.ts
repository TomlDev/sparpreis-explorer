import type { TripLeg } from "@/db/schema";
import { berlinToIso } from "@/lib/time";
import { productOf, trainNumberOf } from "./importDb";

/**
 * "Verbindung teilen" from DB Navigator / bahn.de, as text:
 *
 *   Bochum Hbf → Triberg
 *   17.11.2026
 *
 *   RE42 (10102)
 *   Nach Mönchengladbach Hbf
 *   Ab 5:34 Bochum Hbf, Gleis 4
 *   An 5:43 Essen Hbf, Gleis 10
 *
 *   Bus 550
 *   Nach Schonach
 *   Ab 10:50 Bahnhof, Triberg im Schwarzwald
 *   An 11:28 Rathaus, Triberg im Schwarzwald
 *
 *   Verbindung ansehen:
 *   https://www.bahn.de/buchung/start?vbid=…
 *
 * One block per train / bus; a time earlier than the one before is the next day.
 */
export interface SharedConnection {
  date: string;
  from: string;
  to: string;
  legs: TripLeg[];
  url: string | null;
}

const STOP = /^(Ab|An)\s+(\d{1,2}:\d{2})\s+(.+?)(?:,\s*(?:Gleis|Gl\.|Bahnsteig|Steig)\s+(.+))?$/i;

const nextDay = (d: string) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

export function parseShareText(raw: string): SharedConnection | null {
  const lines = raw
    .replace(/\r/g, "")
    .slice(0, 20_000)
    .split("\n")
    .map((l) => l.trim());
  const dateIdx = lines.findIndex((l) => /^\d{1,2}\.\d{1,2}\.\d{4}\b/.test(l));
  if (dateIdx < 0) return null;
  const [d, m, y] = lines[dateIdx].split(/\s/)[0].split(".");
  let day = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const date = day;
  const head = lines.slice(0, dateIdx).filter(Boolean).pop() ?? "";
  const [from, to] = head.includes("→") ? head.split("→").map((s) => s.trim()) : ["", ""];

  const legs: TripLeg[] = [];
  let last = "";
  // stamps a time on the running day (after midnight → the next day)
  const at = (time: string) => {
    const hhmm = time.padStart(5, "0");
    if (last && hhmm < last) day = nextDay(day);
    last = hhmm;
    return berlinToIso(day, hhmm);
  };
  for (let i = dateIdx + 1; i < lines.length; i++) {
    const dep = STOP.exec(lines[i]);
    if (!dep || dep[1].toLowerCase() !== "ab") continue;
    // the line name is the block's first line, above "Nach …"
    let j = i - 1;
    while (j > dateIdx && (/^Nach\s/i.test(lines[j]) || !lines[j])) j--;
    const line = j > dateIdx && !STOP.test(lines[j]) ? lines[j] : null;
    const arr = STOP.exec(lines[i + 1] ?? "");
    if (!arr || arr[1].toLowerCase() !== "an") continue;
    const walking = !!line && /^(Fußweg|Fussweg|Umstieg)\b/i.test(line);
    legs.push({
      ...(line && !walking ? { lineName: line, product: productOf(line), trainNumber: trainNumberOf(line) } : {}),
      ...(walking ? { isWalking: true } : {}),
      fromName: dep[3].trim(),
      toName: arr[3].trim(),
      plannedDeparture: at(dep[2]),
      plannedArrival: at(arr[2]),
      depPlatform: dep[4]?.trim() || null,
      arrPlatform: arr[4]?.trim() || null,
    });
    i++;
  }
  if (!legs.length) return null;
  const url = /https:\/\/(?:www\.)?bahn\.de\/\S+/.exec(raw)?.[0] ?? null;
  return { date, from: from || legs[0].fromName, to: to || legs[legs.length - 1].toName, legs, url };
}
