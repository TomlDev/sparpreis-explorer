import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getSetting } from "@/lib/repo/settings";
import {
  addStation,
  createProfile,
  listProfiles,
  moveStation,
  removeStation,
  resolveStation,
  setDefaultRoute,
  setStationEnabled,
} from "@/lib/routeProfiles";

export const runtime = "nodejs";

export async function GET() {
  ensureReady();
  return NextResponse.json({
    profiles: listProfiles(),
    defaultRoute: getSetting<{ originKey: string; destKey: string }>("defaultRoute"),
  });
}

export async function POST(req: Request) {
  ensureReady();
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  switch (action) {
    case "create":
      createProfile(String(body.key), String(body.label));
      break;
    case "addStation":
      addStation(
        String(body.profileId),
        String(body.stationName),
        body.query ?? null,
        body.locationId ?? null,
      );
      break;
    case "resolve":
      resolveStation(String(body.stationId), String(body.locationId), body.stationName);
      break;
    case "removeStation":
      removeStation(String(body.stationId));
      break;
    case "setStationEnabled":
      setStationEnabled(String(body.stationId), !!body.enabled);
      break;
    case "moveStation":
      moveStation(String(body.stationId), body.dir === "up" ? "up" : "down");
      break;
    case "setDefault":
      setDefaultRoute(String(body.originKey), String(body.destKey));
      break;
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json({
    profiles: listProfiles(),
    defaultRoute: getSetting<{ originKey: string; destKey: string }>("defaultRoute"),
  });
}
