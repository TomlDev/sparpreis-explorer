import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { evaFromId, normStationKey, trainKey } from "@/lib/delay/normalize";
import { planMonths } from "@/lib/delay/plan";
import {
  computeReliability,
  dowGroup,
  missProbability,
  monthWeight,
  quantile,
  type Dist,
  type LegLike,
  type StatSource,
} from "@/lib/delay/reliability";
import { DEFAULT_WEIGHTS, type StatLevel, type StatRow } from "@/lib/delay/types";

const PY = path.resolve(".venv/bin/python3");
const hasPy = fs.existsSync(PY) && spawnSync(PY, ["-c", "import duckdb"]).status === 0;

describe("Bahnhofs- und Zugschlüssel", () => {
  it("normalisiert Schreibweisen verschiedener Quellen gleich", () => {
    expect(normStationKey("Freiburg Hauptbahnhof")).toBe(normStationKey("Freiburg Hbf"));
    expect(normStationKey("Offenburg Bahnhof")).toBe("offenburg");
    expect(normStationKey("Langendreer, Bochum")).toBe(normStationKey("Bochum-Langendreer"));
    expect(normStationKey("Freiburg (Breisgau) Hbf", true)).toBe("freiburg hbf");
    expect(normStationKey("Freiburg(Breisgau) Hbf")).toBe(normStationKey("Freiburg (Breisgau) Hbf"));
  });

  it("erkennt EVA-Nummern", () => {
    expect(evaFromId("8000207")).toBe("8000207");
    expect(evaFromId("08000041")).toBe("8000041");
    expect(evaFromId("de-DELFI_de:05513:5613:91:6")).toBeNull();
    expect(evaFromId("500137")).toBeNull();
  });

  it("liest Zugnummer und Linie aus db-vendo- und MOTIS-Labels", () => {
    expect(trainKey({ lineName: "RB32 (31242)", trainNumber: "RB32 (31242)" })).toEqual({ number: "31242", line: "RB32" });
    expect(trainKey({ lineName: "ICE 101", trainNumber: "ICE 101" })).toEqual({ number: "101", line: "ICE" });
    expect(trainKey({ lineName: "ICE 109", trainNumber: "109" })).toEqual({ number: "109", line: "ICE" });
    expect(trainKey({ lineName: "RE 2", trainNumber: "4719" })).toEqual({ number: "4719", line: "RE2" });
    expect(trainKey({ lineName: "RE2" })).toEqual({ number: null, line: "RE2" });
    expect(trainKey({ lineName: "88366", trainNumber: "88366" })).toEqual({ number: "88366", line: null });
    expect(trainKey({ lineName: "IC 2012" })).toEqual({ number: "2012", line: "IC" });
  });

  it.skipIf(!hasPy)("Python-Normalisierung ist identisch zu TypeScript", () => {
    const names = [
      "Freiburg Hauptbahnhof",
      "Freiburg (Breisgau) Hbf",
      "Offenburg Bahnhof",
      "Langendreer, Bochum",
      "Villingen (Schwarzw)",
      "Köln Messe/Deutz",
      "Frankfurt(M) Flughafen Fernbf",
      "Gießen",
      "Donaueschingen Mitte/Siedlung",
    ];
    const out = execFileSync(
      PY,
      [
        "-c",
        "import sys,json; sys.path.insert(0,'scripts'); from delay_ingest import norm; " +
          "n=json.load(sys.stdin); print(json.dumps([[norm(x), norm(x, True)] for x in n]))",
      ],
      { input: JSON.stringify(names) },
    ).toString();
    expect(JSON.parse(out)).toEqual(names.map((n) => [normStationKey(n), normStationKey(n, true)]));
  });
});

describe("Gewichtung und Monatsplanung", () => {
  it("halbiert das Gewicht pro Halbwertszeit und bevorzugt die Saison", () => {
    const w = { ...DEFAULT_WEIGHTS, halfLifeMonths: 3, seasonBoost: 2 };
    // travel in December: 2026-08 is 4 months off-season, 2025-12 is same month
    expect(monthWeight("2026-08", "2026-08", "2026-12-10", w)).toBe(1);
    expect(monthWeight("2026-05", "2026-08", "2026-12-10", w)).toBeCloseTo(0.5);
    expect(monthWeight("2025-12", "2026-08", "2026-12-10", w)).toBeCloseTo(Math.pow(0.5, 8 / 3) * 2);
    expect(monthWeight("2025-11", "2026-08", "2026-12-10", w)).toBeCloseTo(Math.pow(0.5, 9 / 3) * 1.5);
  });

  it("wählt die letzten Monate plus dieselbe Jahreszeit im Vorjahr", () => {
    const avail = ["2026-08", "2026-07", "2026-06", "2026-05", "2025-10", "2025-09", "2025-08", "2024-09"].map(
      (month) => ({ month, bytes: 1 }),
    );
    expect(planMonths({ recentMonths: 2, seasonYears: 1, seasonSpan: 1 }, avail, "2026-09-25")).toEqual([
      "2026-08",
      "2026-07",
      "2025-10",
      "2025-09",
      "2025-08",
    ]);
    expect(planMonths({ recentMonths: 1, seasonYears: 2, seasonSpan: 0 }, avail, "2026-09-25")).toEqual([
      "2026-08",
      "2025-09",
      "2024-09",
    ]);
  });

  it("ordnet Wochentage den Gruppen zu", () => {
    expect(dowGroup("2026-09-24")).toBe("wk"); // Thursday
    expect(dowGroup("2026-09-25")).toBe("fr");
    expect(dowGroup("2026-09-27")).toBe("we");
  });
});

