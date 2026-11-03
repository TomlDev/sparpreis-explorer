import { describe, expect, it } from "vitest";
import { activeFilters, DEFAULT_FILTERS } from "@/lib/engine/types";
import { reasonFilterKey } from "@/lib/viewFilter";
import { parseView, serializeView, DEFAULT_VIEW } from "@/lib/viewState";

const f = { ...DEFAULT_FILTERS, maxPrice: 40, minFlexPct: 65, maxOkPct: 30, maxFvLegs: 1, belowReference: true };

describe("Filter kurz ausschalten", () => {
  it("ein ausgeschalteter Filter filtert nicht, sein Wert bleibt", () => {
    const a = activeFilters(f, ["maxPrice"]);
    expect(a.maxPrice).toBeNull();
    expect(a.minFlexPct).toBe(65);
    expect(f.maxPrice).toBe(40);
  });

  it("„alle aus“ hebt alle Grenzen auf, aber nicht: durchgehendes Ticket, Fernverkehr", () => {
    const a = activeFilters(f, ["all"]);
    expect([a.maxPrice, a.minFlexPct, a.maxOkPct, a.maxFvLegs, a.belowReference]).toEqual([null, null, null, 0, false]);
    expect([a.onlyFullTicket, a.requireFv, a.onlyPriced]).toEqual([true, true, true]);
  });

  it("der Grund „ausgeblendet weil …“ zeigt auf den Filter dahinter", () => {
    expect(reasonFilterKey("Preis über Max. (41,29 € > 40,00 €)")).toBe("maxPrice");
    expect(reasonFilterKey("Flex-Chance zu niedrig (20 % < 25 %)")).toBe("minFlexPct");
    expect(reasonFilterKey("keine Pünktlichkeitsdaten (Anschluss-Filter)")).toBe("maxOkPct");
    expect(reasonFilterKey("Abfahrt 10:45 außerhalb 05:00–10:00")).toBeNull();
  });

  it("steht in der URL", () => {
    const q = serializeView({ ...DEFAULT_VIEW, filters: f, off: ["minFlexPct", "maxPrice"] });
    expect(q).toContain("off=maxPrice,minFlexPct");
    expect(parseView(q).off.sort()).toEqual(["maxPrice", "minFlexPct"]);
    expect(parseView("off=all,unsinn").off).toEqual(["all"]);
  });
});
