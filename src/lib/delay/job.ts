import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { newId, now } from "@/db/util";
import { evaFromId } from "./normalize";
import { normalizeParams, planMonths, type AvailableMonth } from "./plan";
import { setActiveBuildId, stmt, type DelayBuildParams } from "./store";

/**
 * "Pünktlichkeitsdaten laden": downloads the chosen months of the open data
 * set, aggregates them for the stations of the user's routes (Python +
 * DuckDB, scripts/delay_ingest.py) and stores compact histograms in SQLite.
 * One job at a time, in-process; the previous build stays active until the
 * new one has finished successfully.
 */

const DATASET = "piebro/deutsche-bahn-data";
const TREE_URL = `https://huggingface.co/api/datasets/${DATASET}/tree/main/monthly_processed_data`;
const FILE_URL = (m: string) =>
  `https://huggingface.co/datasets/${DATASET}/resolve/main/monthly_processed_data/data-${m}.parquet`;


export interface JobState {
  buildId: string;
  params: DelayBuildParams;
  months: string[];
  stage: "start" | "download" | "aggregate" | "written" | "done" | "failed";
  month: string | null;
  index: number;
  bytes: number;
  total: number;
  rows: number;
  stations: number;
  startedAt: number;
  error: string | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __delayJob: { state: JobState; child: ChildProcess | null } | undefined;
  // eslint-disable-next-line no-var
  var __delayMonths: { at: number; months: AvailableMonth[] } | undefined;
}

