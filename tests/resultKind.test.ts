import { describe, expect, it } from "vitest";
import { journey, leg } from "./helpers";

// "Nur Original (DB)" relies on resultKind surviving the cache round-trip:
// restored results used to default to "normal" and slipped through the filter.
describe("resultKind überlebt den Cache", () => {
  it("speichert die Art, hält DB-Originale fest und stuft Altdaten nicht als Original ein", async () => {
    const { ensureReady } = await import("@/lib/bootstrap");
    ensureReady();
    const { buildResult } = await import("@/lib/domain/result");
    const { saveJourneyResult, loadResults } = await import("@/lib/repo/journeys");
    const { db } = await import("@/db/client");
    const { journeys } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const day = "2026-10-18";

    // A pro-forma construction stays pro-forma after reload.
    const pf = journey(
      [
        leg("regional", "A", "B", 0, 60),
        leg("nationalExpress", "B", "C", 65, 80, { trainNumber: "1" }),
        leg("regional", "C", "D", 85, 200),
      ],
      21.79,
      { fullRoute: true },
    );
    const pfRes = buildResult(pf, { resultKind: "proforma" });
    saveJourneyResult(day, "dbvendo", pf, pfRes);
    expect(loadResults([pfRes.fingerprint])[0].resultKind).toBe("proforma");

    // A DB original stays original when a constructed search re-finds it …
    const orig = journey([leg("nationalExpress", "A", "D", 0, 120, { trainNumber: "2" })], 63, {
      fullRoute: true,
    });
    const origRes = buildResult(orig, { resultKind: "normal" });
    saveJourneyResult(day, "dbvendo", orig, origRes);
    saveJourneyResult(day, "dbvendo", orig, buildResult(orig, { resultKind: "alternative" }));
    expect(loadResults([origRes.fingerprint])[0].resultKind).toBe("normal");

    // … and a constructed find is upgraded once a plain search proposes it.
    const alt = journey([leg("national", "A", "D", 0, 150, { trainNumber: "3" })], 40, {
      fullRoute: true,
    });
    const altRes = buildResult(alt, { resultKind: "alternative" });
    saveJourneyResult(day, "dbvendo", alt, altRes);
    expect(loadResults([altRes.fingerprint])[0].resultKind).toBe("alternative");
    saveJourneyResult(day, "dbvendo", alt, buildResult(alt, { resultKind: "normal" }));
    expect(loadResults([altRes.fingerprint])[0].resultKind).toBe("normal");

    // Rows saved before result_kind existed are never claimed as DB originals.
    db.update(journeys).set({ resultKind: null }).where(eq(journeys.fingerprint, pfRes.fingerprint)).run();
    expect(loadResults([pfRes.fingerprint])[0].resultKind).toBe("alternative");
  });
});
