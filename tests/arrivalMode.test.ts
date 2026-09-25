import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS, type SearchParams } from "@/lib/engine/types";
import { MockProvider } from "@/lib/rail/mock";
import type { SearchJourneysOptions } from "@/lib/rail/types";

// Arrival mode: the time window means "arrive between X and Y", so every search
// at the requested time must ask "arrive by Y" instead of "depart at X".
describe("Ankunftszeit statt Abfahrtszeit", { timeout: 20_000 }, () => {
  afterEach(() => vi.restoreAllMocks());

  async function journeyCalls(params: Partial<SearchParams>): Promise<SearchJourneysOptions[]> {
    const spy = vi.spyOn(MockProvider.prototype, "searchJourneys");
    const { ensureReady } = await import("@/lib/bootstrap");
    const { runSearch } = await import("@/lib/engine/search");
    ensureReady();
    await runSearch(
      {
        originKey: "nrw",
        destKey: "schwarzwald",
        travelDate: "2026-10-19",
        timeWindow: "14:00",
        mode: "fast",
        sort: "cheapest",
        filters: { ...DEFAULT_FILTERS },
        ...params,
      },
      { emit: () => {} },
    );
    return spy.mock.calls.map((c) => c[2]);
  }

  it("sucht 'ankommen bis' zum Fenster-Ende", async () => {
    const calls = await journeyCalls({ stage: "normal", timeMode: "arrival", timeTo: "18:00" });
    expect(calls.length).toBeGreaterThan(0);
    for (const o of calls) {
      expect(o.departure).toBeUndefined();
      expect(o.arrival?.toISOString()).toBe(new Date("2026-10-19T18:00:00+02:00").toISOString());
    }
  });

  it("legt das Ende eines Fensters über Mitternacht auf den Folgetag", async () => {
    const calls = await journeyCalls({
      stage: "normal",
      timeMode: "arrival",
      timeWindow: "23:00",
      timeTo: "01:00",
      travelDate: "2026-10-21",
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const o of calls) {
      expect(o.arrival?.toISOString()).toBe(new Date("2026-10-22T01:00:00+02:00").toISOString());
    }
  });

  it("Phase 2 bleibt an der Abfahrt der Referenz", async () => {
    const calls = await journeyCalls({
      stage: "alternatives",
      timeMode: "arrival",
      timeWindow: "07:12", // reference departure
      timeTo: "18:00",
      referencePrice: 60,
      travelDate: "2026-10-23",
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((o) => o.arrival)).toBe(false);
  });

  it("trennt Ankunfts- und Abfahrts-Cache, Abfahrts-Keys bleiben unverändert", async () => {
    const { buildCacheKey } = await import("@/lib/engine/search");
    const base: SearchParams = {
      originKey: "nrw",
      destKey: "schwarzwald",
      travelDate: "2026-10-19",
      timeWindow: "14:00",
      timeTo: "18:00",
      mode: "fast",
      sort: "cheapest",
      filters: { ...DEFAULT_FILTERS },
    };
    const dep = buildCacheKey(base);
    expect(dep).toBe(buildCacheKey({ ...base, timeMode: "departure" }));
    expect(dep.endsWith("|arr:18:00")).toBe(false);
    expect(buildCacheKey({ ...base, timeMode: "arrival" })).toBe(`${dep}|arr:18:00`);
  });
});
