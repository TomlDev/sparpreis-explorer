"use client";

import * as React from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronRight, ChevronUp, FlaskConical, Plus, Trash2 } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { ClaimantCard } from "@/components/ClaimantCard";
import { DelayDataCard } from "@/components/DelayDataCard";
import { DbAccountCard } from "@/components/DbAccountCard";
import { MailSyncCard } from "@/components/MailSyncCard";
import { Badge, Button, Input, Spinner, Switch } from "@/components/ui";
import { SettingsGroup, SettingsSection } from "@/components/SettingsSection";

interface Station {
  id: string;
  stationName: string;
  query: string | null;
  locationId: string | null;
  resolved: boolean;
  priority: number;
  enabled: boolean;
}
interface Profile {
  id: string;
  key: string;
  label: string;
  stations: Station[];
}
interface Loc {
  id: string;
  name: string;
  type?: string;
}
interface Favorite {
  id: string;
  label: string;
  createdAt: number;
}

export default function SettingsPage() {
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [defaultRoute, setDefaultRoute] = React.useState<{ originKey: string; destKey: string } | null>(null);
  const [favorites, setFavorites] = React.useState<Favorite[]>([]);
  const [profilesLoaded, setProfilesLoaded] = React.useState(false);
  const [favoritesLoaded, setFavoritesLoaded] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [doneMsg, setDoneMsg] = React.useState<string | null>(null);

  const loadProfiles = React.useCallback(async () => {
    const data = await fetch("/api/profiles").then((r) => r.json());
    setProfiles(data.profiles ?? []);
    setDefaultRoute(data.defaultRoute ?? null);
    setProfilesLoaded(true);
  }, []);
  const loadFavorites = React.useCallback(async () => {
    const data = await fetch("/api/favorites").then((r) => r.json());
    setFavorites(data.favorites ?? []);
    setFavoritesLoaded(true);
  }, []);

  React.useEffect(() => {
    loadProfiles();
    loadFavorites();
  }, [loadProfiles, loadFavorites]);

  async function post(body: unknown) {
    await fetch("/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await loadProfiles();
  }

  async function cacheAction(action: string) {
    setBusy(action);
    setDoneMsg(null);
    const res = await fetch("/api/cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    // Also clear the browser's local leftovers so the effect is actually visible
    // (otherwise the "Zuletzt gefunden" teaser sticks around and looks un-cleared).
    if (res?.ok && (action === "clearAll" || action === "clearTimetable" || action === "clearPrices")) {
      try {
        localStorage.removeItem("lastResults");
        localStorage.removeItem("lastBody");
      } catch {}
    }
    setBusy(null);
    setDoneMsg(res?.ok ? "✓ Erledigt – Cache geleert (Server + Browser)." : "Fehler beim Leeren.");
    setTimeout(() => setDoneMsg(null), 4000);
  }

  async function deleteFavorite(id: string) {
    await fetch(`/api/favorites?id=${id}`, { method: "DELETE" });
    loadFavorites();
  }

  const usable = (p: Profile) => p.stations.some((s) => s.enabled && s.resolved);
  const labelOf = (key: string | undefined) => profiles.find((p) => p.key === key)?.label ?? key;
  const routeSummary = [
    defaultRoute?.originKey && `Standard: ${labelOf(defaultRoute.originKey)} → ${labelOf(defaultRoute.destKey)}`,
    `${profiles.length} Orte`,
    profiles.filter((p) => !usable(p)).length > 0 &&
      `ohne Haltestelle: ${profiles
        .filter((p) => !usable(p))
        .map((p) => p.label)
        .join(", ")}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <AppHeader />
      <main className="container max-w-3xl space-y-6 py-5">
        <h1 className="text-xl font-semibold">Einstellungen</h1>

        <SettingsGroup title="Suche">
          <PreferencesCard />

          <SettingsSection
            id="orte"
            title="Start & Ziele"
            state={!profilesLoaded ? "loading" : profiles.every(usable) ? "done" : "todo"}
            summary={routeSummary}
          >
            {/* Default route */}
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Standardroute von</span>
                <select
                  className="h-10 rounded-xl border border-input bg-background px-3"
                  value={defaultRoute?.originKey ?? ""}
                  onChange={(e) => setDefaultRoute((d) => ({ originKey: e.target.value, destKey: d?.destKey ?? "" }))}
                >
                  {profiles.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">nach</span>
                <select
                  className="h-10 rounded-xl border border-input bg-background px-3"
                  value={defaultRoute?.destKey ?? ""}
                  onChange={(e) => setDefaultRoute((d) => ({ originKey: d?.originKey ?? "", destKey: e.target.value }))}
                >
                  {profiles.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="outline"
                onClick={() =>
                  defaultRoute && post({ action: "setDefault", originKey: defaultRoute.originKey, destKey: defaultRoute.destKey })
                }
              >
                Speichern
              </Button>
            </div>

            {/* Profiles */}
            <p className="mb-2 mt-4 text-xs text-muted-foreground">
              Je Ort: primäre Haltestelle zuerst, danach Fallbacks (z. B. der Hauptbahnhof). Mit den Pfeilen umsortieren
              (oben = primär), mit dem Schalter aktivieren/deaktivieren, und jeder Haltestelle die richtige DB-Location
              zuordnen.
            </p>
            <div className="space-y-2">
              {profiles.map((p) => {
                const active = p.stations.filter((s) => s.enabled && s.resolved);
                return (
                  <SettingsSection
                    key={p.id}
                    nested
                    title={
                      <span className="inline-flex items-center gap-2">
                        {p.label}
                        <Badge variant="outline" className="px-2 py-0 font-normal">
                          {p.key}
                        </Badge>
                      </span>
                    }
                    state={usable(p) ? "done" : "todo"}
                    summary={
                      active.length
                        ? `${active[0].stationName}${active.length > 1 ? ` + ${active.length - 1} Fallback${active.length > 2 ? "s" : ""}` : ""}`
                        : "Noch keine zugeordnete Haltestelle"
                    }
                  >
                    <div className="space-y-3">
                      {p.stations.map((s, i) => (
                        <StationRow
                          key={s.id}
                          station={s}
                          isFirst={i === 0}
                          isLast={i === p.stations.length - 1}
                          onResolve={(loc) =>
                            post({ action: "resolve", stationId: s.id, locationId: loc.id, stationName: loc.name })
                          }
                          onRemove={() => post({ action: "removeStation", stationId: s.id })}
                          onToggle={() => post({ action: "setStationEnabled", stationId: s.id, enabled: !s.enabled })}
                          onMove={(dir) => post({ action: "moveStation", stationId: s.id, dir })}
                        />
                      ))}
                    </div>
                    <AddStation
                      first={p.stations.length === 0}
                      onAdd={(loc) => post({ action: "addStation", profileId: p.id, stationName: loc.name, query: loc.name, locationId: loc.id })}
                    />
                  </SettingsSection>
                );
              })}
            </div>
            <NewProfile onCreate={(label) => post({ action: "create", label })} />
          </SettingsSection>

          <DelayDataCard />
        </SettingsGroup>

        <SettingsGroup title="Fahrten & Erstattung">
          <DbAccountCard />
          <MailSyncCard />
          <ClaimantCard />
        </SettingsGroup>

        <SettingsGroup title="Sonstiges">
          <SettingsSection
            id="favoriten"
            title="Favoriten"
            state={favoritesLoaded ? "info" : "loading"}
            summary={favorites.length ? `${favorites.length} gemerkt` : "Noch keine gemerkten Verbindungen"}
          >
            {favorites.length === 0 ? (
              <p className="text-sm text-muted-foreground">Noch keine gemerkten Verbindungen.</p>
            ) : (
              <div className="space-y-2">
                {favorites.map((f) => (
                  <div key={f.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{f.label}</span>
                    <button onClick={() => deleteFavorite(f.id)} className="rounded p-1 text-muted-foreground hover:bg-muted">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>

          <SettingsSection id="cache" title="Cache" state="info" summary="Gespeicherte Fahrpläne und Preise leeren">
            <div className="flex flex-wrap gap-2">
              {[
                ["prune", "Abgelaufenes entfernen"],
                ["clearPrices", "Preis-Cache leeren"],
                ["clearTimetable", "Fahrplan-Cache leeren"],
                ["relearn", "Alles neu lernen"],
                ["clearAll", "Alles leeren"],
              ].map(([action, label]) => (
                <Button
                  key={action}
                  variant={action === "clearAll" ? "danger" : "outline"}
                  size="sm"
                  disabled={busy === action}
                  onClick={() => cacheAction(action)}
                >
                  {busy === action ? <Spinner /> : label}
                </Button>
              ))}
            </div>
            {doneMsg && <p className="mt-3 text-sm font-medium text-[#1B873F]">{doneMsg}</p>}
          </SettingsSection>

          <Link
            href="/lab"
            className="flex items-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm shadow-sm hover:bg-muted/40"
          >
            <FlaskConical className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1">
              <span className="block font-semibold uppercase tracking-wide text-muted-foreground">Lab</span>
              <span className="block text-xs text-muted-foreground">Cache-Statistik, Provider-Status und Technik</span>
            </span>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Link>
        </SettingsGroup>
      </main>
    </>
  );
}

function PreferencesCard() {
  const [bahncard, setBahncard] = React.useState<string>("none");
  const [klasse, setKlasse] = React.useState<1 | 2>(2);
  const [deutschlandTicket, setDeutschlandTicket] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/prefs")
      .then((r) => r.json())
      .then((d) => {
        setBahncard(d.prefs?.bahncard ?? "none");
        setKlasse(d.prefs?.klasse === 1 ? 1 : 2);
        setDeutschlandTicket(d.prefs?.deutschlandTicket === true);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function save() {
    await fetch("/api/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bahncard: bahncard === "none" ? null : bahncard, klasse, deutschlandTicket }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const summary = [
    bahncard === "none" ? "ohne BahnCard" : `BahnCard ${bahncard.slice(2)}`,
    `${klasse}. Klasse`,
    deutschlandTicket && "Deutschland-Ticket",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsSection id="preise" title="Preis-Einstellungen" state={loaded ? "done" : "loading"} summary={summary}>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">BahnCard</span>
          <select
            className="h-10 rounded-xl border border-input bg-background px-3"
            value={bahncard}
            onChange={(e) => setBahncard(e.target.value)}
          >
            <option value="none">keine</option>
            <option value="BC25">BahnCard 25</option>
            <option value="BC50">BahnCard 50</option>
            <option value="BC100">BahnCard 100</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Klasse</span>
          <select
            className="h-10 rounded-xl border border-input bg-background px-3"
            value={klasse}
            onChange={(e) => setKlasse(Number(e.target.value) === 1 ? 1 : 2)}
          >
            <option value={2}>2. Klasse</option>
            <option value={1}>1. Klasse</option>
          </select>
        </label>
        <Button onClick={save}>{saved ? "Gespeichert ✓" : "Speichern"}</Button>
      </div>
      <div className="mt-3">
        <Switch checked={deutschlandTicket} onChange={setDeutschlandTicket} label="Deutschland-Ticket vorhanden" />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Wird bei der Preisabfrage berücksichtigt. Preise ohne diese Angaben sind 2. Klasse ohne Ermäßigung.
      </p>
    </SettingsSection>
  );
}

function StationRow({
  station,
  isFirst,
  isLast,
  onResolve,
  onRemove,
  onToggle,
  onMove,
}: {
  station: Station;
  isFirst: boolean;
  isLast: boolean;
  onResolve: (loc: Loc) => void;
  onRemove: () => void;
  onToggle: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className={"rounded-xl border border-border p-3 " + (station.enabled ? "" : "bg-muted/30 opacity-60")}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Reorder (primär ↔ Fallback / Reihenfolge) */}
          <div className="flex flex-col">
            <button
              onClick={() => onMove("up")}
              disabled={isFirst}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
              aria-label="Nach oben"
              title="Nach oben (Richtung primär)"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              onClick={() => onMove("down")}
              disabled={isLast}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted disabled:opacity-30"
              aria-label="Nach unten"
              title="Nach unten"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium">{station.stationName}</div>
            <div className="text-xs">
              {station.resolved ? (
                <span className="inline-flex items-center gap-1 text-success">
                  <Check className="h-3 w-3" /> zugeordnet
                </span>
              ) : (
                <span className="text-warning">noch nicht zugeordnet</span>
              )}
              {station.priority === 0 ? " · primär" : " · Fallback"}
              {!station.enabled && " · deaktiviert"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch checked={station.enabled} onChange={onToggle} />
          <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
            {station.resolved ? "Ändern" : "Zuordnen"}
          </Button>
          <button onClick={onRemove} className="rounded p-1 text-muted-foreground hover:bg-muted" aria-label="Entfernen">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      {open && (
        <div className="mt-2">
          <LocationSearch
            autoFocus
            placeholder="Haltestelle bei DB suchen …"
            onPick={(loc) => {
              onResolve(loc);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** A new start / destination (e.g. "Freiburg") — then add its stations in its card. */
function NewProfile({ onCreate }: { onCreate: (label: string) => void }) {
  const [label, setLabel] = React.useState("");
  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="mb-1 text-sm font-medium">Neuer Ort</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Start oder Ziel für die Suche anlegen (z. B. „Freiburg“), danach in seinem Eintrag die Haltestelle hinzufügen.
      </p>
      <div className="flex gap-2">
        <Input placeholder="Name, z. B. Freiburg" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button
          variant="outline"
          onClick={() => {
            if (label.trim()) {
              onCreate(label.trim());
              setLabel("");
            }
          }}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/** Search field over DB's stations: pick one and it is added already resolved. */
function AddStation({ first, onAdd }: { first: boolean; onAdd: (loc: Loc) => void }) {
  return (
    <div className="mt-3">
      <LocationSearch
        placeholder={first ? "Haltestelle suchen, z. B. Freiburg Hbf" : "Weitere Haltestelle (Fallback) suchen …"}
        onPick={onAdd}
      />
    </div>
  );
}

/** Type a name → DB's matching stations → tap one. */
function LocationSearch({ placeholder, onPick, autoFocus }: { placeholder: string; onPick: (loc: Loc) => void; autoFocus?: boolean }) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Loc[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [searched, setSearched] = React.useState("");

  React.useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await fetch(`/api/locations?q=${encodeURIComponent(q.trim())}`).then((r) => r.json());
        // stops only — the search also knows OSM places (streets, buildings), no use as a station
        setResults(((data.locations ?? []) as Loc[]).filter((l) => (l.type ?? "").toUpperCase() !== "PLACE" && !/^(way|node|relation)\//.test(l.id)));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
        setSearched(q.trim());
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <div className="relative">
        <Input autoFocus={autoFocus} placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        {loading && <Spinner className="absolute right-3 top-1/2 -translate-y-1/2" />}
      </div>
      {results.length > 0 && (
        <div className="mt-1 space-y-0.5 rounded-xl border border-border p-1">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                onPick(r);
                setQ("");
                setResults([]);
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {r.name}
            </button>
          ))}
        </div>
      )}
      {!loading && searched === q.trim() && q.trim().length >= 2 && results.length === 0 && <p className="mt-1 text-xs text-muted-foreground">Nichts gefunden.</p>}
    </div>
  );
}
