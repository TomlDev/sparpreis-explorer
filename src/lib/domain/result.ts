import type { Reliability } from "@/lib/delay/reliability";
import type { NormJourney, NormLeg } from "@/lib/rail/types";
import { minutesBetween } from "@/lib/time";
import { analyzeJourney, type JourneyMetrics } from "./analyze";
import { journeyFingerprint, journeyRouteSignature } from "./fingerprint";
import { legChainLabel, isLongDistanceLeg, legStopCount, productLabel } from "./products";
import { assessCoverage, type CoverageResult } from "./ticketCoverage";

export type ResultKind = "anchor" | "normal" | "alternative" | "proforma";
/** Search that produced the shown price: plain O→D, without ICE, forced Zwischenhalte, per-Abschnitt pro-forma. */
export type PriceHow = "plain" | "lowfv" | "via" | "proforma";

/** "Original" = what DB itself proposes for a plain Start→Ziel search. */
export function isOriginalKind(k: string | null | undefined): boolean {
  return k === "normal" || k === "anchor";
}

export interface FvSegment {
  product: string;
  productLabel: string;
  lineName: string;
  fromName: string;
  toName: string;
  minutes: number;
  stops: number;
}

export interface LegView {
  product?: string;
  productLabel: string;
  lineName?: string;
  trainNumber?: string;
  /** Provider station ids (EVA for DB) — used to match punctuality data. */
  fromId?: string | null;
  toId?: string | null;
  fromName: string;
  toName: string;
  plannedDeparture: string | null;
  plannedArrival: string | null;
  durationMin: number;
  isLongDistance: boolean;
  isWalking: boolean;
  stops: number;
}

export interface SearchResult {
  fingerprint: string;
  routeSignature: string;
  metrics: JourneyMetrics;
  coverage: CoverageResult;
  chainLabel: string;
  legs: LegView[];
  fvSegments: FvSegment[];
  headlineFv: FvSegment | null;
  refreshToken: string | null;
  priceCheckedAt: number | null;
  timetableAt: number | null;
  variant: "primary" | "fallback";
  variantLabel: string | null;
  reasons: string[];
  score: number;
  source: "cache" | "live" | "candidate";
  /** anchor = DB best price, normal = plain DB search (the "original" DB
   *  suggestions), alternative = DB journey from a constructed search (low-FV,
   *  via-forced, MOTIS route), proforma = per-Abschnitt / leave-earlier trick. */
  resultKind: ResultKind;
  /** How the shown price was found — the kind alone can be "normal" for a pro-forma price. */
  priceHow?: PriceHow | null;
  /** € cheaper than the day's anchor/best price (positive = cheaper). */
  savingsVsAnchor: number | null;
  /** true when a pro-forma candidate actually beats the anchor. */
  isProformaWin: boolean;
  /** Punctuality estimate from historical open data (null = no data loaded). */
  reliability?: Reliability | null;
}

export function legViews(journey: NormJourney): LegView[] {
  return journey.legs.map((l) => ({
    product: l.product,
    productLabel: productLabel(l.product),
    lineName: l.lineName,
    trainNumber: l.trainNumber,
    fromId: l.origin.id ?? null,
    toId: l.destination.id ?? null,
    fromName: l.origin.name,
    toName: l.destination.name,
    plannedDeparture: l.plannedDeparture ?? l.departure ?? null,
    plannedArrival: l.plannedArrival ?? l.arrival ?? null,
    durationMin: minutesBetween(
      l.plannedDeparture ?? l.departure,
      l.plannedArrival ?? l.arrival,
    ),
    isLongDistance: isLongDistanceLeg(l),
    isWalking: l.isWalking,
    stops: legStopCount(l),
  }));
}

export function fvSegments(journey: NormJourney): FvSegment[] {
  return journey.legs.filter(isLongDistanceLeg).map((l) => ({
    product: l.product!,
    productLabel: productLabel(l.product),
    lineName: l.lineName ?? productLabel(l.product),
    fromName: l.origin.name,
    toName: l.destination.name,
    minutes: minutesBetween(
      l.plannedDeparture ?? l.departure,
      l.plannedArrival ?? l.arrival,
    ),
    stops: legStopCount(l) + 1,
  }));
}

export interface BuildResultContext {
  variant?: "primary" | "fallback";
  variantLabel?: string | null;
  source?: SearchResult["source"];
  priceCheckedAt?: number | null;
  timetableAt?: number | null;
  /** Requested O→D names — used to verify a priced journey really covers them. */
  expected?: { fromName?: string; toName?: string };
  resultKind?: ResultKind;
  /** The user holds a Deutschlandticket: regional trains outside a ticket's span are covered. */
  deutschlandTicket?: boolean;
}

export function buildResult(
  journey: NormJourney,
  ctx: BuildResultContext = {},
): SearchResult {
  const metrics = analyzeJourney(journey);
  const coverage = assessCoverage(journey, ctx.expected, { deutschlandTicket: ctx.deutschlandTicket });
  const segs = fvSegments(journey);
  const headline =
    segs.length > 0
      ? segs.reduce((a, b) => (b.minutes < a.minutes ? b : a))
      : null;

  const reasons = intrinsicReasons(metrics, coverage, segs);

  return {
    fingerprint: journeyFingerprint(journey),
    routeSignature: journeyRouteSignature(journey),
    metrics,
    coverage,
    chainLabel: legChainLabel(journey.legs),
    legs: legViews(journey),
    fvSegments: segs,
    headlineFv: headline,
    refreshToken: journey.refreshToken ?? null,
    priceCheckedAt: ctx.priceCheckedAt ?? null,
    timetableAt: ctx.timetableAt ?? null,
    variant: ctx.variant ?? "primary",
    variantLabel: ctx.variantLabel ?? null,
    reasons,
    score: 0, // filled by ranking
    source: ctx.source ?? "live",
    resultKind: ctx.resultKind ?? "normal",
    priceHow: journey.price?.how ?? null,
    savingsVsAnchor: null, // annotated by the engine once the anchor is known
    isProformaWin: false,
  };
}

function intrinsicReasons(
  m: JourneyMetrics,
  c: CoverageResult,
  segs: FvSegment[],
): string[] {
  const out: string[] = [];
  if (segs.length === 1 && segs[0].stops <= 1) {
    out.push(`nur ${segs[0].stops} Fernverkehrshalt`);
  } else if (m.fvStops > 0 && m.fvStops <= 2) {
    out.push(`nur ${m.fvStops} Fernverkehrshalte`);
  }
  if (m.fvPercent > 0 && m.fvPercent < 10) {
    out.push(`Fernverkehrsanteil nur ${m.fvPercent.toLocaleString("de-DE")} %`);
  }
  if (c.coverage === "green") out.push("vollständiges Start-Ziel-Ticket bestätigt");
  return out;
}
