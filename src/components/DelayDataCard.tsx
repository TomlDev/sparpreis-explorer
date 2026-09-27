"use client";

import * as React from "react";
import { Badge, Button, Card, ProgressBar, Spinner, Switch } from "@/components/ui";
import { FULL_COVERAGE_FROM, planMonths, type AvailableMonth } from "@/lib/delay/plan";
import { DEFAULT_BUILD_PARAMS, type DelayBuildParams, type DelayWeights } from "@/lib/delay/types";
import { formatAgo } from "@/lib/time";

interface BuildInfo {
  id: string;
  status: string;
  params: DelayBuildParams;
  months: string[];
  stations: number;
  rows: number;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}
interface JobState {
  buildId: string;
  months: string[];
  stage: string;
  month: string | null;
  index: number;
  bytes: number;
  total: number;
  stations: number;
  error: string | null;
}
interface Status {
  active: BuildInfo | null;
  job: JobState | null;
  lastFailed: BuildInfo | null;
  weights: DelayWeights;
  available: AvailableMonth[] | null;
  availableError: string | null;
  relevant: { evas: number; names: number; missing: number };
}

const mb = (b: number) => `${Math.round(b / 1e6).toLocaleString("de-DE")} MB`;
const monthLabel = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, 15)).toLocaleDateString("de-DE", { month: "short", year: "2-digit" });
};

