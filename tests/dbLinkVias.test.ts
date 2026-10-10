import { describe, expect, it } from "vitest";
import { bahnDeLink, FV_CODES, NV_CODES, viaPlan } from "@/lib/dbLink";

const hash = (url: string) => new URLSearchParams(url.split("#")[1]);

describe("„Bei DB prüfen“ mit Zwischenhalten", () => {
  it("Pro-Forma: Nahverkehr – nur Fernverkehr zwischen A und B – Nahverkehr", () => {
    const plan = viaPlan("proforma", { fromName: "Mannheim Hbf", toName: "Offenburg" }, "Bochum Hbf", "Triberg");
    expect(plan).toEqual({ vias: [{ name: "Mannheim Hbf", nextProducts: FV_CODES }, { name: "Offenburg", nextProducts: NV_CODES }], firstProducts: NV_CODES });
    const url = bahnDeLink("Bochum Hbf", "Triberg", "2026-12-11T13:42:00Z", undefined, {
      vias: [{ lid: "A=1@L=8000244@", name: "Mannheim Hbf", nextProducts: FV_CODES }, { lid: "A=1@L=8000290@", name: "Offenburg", nextProducts: NV_CODES }],
      firstProducts: NV_CODES,
    });
    const q = hash(url);
    expect(JSON.parse(q.get("hz")!)).toEqual([
      ["A=1@L=8000244@", "Mannheim Hbf", 0, "00,01,02"],
      ["A=1@L=8000290@", "Offenburg", 0, "03,04,05,06,07,08,09"],
    ]);
    expect(q.get("vm")).toBe("03,04,05,06,07,08,09");
    expect(q.get("hd")).toBe("2026-12-11T14:42:00");
  });

  it("Fernverkehr ab dem Start: erster Abschnitt Fernverkehr, nur ein Zwischenhalt", () => {
    expect(viaPlan("proforma", { fromName: "Bochum Hbf", toName: "Köln Hbf" }, "Bochum Hbf", "Bonn Hbf")).toEqual({
      vias: [{ name: "Köln Hbf", nextProducts: NV_CODES }],
      firstProducts: FV_CODES,
    });
  });

  it("über Zwischenhalte bepreiste Alternative: 5 min Aufenthalt am ersten, alle Verkehrsmittel", () => {
    expect(viaPlan("alternative", { fromName: "Köln Hbf", toName: "Siegburg/Bonn" }, "Bochum Hbf", "Bonn Hbf")).toEqual({
      vias: [{ name: "Köln Hbf", dwell: 5 }, { name: "Siegburg/Bonn", dwell: 0 }],
    });
    expect(viaPlan("normal", { fromName: "Köln Hbf", toName: "Siegburg/Bonn" }, "Bochum Hbf", "Bonn Hbf")).toBeNull();
    expect(hash(bahnDeLink("A", "B", null)).get("hz")).toBe("[]");
    // the same with the stored price kind "via"
    expect(viaPlan("via", { fromName: "Köln Hbf", toName: "Siegburg/Bonn" }, "Bochum Hbf", "Bonn Hbf")?.vias).toHaveLength(2);
  });

  it("ohne ICE bepreist: bahn.de ohne ICE suchen, BahnCard aus den Einstellungen", () => {
    expect(viaPlan("lowfv", null, "Bochum Hbf", "Bonn Hbf")).toEqual({ vias: [], firstProducts: ["01", "02", "03", "04", "05", "06", "07", "08", "09"] });
    const q = hash(bahnDeLink("A", "B", null, undefined, { traveller: { bahncard: "BC25", klasse: 2 } }));
    expect(q.get("r")).toBe("13:17:KLASSE_2:1");
    expect(hash(bahnDeLink("A", "B", null, undefined, { traveller: { bahncard: "BC50", klasse: 1 } })).get("r")).toBe("13:23:KLASSE_1:1");
  });
});
