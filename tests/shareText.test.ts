import { describe, expect, it } from "vitest";
import { parseShareText } from "@/lib/trips/shareText";

const TEXT = `Bochum Hbf → Rathaus, Triberg im Schwarzwald
17.11.2026

RE42 (10102)
Nach Mönchengladbach Hbf
Ab 5:34 Bochum Hbf, Gleis 4
An 5:43 Essen Hbf, Gleis 10

ICE 101
Nach Interlaken West
Ab 6:00 Essen Hbf, Gleis 2
An 9:18 Baden-Baden, Gleis 7

Bus 550
Nach Schonach Rathaus
Ab 10:50 Bahnhof, Triberg im Schwarzwald
An 11:28 Rathaus, Triberg im Schwarzwald

Verbindung ansehen:
https://www.bahn.de/buchung/start?vbid=abc%2Ddef
`;

describe("parseShareText", () => {
  it("reads the trains, times, platforms and the link", () => {
    const c = parseShareText(TEXT)!;
    expect(c.date).toBe("2026-11-17");
    expect(c.from).toBe("Bochum Hbf");
    expect(c.to).toBe("Rathaus, Triberg im Schwarzwald");
    expect(c.url).toBe("https://www.bahn.de/buchung/start?vbid=abc%2Ddef");
    expect(c.legs).toHaveLength(3);
    expect(c.legs[0]).toMatchObject({
      lineName: "RE42 (10102)",
      trainNumber: "10102",
      product: "regionalExpress",
      fromName: "Bochum Hbf",
      toName: "Essen Hbf",
      depPlatform: "4",
      arrPlatform: "10",
      plannedDeparture: "2026-11-17T04:34:00.000Z",
      plannedArrival: "2026-11-17T04:43:00.000Z",
    });
    expect(c.legs[1]).toMatchObject({ lineName: "ICE 101", product: "nationalExpress", depPlatform: "2", arrPlatform: "7" });
    // a bus stop keeps the comma in its name and has no platform
    expect(c.legs[2]).toMatchObject({
      lineName: "Bus 550",
      product: "bus",
      fromName: "Bahnhof, Triberg im Schwarzwald",
      toName: "Rathaus, Triberg im Schwarzwald",
      depPlatform: null,
      arrPlatform: null,
    });
  });

  it("rolls over midnight", () => {
    const c = parseShareText(`A → B\n21.11.2026\n\nICE 1\nNach X\nAb 23:10 A, Gleis 1\nAn 0:20 B, Gleis 2\n`)!;
    expect(c.legs[0].plannedDeparture).toBe("2026-11-21T22:10:00.000Z");
    expect(c.legs[0].plannedArrival).toBe("2026-11-21T23:20:00.000Z");
  });

  it("is null for other text", () => {
    expect(parseShareText("Hallo, wie geht's?")).toBeNull();
    expect(parseShareText("17.11.2026\nnichts weiter")).toBeNull();
  });
});