function Select<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <select
        className="h-10 rounded-xl border border-input bg-background px-3"
        value={String(value)}
        onChange={(e) => {
          const hit = options.find(([v]) => String(v) === e.target.value);
          if (hit) onChange(hit[0]);
        }}
      >
        {options.map(([v, l]) => (
          <option key={String(v)} value={String(v)}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DelayDataCard() {
  const [st, setSt] = React.useState<Status | null>(null);
  const [params, setParams] = React.useState<DelayBuildParams>(DEFAULT_BUILD_PARAMS);
  const [weights, setWeightsState] = React.useState<DelayWeights | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [savedW, setSavedW] = React.useState(false);
  const running = !!st?.job && st.job.stage !== "done" && st.job.stage !== "failed";

  const load = React.useCallback(async () => {
    const d = (await fetch("/api/delaydata").then((r) => r.json())) as Status;
    setSt(d);
    setWeightsState((w) => w ?? d.weights);
    if (d.active?.params) setParams((p) => (p === DEFAULT_BUILD_PARAMS ? d.active!.params : p));
  }, []);

  React.useEffect(() => {
    load().catch(() => setErr("Status konnte nicht geladen werden."));
  }, [load]);
  React.useEffect(() => {
    if (!running) return;
    const t = setInterval(() => load().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [running, load]);

  const today = new Date().toISOString().slice(0, 10);
  const plan = st?.available ? planMonths(params, st.available, today) : [];
  const bytes = plan.reduce((s, m) => s + (st?.available?.find((a) => a.month === m)?.bytes ?? 0), 0);
  const sparse = plan.filter((m) => m < FULL_COVERAGE_FROM);

  async function act(body: unknown) {
    setErr(null);
    const res = await fetch("/api/delaydata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) setErr(d.error ?? `Fehler ${res.status}`);
    await load();
    return d;
  }

  async function saveWeights() {
    if (!weights) return;
    const d = await act({ action: "weights", weights });
    if (d.weights) setWeightsState(d.weights);
    setSavedW(true);
    setTimeout(() => setSavedW(false), 1500);
  }

  const job = st?.job;
  // index = months finished so far (download of month k happens while index = k − 1)
  const done = !job
    ? 0
    : job.stage === "download"
      ? job.index + (job.total ? job.bytes / job.total : 0) * 0.8
      : job.stage === "aggregate"
        ? job.index - 0.2
        : job.index;
  const progress = job ? done / Math.max(1, job.months.length) : 0;

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Pünktlichkeit (Open Data)
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Lädt echte Ist-Zeiten vergangener Monate für die Bahnhöfe deiner Strecken und speichert kompakte Statistiken.
        Daraus schätzt die Suche pro Verbindung, wie wahrscheinlich Anschlüsse klappen und wie oft man ≥ 20 min zu spät
        ankommt (dann ist die Zugbindung aufgehoben). Das ist eine Statistik über die Vergangenheit, keine Aussage über
        einen konkreten Zug.
      </p>

      {/* Active data */}
      {st?.active ? (
        <div className="mb-3 rounded-xl border border-border p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="success">aktiv</Badge>
            <span>
              {st.active.months.length} Monate ({st.active.months.map(monthLabel).join(", ")})
            </span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {st.active.stations} Bahnhöfe · {st.active.rows.toLocaleString("de-DE")} Statistikzeilen · erstellt{" "}
            {st.active.finishedAt ? formatAgo(st.active.finishedAt) : "–"}
            {st.relevant.missing > 0 && (
              <span className="text-warning">
                {" "}
                · {st.relevant.missing} neue Bahnhöfe ohne Daten → neu laden
              </span>
            )}
          </div>
        </div>
      ) : (
        st && <p className="mb-3 text-sm text-muted-foreground">Noch keine Pünktlichkeitsdaten geladen.</p>
      )}

      {/* Build parameters */}
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Letzte Monate"
          value={params.recentMonths}
          options={[1, 2, 3, 4, 6, 9, 12].map((n) => [n, `${n} ${n === 1 ? "Monat" : "Monate"}`])}
          onChange={(v) => setParams((p) => ({ ...p, recentMonths: v }))}
        />
        <Select
          label="Gleiche Jahreszeit aus"
          value={params.seasonYears}
          options={[
            [0, "– aus –"],
            [1, "Vorjahr"],
            [2, "Vor- + Vorvorjahr"],
          ]}
          onChange={(v) => setParams((p) => ({ ...p, seasonYears: v }))}
        />
        <Select
          label="Saison-Fenster"
          value={params.seasonSpan}
          options={[
            [0, "nur gleicher Monat"],
            [1, "± 1 Monat"],
            [2, "± 2 Monate"],
          ]}
          onChange={(v) => setParams((p) => ({ ...p, seasonSpan: v }))}
        />
      </div>
      {st?.available && (
        <p className="mt-2 text-xs text-muted-foreground">
          Lädt {plan.length} Monate ({plan.map(monthLabel).join(", ")}) · ca. {mb(bytes)} Download, wird nach dem
          Auswerten gelöscht · {st.relevant.evas + st.relevant.names} Halte aus deinen Suchen (Daten gibt es nur
          für Bahnhöfe, nicht für Bus/Tram).
          {sparse.length > 0 && (
            <>
              {" "}
              Monate vor {monthLabel(FULL_COVERAGE_FROM)} enthalten nur ~130 große Bahnhöfe; für kleinere Halte zählen
              dort nur die neueren Monate.
            </>
          )}
        </p>
      )}
      {st?.availableError && (
        <p className="mt-2 text-xs text-danger">Monatsliste nicht abrufbar: {st.availableError}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {running ? (
          <Button variant="outline" onClick={() => act({ action: "cancel" })}>
            Abbrechen
          </Button>
        ) : (
          <Button disabled={!st?.available || plan.length === 0} onClick={() => act({ action: "build", params })}>
            {st?.active ? "Daten neu laden" : "Daten laden & auswerten"}
          </Button>
        )}
        {st?.active && !running && (
          <Button variant="ghost" size="sm" onClick={() => act({ action: "delete" })}>
            Daten löschen
          </Button>
        )}
      </div>

      {running && job && (
        <div className="mt-3 space-y-1">
          <ProgressBar value={Math.round(Math.min(1, Math.max(0, progress)) * 100)} />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            {job.stage === "download"
              ? `Lade ${monthLabel(job.month ?? "")} (${job.index + 1}/${job.months.length}) · ${mb(job.bytes)}${job.total ? ` / ${mb(job.total)}` : ""}`
              : job.stage === "aggregate"
                ? `Werte ${monthLabel(job.month ?? "")} aus (${job.index}/${job.months.length})`
                : job.stage === "written"
                  ? `${monthLabel(job.month ?? "")} gespeichert (${job.index}/${job.months.length})`
                  : "Startet …"}
          </div>
        </div>
      )}
      {job?.stage === "failed" && <p className="mt-2 text-sm text-danger">Import fehlgeschlagen: {job.error}</p>}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}

      {/* Query-time weighting */}
      {weights && (
        <div className="mt-4 border-t border-border pt-3">
          <div className="mb-2 text-xs font-semibold text-muted-foreground">
            Gewichtung (wirkt sofort, ohne neu zu laden)
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Ältere Monate zählen weniger"
              value={weights.halfLifeMonths}
              options={[
                [1, "stark (Halbwertszeit 1 Monat)"],
                [3, "mittel (3 Monate)"],
                [6, "schwach (6 Monate)"],
                [36, "kaum (alle gleich)"],
              ]}
              onChange={(v) => setWeightsState((w) => w && { ...w, halfLifeMonths: v })}
            />
            <Select
              label="Gleiche Jahreszeit wie Reisedatum"
              value={weights.seasonBoost}
              options={[
                [1, "normal"],
                [2, "doppelt"],
                [3, "dreifach"],
              ]}
              onChange={(v) => setWeightsState((w) => w && { ...w, seasonBoost: v })}
            />
            <Select
              label="Mindest-Beobachtungen pro Zug"
              value={weights.minSamples}
              options={[
                [10, "10"],
                [20, "20"],
                [40, "40"],
              ]}
              onChange={(v) => setWeightsState((w) => w && { ...w, minSamples: v })}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Switch
              checked={weights.matchWeekday}
              onChange={(v) => setWeightsState((w) => w && { ...w, matchWeekday: v })}
              label="Wochentag beachten (Mo–Do / Fr / Wochenende)"
            />
            <Button size="sm" variant="outline" onClick={saveWeights}>
              {savedW ? "Gespeichert ✓" : "Gewichtung speichern"}
            </Button>
          </div>
        </div>
      )}

      <p className="mt-4 text-[11px] text-muted-foreground">
        Datenquelle:{" "}
        <a
          className="underline"
          href="https://huggingface.co/datasets/piebro/deutsche-bahn-data"
          target="_blank"
          rel="noreferrer"
        >
          piebro/deutsche-bahn-data
        </a>{" "}
        (Deutsche Bahn Timetables API, Lizenz CC BY 4.0).
      </p>
    </Card>
  );
}
