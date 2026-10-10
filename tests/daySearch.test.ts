import { describe, expect, it } from "vitest";
import type { SearchResult } from "@/lib/domain/result";
import { byPrice, DAY_SLOTS, mergeResults } from "@/lib/engine/daySearch";

const r = (fp: string, price: number | null, fvMinutes = 30, flex = 0.5) =>
  ({ fingerprint: fp, coverage: { price }, metrics: { fvMinutes }, reliability: { flexPct: flex } }) as unknown as SearchResult;

describe("Flex-Tag", () => {
  it("deckt den Tag lückenlos ab (Abstand ≤ 3 h, ab 5 Uhr)", () => {
    const min = DAY_SLOTS.map((s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3)));
    expect(min[0]).toBeLessThanOrEqual(5 * 60);
    for (let i = 1; i < min.length; i++) expect(min[i] - min[i - 1]).toBeLessThanOrEqual(180);
  });

  it("behält den Preis, wenn ein späteres Zeitfenster dieselbe Verbindung ohne Preis liefert", () => {
    const all = new Map<string, SearchResult>();
    mergeResults(all, [r("a", 29.99)]);
    mergeResults(all, [r("a", null), r("b", null)]);
    expect(all.get("a")!.coverage.price).toBe(29.99);
    mergeResults(all, [r("b", 19.99)]);
    expect(all.get("b")!.coverage.price).toBe(19.99);
  });

  it("sortiert nach Preis, bei Gleichstand kürzerer Fernverkehr und höhere Flex-Chance zuerst", () => {
    const list = byPrice([r("teuer", 40), r("ohne", null), r("lang", 20, 90), r("kurz", 20, 15, 0.5), r("kurz-flex", 20, 15, 0.8)]);
    expect(list.map((x) => x.fingerprint)).toEqual(["kurz-flex", "kurz", "lang", "teuer", "ohne"]);
  });
});
