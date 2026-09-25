import { describe, expect, it } from "vitest";
import { buildResult, type SearchResult } from "@/lib/domain/result";
import { DEFAULT_FILTERS } from "@/lib/engine/types";
import { clientFilter, filterReason, refLeadKeysFor, timeFilterWindow, type FilterContext } from "@/lib/viewFilter";
import { journey, leg } from "./helpers";

// helpers.leg() counts minutes from 06:00 on 2026-10-18.
function res(
  legs: Parameters<typeof journey>[0],
  price: number | null,
  kind: SearchResult["resultKind"] = "normal",
): SearchResult {
  return buildResult(journey(legs, price, { fullRoute: true }), { resultKind: kind });
}

const reference = res(
  [leg("regional", "Langendreer", "Bochum Hbf", 0, 20), leg("nationalExpress", "Bochum Hbf", "Köln", 30, 90)],
  63,
);
const sameStart = res(
  [
    leg("regional", "Langendreer", "Bochum Hbf", 0, 20),
    leg("regional", "Bochum Hbf", "Essen", 25, 40),
    leg("nationalExpress", "Essen", "Köln", 45, 100),
  ],
  28.54,
  "proforma",
);
const otherStart = res(
  [leg("regional", "Langendreer", "Bochum Hbf", 60, 80), leg("nationalExpress", "Bochum Hbf", "Köln", 90, 150)],
  25,
);

const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
  filters: DEFAULT_FILTERS,
  reference: null,
  refLeadKeys: null,
  window: null,
  anyPriced: true,
  ...over,
});

describe("Sichtbarkeit (gemeinsam mit npm run view)", () => {
  it("zeigt nur Alternativen mit denselben ersten Zügen wie die Referenz, und nur günstigere", () => {
    const c = ctx({ reference: 63, refLeadKeys: refLeadKeysFor(reference) });
    expect(filterReason(sameStart, c)).toBeNull();
    expect(filterReason(otherStart, c)).toMatch(/andere ersten Züge/);
    expect(filterReason(reference, c)).toMatch(/nicht günstiger als Referenz/);
  });

  it("nennt den Grund für 'Nur Original (DB)'", () => {
    const c = ctx({ filters: { ...DEFAULT_FILTERS, onlyOriginal: true } });
    expect(filterReason(sameStart, c)).toBe("nur Original (DB) – Art: proforma");
    expect(filterReason(otherStart, c)).toBeNull();
  });

  it("prüft im Ankunftsmodus die Ankunft gegen das Fenster", () => {
    // reference arrives 07:30 (06:00 + 90 min)
    expect(filterReason(reference, ctx({ window: timeFilterWindow("07:00", "08:00", "arrival") }))).toBeNull();
    expect(filterReason(reference, ctx({ window: timeFilterWindow("06:00", "06:30", "arrival") }))).toMatch(
      /Ankunft 07:30 außerhalb 06:00–06:30/,
    );
  });

  it("clientFilter behält genau die Verbindungen ohne Grund", () => {
    const all = [reference, sameStart, otherStart];
    const shown = clientFilter(all, DEFAULT_FILTERS, 63, refLeadKeysFor(reference), null);
    expect(shown.map((r) => r.fingerprint)).toEqual([sameStart.fingerprint]);
  });
});