describe("Anschluss- und Flex-Wahrscheinlichkeit", () => {
  it("rechnet Verpass-Wahrscheinlichkeit per Faltung", () => {
    const arr: Dist = [
      [0, 0.5],
      [5, 0.3],
      [10, 0.2],
    ];
    expect(missProbability(arr, [[0, 1]], 4)).toBeCloseTo(0.5); // 5 and 10 miss
    expect(missProbability(arr, [[0, 1]], 9)).toBeCloseTo(0.2);
    // connecting train itself 3 min late half the time → buys buffer
    expect(missProbability(arr, [[0, 0.5], [3, 0.5]], 4)).toBeCloseTo(0.3 * 0.5 + 0.2 * 0.5 + 0.2 * 0.5);
    expect(quantile(arr, 0.5)).toBe(0);
    expect(quantile(arr, 0.8)).toBe(5);
  });

  // RE (4719) Bochum → Essen, 4 min to change, then ICE 101 Essen → Köln.
  const T = "2026-10-15"; // Thursday
  const legs: LegLike[] = [
    { product: "regional", lineName: "RE 1", trainNumber: "4719", fromId: "8000041", toId: "8000098", fromName: "Bochum Hbf", toName: "Essen Hbf", plannedDeparture: `${T}T07:00:00+02:00`, plannedArrival: `${T}T07:10:00+02:00`, durationMin: 10, isWalking: false },
    { product: "nationalExpress", lineName: "ICE 101", trainNumber: "101", fromId: "8000098", toId: "8000207", fromName: "Essen Hbf", toName: "Köln Hbf", plannedDeparture: `${T}T07:14:00+02:00`, plannedArrival: `${T}T08:00:00+02:00`, durationMin: 46, isWalking: false },
  ];
  const row = (arr: [number, number][], dep: [number, number][], n = 100, cancelled = 0): StatRow => ({
    month: "2026-08",
    dow: "wk",
    n,
    cancelled,
    arr,
    dep,
  });
  const data: Record<string, StatRow[]> = {
    // RE arrives in Essen: 60 % on time, 20 % +3, 20 % +8
    "train|8000098|4719": [row([[0, 60], [3, 20], [8, 20]], [])],
    // ICE leaves Essen always on time
    "train|8000098|101": [row([], [[0, 100]])],
    // ICE arrives Köln: 70 % on time, 30 % +25; 2 of 100 cancelled
    "train|8000207|101": [row([[0, 70], [25, 28]], [], 100, 2)],
    "train|8000041|4719": [row([], [[0, 100]])],
  };
  const src: StatSource = {
    resolveEva: (id) => id ?? null,
    rows: (level: StatLevel, eva: string, key: string) => data[`${level}|${eva}|${key}`] ?? [],
  };
  const ctx = { travelDate: T, months: ["2026-08"], weights: { ...DEFAULT_WEIGHTS, minSamples: 10 } };

  it("schätzt Anschluss, Ausfall und Flex-Chance für eine Umstiegsverbindung", () => {
    const rel = computeReliability(legs, src, ctx)!;
    expect(rel).not.toBeNull();
    expect(rel.basis).toBe("train");
    expect(rel.complete).toBe(true);
    // buffer 4 min, −1 min for changing trains → +8 misses (20 %); +3 makes it
    expect(rel.transfers).toHaveLength(1);
    expect(rel.transfers[0].missPct).toBeCloseTo(0.2);
    expect(rel.cancelPct).toBeCloseTo(0.02);
    expect(rel.okPct).toBeCloseTo(0.98 * 0.8, 3);
    // no headway known → a missed ICE counts as ≥ 20 min; late arrival 28/98
    const late = 28 / 98;
    expect(rel.flexPct).toBeCloseTo(1 - 0.98 * (1 - 0.2) * (1 - late), 2);
    expect(rel.arrP50).toBe(0);
    expect(rel.arrP80).toBe(25);
  });

  it("füllt dünne Zughistorie mit der Linie auf und markiert fehlende Züge", () => {
    const sparse: Record<string, StatRow[]> = {
      ...data,
      "train|8000207|101": [row([[30, 2]], [], 2)],
      "line|8000207|ICE": [row([[0, 100]], [], 100)],
    };
    const rel = computeReliability(legs, { ...src, rows: (l, e, k) => sparse[`${l}|${e}|${k}`] ?? [] }, ctx)!;
    // 2 own observations (+30) + 8 from the line (on time) → 20 % ≥ 20 min
    expect(rel.basis).toBe("train");
    expect(rel.flexPct).toBeCloseTo(1 - (1 - 0.2) * (1 - 0.2), 2);
    const noIce = computeReliability(legs, { ...src, rows: (l, e, k) => (k === "101" ? [] : data[`${l}|${e}|${k}`] ?? []) }, ctx)!;
    expect(noIce.complete).toBe(false);
    expect(noIce.transfers).toHaveLength(0);
  });

  it("wertet Bus zwischen zwei Zügen nicht als Umstieg", () => {
    const withBus: LegLike[] = [
      legs[0],
      { ...legs[1], product: "bus", lineName: "Bus 240", trainNumber: undefined },
      legs[1],
    ];
    expect(computeReliability(withBus, src, ctx)!.transfers).toHaveLength(0);
  });
});

