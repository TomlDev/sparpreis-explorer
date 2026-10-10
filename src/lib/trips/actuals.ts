import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { lt } from "drizzle-orm";
import { db } from "@/db/client";
import { trips, type LegRealtime, type TripLeg, type TripRow } from "@/db/schema";
import { dbPath, pythonBin } from "@/lib/delay/job";
import { resolveEva } from "@/lib/delay/store";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { todayLocal } from "@/lib/time";
import { getTrip, updateTrip } from "./repo";
import { normalizeLeg, withRealtime } from "./realtime";
import { isRailLeg } from "./rules";

/**
 * Actual times of past trips from the open DB data: piebro/deutsche-bahn-data
 * publishes the raw Timetables API responses of every day (about a day later).
 * Per travel day we download those files, pick out our trains
 * (scripts/actuals_extract.py) and store plan + actual time on each leg.
 */

const DATASET = "piebro/deutsche-bahn-data";
const TZ = "Europe/Berlin";
/** Raw data exists from here on; older trips are marked as not available. */
const FIRST_DAY = "2024-06-01";
/** Downloads per nightly run are ~130 MB per day — older trips are filled in a few days at a time. */
const DAYS_PER_RUN = 6;

type Stop = { key: string; eva?: string; station: string; number?: string; line?: string; kind: "dp" | "ar"; planned: string };
type Hit = { found: boolean; pt?: string; ct?: string | null; cs?: string | null; codes?: string[]; final: boolean };

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const folder = (day: string) => {
  const [y, m, d] = day.split("-");
  return `raw_data/year=${y}/month=${Number(m)}/day=${Number(d)}`;
};
const stamp = (iso: string) => formatInTimeZone(new Date(iso), TZ, "yyMMddHHmm");
const fromStamp = (t: string) =>
  fromZonedTime(`20${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}T${t.slice(6, 8)}:${t.slice(8, 10)}:00`, TZ).toISOString();

/** Rail legs whose actual times are still open. */
export function needsActuals(trip: Pick<TripRow, "date" | "legs">, today = todayLocal()): boolean {
  return trip.date < today && trip.legs.some((l) => isRailLeg(l) && !normalizeLeg(l).rtOpen?.final);
}

async function listFiles(day: string): Promise<string[]> {
  const res = await fetch(`https://huggingface.co/api/datasets/${DATASET}/tree/main/${folder(day)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`Rohdaten-Verzeichnis: HTTP ${res.status}`);
  const items = (await res.json()) as { type: string; path: string }[];
  return items.filter((i) => i.type === "file" && i.path.endsWith(".parquet")).map((i) => i.path);
}

async function download(file: string, dir: string): Promise<string> {
  const target = path.join(dir, path.basename(file));
  const res = await fetch(`https://huggingface.co/datasets/${DATASET}/resolve/main/${file}`, {
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok || !res.body) throw new Error(`Download ${path.basename(file)}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(target));
  return target;
}

function extract(files: string[], stops: Stop[]): Promise<Record<string, Hit>> {
  const script = path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "actuals_extract.py");
  return new Promise((resolve, reject) => {
    const child = spawn(/*turbopackIgnore: true*/ pythonBin(), [script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Auswertung fehlgeschlagen: ${err.slice(-300) || code}`));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error("Auswertung lieferte kein JSON"));
      }
    });
    child.stdin.end(JSON.stringify({ files, stops }));
  });
}

function evaOf(id: string | null | undefined, name: string): string | undefined {
  if (id && /^\d{6,8}$/.test(id)) return id.replace(/^0+/, "");
  try {
    return resolveEva(null, name) ?? undefined;
  } catch {
    return undefined; // no punctuality build — the script matches by station name
  }
}

function stopsOf(trip: TripRow): Stop[] {
  const out: Stop[] = [];
  trip.legs.forEach((l, i) => {
    if (!isRailLeg(l)) return;
    const number = l.trainNumber || undefined;
    const line = number ? undefined : (l.lineName ?? "").replace(/\s+/g, "") || undefined;
    if (!number && !line) return;
    if (l.plannedDeparture)
      out.push({ key: `${trip.id}|${i}|dp`, eva: evaOf(l.fromId, l.fromName), station: l.fromName, number, line, kind: "dp", planned: stamp(l.plannedDeparture) });
    if (l.plannedArrival)
      out.push({ key: `${trip.id}|${i}|ar`, eva: evaOf(l.toId, l.toName), station: l.toName, number, line, kind: "ar", planned: stamp(l.plannedArrival) });
  });
  return out;
}

