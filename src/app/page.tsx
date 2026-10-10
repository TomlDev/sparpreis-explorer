"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { ArrowDownUp, SlidersHorizontal, Search, StopCircle, GitCompare, CircleDollarSign, Pencil, CalendarRange, Trash2, Link2, Check } from "lucide-react";
import { Sheet } from "@/components/Sheet";
import { AppHeader } from "@/components/AppHeader";
import { CalendarStrip } from "@/components/CalendarStrip";
import { CompareView } from "@/components/CompareView";
import { FiltersSheet } from "@/components/FiltersSheet";
import { ResultCard } from "@/components/results";
import { Button, Card, Chip, ProgressBar, Spinner, Switch } from "@/components/ui";
import { useSearch } from "@/hooks/useSearch";
import type { SearchResult } from "@/lib/domain/result";
import { SORT_LABELS, type SortMode } from "@/lib/domain/ranking";
import type { SearchFilters } from "@/lib/engine/types";
import { formatAgo, formatDateHuman, formatTime, todayLocal, windowToHHmm } from "@/lib/time";
import { TimeRange } from "@/components/TimeRange";
import { parseView, serializeView } from "@/lib/viewState";
import { clientFilter, clientSort, refLeadKeysFor, timeFilterWindow } from "@/lib/viewFilter";
import { formatEuro } from "@/lib/utils";

interface Endpoint {
  key: string;
  label: string;
}

const MODES: { key: "fast" | "thorough" | "deep"; label: string; hint: string }[] = [
  { key: "fast", label: "Schnell", hint: "Cache + wenige Abfragen" },
  { key: "thorough", label: "Gründlich", hint: "Standard – kurze ICE-Segmente & Alternativen" },
  { key: "deep", label: "Tiefensuche", hint: "Systematisch, langsamer" },
];

export default function Page() {
  return (
    <React.Suspense fallback={null}>
      <Home />
    </React.Suspense>
  );
}

