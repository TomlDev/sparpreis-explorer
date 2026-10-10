import { describe, expect, it } from "vitest";
import type { SearchResult } from "@/lib/domain/result";
import { DEFAULT_FILTERS } from "@/lib/engine/types";
import { filterReason } from "@/lib/viewFilter";

const r = (okPct: number | null) =>
  ({
    fingerprint: "x",
    legs: [],
    coverage: { coverage: "green", price: 20 },
    metrics: { durationMin: 60, transfers: 3, fvMinutes: 30, fvStops: 1, fvLegs: 1, minTransferMin: 5 },
    reliability: okPct == null ? null : { okPct, flexPct: 0.5 },
  }) as unknown as SearchResult;
const ctx = (maxOkPct: number | null) => ({
  filters: { ...DEFAULT_FILTERS, onlyFullTicket: false, belowReference: false, maxOkPct },
  reference: null,
  refLeadKeys: null,
  window: null,
  anyPriced: true,
});

describe("Filter: max. Anschluss-Quote", () => {
  it("blendet Verbindungen aus, deren Umstiege zu wahrscheinlich klappen", () => {
    expect(filterReason(r(0.08), ctx(10))).toBeNull();
    expect(filterReason(r(0.18), ctx(10))).toMatch(/Anschluss-Quote zu hoch \(18 % > 10 %\)/);
    expect(filterReason(r(null), ctx(10))).toMatch(/keine Pünktlichkeitsdaten/);
    expect(filterReason(r(0.9), ctx(null))).toBeNull();
  });
});