/** Store the script's answer as DB's data on the legs — our own live observations stay untouched. */
export function applyHits(trip: Pick<TripRow, "id" | "legs">, hits: Record<string, Hit>, checkedAt = Date.now()): TripLeg[] {
  return trip.legs.map((l, i) => {
    if (!isRailLeg(l)) return l;
    const dp = hits[`${trip.id}|${i}|dp`];
    const ar = hits[`${trip.id}|${i}|ar`];
    if (!dp && !ar) return l;
    const found = !!(dp?.found || ar?.found);
    const open: LegRealtime = {
      dep: dp?.found ? fromStamp(dp.ct || dp.pt!) : null,
      arr: ar?.found ? fromStamp(ar.ct || ar.pt!) : null,
      depCancelled: dp?.cs === "c",
      arrCancelled: ar?.cs === "c",
      codes: [...new Set([...(dp?.codes ?? []), ...(ar?.codes ?? [])])],
      missing: !found,
      final: (!dp?.found || dp.final) && (!ar?.found || ar.final),
      source: "opendata",
      checkedAt,
    };
    return withRealtime(l, { open });
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __actualsRun: Promise<unknown> | undefined;
}

/**
 * Fetch actual times for the given trips (or every past trip that still lacks
 * them, newest first, at most DAYS_PER_RUN travel days). Returns per trip id
 * whether data was found; days without published data are retried later.
 */
export async function fetchActuals(tripIds?: string[]): Promise<{ days: string[]; updated: string[]; pending: string[] }> {
  if (globalThis.__actualsRun) await globalThis.__actualsRun.catch(() => {});
  const run = (async () => {
    const today = todayLocal();
    const all = tripIds
      ? tripIds.map((id) => getTrip(id)).filter((t): t is NonNullable<typeof t> => !!t && t.date < today)
      : db.select().from(trips).where(lt(trips.date, today)).all().filter((t) => needsActuals(t, today));
    const byDay = new Map<string, TripRow[]>();
    for (const t of all) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
    const days = [...byDay.keys()].sort().reverse().slice(0, tripIds ? undefined : DAYS_PER_RUN);
    const updated: string[] = [];
    const pending: string[] = [];
    const dir = path.join(path.dirname(dbPath()), "delay-tmp", "raw");
    fs.mkdirSync(dir, { recursive: true });

    for (const day of days) {
      const list = byDay.get(day)!;
      const stops = list.flatMap(stopsOf);
      if (!stops.length) continue;
      if (day < FIRST_DAY) {
        for (const t of list) updateTrip(t.id, { legs: applyHits(t, Object.fromEntries(stops.map((s) => [s.key, { found: false, final: true }]))) });
        continue;
      }
      // The day's folder holds 03:00–00:59; trips past midnight also need the next one.
      const overnight = list.some((t) => t.legs.some((l) => l.plannedArrival && stamp(l.plannedArrival).slice(0, 6) !== stamp(`${day}T12:00:00Z`).slice(0, 6)));
      const files = [...(await listFiles(day)), ...(overnight ? await listFiles(addDays(day, 1)) : [])];
      if (!files.length) {
        pending.push(...list.map((t) => t.id));
        continue;
      }
      const local: string[] = [];
      try {
        for (const f of files) local.push(await download(f, dir));
        const hits = await extract(local, stops);
        for (const t of list) {
          updateTrip(t.id, { legs: applyHits(t, hits) });
          updated.push(t.id);
        }
      } finally {
        for (const f of local) fs.rmSync(f, { force: true });
      }
    }
    return { days, updated, pending };
  })();
  globalThis.__actualsRun = run;
  try {
    return await run;
  } finally {
    if (globalThis.__actualsRun === run) globalThis.__actualsRun = undefined;
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __actualsTimer: ReturnType<typeof setInterval> | undefined;
}

/** Once a day (from 06:00, when yesterday's raw data is usually out): fill in actual times. */
export function startActualsPolling(): void {
  if (globalThis.__actualsTimer || process.env.NODE_ENV === "test") return;
  const tick = () => {
    const today = todayLocal();
    const hour = Number(formatInTimeZone(new Date(), TZ, "H"));
    if (hour < 6 || getSetting<string>("actuals:lastRun") === today) return;
    setSetting("actuals:lastRun", today);
    fetchActuals().catch((e) => console.error("[actuals]", (e as Error).message));
  };
  globalThis.__actualsTimer = setInterval(tick, 30 * 60_000);
  globalThis.__actualsTimer.unref();
  setTimeout(tick, 60_000).unref();
}
