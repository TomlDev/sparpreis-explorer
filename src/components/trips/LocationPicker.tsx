"use client";

import * as React from "react";
import "leaflet/dist/leaflet.css";
import type * as Leaflet from "leaflet";
import { Crosshair, Search, X } from "lucide-react";
import { Button, Input, Spinner } from "@/components/ui";
import { currentPosition } from "./tripUi";

export interface PickedLocation {
  lat: number;
  lng: number;
  accuracy: number | null;
}

interface Hit {
  id: string;
  name: string;
  lat?: number;
  lng?: number;
}

const GERMANY: [number, number] = [51.16, 10.45];

/**
 * Interactive map to set a location by hand: tap the map or drag the pin,
 * jump to your GPS position or to a searched station. OpenStreetMap tiles.
 */
export function LocationPicker({
  value,
  onChange,
  hintStation,
}: {
  value: PickedLocation | null;
  onChange: (v: PickedLocation | null) => void;
  /** Station to centre on when there is no location yet (e.g. the current leg's start). */
  hintStation?: string | null;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<Leaflet.Map | null>(null);
  const L = React.useRef<typeof Leaflet | null>(null);
  const pin = React.useRef<Leaflet.Marker | null>(null);
  const ring = React.useRef<Leaflet.Circle | null>(null);
  const changeRef = React.useRef(onChange);
  changeRef.current = onChange;
  const [ready, setReady] = React.useState(false);
  const [gpsBusy, setGpsBusy] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [hits, setHits] = React.useState<Hit[]>([]);

  // Create the map once (Leaflet needs the browser).
  React.useEffect(() => {
    let cancelled = false;
    import("leaflet").then((mod) => {
      if (cancelled || !box.current || map.current) return;
      const lf = (mod.default ?? mod) as typeof Leaflet;
      L.current = lf;
      const m = lf.map(box.current, { zoomControl: true, attributionControl: true }).setView(GERMANY, 6);
      lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(m);
      m.on("click", (e: Leaflet.LeafletMouseEvent) => changeRef.current({ lat: e.latlng.lat, lng: e.latlng.lng, accuracy: null }));
      map.current = m;
      setReady(true);
      // The sheet animates in — recompute size once it has its final layout.
      setTimeout(() => m.invalidateSize(), 250);
    });
    return () => {
      cancelled = true;
      map.current?.remove();
      map.current = null;
      pin.current = null;
      ring.current = null;
    };
  }, []);

  // Draw / move the pin whenever the value changes.
  React.useEffect(() => {
    const m = map.current;
    const lf = L.current;
    if (!ready || !m || !lf) return;
    if (!value) {
      pin.current?.remove();
      ring.current?.remove();
      pin.current = null;
      ring.current = null;
      return;
    }
    const ll: [number, number] = [value.lat, value.lng];
    if (!pin.current) {
      const icon = lf.divIcon({
        className: "",
        html: '<div style="width:22px;height:22px;border-radius:50% 50% 50% 0;background:#EC0016;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);transform:rotate(-45deg)"></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 22],
      });
      pin.current = lf.marker(ll, { draggable: true, icon }).addTo(m);
      pin.current.on("dragend", () => {
        const p = pin.current!.getLatLng();
        changeRef.current({ lat: p.lat, lng: p.lng, accuracy: null });
      });
    } else pin.current.setLatLng(ll);
    ring.current?.remove();
    ring.current = value.accuracy ? lf.circle(ll, { radius: value.accuracy, color: "#EC0016", weight: 1, fillOpacity: 0.08 }).addTo(m) : null;
    if (!m.getBounds().pad(-0.2).contains(ll)) m.setView(ll, Math.max(m.getZoom(), 14));
  }, [value, ready]);

  // No location yet → centre on the hinted station.
  React.useEffect(() => {
    if (!ready || value || !hintStation) return;
    fetch(`/api/locations?q=${encodeURIComponent(hintStation)}`)
      .then((r) => r.json())
      .then((d: { locations?: Hit[] }) => {
        const h = d.locations?.find((x) => x.lat != null && x.lng != null);
        if (h && map.current) map.current.setView([h.lat!, h.lng!], 12);
      })
      .catch(() => {});
  }, [ready, value, hintStation]);

  // Station / place search.
  React.useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      fetch(`/api/locations?q=${encodeURIComponent(q.trim())}`)
        .then((r) => r.json())
        .then((d: { locations?: Hit[] }) => setHits((d.locations ?? []).filter((h) => h.lat != null && h.lng != null).slice(0, 6)))
        .catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Bahnhof oder Ort suchen …" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button
          variant="outline"
          disabled={gpsBusy}
          title="Meinen Standort verwenden"
          onClick={async () => {
            setGpsBusy(true);
            const pos = await currentPosition();
            setGpsBusy(false);
            if (pos) onChange(pos);
            else alert("Standort nicht verfügbar – bitte Standortfreigabe erlauben oder auf der Karte tippen.");
          }}
        >
          {gpsBusy ? <Spinner /> : <Crosshair className="h-4 w-4" />}
        </Button>
      </div>
      {hits.length > 0 && (
        <div className="rounded-xl border border-border">
          {hits.map((h) => (
            <button
              key={h.id}
              className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => {
                onChange({ lat: h.lat!, lng: h.lng!, accuracy: null });
                map.current?.setView([h.lat!, h.lng!], 15);
                setQ("");
                setHits([]);
              }}
            >
              {h.name}
            </button>
          ))}
        </div>
      )}
      <div ref={box} className="h-64 w-full overflow-hidden rounded-xl border border-border sm:h-72" style={{ zIndex: 0 }} />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {value
            ? `${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}${value.accuracy ? ` (± ${Math.round(value.accuracy)} m)` : ""}`
            : "Auf die Karte tippen, um den Ort zu setzen."}
        </span>
        {value && (
          <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => onChange(null)}>
            <X className="h-3 w-3" /> ohne Ort
          </button>
        )}
      </div>
    </div>
  );
}
