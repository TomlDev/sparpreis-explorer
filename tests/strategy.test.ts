import { describe, expect, it } from "vitest";
import { explorationEpsilon, exploitOrder, selectForPricing } from "@/lib/engine/strategy";
import type { SearchResult } from "@/lib/domain/result";

function cand(id: string, fvStops: number, fvMinutes: number): SearchResult {
  return {
    fingerprint: id,
    metrics: { fvStops, fvMinutes, transfers: 2, durationMin: 400 },
    headlineFv: { fromName: id, toName: id + "-x", product: "nationalExpress", minutes: fvMinutes, stops: fvStops },
  } as unknown as SearchResult;
}

describe("explorationEpsilon", () => {
  it("starts high and decays to the floor as observations grow", () => {
    const e0 = explorationEpsilon(0);
    const eMid = explorationEpsilon(200);
    const eLate = explorationEpsilon(1000);
    expect(e0).toBeGreaterThan(eMid);
    expect(eMid).toBeGreaterThan(eLate);
    expect(eLate).toBeGreaterThanOrEqual(0.15); // floor
    expect(e0).toBeLessThanOrEqual(0.6); // base
  });
});

describe("exploitOrder", () => {
  it("orders by fewest FV stops, then fewest FV minutes (shortest ICE first)", () => {
    const a = cand("a", 3, 200);
    const b = cand("b", 1, 90);
    const c = cand("c", 1, 60);
    const ordered = exploitOrder([a, b, c]);
    expect(ordered.map((r) => r.fingerprint)).toEqual(["c", "b", "a"]);
  });
});

describe("selectForPricing", () => {
  it("pure-exploit (rng high) prices the shortest ICE segments first", () => {
    const a = cand("a", 4, 300);
    const b = cand("b", 1, 60);
    const c = cand("c", 2, 120);
    const sel = selectForPricing([a, b, c], {
      budget: 2,
      totalObservations: 1000, // low epsilon
      observationsOf: () => 0,
      rng: () => 0.99, // never below epsilon -> always exploit
    });
    expect(sel.map((s) => s.result.fingerprint)).toEqual(["b", "c"]);
    expect(sel.every((s) => s.reason === "exploit")).toBe(true);
  });

  it("explores an under-observed segment when rng is below epsilon", () => {
    const a = cand("a", 1, 60); // best exploit
    const b = cand("b", 3, 300); // worst exploit but least observed
    const sel = selectForPricing([a, b], {
      budget: 1,
      totalObservations: 0, // high epsilon
      observationsOf: (r) => (r.fingerprint === "a" ? 10 : 0), // b under-observed
      rng: () => 0.0, // force explore + pick first of least-observed
    });
    expect(sel[0].reason).toBe("explore");
    expect(sel[0].result.fingerprint).toBe("b");
  });

  it("respects the budget", () => {
    const cands = [cand("a", 1, 60), cand("b", 2, 90), cand("c", 3, 120)];
    const sel = selectForPricing(cands, {
      budget: 2,
      totalObservations: 1000,
      observationsOf: () => 0,
      rng: () => 0.99,
    });
    expect(sel).toHaveLength(2);
  });
});
