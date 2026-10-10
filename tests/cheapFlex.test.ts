import { describe, expect, it } from "vitest";
import { cheapFlexOrder } from "@/lib/domain/ranking";
import type { SearchResult } from "@/lib/domain/result";

const r = (id: string, price: number | null, flex: number | null) =>
  ({ fingerprint: id, coverage: { price }, reliability: flex == null ? null : { flexPct: flex } }) as unknown as SearchResult;

describe("Günstig & oft Flex", () => {
  it("zeigt zuerst die Verbindungen, zu denen es keine günstigere mit höherer Flex-Chance gibt", () => {
    const list = [
      r("teuer-sicher", 80, 0.1), // dominated by everything cheaper and riskier
      r("billig", 10, 0.2),
      r("mittel-riskant", 30, 0.6),
      r("billig-riskanter", 12, 0.4),
      r("teuer-riskant", 60, 0.7),
      r("mittel-sicher", 30, 0.3), // dominated by billig-riskanter
      r("ohne-daten", 5, null),
      r("ohne-preis", null, 0.9),
    ];
    expect(cheapFlexOrder(list).map((x) => x.fingerprint)).toEqual([
      // front, by price
      "billig", "billig-riskanter", "mittel-riskant", "teuer-riskant",
      // second layer
      "mittel-sicher",
      // third layer
      "teuer-sicher",
      // no price or no punctuality data: last, most likely Flex first
      "ohne-preis", "ohne-daten",
    ]);
  });
});
