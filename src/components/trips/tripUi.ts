import type { TripLeg } from "@/db/schema";

export const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  planned: { label: "Geplant", cls: "bg-muted text-foreground", dot: "bg-muted-foreground" },
  done: { label: "Gefahren", cls: "bg-success/15 text-success", dot: "bg-success" },
  delayed: { label: "Verspätet", cls: "bg-warning/15 text-warning", dot: "bg-warning" },
  aborted: { label: "Abgebrochen", cls: "bg-danger/15 text-danger", dot: "bg-danger" },
  not_started: { label: "Nicht angetreten", cls: "bg-danger/15 text-danger", dot: "bg-danger" },
  cancelled: { label: "Zugausfall", cls: "bg-danger/15 text-danger", dot: "bg-danger" },
};

const PREFIX: Record<string, string> = {
  nationalExpress: "ICE",
  national: "IC",
  regionalExpress: "RE",
  regional: "RB",
  suburban: "S",
  subway: "U",
  tram: "STR",
  bus: "Bus",
};

export function legLabel(l: TripLeg): string {
  const name = (l.lineName || "").trim();
  const prefix = PREFIX[l.product ?? ""] ?? "";
  if (!name) return prefix || "Zug";
  return /^\d+$/.test(name) && prefix ? `${prefix} ${name}` : name;
}

export function legColor(l: TripLeg): string {
  if (l.isWalking) return "bg-muted text-muted-foreground";
  switch (l.product) {
    case "nationalExpress":
    case "national":
      return "bg-[#EC0016] text-white";
    case "suburban":
      return "bg-[#008D4F] text-white";
    case "subway":
      return "bg-[#1455C0] text-white";
    case "tram":
      return "bg-[#D0006F] text-white";
    case "bus":
      return "bg-[#814997] text-white";
    default:
      return "bg-[#3C414B] text-white";
  }
}

/** Current GPS position (null if denied/unavailable — never blocks logging). */
export function currentPosition(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

/** Log a ticket check now, with location if the browser allows it. */
export async function logControl(tripId: string): Promise<{ ok: boolean; withLocation: boolean }> {
  const pos = await currentPosition();
  const res = await fetch(`/api/trips/${tripId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "control", at: Date.now(), ...(pos ?? {}) }),
  });
  return { ok: res.ok, withLocation: !!pos };
}

/** Upload files one by one (keeps each request small). */
export async function uploadFiles(tripId: string, files: FileList | File[], kind = "screenshot"): Promise<string | null> {
  for (const f of Array.from(files)) {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("kind", kind);
    const res = await fetch(`/api/trips/${tripId}/attachments`, { method: "POST", body: fd });
    if (!res.ok) return (await res.json().catch(() => ({}))).error ?? `Upload fehlgeschlagen (${res.status})`;
  }
  return null;
}

export const mapsLink = (lat: number, lng: number) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