describe.skipIf(!hasPy)("Import-Skript (Python + DuckDB)", () => {
  it("aggregiert eine Mini-Parquet-Datei in delay_stats/delay_stations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delay-"));
    const parquet = path.join(dir, "m.parquet");
    // 3 arrivals of RE 4719 in Essen (0 / +3 / cancelled), one ICE departure +2, one Bus (ignored)
    execFileSync(PY, [
      "-c",
      `import duckdb; duckdb.sql("""
      COPY (SELECT * FROM (VALUES
        ('Essen Hbf','08000098','4719','1','RE', TIMESTAMP '2026-08-06 07:10', TIMESTAMP '2026-08-06 07:10', NULL::TIMESTAMP, NULL::TIMESTAMP, false, false),
        ('Essen Hbf','08000098','4719','1','RE', TIMESTAMP '2026-08-13 07:10', TIMESTAMP '2026-08-13 07:13', NULL, NULL, false, false),
        ('Essen Hbf','08000098','4719','1','RE', TIMESTAMP '2026-08-14 07:10', NULL, NULL, NULL, true, true),
        ('Essen Hbf','08000098','101',NULL,'ICE', NULL, NULL, TIMESTAMP '2026-08-06 07:14', TIMESTAMP '2026-08-06 07:16', false, false),
        ('Freiburg (Breisgau) Hbf','08000107','87350','RS2','SWE', TIMESTAMP '2026-08-06 09:00', TIMESTAMP '2026-08-06 09:40', NULL, NULL, false, false),
        ('Essen Hbf','08000098','9','SEV','Bus', TIMESTAMP '2026-08-06 07:10', TIMESTAMP '2026-08-06 07:50', NULL, NULL, false, false)
      ) t(station_name, eva, train_number, line_number, train_type, arrival_planned_time, arrival_change_time,
          departure_planned_time, departure_change_time, arrival_is_canceled, departure_is_canceled))
      TO '${parquet}' (FORMAT parquet)""")`,
    ]);
    const dbFile = path.join(dir, "t.db");
    const db = new Database(dbFile);
    for (const f of fs.readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort())
      for (const stmt of fs.readFileSync(path.join("drizzle", f), "utf8").split("--> statement-breakpoint"))
        if (stmt.trim()) db.exec(stmt);
    const job = {
      dbPath: dbFile,
      buildId: "b1",
      months: [{ month: "2026-08", path: parquet }],
      evas: ["08000098"],
      names: ["Freiburg Hauptbahnhof"],
      tmpDir: dir,
    };
    const out = execFileSync(PY, ["scripts/delay_ingest.py"], { input: JSON.stringify(job) }).toString();
    expect(out).toContain('"type": "done"');

    const get = (level: string, eva: string, key: string) =>
      db.prepare("SELECT * FROM delay_stats WHERE build_id='b1' AND level=? AND eva=? AND key=?").all(level, eva, key) as {
        dow: string;
        n: number;
        cancelled: number;
        arr_hist: string;
        dep_hist: string;
      }[];
    const re = get("train", "8000098", "4719");
    expect(re).toHaveLength(2); // Thursdays (wk) + Friday (fr)
    const wk = re.find((r) => r.dow === "wk")!;
    expect(wk.n).toBe(2);
    expect(JSON.parse(wk.arr_hist)).toEqual([
      [0, 1],
      [3, 1],
    ]);
    expect(re.find((r) => r.dow === "fr")!.cancelled).toBe(1);
    expect(JSON.parse(get("train", "8000098", "101")[0].dep_hist)).toEqual([[2, 1]]);
    // "1" + RE → "RE1" (older months store bare numbers)
    expect(get("line_hour", "8000098", "RE1|7")[0].n).toBe(3);
    // Freiburg matched by name (loose), 40 min delay → bin 38
    expect(JSON.parse(get("train", "8000107", "87350")[0].arr_hist)).toEqual([[38, 1]]);
    // Bus ignored
    expect(get("train", "8000098", "9")).toHaveLength(0);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
