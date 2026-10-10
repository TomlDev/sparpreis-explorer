import { ensureReady } from "@/lib/bootstrap";
import { type SearchMode } from "@/lib/config";
import { runDaySearch } from "@/lib/engine/daySearch";
import { runSearch } from "@/lib/engine/search";
import { DEFAULT_FILTERS, type SearchFilters, type SearchParams } from "@/lib/engine/types";
import { todayLocal } from "@/lib/time";
import type { SortMode } from "@/lib/domain/ranking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeMode(m: unknown): SearchMode {
  return m === "fast" || m === "deep" ? m : "thorough";
}

function normalizeSort(s: unknown): SortMode {
  const allowed: SortMode[] = [
    "proforma",
    "cheapest",
    "fastest",
    "least-fv",
    "fewest-transfers",
    "tight-transfers",
    "unreliable",
    "cheap-flex",
  ];
  return allowed.includes(s as SortMode) ? (s as SortMode) : "proforma";
}

function normalizeFilters(f: unknown): SearchFilters {
  const o = (f ?? {}) as Partial<SearchFilters>;
  const num = (v: unknown): number | null =>
    v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);
  return {
    onlyFullTicket: o.onlyFullTicket ?? DEFAULT_FILTERS.onlyFullTicket,
    onlyPriced: o.onlyPriced ?? DEFAULT_FILTERS.onlyPriced,
    requireFv: o.requireFv ?? DEFAULT_FILTERS.requireFv,
    maxFvLegs: o.maxFvLegs === undefined ? DEFAULT_FILTERS.maxFvLegs : num(o.maxFvLegs),
    belowReference: o.belowReference ?? DEFAULT_FILTERS.belowReference,
    onlyOriginal: o.onlyOriginal ?? DEFAULT_FILTERS.onlyOriginal,
    allowICE: o.allowICE ?? DEFAULT_FILTERS.allowICE,
    allowIC: o.allowIC ?? DEFAULT_FILTERS.allowIC,
    maxPrice: num(o.maxPrice),
    maxDurationMin: num(o.maxDurationMin),
    maxTransfers: num(o.maxTransfers),
    maxFvMinutes: num(o.maxFvMinutes),
    maxFvStops: num(o.maxFvStops),
    useFallback: o.useFallback ?? DEFAULT_FILTERS.useFallback,
    allowSlow: o.allowSlow ?? DEFAULT_FILTERS.allowSlow,
    minTransferMin: num(o.minTransferMin),
    minFlexPct: num(o.minFlexPct),
  };
}

export async function POST(req: Request) {
  ensureReady();
  const body = await req.json().catch(() => ({}));

  const params: SearchParams = {
    originKey: body.originKey || undefined,
    destKey: body.destKey || undefined,
    originId: body.originId || undefined,
    originName: body.originName || undefined,
    destId: body.destId || undefined,
    destName: body.destName || undefined,
    travelDate: typeof body.travelDate === "string" ? body.travelDate : todayLocal(),
    timeWindow: typeof body.timeWindow === "string" ? body.timeWindow : "morning",
    timeTo: typeof body.timeTo === "string" ? body.timeTo : undefined,
    timeMode: body.timeMode === "arrival" ? "arrival" : "departure",
    mode: normalizeMode(body.mode),
    sort: normalizeSort(body.sort),
    filters: normalizeFilters(body.filters),
    restoreOnly: body.restoreOnly === true,
    morePrices: body.morePrices === true,
    stage: body.stage === "normal" || body.stage === "alternatives" ? body.stage : "full",
    referencePrice: typeof body.referencePrice === "number" ? body.referencePrice : null,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      // Coalesce rapid progressive "results" snapshots (each re-sends the full
      // set) so the stream stays small — the final "done" carries the full state.
      let lastResultsAt = 0;
      const emit = (event: { type?: string }) => {
        if (event?.type === "results") {
          const now = Date.now();
          if (now - lastResultsAt < 600) return; // drop; a later snapshot supersedes it
          lastResultsAt = now;
        }
        send(event);
      };
      try {
        if (body.scope === "day") {
          // Whole day: the fast mode skips the one-Fernverkehr-leg pricing, so at least "gründlich".
          const mode = params.mode === "deep" ? "deep" : "thorough";
          await runDaySearch({ ...params, mode, sort: "cheapest" }, { emit, signal: req.signal });
        } else await runSearch(params, { emit, signal: req.signal });
      } catch (err) {
        send({ type: "error", message: (err as Error).message, results: [], meta: null });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
