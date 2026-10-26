import { NextResponse } from "next/server";
import { ensureReady } from "@/lib/bootstrap";
import { getSetting } from "@/lib/repo/settings";
import {
  addStation,
  createProfile,
  deleteProfile,
  listProfiles,
  moveStation,
  removeStation,
  renameProfile,
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
    case "create": {
      const label = String(body.label ?? "").trim().slice(0, 60);
      // key from the name: "Freiburg (Breisgau)" → "freiburg-breisgau"
      const key = (String(body.key ?? "") || label)
        .toLowerCase()
        .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      if (!label || !key) return NextResponse.json({ error: "Name fehlt" }, { status: 400 });
      if (listProfiles().some((p) => p.key === key)) return NextResponse.json({ error: "Gibt es schon" }, { status: 400 });
      createProfile(key, label);
      break;
    }
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
    case "rename":
    case "delete":
      try {
        if (action === "rename") renameProfile(String(body.profileId), String(body.label ?? ""));
        else deleteProfile(String(body.profileId));
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 400 });
      }
      break;
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
  return NextResponse.json({
    profiles: listProfiles(),
    defaultRoute: getSetting<{ originKey: string; destKey: string }>("defaultRoute"),
  });
}
