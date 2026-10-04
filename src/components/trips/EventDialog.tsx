"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Sheet } from "@/components/Sheet";
import { Button, Input, Spinner } from "@/components/ui";
import { berlinToIso } from "@/lib/time";
import type { TripEventRow, TripLeg } from "@/db/schema";
import type { PickedLocation } from "./LocationPicker";
import { currentPosition } from "./tripUi";

// Leaflet touches `window` — load the map only in the browser.
const LocationPicker = dynamic(() => import("./LocationPicker").then((m) => m.LocationPicker), {
  ssr: false,
  loading: () => <div className="h-64 animate-pulse rounded-xl bg-muted" />,
});

const TZ = "Europe/Berlin";
const berlinParts = (ms: number) => ({
  date: new Date(ms).toLocaleDateString("sv-SE", { timeZone: TZ }),
  time: new Date(ms).toLocaleTimeString("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }),
});
function berlinMs(date: string, time: string): number | null {
  const iso = berlinToIso(date, time);
  return iso ? new Date(iso).getTime() : null;
}

/** Last ride that had departed by `at` — its start station centres the map. */
function stationAt(legs: TripLeg[], at: number): string | null {
  let name: string | null = legs.find((l) => !l.isWalking)?.fromName ?? null;
  for (const l of legs) if (!l.isWalking && l.plannedDeparture && new Date(l.plannedDeparture).getTime() <= at) name = l.fromName;
  return name;
}

/**
 * Create or edit a trip event (ticket check / note): time, text and a
 * location set via GPS, search or by tapping the map.
 */
export function EventDialog({
  open,
  onClose,
  tripId,
  legs,
  event,
  initialType = "control",
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  tripId: string;
  legs: TripLeg[];
  /** Edit this event; omit to create a new ticket check. */
  event?: TripEventRow | null;
  /** Type for a new entry. */
  initialType?: "control" | "note";
  onSaved: () => void;
}) {
  const [type, setType] = React.useState("control");
  const [date, setDate] = React.useState("");
  const [time, setTime] = React.useState("");
  const [text, setText] = React.useState("");
  const [loc, setLoc] = React.useState<PickedLocation | null>(null);
  /** Set once the user picks a spot by hand — a late GPS fix must not override it. */
  const touched = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Reset whenever the dialog opens; a new check tries GPS right away.
  React.useEffect(() => {
    if (!open) return;
    const at = event?.at ?? Date.now();
    const p = berlinParts(at);
    setType(event?.type ?? initialType);
    setDate(p.date);
    setTime(p.time);
    setText(event?.text ?? "");
    setErr(null);
    touched.current = false;
    if (event) {
      setLoc(event.lat != null && event.lng != null ? { lat: event.lat, lng: event.lng, accuracy: event.accuracy } : null);
    } else {
      setLoc(null);
      currentPosition().then((pos) => {
        if (pos && !touched.current) setLoc(pos);
      });
    }
  }, [open, event, initialType]);

  const at = berlinMs(date, time) ?? Date.now();

  async function save() {
    const ms = berlinMs(date, time);
    if (ms == null) return setErr("Datum und Uhrzeit prüfen.");
    setBusy(true);
    setErr(null);
    const body = { type, at: ms, text: text.trim() || null, lat: loc?.lat ?? null, lng: loc?.lng ?? null, accuracy: loc?.accuracy ?? null };
    try {
      const res = event
        ? await fetch(`/api/trips/${tripId}/events?eventId=${event.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        : await fetch(`/api/trips/${tripId}/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
      if (!res.ok) return setErr((await res.json().catch(() => ({}))).error ?? "Speichern fehlgeschlagen");
      onSaved();
      onClose();
    } catch {
      setErr("Keine Verbindung – bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={event ? "Eintrag bearbeiten" : type === "note" ? "Notiz eintragen" : "Kontrolle eintragen"}>
      <div className="space-y-3">
        <div className="flex gap-1.5">
          {[
            ["control", "Kontrolle"],
            ["note", "Notiz"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setType(k)}
              aria-pressed={type === k}
              className={
                "rounded-full border px-3 py-1.5 text-sm " +
                (type === k ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted")
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <Input
          placeholder={type === "control" ? "Notiz (optional, z. B. „zwischen Köln und Bonn“)" : "Notiz"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {open && (
          <LocationPicker
            value={loc}
            onChange={(v) => {
              touched.current = true;
              setLoc(v);
            }}
            hintStation={stationAt(legs, at)}
          />
        )}
        {err && <p className="text-sm text-danger">{err}</p>}
        <div className="flex gap-2 pb-2">
          <Button onClick={save} disabled={busy}>
            {busy ? <Spinner /> : "Speichern"}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Abbrechen
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