function Home() {
  const urlParams = useSearchParams();
  const { state, run: runSearch, abort } = useSearch();
  // The whole view lives in the URL (see lib/viewState) so a copied link
  // restores exactly what was on screen. Parsed once; the URL is then kept in
  // sync with the state below.
  const [initialView] = React.useState(() => parseView(urlParams.toString()));
  const urlHasView = !!initialView.date;

  const [profiles, setProfiles] = React.useState<Endpoint[]>([]);
  const [origin, setOrigin] = React.useState<Endpoint | null>(null);
  const [dest, setDest] = React.useState<Endpoint | null>(null);
  const [travelDate, setTravelDate] = React.useState(initialView.date || todayLocal());
  const [timeWindow, setTimeWindow] = React.useState(initialView.timeFrom);
  const [timeTo, setTimeTo] = React.useState(initialView.timeTo);
  // Does the window mean departure (default) or arrival ("ankommen zwischen …")?
  const [timeMode, setTimeMode] = React.useState<"departure" | "arrival">(initialView.timeMode);
  const [mode, setMode] = React.useState<"fast" | "thorough" | "deep">(initialView.mode);
  const [sort, setSort] = React.useState<SortMode>(initialView.sort);
  const [filters, setFilters] = React.useState<SearchFilters>(initialView.filters);
  // Whole-day scan: cheapest connection with one Fernverkehr leg and a high Flex chance.
  const [dayScan, setDayScan] = React.useState(initialView.day);
  const beforeDayScan = React.useRef<{ sort: SortMode; maxFvLegs: number | null; minFlexPct: number | null } | null>(null);
  function toggleDayScan(on: boolean) {
    setDayScan(on);
    if (on) {
      beforeDayScan.current = { sort, maxFvLegs: filters.maxFvLegs, minFlexPct: filters.minFlexPct };
      setSort("cheapest");
      setFilters({ ...filters, maxFvLegs: 1, minFlexPct: filters.minFlexPct ?? 50 });
      if (mode === "fast") setMode("thorough");
    } else if (beforeDayScan.current) {
      const b = beforeDayScan.current;
      setSort(b.sort);
      setFilters({ ...filters, maxFvLegs: b.maxFvLegs, minFlexPct: b.minFlexPct });
      beforeDayScan.current = null;
    }
  }
  const [referencePrice, setReferencePrice] = React.useState<number | null>(initialView.refPrice);
  const [referenceFp, setReferenceFp] = React.useState<string | null>(initialView.refFp);
  const [filtersOpen, setFiltersOpen] = React.useState(initialView.dialog === "filters");
  const [compare, setCompare] = React.useState<Set<string>>(() => new Set(initialView.compare));
  const [compareOpen, setCompareOpen] = React.useState(initialView.dialog === "compare");
  const [expanded, setExpanded] = React.useState(true);
  const [calendarOpen, setCalendarOpen] = React.useState(initialView.dialog === "calendar");
  // Expanded result cards (details open) — part of the shared view.
  const [openCards, setOpenCards] = React.useState<Set<string>>(() => new Set(initialView.open));
  // Route + date of the results ON SCREEN (the last run), which is what a
  // shared link must reproduce — not unsent edits in the search form.
  const [shown, setShown] = React.useState<{ origin: string | null; dest: string | null; date: string } | null>(
    urlHasView ? { origin: initialView.origin, dest: initialView.dest, date: initialView.date! } : null,
  );
  const [linkCopied, setLinkCopied] = React.useState(false);
  // Every search/restore goes through here, so the link knows which results
  // are on screen.
  const run = React.useCallback(
    (body: Parameters<typeof runSearch>[0]) => {
      const b = body as { originKey?: string; destKey?: string; travelDate?: string };
      if (b.travelDate) setShown({ origin: b.originKey ?? null, dest: b.destKey ?? null, date: b.travelDate });
      return runSearch(body);
    },
    [runSearch],
  );
  const formRef = React.useRef<HTMLDivElement>(null);
  const [teaser, setTeaser] = React.useState<{ results: SearchResult[]; at: number } | null>(null);

  // Load profiles + default route.
  React.useEffect(() => {
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((data) => {
        const eps: Endpoint[] = (data.profiles ?? []).map((p: { key: string; label: string }) => ({
          key: p.key,
          label: p.label,
        }));
        setProfiles(eps);
        const dr = data.defaultRoute;
        // A link's route wins over the default route.
        const byKey = (k: string | null | undefined) => (k ? eps.find((e) => e.key === k) : undefined);
        setOrigin(byKey(initialView.origin) ?? byKey(dr?.originKey) ?? eps[0] ?? null);
        setDest(byKey(initialView.dest) ?? byKey(dr?.destKey) ?? eps[1] ?? null);
      })
      .catch(() => {});
    // restore teaser
    try {
      const raw = localStorage.getItem("lastResults");
      if (raw) setTeaser(JSON.parse(raw));
      // The last search pre-fills the form — unless a link brought its own view.
      const lb = urlHasView ? null : localStorage.getItem("lastBody");
      if (lb) {
        const b = JSON.parse(lb);
        if (b.timeWindow) setTimeWindow(windowToHHmm(b.timeWindow));
        if (b.timeTo) setTimeTo(windowToHHmm(b.timeTo));
        if (b.timeMode) setTimeMode(b.timeMode === "arrival" ? "arrival" : "departure");
        if (b.mode) setMode(b.mode);
        // Remember the last-searched date too.
        if (b.travelDate) setTravelDate(b.travelDate);
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount with a date in the URL, restore cached results once (no live search).
  const restoredRef = React.useRef(false);
  React.useEffect(() => {
    if (restoredRef.current) return;
    const urlDate = initialView.date;
    if (!urlDate) return;
    if (!origin || !dest) return;
    restoredRef.current = true;
    if (urlDate !== travelDate) setTravelDate(urlDate);
    run({
      originKey: origin.key,
      destKey: dest.key,
      travelDate: urlDate, // source of truth for a reload, not the (possibly stale) state
      timeWindow,
      timeTo,
      timeMode,
      mode,
      sort,
      filters,
      restoreOnly: true,
    });
    setExpanded(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, dest]);

  // Persist done results as teaser.
  React.useEffect(() => {
    if (state.phase === "done" && state.results.length) {
      const payload = { results: state.results.slice(0, 8), at: Date.now() };
      try {
        localStorage.setItem("lastResults", JSON.stringify(payload));
      } catch {}
    }
  }, [state.phase, state.results]);

  function swap() {
    setOrigin(dest);
    setDest(origin);
  }

  // Click outside the expanded form collapses it (once results exist).
  React.useEffect(() => {
    if (!expanded) return;
    const hasResults = state.results.length > 0 || !!teaser?.results.length;
    if (!hasResults) return;
    const onDown = (e: MouseEvent) => {
      if (formRef.current && !formRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [expanded, state.results.length, teaser]);

  const bodyBase = React.useCallback(
    () => ({
      originKey: origin?.key,
      destKey: dest?.key,
      timeWindow,
      timeTo,
      timeMode,
      sort,
      filters,
    }),
    [origin, dest, timeWindow, timeTo, timeMode, sort, filters],
  );

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!origin || !dest) return;
    // Phase 1: show the normal bookable connections (reference candidates).
    const body = dayScan
      ? { ...bodyBase(), travelDate, mode, scope: "day" as const, stage: "full" as const }
      : { ...bodyBase(), travelDate, mode, stage: "normal" as const };
    try {
      localStorage.setItem("lastBody", JSON.stringify(body));
    } catch {}
    setCompare(new Set());
    setOpenCards(new Set());
    setReferencePrice(null);
    setReferenceFp(null);
    setExpanded(false); // collapse the form into the compact top bar
    run(body);
  }

  // Phase 2: pick a connection as reference → fetch ALL cheaper alternatives.
  // Anchor the alternatives search on the REFERENCE departure time (not the form
  // window), so the cheaper suggestions are around the same time you'd travel.
  function chooseReference(fp: string, price: number | null) {
    setReferenceFp(fp);
    setReferencePrice(price);
    const ref = displayResults.find((r) => r.fingerprint === fp);
    const refWindow = ref?.metrics.plannedDeparture
      ? formatTime(ref.metrics.plannedDeparture)
      : timeWindow;
    if (origin && dest && price != null && !state.running) {
      run({
        ...bodyBase(),
        timeWindow: refWindow,
        // Alternatives board the reference's leading trains → anchor on its
        // departure, even when browsing by arrival time.
        timeMode: "departure" as const,
        travelDate,
        mode,
        stage: "alternatives" as const,
        referencePrice: price,
      });
    }
  }

  function loadMorePrices() {
    if (!origin || !dest || state.running) return;
    run({ ...bodyBase(), travelDate, mode, morePrices: true });
  }

  const [clearing, setClearing] = React.useState(false);
  async function clearSearch() {
    if (clearing) return;
    if (!window.confirm("Aktuelle Suche komplett leeren (Server-Cache, gelernte Daten und Browser)?")) return;
    setClearing(true);
    abort();
    await fetch("/api/cache", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clearAll" }),
    }).catch(() => {});
    try {
      localStorage.removeItem("lastResults");
      localStorage.removeItem("lastBody");
    } catch {}
    // Hard reset to a clean state (no cached results / URL params left).
    window.location.href = "/";
  }

  // Filter + re-rank the visible set client-side, so applying a filter (e.g.
  // max price) or changing the sort takes effect immediately without a refetch.
  const displayResults = state.results.length ? state.results : teaser?.results ?? [];
  const effectiveReference = referencePrice ?? state.meta?.anchorPrice ?? null;
  const referenceResult = referenceFp
    ? displayResults.find((r) => r.fingerprint === referenceFp) ?? null
    : null;
  // A real alternative must board the SAME leading trains as the reference —
  // same first train at the same time, and the same following regional legs up
  // to the first Fernverkehr (it may only diverge at/after the FV part). Match
  // by departure time + station (train NUMBERS/line labels differ for the same
  // train, e.g. "RB32" vs "31242"), ignoring walking legs.
  const refLeadKeys = React.useMemo(() => refLeadKeysFor(referenceResult), [referenceResult]);
  // Only a reference the USER picked filters the list (belowReference). The auto
  // anchor is informational — filtering by the cheapest would hide everything.
  // Same filter/sort as `npm run view` (lib/viewFilter) → links reproduce 1:1.
  const sorted = React.useMemo(
    () =>
      clientSort(
        clientFilter(
          displayResults,
          filters,
          referencePrice,
          refLeadKeys,
          dayScan ? null : timeFilterWindow(timeWindow, timeTo, timeMode),
        ),
        sort,
      ),
    [displayResults, filters, sort, referencePrice, refLeadKeys, timeWindow, timeTo, timeMode, dayScan],
  );

  // ---- Shareable view: keep the URL = what is on screen ----
  const viewQuery = serializeView({
    origin: shown?.origin ?? origin?.key ?? null,
    dest: shown?.dest ?? dest?.key ?? null,
    date: shown?.date ?? travelDate,
    timeFrom: timeWindow,
    timeTo,
    timeMode,
    mode,
    sort,
    filters,
    refFp: referenceFp,
    refPrice: referencePrice,
    open: [...openCards],
    compare: [...compare],
    dialog: filtersOpen ? "filters" : calendarOpen ? "calendar" : compareOpen ? "compare" : null,
    day: dayScan,
  });
  React.useEffect(() => {
    if (!shown) return; // nothing searched yet → keep the URL clean
    if (window.location.search.replace(/^\?/, "") === viewQuery) return;
    window.history.replaceState(null, "", `${window.location.pathname}?${viewQuery}`);
  }, [shown, viewQuery]);

  // Opened via a link with expanded cards → scroll the first one into view once.
  const scrolledRef = React.useRef(false);
  React.useEffect(() => {
    if (scrolledRef.current) return;
    const target = initialView.open.find((fp) => sorted.some((r) => r.fingerprint === fp));
    if (!target) return;
    scrolledRef.current = true;
    requestAnimationFrame(() =>
      document.getElementById(`r-${target}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }, [sorted, initialView.open]);

  function setCardOpen(fp: string, isOpen: boolean) {
    setOpenCards((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(fp);
      else next.delete(fp);
      return next;
    });
  }

  function copyLink() {
    const url = window.location.href;
    const done = () => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(done);
    } else {
      // fallback for non-secure contexts
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      ta.remove();
      done();
    }
  }

  function toggleCompare(fp: string) {
    setCompare((prev) => {
      const next = new Set(prev);
      if (next.has(fp)) next.delete(fp);
      else if (next.size < 3) next.add(fp);
      return next;
    });
  }

  const totalCount = sorted.length;
  const pricedCount = sorted.filter((r) => r.coverage.price != null).length;
  const priceableRemaining = state.meta?.priceableRemaining ?? null;
  const nothingMoreToPrice = priceableRemaining === 0;
  const compareResults = sorted.filter((r) => compare.has(r.fingerprint));
  const progressPct = state.progress && state.progress.total > 0 ? (state.progress.checked / state.progress.total) * 100 : 0;

  // Compact search shown inside the top header once collapsed.
  const compactSearch = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-muted"
        title="Suche ändern"
      >
        <span className="truncate text-sm font-medium">
          {origin?.label} → {dest?.label}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground xl:inline">
          {dayScan ? "ganzer Tag" : `${timeMode === "arrival" ? "an" : "ab"} ${timeWindow}–${timeTo}`} ·{" "}
          {MODES.find((m) => m.key === mode)?.label}
        </span>
        <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={copyLink}
        aria-label="Link zu dieser Ansicht kopieren"
        title={linkCopied ? "Link kopiert" : "Link zu dieser Ansicht kopieren"}
      >
        {linkCopied ? <Check className="h-5 w-5 text-success" /> : <Link2 className="h-5 w-5" />}
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={() => setCalendarOpen(true)} aria-label="Woche vergleichen" title="Woche vergleichen">
        <CalendarRange className="h-5 w-5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" onClick={() => setFiltersOpen(true)} aria-label="Filter">
        <SlidersHorizontal className="h-5 w-5" />
      </Button>
      {state.running ? (
        <Button type="button" variant="ghost" size="icon" onClick={abort} aria-label="Abbrechen">
          <StopCircle className="h-5 w-5" />
        </Button>
      ) : (
        <Button type="button" size="icon" onClick={() => submit()} aria-label="Suchen">
          <Search className="h-5 w-5" />
        </Button>
      )}
    </div>
  );

  // Status / hint notices — shown floating on the right (desktop) or inline (mobile).
  const infoNotices = (
    <>
      {(state.cached || (!state.results.length && teaser)) && sorted.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          Gespeicherte Ergebnisse – Preise werden ggf. aktualisiert …
        </div>
      )}
      {teaser && !state.results.length && !state.running && (
        <div className="text-xs text-muted-foreground">Zuletzt gefunden {formatAgo(teaser.at)}</div>
      )}
      {!referenceFp && !dayScan && sorted.length > 0 && !state.running && (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
          Wähle mit <b>„Als Referenz"</b> deine Wunschverbindung — danach sucht die App automatisch alle{" "}
          <b>günstigeren</b> Alternativen mit möglichst wenig Fernverkehr.
        </div>
      )}
      {referenceFp && !state.running && (
        <div className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          Referenz {referencePrice != null ? formatEuro(referencePrice) : ""} gewählt — gezeigt werden nur
          günstigere Alternativen, die mit <b>denselben ersten Zügen</b> starten und erst beim Fernverkehr abweichen.
        </div>
      )}
    </>
  );

  return (
    <>
      <AppHeader center={expanded ? undefined : compactSearch} />
      <main className="container max-w-3xl pb-28 pt-5">
        {/* Search form (full) */}
        {expanded && (
        <Card ref={formRef} className="p-4 sm:p-5">
          <form onSubmit={submit}>
            <div className="relative flex flex-col gap-2">
              <EndpointSelect label="Von" value={origin} options={profiles} onChange={setOrigin} />
              <button
                type="button"
                onClick={swap}
                className="absolute right-3 top-1/2 z-10 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card shadow-sm hover:bg-muted"
                aria-label="Start und Ziel tauschen"
              >
                <ArrowDownUp className="h-5 w-5" />
              </button>
              <EndpointSelect label="Nach" value={dest} options={profiles} onChange={setDest} />
            </div>

            <div className="mt-3 space-y-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Datum</span>
                <input
                  type="date"
                  value={travelDate}
                  min={todayLocal()}
                  onChange={(e) => setTravelDate(e.target.value)}
                  className="h-11 rounded-xl border border-input bg-background px-3 text-base"
                />
              </label>
              <div className="rounded-xl border border-input bg-background px-3.5 py-1.5">
                <Switch checked={dayScan} onChange={toggleDayScan} label="Ganzer Tag: günstigste Flex-Verbindung" />
                {dayScan && (
                  <p className="pb-1 text-xs text-muted-foreground">
                    Sucht den ganzen Tag (ab 05 Uhr, 6 Zeitfenster) nach Tickets mit genau einem Fernverkehrs-Abschnitt und
                    hoher Flex-Chance (ab {filters.minFlexPct ?? 0} %, im Filter änderbar) – sortiert nach Preis. Dauert ein
                    paar Minuten.
                  </p>
                )}
              </div>
              {!dayScan && (
                <div className="rounded-xl border border-input bg-background px-3.5 pb-2 pt-2.5">
                  <TimeRange
                    from={timeWindow}
                    to={timeTo}
                    onChange={(f, t) => {
                      setTimeWindow(f);
                      setTimeTo(t);
                    }}
                    noun={timeMode === "arrival" ? "Ankunft" : "Abfahrt"}
                    label={
                      <span className="inline-flex rounded-md bg-muted p-0.5" role="group" aria-label="Zeitfenster bezieht sich auf">
                        {(["departure", "arrival"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setTimeMode(m)}
                            aria-pressed={timeMode === m}
                            className={
                              "rounded px-2 py-0.5 text-xs font-medium transition " +
                              (timeMode === m
                                ? "bg-card text-foreground shadow-sm"
                                : "text-muted-foreground hover:text-foreground")
                            }
                          >
                            {m === "departure" ? "Abfahrt" : "Ankunft"}
                          </button>
                        ))}
                      </span>
                    }
                  />
                </div>
              )}
            </div>

            {/* Modes */}
            <div className="mt-3 grid grid-cols-3 gap-2">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setMode(m.key)}
                  // The fast mode skips the one-Fernverkehr-leg pricing the day scan is about.
                  disabled={dayScan && m.key === "fast"}
                  className={
                    "rounded-xl border p-2 text-center transition disabled:opacity-40 " +
                    (mode === m.key && !(dayScan && m.key === "fast")
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-muted")
                  }
                  title={dayScan && m.key === "fast" ? "Für den ganzen Tag mindestens „Gründlich“" : m.hint}
                >
                  <div className="text-sm font-medium">{m.label}</div>
                </button>
              ))}
            </div>

            <div className="mt-3 flex gap-2">
              {state.running ? (
                <Button type="button" variant="danger" size="lg" className="flex-1" onClick={abort}>
                  <StopCircle className="h-5 w-5" /> Suche abbrechen
                </Button>
              ) : (
                <Button type="submit" size="lg" className="flex-1">
                  <Search className="h-5 w-5" /> Verbindungen finden
                </Button>
              )}
              <Button type="button" variant="outline" size="lg" onClick={() => setFiltersOpen(true)}>
                <SlidersHorizontal className="h-5 w-5" />
                <span className="hidden sm:inline">Filter</span>
              </Button>
              <Button type="button" variant="outline" size="lg" onClick={() => setCalendarOpen(true)} title="Woche vergleichen">
                <CalendarRange className="h-5 w-5" />
              </Button>
            </div>
          </form>
        </Card>
        )}

        {/* Meta / status line */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {state.meta && (
            <>
              {state.meta.originVariants.map((v) => (
                <span key={v.label}>
                  Ab {v.label}: <b className="text-foreground">{v.count}</b>
                </span>
              ))}
              {state.meta.anchorPrice != null && (
                <span>Bestpreis ab {formatEuro(state.meta.anchorPrice)}</span>
              )}
              {referenceFp && referencePrice != null && (
                <span className="inline-flex items-center gap-1 font-medium text-primary">
                  Referenz: {formatEuro(referencePrice)} — nur günstigere
                  {referenceFp && (
                    <button
                      type="button"
                      onClick={() => {
                        setReferencePrice(null);
                        setReferenceFp(null);
                      }}
                      className="rounded px-1 leading-none hover:bg-muted"
                      aria-label="Referenz zurücksetzen"
                      title="Referenz zurücksetzen"
                    >
                      ×
                    </button>
                  )}
                </span>
              )}
              {state.meta.dailyCapReached && (
                <span className="font-medium text-warning">⚠ Tageslimit Preisabfragen erreicht</span>
              )}
              <span>Fahrplan: {state.meta.routingProvider}</span>
              <span>
                {state.meta.priceCheckAvailable
                  ? `Preisprüfung: ${state.meta.pricingProvider} (${state.meta.pricedCount} geprüft)`
                  : "Preisprüfung: nicht verfügbar"}
              </span>
            </>
          )}
        </div>

        {/* status + progress */}
        {state.running && (
          <div className="mt-3 rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2 text-sm">
              <Spinner /> {state.status ?? "Suche läuft …"}
            </div>
            {state.progress && state.progress.total > 0 && (
              <div className="mt-2">
                <ProgressBar value={progressPct} />
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>
                    {state.progress.checked} / {state.progress.total} Kombinationen
                  </span>
                  {state.progress.bestPrice != null && (
                    <span>
                      bester Treffer: {formatEuro(state.progress.bestPrice)}
                      {state.progress.bestFvMinutes != null && ` · ICE ${state.progress.bestFvMinutes} min`}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* error banner (with graceful fallback) */}
        {state.error && (
          <Card className="mt-3 border-warning/40 bg-warning/5 p-4">
            <p className="text-sm">{state.error}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => submit()}>
              Erneut versuchen
            </Button>
          </Card>
        )}

        {/* Mobile sort row (desktop uses the floating right stack) */}
        {displayResults.length > 0 && (
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {(Object.keys(SORT_LABELS) as SortMode[]).map((s) => (
              <Chip key={s} type="button" active={sort === s} onClick={() => setSort(s)} className="shrink-0">
                {SORT_LABELS[s]}
              </Chip>
            ))}
          </div>
        )}

        {sort === "cheap-flex" && displayResults.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            🎯 Oben stehen Verbindungen, zu denen es keine günstigere mit höherer Flex-Chance gibt. Flex = Chance auf ≥ 20 min
            Verspätung am Ziel – dann ist die Zugbindung aufgehoben. Schätzung aus vergangenen Monaten (Open Data), keine
            Garantie.
          </p>
        )}

        {/* Results */}
        <div className="mt-4 space-y-3">
          {sorted.length === 0 && !state.running && referenceFp && displayResults.length > 0 ? (
            (() => {
              const priced = displayResults.filter((r) => r.coverage.price != null);
              const cheapest = priced.length
                ? priced.reduce((a, b) => ((a.coverage.price ?? 1e9) < (b.coverage.price ?? 1e9) ? a : b))
                : null;
              const refT = referenceResult ? formatTime(referenceResult.metrics.plannedDeparture) : "";
              const cheaperElsewhere =
                cheapest && referencePrice != null && (cheapest.coverage.price ?? 1e9) < referencePrice;
              return (
                <Card className="p-6 text-center text-muted-foreground">
                  <p className="text-sm">
                    Für deine Referenz {refT ? `um ${refT} ` : ""}
                    ({referencePrice != null ? formatEuro(referencePrice) : ""}) gibt es{" "}
                    <b>keine günstigere</b> Verbindung mit <b>denselben ersten Zügen</b> — sie ist bereits die
                    günstigste zu dieser Abfahrt.
                  </p>
                  {cheaperElsewhere && cheapest && (
                    <p className="mt-2 text-sm">
                      Günstiger (<b>{formatEuro(cheapest.coverage.price)}</b>) geht nur mit{" "}
                      <b>anderer Abfahrt um {formatTime(cheapest.metrics.plannedDeparture)}</b>.
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => {
                      setReferencePrice(null);
                      setReferenceFp(null);
                    }}
                  >
                    Referenz zurücksetzen – alle {displayResults.length} anzeigen
                  </Button>
                </Card>
              );
            })()
          ) : (
            sorted.length === 0 &&
            !state.running && (
              <Card className="p-8 text-center text-muted-foreground">
                <p className="text-sm">
                  Wähle Datum und starte die Suche. Nach den ersten Suchen wird die App auf deiner
                  Stammstrecke immer schneller.
                </p>
                <p className="mt-1 text-xs">{formatDateHuman(travelDate)}</p>
              </Card>
            )
          )}
          <div className="space-y-2 lg:hidden">{infoNotices}</div>
          {sorted.map((r) => (
            <ResultCard
              key={r.fingerprint + r.variant}
              r={r}
              travelDate={travelDate}
              compareOn={compare.has(r.fingerprint)}
              onToggleCompare={() => toggleCompare(r.fingerprint)}
              referencePrice={effectiveReference}
              isReference={r.fingerprint === referenceFp}
              onSetReference={() => chooseReference(r.fingerprint, r.coverage.price ?? null)}
              stationIds={state.meta?.stationIds}
              open={openCards.has(r.fingerprint)}
              onOpenChange={(o) => setCardOpen(r.fingerprint, o)}
            />
          ))}
        </div>
      </main>

      {/* Floating "clear search" button — bottom-left */}
      <button
        type="button"
        onClick={clearSearch}
        disabled={clearing}
        className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium text-muted-foreground shadow-lg transition hover:bg-muted hover:text-foreground disabled:opacity-60"
        title="Aktuelle Suche leeren (Server-Cache, gelernte Daten & Browser)"
      >
        {clearing ? <Spinner /> : <Trash2 className="h-4 w-4" />}
        <span>Suche leeren</span>
      </button>

      {/* Floating "load more prices" button — always visible, with counts */}
      <button
        type="button"
        onClick={loadMorePrices}
        disabled={state.running || nothingMoreToPrice}
        className={
          "fixed right-4 z-50 flex items-center gap-2 rounded-full bg-primary py-2.5 pl-4 pr-4 text-primary-foreground shadow-lg transition hover:opacity-90 disabled:opacity-60 " +
          (compare.size >= 2 ? "bottom-20" : "bottom-4")
        }
        aria-label="Mehr Preise laden"
        title={
          nothingMoreToPrice
            ? "Alle bepreisbaren Kandidaten der aktuellen Suche sind geprüft"
            : "Weitere Kandidaten der aktuellen Suche bepreisen (gleiche Route, kein neuer Fahrplan-Abruf)"
        }
      >
        {state.running ? <Spinner /> : <CircleDollarSign className="h-5 w-5 shrink-0" />}
        <span className="flex flex-col items-start leading-tight">
          <span className="text-sm font-medium">
            {nothingMoreToPrice
              ? "Alle Preise geladen"
              : priceableRemaining != null
                ? `Mehr Preise laden (${priceableRemaining})`
                : "Mehr Preise laden"}
          </span>
          <span className="text-[11px] opacity-85">
            {pricedCount} Preise · {totalCount} Verbindungen
          </span>
        </span>
      </button>

      {/* Compare bar */}
      {compare.size >= 2 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 p-3 backdrop-blur">
          <div className="container flex max-w-3xl items-center justify-between">
            <span className="text-sm">{compare.size} ausgewählt</span>
            <Button onClick={() => setCompareOpen(true)}>
              <GitCompare className="h-4 w-4" /> Vergleichen
            </Button>
          </div>
        </div>
      )}

      {/* Floating filter panel — left screen edge (mirror of the sort stack) */}
      {displayResults.length > 0 && (
        <div className="fixed left-3 top-20 z-40 hidden w-64 flex-col gap-1 rounded-2xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur lg:flex">
          <span className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Filter</span>
          <Switch
            label="Nur Original (DB)"
            checked={filters.onlyOriginal}
            onChange={(v) => setFilters({ ...filters, onlyOriginal: v })}
          />
          <Switch
            label="Nur günstigere"
            checked={filters.belowReference}
            onChange={(v) => setFilters({ ...filters, belowReference: v })}
          />
          <Switch
            label="Start-Fallback"
            checked={filters.useFallback}
            onChange={(v) => setFilters({ ...filters, useFallback: v })}
          />
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setFiltersOpen(true)}>
            Alle Filter …
          </Button>
        </div>
      )}

      {/* Floating reference panel — left screen edge, with controls */}
      {referenceResult && (
        <div className="fixed left-3 top-1/2 z-40 hidden w-64 -translate-y-1/2 flex-col gap-1.5 rounded-2xl border border-primary/40 bg-card/95 p-3 shadow-lg backdrop-blur lg:flex">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wide text-primary">Referenz</span>
            <button
              type="button"
              onClick={() => {
                setReferencePrice(null);
                setReferenceFp(null);
              }}
              className="rounded px-1.5 text-lg leading-none text-muted-foreground hover:bg-muted"
              aria-label="Referenz zurücksetzen"
              title="Referenz zurücksetzen"
            >
              ×
            </button>
          </div>
          <div className="text-base font-semibold tabular-nums">
            {formatTime(referenceResult.metrics.plannedDeparture)}–{formatTime(referenceResult.metrics.plannedArrival)}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {referenceResult.metrics.originName} → {referenceResult.metrics.destinationName}
          </div>
          {referenceResult.coverage.price != null && (
            <div className="text-xl font-bold leading-none">{formatEuro(referenceResult.coverage.price)}</div>
          )}
          <div className="truncate text-[11px] text-muted-foreground">{referenceResult.chainLabel}</div>
          <Button
            size="sm"
            variant="outline"
            className="mt-1"
            disabled={state.running}
            onClick={() => chooseReference(referenceResult.fingerprint, referenceResult.coverage.price ?? null)}
          >
            Alternativen neu suchen
          </Button>
        </div>
      )}

      {/* Floating status/hint notices — top-right (desktop) */}
      <div className="fixed right-3 top-20 z-30 hidden max-h-[40vh] w-64 flex-col gap-2 overflow-auto lg:flex">
        {infoNotices}
      </div>

      {/* Floating sort controls — right screen edge, vertically stacked */}
      {displayResults.length > 0 && (
        <div className="fixed right-3 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-stretch gap-1.5 rounded-2xl border border-border bg-card/95 p-2 shadow-lg backdrop-blur lg:flex">
          <span className="px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sortierung</span>
          {(Object.keys(SORT_LABELS) as SortMode[]).map((s) => (
            <Chip key={s} type="button" active={sort === s} onClick={() => setSort(s)}>
              {SORT_LABELS[s]}
            </Chip>
          ))}
        </div>
      )}

      <FiltersSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} filters={filters} onChange={setFilters} />
      <CompareView open={compareOpen} onClose={() => setCompareOpen(false)} results={compareResults} />
      <Sheet open={calendarOpen} onClose={() => setCalendarOpen(false)} title="Woche vergleichen">
        {origin && dest ? (
          <CalendarStrip
            baseDate={travelDate}
            baseBody={bodyBase()}
            onPick={(d) => {
              setTravelDate(d);
              setCalendarOpen(false);
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">Bitte zuerst Start und Ziel wählen.</p>
        )}
      </Sheet>
    </>
  );
}

function EndpointSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Endpoint | null;
  options: Endpoint[];
  onChange: (e: Endpoint) => void;
}) {
  return (
    <div className="rounded-xl border border-input bg-background px-3.5 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <select
        value={value?.key ?? ""}
        onChange={(e) => {
          const found = options.find((o) => o.key === e.target.value);
          if (found) onChange(found);
        }}
        className="w-full bg-transparent text-base font-medium outline-none"
      >
        {options.length === 0 && <option>lädt …</option>}
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