export async function availableMonths(): Promise<AvailableMonth[]> {
  const c = globalThis.__delayMonths;
  if (c && now() - c.at < 6 * 3600_000) return c.months;
  const res = await fetch(TREE_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Hugging Face: HTTP ${res.status}`);
  const items = (await res.json()) as { path: string; size?: number; lfs?: { size?: number } }[];
  const months = items
    .map((it) => {
      const m = /data-(\d{4}-\d{2})\.parquet$/.exec(it.path);
      return m ? { month: m[1], bytes: it.lfs?.size ?? it.size ?? 0 } : null;
    })
    .filter((x): x is AvailableMonth => !!x)
    .sort((a, b) => b.month.localeCompare(a.month));
  globalThis.__delayMonths = { at: now(), months };
  return months;
}

/** Stations of the user's routes: every boarding/alighting station seen in
 *  cached journeys, the profile stations and the learned FV graph. */
export function relevantStations(): { evas: string[]; names: string[] } {
  const evas = new Set<string>();
  const names = new Set<string>();
  const add = (id: string | null, name: string | null) => {
    const eva = evaFromId(id);
    if (eva) evas.add(eva);
    else if (name) names.add(name);
  };
  const legs = stmt(
      `SELECT origin_id AS id, origin_name AS name FROM journey_legs WHERE product IS NULL OR product NOT IN ('bus','tram','subway','ferry','taxi')
       UNION SELECT dest_id, dest_name FROM journey_legs WHERE product IS NULL OR product NOT IN ('bus','tram','subway','ferry','taxi')
       UNION SELECT location_id, station_name FROM profile_stations
       UNION SELECT from_location_id, from_name FROM long_distance_edges
       UNION SELECT to_location_id, to_name FROM long_distance_edges`,
    )
    .all() as { id: string | null; name: string | null }[];
  for (const r of legs) add(r.id, r.name);
  return { evas: [...evas].sort(), names: [...names].sort() };
}

export function pythonBin(): string {
  return process.env.DELAY_PYTHON || process.env.DB_IMPERSONATE_PYTHON || "python3";
}

export function dbPath(): string {
  const p = process.env.DATABASE_PATH || "./data/bahn-finder.db";
  return path.isAbsolute(p) ? p : path.join(/*turbopackIgnore: true*/ process.cwd(), p);
}

function deleteBuildData(id: string): void {
  stmt("DELETE FROM delay_stats WHERE build_id = ?").run(id);
  stmt("DELETE FROM delay_stations WHERE build_id = ?").run(id);
}

export function currentJob(): JobState | null {
  return globalThis.__delayJob?.state ?? null;
}

export function isRunning(): boolean {
  const s = currentJob();
  return !!s && s.stage !== "done" && s.stage !== "failed";
}

/** A "running" row without a live process (app restarted mid-build) → failed. */
export function reapOrphans(): void {
  const live = isRunning() ? currentJob()!.buildId : null;
  const rows = stmt("SELECT id FROM delay_builds WHERE status = 'running'").all() as { id: string }[];
  for (const r of rows) {
    if (r.id === live) continue;
    deleteBuildData(r.id);
    stmt("UPDATE delay_builds SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
      .run("abgebrochen (Neustart)", now(), r.id);
  }
}

export async function startBuild(input: Partial<DelayBuildParams>): Promise<JobState> {
  if (isRunning()) throw new Error("Es läuft bereits ein Import.");
  reapOrphans();
  const params = normalizeParams(input);
  const available = await availableMonths();
  const today = new Date().toISOString().slice(0, 10);
  const months = planMonths(params, available, today);
  if (!months.length) throw new Error("Keine Monate verfügbar.");
  const { evas, names } = relevantStations();
  if (!evas.length && !names.length) throw new Error("Noch keine Bahnhöfe bekannt – erst eine Suche ausführen.");

  const buildId = newId("delay");
  stmt("INSERT INTO delay_builds (id, status, params, months, started_at) VALUES (?, 'running', ?, ?, ?)")
    .run(buildId, JSON.stringify(params), JSON.stringify(months), now());

  const tmpDir = path.join(path.dirname(dbPath()), "delay-tmp");
  // Leftovers of an interrupted run (app restart mid-download).
  if (fs.existsSync(tmpDir))
    for (const f of fs.readdirSync(tmpDir)) if (f.startsWith("data-")) fs.rmSync(path.join(tmpDir, f), { force: true });
  const state: JobState = {
    buildId,
    params,
    months,
    stage: "start",
    month: null,
    index: 0,
    bytes: 0,
    total: 0,
    rows: 0,
    stations: 0,
    startedAt: now(),
    error: null,
  };
  const script = path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "delay_ingest.py");
  const child = spawn(/*turbopackIgnore: true*/ pythonBin(), [script], { stdio: ["pipe", "pipe", "pipe"] });
  globalThis.__delayJob = { state, child };

  let stderr = "";
  let buf = "";
  const fail = (msg: string) => {
    if (state.stage === "done" || state.stage === "failed") return;
    state.stage = "failed";
    state.error = msg;
    try {
      // SIGTERM skips the script's own cleanup → remove partial downloads.
      for (const f of fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [])
        if (f.startsWith("data-")) fs.rmSync(path.join(tmpDir, f), { force: true });
      deleteBuildData(buildId);
      stmt("UPDATE delay_builds SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
        .run(msg.slice(0, 500), now(), buildId);
    } catch {
      /* best effort */
    }
  };
  const finish = (rows: number, stations: number) => {
    stmt("UPDATE delay_builds SET status = 'done', rows = ?, stations = ?, finished_at = ? WHERE id = ?")
      .run(rows, stations, now(), buildId);
    setActiveBuildId(buildId);
    // Keep only the active build's data.
    const old = stmt("SELECT id FROM delay_builds WHERE id <> ?").all(buildId) as { id: string }[];
    for (const o of old) deleteBuildData(o.id);
    stmt("DELETE FROM delay_builds WHERE id <> ? AND status <> 'running'").run(buildId);
    state.stage = "done";
  };

  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "progress") {
        state.stage = ev.stage as JobState["stage"];
        state.month = (ev.month as string) ?? state.month;
        if (typeof ev.index === "number") state.index = ev.index;
        if (typeof ev.bytes === "number") state.bytes = ev.bytes;
        if (typeof ev.total === "number") state.total = ev.total;
        if (typeof ev.rows === "number") state.rows += ev.rows;
      } else if (ev.type === "stations") {
        state.stations = Number(ev.count) || 0;
      } else if (ev.type === "done") {
        try {
          finish(Number(ev.rows) || state.rows, Number(ev.stations) || state.stations);
        } catch (e) {
          fail((e as Error).message);
        }
      } else if (ev.type === "error") {
        fail(String(ev.message));
      }
    }
  });
  child.stderr!.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  child.on("error", (e) => fail(`Python nicht startbar: ${e.message}`));
  child.on("close", (code) => {
    globalThis.__delayJob!.child = null;
    if (state.stage !== "done") fail(code === null ? "abgebrochen" : stderr.trim().split("\n").pop() || `Exit ${code}`);
  });

  child.stdin!.end(
    JSON.stringify({
      dbPath: dbPath(),
      buildId,
      months: months.map((m) => ({ month: m, url: FILE_URL(m) })),
      evas,
      names,
      tmpDir,
    }),
  );
  return state;
}

export function cancelBuild(): boolean {
  const j = globalThis.__delayJob;
  if (!j?.child || !isRunning()) return false;
  j.child.kill("SIGTERM");
  return true;
}
