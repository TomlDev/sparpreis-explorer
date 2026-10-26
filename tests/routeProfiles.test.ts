import { beforeAll, describe, expect, it } from "vitest";
import { ensureReady } from "@/lib/bootstrap";
import { getSetting } from "@/lib/repo/settings";
import { createProfile, deleteProfile, getProfile, listProfiles, renameProfile, setDefaultRoute } from "@/lib/routeProfiles";

beforeAll(() => ensureReady());

describe("Start und Ziele verwalten", () => {
  it("umbenennen ändert nur den Namen, der Schlüssel bleibt", () => {
    const p = createProfile("testort", "Testort");
    renameProfile(p.id, "  Neuer Name ");
    expect(getProfile("testort")?.label).toBe("Neuer Name");
    expect(() => renameProfile(p.id, " ")).toThrow(/Name fehlt/);
  });

  it("löschen entfernt den Ort; die Standardroute weicht aus; mindestens zwei bleiben", () => {
    const keep = listProfiles().filter((p) => p.key !== "testort");
    setDefaultRoute(keep[0].key, "testort");
    deleteProfile(getProfile("testort")!.id);
    expect(getProfile("testort")).toBeNull();
    const dr = getSetting<{ originKey: string; destKey: string }>("defaultRoute")!;
    expect(dr.originKey).toBe(keep[0].key);
    expect(dr.destKey).not.toBe("testort");
    expect(dr.destKey).not.toBe(dr.originKey);
    // only two left → refuse
    while (listProfiles().length > 2) deleteProfile(listProfiles()[listProfiles().length - 1].id);
    expect(() => deleteProfile(listProfiles()[0].id)).toThrow(/Mindestens zwei/);
  });
});
