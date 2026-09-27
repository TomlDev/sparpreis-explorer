import { formatTime, minutesBetween } from "@/lib/time";
import { trainKey } from "./normalize";
import type { DelayWeights, DowGroup, StatLevel, StatRow } from "./types";

/**
 * Punctuality estimate for one connection from historical open data
 * (piebro/deutsche-bahn-data, Deutsche Bahn, CC BY 4.0).
 *
 * Per rail leg we build delay distributions (departure at the boarding
 * station, arrival at the alighting station) from the most specific history
 * available — the train itself, else its line in that hour, else the line,
 * else the station — topping sparse history up with the next level
 * ("shrinkage"), with months weighted by age / season and the travel day's
 * weekday group preferred. Transfers are missed when
 *   arrival delay − departure delay of the connecting train > planned buffer.
 * Assumes independent trains (no connection holding) — an estimate from past
 * statistics, never a statement about a concrete train.
 */

export const RAIL_PRODUCTS = new Set(["nationalExpress", "national", "regionalExpress", "regional", "suburban"]);
/** Zugbindung is lifted from 20 min expected delay at the destination. */
export const FLEX_MINUTES = 20;

export interface ReliabilityLeg {
  from?: string;
  to?: string;
  basis: StatLevel | null;
  samples: number;
  cancelPct: number;
}

export interface ReliabilityTransfer {
  /** Station where the connection happens (alighting station). */
  station: string;
  /** Index into result.legs of the arriving leg. */
  afterLeg: number;
  /** Planned time between arrival and departure minus walking time. */
  bufferMin: number;
  missPct: number;
  /** Rough gap to the next train of the connecting line (from the data), if known. */
  headwayMin: number | null;
}

export interface Reliability {
  /** Everything as planned: no cancellation, every transfer holds. */
  okPct: number;
  /** ≈ chance of arriving ≥ 20 min late (incl. missed connection / cancellation). */
  flexPct: number;
  cancelPct: number;
  /** Arrival delay of the last train (if all connections hold) … */
  arrP50: number | null;
  arrP80: number | null;
  /** … at this station (the last train's destination). */
  arrAt: string | null;
  transfers: ReliabilityTransfer[];
  /** Per leg of result.legs (null for walks / non-rail legs). */
  legs: (ReliabilityLeg | null)[];
  /** Weakest basis any rail leg used ("train" best … "station" worst). */
  basis: StatLevel;
  /** All rail legs had data. */
  complete: boolean;
  /** Fewest observations behind a rail leg's estimate. */
  samples: number;
}

export interface LegLike {
  product?: string;
  lineName?: string;
  trainNumber?: string;
  fromId?: string | null;
  toId?: string | null;
  fromName: string;
  toName: string;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  durationMin: number;
  isWalking: boolean;
}

export interface StatSource {
  resolveEva(id: string | null | undefined, name: string): string | null;
  rows(level: StatLevel, eva: string, key: string): StatRow[];
}

export interface ReliabilityContext {
  travelDate: string; // yyyy-MM-dd
  /** Months of the active build ("2026-08", …). */
  months: string[];
  weights: DelayWeights;
}

// ---------------------------------------------------------------------------
// weighting
// ---------------------------------------------------------------------------

const monthIndex = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return y * 12 + (mo - 1);
};

export function dowGroup(date: string): DowGroup {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return d >= 1 && d <= 4 ? "wk" : d === 5 ? "fr" : "we";
}

/** Weight of a data month: halves every halfLife months (age vs. the newest
 *  month), boosted when it lies in the travel date's season. */
export function monthWeight(month: string, newest: string, travelDate: string, w: DelayWeights): number {
  const age = Math.max(0, monthIndex(newest) - monthIndex(month));
  let weight = Math.pow(0.5, age / w.halfLifeMonths);
  const cal = Math.abs((monthIndex(month) % 12) - (monthIndex(travelDate.slice(0, 7)) % 12));
  const dist = Math.min(cal, 12 - cal);
  if (dist === 0) weight *= w.seasonBoost;
  else if (dist === 1) weight *= 1 + (w.seasonBoost - 1) / 2;
  return weight;
}

// ---------------------------------------------------------------------------
// distributions
// ---------------------------------------------------------------------------

/** Discrete distribution: [delay minute, probability], sorted by minute. */
export type Dist = [number, number][];

interface Agg {
  dist: Dist;
  cancel: number; // rate
  samples: number; // observations (weekday-weighted, not age-weighted)
}

