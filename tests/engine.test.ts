import { describe, expect, it } from "vitest";
import { reverseSearchParams, shouldTryFallback } from "@/lib/engine/search";
import { DEFAULT_FILTERS, type SearchEvent, type SearchParams } from "@/lib/engine/types";

describe("Reverse Route", () => {
  it("dreht Start-/Zielprofile und Ad-hoc-Endpunkte", () => {
    const p: SearchParams = {
      originKey: "nrw",
      destKey: "schwarzwald",
      originId: "a",
      originName: "A",
      destId: "b",
      destName: "B",
      travelDate: "2026-10-18",
      timeWindow: "morning",
      mode: "thorough",
      sort: "proforma",
      filters: DEFAULT_FILTERS,
    };
    const r = reverseSearchParams(p);
    expect(r.originKey).toBe("schwarzwald");
    expect(r.destKey).toBe("nrw");
    expect(r.originId).toBe("b");
    expect(r.destName).toBe("A");
  });
});

describe("Fallback (Hbf)", () => {
  it("prüft Fallback wenn Primär keinen brauchbaren Preis liefert", () => {
    expect(
      shouldTryFallback({
        useFallback: true,
        hasFallback: true,
        primaryUsable: false,
        mode: "fast",
        requestsUsed: 1,
        budget: 10,
      }),
    ).toBe(true);
  });

  it("kein Fallback im Schnellmodus wenn Primär brauchbar ist", () => {
    expect(
      shouldTryFallback({
        useFallback: true,
        hasFallback: true,
        primaryUsable: true,
        mode: "fast",
        requestsUsed: 1,
        budget: 10,
      }),
    ).toBe(false);
  });

  it("kein Fallback wenn deaktiviert oder Budget erschöpft", () => {
    expect(
      shouldTryFallback({ useFallback: false, hasFallback: true, primaryUsable: false, mode: "deep", requestsUsed: 1, budget: 10 }),
    ).toBe(false);
    expect(
      shouldTryFallback({ useFallback: true, hasFallback: true, primaryUsable: false, mode: "deep", requestsUsed: 10, budget: 10 }),
    ).toBe(false);
  });
});

// Runs the full engine (rate limiter + jitter) — ~2 s per test alone, slower
// when the test files run in parallel, so give it headroom over the 5 s default.
describe("Integration (mock provider)", { timeout: 20_000 }, () => {
  it("findet das durchgehende 18,99-€-Pro-Forma-Ticket und filtert Teilstrecken", async () => {
    const { ensureReady } = await import("@/lib/bootstrap");
    const { runSearch } = await import("@/lib/engine/search");
    ensureReady();

    const events: SearchEvent[] = [];
    await runSearch(
      {
        originKey: "nrw",
        destKey: "schwarzwald",
        travelDate: "2026-10-18",
        timeWindow: "morning",
        mode: "thorough",
        sort: "proforma",
        filters: { ...DEFAULT_FILTERS },
      },
      { emit: (e) => events.push(e) },
    );

    const done = events.find((e) => e.type === "done");
    expect(done).toBeTruthy();
    const results = done!.type === "done" ? done!.results : [];
    expect(results.length).toBeGreaterThan(0);

    // The pro-forma gem is present, green, and ranked first.
    const prices = results.map((r) => r.coverage.price);
    expect(prices).toContain(18.99);
    expect(results[0].coverage.price).toBe(18.99);
    expect(results[0].coverage.coverage).toBe("green");

    // The 15.00 € partial-coverage trap must be filtered out (onlyFullTicket).
    expect(prices).not.toContain(15);

    // Every result carries at least one Fernverkehr leg.
    expect(results.every((r) => r.metrics.fvLegs >= 1)).toBe(true);
  });

  it("liefert beim zweiten Lauf sofort gecachte Ergebnisse", async () => {
    const { runSearch } = await import("@/lib/engine/search");
    const events: SearchEvent[] = [];
    await runSearch(
      {
        originKey: "nrw",
        destKey: "schwarzwald",
        travelDate: "2026-10-18",
        timeWindow: "morning",
        mode: "thorough",
        sort: "proforma",
        filters: { ...DEFAULT_FILTERS },
      },
      { emit: (e) => events.push(e) },
    );
    // A cached event should now precede the live refresh.
    expect(events.some((e) => e.type === "cached")).toBe(true);
  });
});
