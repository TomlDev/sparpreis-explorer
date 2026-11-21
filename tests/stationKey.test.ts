import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { upsertLocation } from "@/lib/repo/locations";
import { getProfile, isStationKey, searchableStations } from "@/lib/routeProfiles";
import { parseView, serializeView } from "@/lib/viewState";

beforeAll(() => ensureReady());

describe("Einzelner Bahnhof statt Profil", () => {
  it("st:<id> verhält sich wie ein Profil mit genau diesem Bahnhof", () => {
    upsertLocation({ id: "de-test:bochum-hbf", name: "Bochum Hbf", type: "STOP" }, "motis");
    const p = getProfile("st:de-test:bochum-hbf")!;
    expect(isStationKey(p.key)).toBe(true);
    expect(p.label).toBe("Bochum Hbf");
    expect(searchableStations(p).map((s) => [s.locationId, s.priority])).toEqual([["de-test:bochum-hbf", 0]]);
  });

  it("unbekannte Id: Name = Id, leerer Schlüssel: nichts", () => {
    expect(getProfile("st:de-test:unknown")?.label).toBe("de-test:unknown");
    expect(getProfile("st:")).toBeNull();
  });

  it("bleibt im Link lesbar", () => {
    const q = serializeView({ ...parseView(""), origin: "st:de-DELFI_de:05911:5545", dest: "schwarzwald", date: "2026-12-20" });
    expect(q).toContain("o=st:de-DELFI_de:05911:5545");
    expect(parseView(q).origin).toBe("st:de-DELFI_de:05911:5545");
  });
});
