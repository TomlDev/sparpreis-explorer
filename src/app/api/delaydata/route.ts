import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { availableMonths, cancelBuild, currentJob, reapOrphans, relevantStations, startBuild } from "@/lib/delay/job";
import {
  buildInfo,
  getActiveBuildId,
  getWeights,
  lastFailedBuild,
  setActiveBuildId,
  setWeights,
  stmt,
} from "@/lib/delay/store";

export const runtime = "nodejs";

/** Relevant stations not covered by the active build (e.g. a new route). */
function missingStations(activeId: string | null, evas: string[]): number {
  if (!activeId || !evas.length) return evas.length;
  const have = new Set(
    (
      stmt("SELECT DISTINCT eva FROM delay_stats WHERE build_id = ? AND level = 'station'").all(activeId) as {
        eva: string;
      }[]
    ).map((r) => r.eva),
  );
  return evas.filter((e) => !have.has(e)).length;
}

export async function GET() {
  ensureReady();
  reapOrphans();
  const activeId = getActiveBuildId();
  const rel = relevantStations();
  let available: { month: string; bytes: number }[] | null = null;
  let availableError: string | null = null;
  try {
    available = await availableMonths();
  } catch (e) {
    availableError = (e as Error).message;
  }
  return NextResponse.json({
    active: buildInfo(activeId),
    job: currentJob(),
    lastFailed: lastFailedBuild(),
    weights: getWeights(),
    available,
    availableError,
    relevant: { evas: rel.evas.length, names: rel.names.length, missing: missingStations(activeId, rel.evas) },
  });
}

export async function POST(req: Request) {
  ensureReady();
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    params?: Record<string, unknown>;
    weights?: Record<string, unknown>;
  };
  try {
    switch (body.action) {
      case "build":
        return NextResponse.json({ job: await startBuild(body.params ?? {}) });
      case "cancel":
        return NextResponse.json({ cancelled: cancelBuild() });
      case "weights":
        return NextResponse.json({ weights: setWeights(body.weights ?? {}) });
      case "delete": {
        const id = getActiveBuildId();
        setActiveBuildId(null);
        if (id) {
          stmt("DELETE FROM delay_stats WHERE build_id = ?").run(id);
          stmt("DELETE FROM delay_stations WHERE build_id = ?").run(id);
          stmt("DELETE FROM delay_builds WHERE id = ?").run(id);
        }
        return NextResponse.json({ deleted: !!id });
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
