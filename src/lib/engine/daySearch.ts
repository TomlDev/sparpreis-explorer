import { cents, samePriceOrder } from "@/lib/domain/ranking";
import type { SearchResult } from "@/lib/domain/result";
import { runSearch, type RunOptions } from "./search";
import type { SearchEvent, SearchMeta, SearchParams } from "./types";

/**
 * Departure slots of a whole-day scan. A search covers roughly 1.5 h before to
 * 2.5 h after its anchor, so every 3 h leaves no gap between 05:00 and ~22:30.
 */
export const DAY_SLOTS = ["05:00", "08:00", "11:00", "14:00", "17:00", "20:00"];

/** Keep the priced version of a connection when slots return it twice. */
export function mergeResults(into: Map<string, SearchResult>, results: SearchResult[]): void {
  for (const r of results) {
    const prev = into.get(r.fingerprint);
    if (!prev || r.coverage.price != null || prev.coverage.price == null) into.set(r.fingerprint, r);
  }
}

/** Cheapest first; same price → likelier to lose the Zugbindung first (see samePriceOrder). */
export function byPrice(results: Iterable<SearchResult>): SearchResult[] {
  return [...results].sort((a, b) => cents(a.coverage.price) - cents(b.coverage.price) || samePriceOrder(a, b));
}

/**
 * Whole day in one go: the normal full search once per slot, one after the
 * other (keeps DB traffic low), merged into one list sorted by price. The
 * filters (e.g. one Fernverkehr leg, minimum Flex chance) also steer which
 * candidates get a price check in every slot.
 */
export async function runDaySearch(params: SearchParams, opts: RunOptions): Promise<void> {
  const { emit, signal } = opts;
  const all = new Map<string, SearchResult>();
  let lastMeta: SearchMeta | null = null;
  // DB / MOTIS calls of the finished slots (each slot's meta counts its own).
  let doneDb = 0;
  let doneMotis = 0;
  let failed = 0;

  const totals = (m: SearchMeta): SearchMeta => {
    const prices = [...all.values()].map((r) => r.coverage.price).filter((p): p is number => p != null);
    return {
      ...m,
      dbUsed: doneDb + m.dbUsed,
      motisUsed: doneMotis + m.motisUsed,
      pricedCount: prices.length,
      bestPrice: prices.length ? Math.min(...prices) : null,
    };
  };

  for (const [i, slot] of DAY_SLOTS.entries()) {
    if (signal?.aborted) break;
    const label = `Zeitfenster ${i + 1}/${DAY_SLOTS.length} (ab ${slot})`;
    let slotMeta: SearchMeta | null = null;
    const onEvent = (e: SearchEvent) => {
      if (e.type === "progress") return emit(e);
      if (e.type === "status") return emit({ ...e, message: `${label}: ${e.message}` });
      slotMeta = e.meta;
      lastMeta = e.meta;
      mergeResults(all, e.results);
      if (e.type === "error") {
        failed++;
        emit({ type: "status", message: `${label}: ${e.message}`, meta: totals(e.meta) });
      } else if (e.type !== "done") {
        emit({ type: "results", results: byPrice(all.values()), meta: totals(e.meta) });
      }
    };
    try {
      await runSearch(
        { ...params, timeWindow: slot, timeTo: undefined, timeMode: "departure", stage: "full", daySlot: true },
        { emit: onEvent, signal },
      );
    } catch {
      failed++;
    }
    const m = slotMeta as SearchMeta | null;
    if (m) {
      doneDb += m.dbUsed;
      doneMotis += m.motisUsed;
      if (m.dailyCapReached) break; // no more price checks today
    }
  }

  const results = byPrice(all.values());
  const meta = lastMeta as SearchMeta | null;
  if (!meta) {
    emit({ type: "status", message: "Die Suche über den Tag hat nichts geliefert." });
    return;
  }
  const final = { ...totals(meta), dbUsed: doneDb, motisUsed: doneMotis };
  if (failed === DAY_SLOTS.length && !results.length)
    emit({ type: "error", message: "Die Suche über den Tag ist fehlgeschlagen.", results, meta: final });
  else emit({ type: "done", results, meta: final });
}