function aggregate(rows: StatRow[], side: "arr" | "dep", ctx: ReliabilityContext, dow: DowGroup): Agg | null {
  if (!rows.length) return null;
  const newest = ctx.months.reduce((a, b) => (b > a ? b : a), ctx.months[0] ?? rows[0].month);
  const acc = new Map<number, number>();
  let mass = 0;
  let total = 0;
  let cancelled = 0;
  let samples = 0;
  for (const r of rows) {
    const wd = r.dow === "all" || !ctx.weights.matchWeekday || r.dow === dow ? 1 : 0.25;
    const w = monthWeight(r.month, newest, ctx.travelDate, ctx.weights) * wd;
    for (const [bin, count] of side === "arr" ? r.arr : r.dep) {
      acc.set(bin, (acc.get(bin) ?? 0) + count * w);
      mass += count * w;
    }
    total += r.n * w;
    cancelled += r.cancelled * w;
    samples += r.n * wd;
  }
  if (mass <= 0) return null;
  const dist: Dist = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => [b, v / mass]);
  return { dist, cancel: total > 0 ? cancelled / total : 0, samples: Math.round(samples) };
}

/** Most specific level first; tops it up with coarser levels until minSamples. */
function blend(chain: [StatLevel, Agg | null][], minSamples: number): (Agg & { basis: StatLevel }) | null {
  const acc = new Map<number, number>();
  let mass = 0;
  let cancel = 0;
  let basis: StatLevel | null = null;
  let samples = 0;
  for (const [level, agg] of chain) {
    if (!agg || agg.samples <= 0) continue;
    const take = basis === null ? agg.samples : Math.min(agg.samples, minSamples - mass);
    if (take <= 0) break;
    for (const [b, p] of agg.dist) acc.set(b, (acc.get(b) ?? 0) + p * take);
    cancel += agg.cancel * take;
    mass += take;
    if (basis === null) {
      basis = level;
      samples = agg.samples;
    }
    if (mass >= minSamples) break;
  }
  if (!basis || mass <= 0) return null;
  const dist: Dist = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => [b, v / mass]);
  return { dist, cancel: cancel / mass, samples, basis };
}

/** P(arrival delay − departure delay > buffer). */
export function missProbability(arr: Dist, dep: Dist, buffer: number): number {
  let p = 0;
  for (const [a, pa] of arr) for (const [d, pd] of dep) if (a - d > buffer) p += pa * pd;
  return Math.min(1, p);
}

export function tailProbability(d: Dist, atLeast: number): number {
  return d.reduce((s, [b, p]) => (b >= atLeast ? s + p : s), 0);
}

export function quantile(d: Dist, q: number): number | null {
  let c = 0;
  for (const [b, p] of d) {
    c += p;
    if (c >= q - 1e-9) return b;
  }
  return d.length ? d[d.length - 1][0] : null;
}

const LEVEL_RANK: Record<StatLevel, number> = { train: 0, line_hour: 1, line: 2, station: 3 };
const round3 = (x: number) => Math.round(x * 1000) / 1000;

