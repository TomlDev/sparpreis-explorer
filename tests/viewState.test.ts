import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS } from "@/lib/engine/types";
import { DEFAULT_VIEW, parseView, serializeView, type ViewState } from "@/lib/viewState";

describe("Ansicht in der URL", () => {
  it("überträgt den kompletten Zustand verlustfrei (Hin- und Rückweg)", () => {
    const v: ViewState = {
      origin: "nrw",
      dest: "schwarzwald",
      date: "2026-10-16",
      timeFrom: "14:00",
      timeTo: "18:00",
      timeMode: "arrival",
      mode: "deep",
      sort: "tight-transfers",
      filters: { ...DEFAULT_FILTERS, onlyOriginal: true, belowReference: false, maxPrice: 40, maxFvLegs: null },
      refFp: "6f4394c563dfb9e52f957d98",
      refPrice: 63.04,
      open: ["6f4394c563dfb9e52f957d98", "a03f1cf5a39f679212b7c48d"],
      compare: ["aa9edfd160b3567faf574e03"],
      day: true,
      grouped: false,
      dialog: "filters",
    };
    const q = serializeView(v);
    expect(parseView(q)).toEqual(v);
    // readable, and the same view always yields the same link
    expect(q).toContain("open=6f4394c563dfb9e52f957d98,a03f1cf5a39f679212b7c48d");
    expect(q).toContain("tw=14:00");
    expect(serializeView(parseView(q))).toBe(q);
  });

  it("Gruppierung: nur in der URL, wenn sie vom Standard abweicht (Ganzer Tag = gruppiert)", () => {
    const base = { ...DEFAULT_VIEW, date: "2026-10-16" };
    expect(serializeView({ ...base, day: true, grouped: true })).not.toContain("g=");
    expect(serializeView({ ...base, day: true, grouped: false })).toContain("g=0");
    expect(serializeView({ ...base, grouped: true })).toContain("g=1");
    expect(parseView(serializeView({ ...base, grouped: true })).grouped).toBe(true);
    expect(parseView("date=2026-10-16").grouped).toBeNull();
  });

  it("lässt Standardwerte weg und schreibt nur abweichende Filter", () => {
    const q = serializeView({ ...DEFAULT_VIEW, date: "2026-10-16", filters: { ...DEFAULT_FILTERS, onlyOriginal: true } });
    expect(q).toBe("date=2026-10-16&tw=06:00&tt=10:00&f.onlyOriginal=1");
  });

  it("versteht alte Links (benanntes Zeitfenster, ohne Route)", () => {
    const v = parseView("https://example.org/?date=2026-10-16&tw=morning&tt=10:00&mode=deep");
    expect(v.date).toBe("2026-10-16");
    expect(v.timeFrom).toBe("06:00");
    expect(v.mode).toBe("deep");
    expect(v.origin).toBeNull();
    expect(v.filters).toEqual(DEFAULT_FILTERS);
  });

  it("ignoriert ungültige Werte statt kaputtzugehen", () => {
    const v = parseView(
      "date=16.10.2026&tw=25:00&tt=9x&sort=bogus&mode=turbo&view=nope&ref=<script>&refp=abc&f.maxPrice=viel&f.onlyOriginal=vielleicht&cmp=aaaaaa1,bbbbbb2,cccccc3,dddddd4",
    );
    expect(v.date).toBeNull();
    expect(v.timeFrom).toBe(DEFAULT_VIEW.timeFrom);
    expect(v.timeTo).toBe(DEFAULT_VIEW.timeTo);
    expect(v.sort).toBe(DEFAULT_VIEW.sort);
    expect(v.mode).toBe(DEFAULT_VIEW.mode);
    expect(v.dialog).toBeNull();
    expect(v.refFp).toBeNull();
    expect(v.refPrice).toBeNull();
    expect(v.filters.maxPrice).toBe(DEFAULT_FILTERS.maxPrice);
    expect(v.filters.onlyOriginal).toBe(DEFAULT_FILTERS.onlyOriginal);
    expect(v.compare).toHaveLength(3); // the page compares at most 3
  });

  it("'kein Limit' (leer) übersteuert einen gesetzten Standard", () => {
    // maxFvLegs defaults to 0 ("unbegrenzt"); an explicit empty value means null
    const v = parseView("date=2026-10-16&f.maxFvLegs=");
    expect(v.filters.maxFvLegs).toBeNull();
    expect(serializeView(v)).toContain("f.maxFvLegs=");
  });
});