function daysInMonth(m: string): number {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// per connection
// ---------------------------------------------------------------------------

export function computeReliability(
  legs: LegLike[],
  src: StatSource,
  ctx: ReliabilityContext,
): Reliability | null {
  const dow = dowGroup(ctx.travelDate);
  const K = ctx.weights.minSamples;

  const side = (leg: LegLike, which: "arr" | "dep") => {
    const atName = which === "dep" ? leg.fromName : leg.toName;
    const eva = src.resolveEva(which === "dep" ? leg.fromId : leg.toId, atName);
    if (!eva) return null;
    const { number, line } = trainKey(leg);
    const hour = Number(formatTime(which === "dep" ? leg.plannedDeparture : leg.plannedArrival).slice(0, 2));
    const chain: [StatLevel, Agg | null][] = [
      ["train", number ? aggregate(src.rows("train", eva, number), which, ctx, dow) : null],
      ["line_hour", line && Number.isFinite(hour) ? aggregate(src.rows("line_hour", eva, `${line}|${hour}`), which, ctx, dow) : null],
      ["line", line ? aggregate(src.rows("line", eva, line), which, ctx, dow) : null],
      ["station", aggregate(src.rows("station", eva, ""), which, ctx, dow)],
    ];
    return blend(chain, K);
  };

  /** Trains per hour of the leg's line at its boarding station → headway. */
  const headway = (leg: LegLike): number | null => {
    const eva = src.resolveEva(leg.fromId, leg.fromName);
    const { line } = trainKey(leg);
    const hour = Number(formatTime(leg.plannedDeparture).slice(0, 2));
    if (!eva || !line || !Number.isFinite(hour)) return null;
    const rows = src.rows("line_hour", eva, `${line}|${hour}`);
    if (!rows.length) return null;
    const perDay = rows.reduce((s, r) => s + r.n / daysInMonth(r.month), 0) / rows.length;
    return perDay > 0 ? Math.round(60 / perDay) : null;
  };

  const rail = legs.map((l, i) => ({ l, i })).filter(({ l }) => !l.isWalking && RAIL_PRODUCTS.has(l.product ?? ""));
  if (!rail.length) return null;

  const legOut: (ReliabilityLeg | null)[] = legs.map(() => null);
  const dists = new Map<number, { dep: ReturnType<typeof side>; arr: ReturnType<typeof side> }>();
  let complete = true;
  let basisRank = 0;
  let samples = Infinity;
  let pNoCancel = 1;
  for (const { l, i } of rail) {
    const dep = side(l, "dep");
    const arr = side(l, "arr");
    dists.set(i, { dep, arr });
    if (!dep && !arr) {
      complete = false;
      continue;
    }
    const cancel = Math.max(dep?.cancel ?? 0, arr?.cancel ?? 0);
    const basis = [dep?.basis, arr?.basis]
      .filter((b): b is StatLevel => !!b)
      .reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a));
    const s = Math.min(dep?.samples ?? Infinity, arr?.samples ?? Infinity);
    legOut[i] = { from: l.fromName, to: l.toName, basis, samples: s, cancelPct: round3(cancel) };
    basisRank = Math.max(basisRank, LEVEL_RANK[basis]);
    samples = Math.min(samples, s);
    pNoCancel *= 1 - cancel;
    if (!dep || !arr) complete = false;
  }
  if (samples === Infinity) return null;

  const last = rail[rail.length - 1];
  const lastArr = dists.get(last.i)?.arr ?? null;
  if (!lastArr) complete = false;

  const transfers: ReliabilityTransfer[] = [];
  let pConnections = 1;
  let pNoFlexFromMisses = 1;
  for (let k = 0; k + 1 < rail.length; k++) {
    const a = rail[k];
    const b = rail[k + 1];
    const between = legs.slice(a.i + 1, b.i);
    if (between.some((l) => !l.isWalking)) continue; // bus/tram in between — not a train-to-train transfer
    const walk = between.reduce((s, l) => s + l.durationMin, 0);
    const buffer = minutesBetween(a.l.plannedArrival, b.l.plannedDeparture) - walk;
    const arr = dists.get(a.i)?.arr;
    const dep = dists.get(b.i)?.dep;
    if (!arr || !dep) continue;
    // Changing trains takes at least a minute even on the same platform.
    const miss = missProbability(arr.dist, dep.dist, walk > 0 ? buffer : buffer - 1);
    const h = headway(b.l);
    transfers.push({ station: a.l.toName, afterLeg: a.i, bufferMin: buffer, missPct: round3(miss), headwayMin: h });
    pConnections *= 1 - miss;
    // After a miss you take the next train of that line ≈ one headway later.
    const flexIfMiss = lastArr ? tailProbability(lastArr.dist, FLEX_MINUTES - (h ?? 60)) : 1;
    pNoFlexFromMisses *= 1 - miss * flexIfMiss;
  }

  const late = lastArr ? tailProbability(lastArr.dist, FLEX_MINUTES) : 0;
  const ok = pNoCancel * pConnections;
  const noFlex = pNoCancel * pNoFlexFromMisses * (1 - late);
  const basis = (Object.keys(LEVEL_RANK) as StatLevel[]).find((l) => LEVEL_RANK[l] === basisRank)!;
  return {
    okPct: round3(ok),
    flexPct: round3(1 - noFlex),
    cancelPct: round3(1 - pNoCancel),
    arrP50: lastArr ? quantile(lastArr.dist, 0.5) : null,
    arrP80: lastArr ? quantile(lastArr.dist, 0.8) : null,
    arrAt: lastArr ? last.l.toName : null,
    transfers,
    legs: legOut,
    basis,
    complete,
    samples,
  };
}
