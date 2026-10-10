/**
 * Reproduce exactly what the user sees from a shared link (lib/viewState):
 *
 *   npm run view -- '<https://your-domain.example/?...>'        visible list
 *   npm run view -- '<url>' --all                          + hidden ones with the reason
 *   npm run view -- '<url>' --json                         machine-readable
 *
 * Cache-only (same as a browser reload): no MOTIS/DB calls. The visible list is
 * computed with the page's own filter/sort (lib/viewFilter), so it matches 1:1.
 */
import { SORT_LABELS } from "@/lib/domain/ranking";
import type { SearchResult } from "@/lib/domain/result";
import { walkWait } from "@/lib/domain/transferWait";
import {
  DEFAULT_FILTERS,
  type SearchEvent,
  type SearchFilters,
} from "@/lib/engine/types";
import { formatTime } from "@/lib/time";
import {
  clientFilter,
  clientSort,
  filterReason,
  refLeadKeysFor,
  timeFilterWindow,
} from "@/lib/viewFilter";
import { parseView } from "@/lib/viewState";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const input = args.find((a) => !a.startsWith("--"));
  if (!input) {
    console.error("Usage: npm run view -- '<url or query>' [--all] [--json]");
    process.exit(2);
  }

  const { ensureReady } = await import("@/lib/bootstrap");
  const { runSearch, applyFilters } = await import("@/lib/engine/search");
  const { loadResults } = await import("@/lib/repo/journeys");
  const { getDefaultRoute, getProfile } = await import("@/lib/routeProfiles");
  ensureReady();

  const view = parseView(input);
  if (!view.date) {
    console.error(
      "Der Link enthält keine Ansicht (kein date=…). Erst suchen, dann den Link kopieren.",
    );
    process.exit(1);
  }
  const dr = getDefaultRoute();
  const originKey = view.origin ?? dr?.origin.key;
  const destKey = view.dest ?? dr?.destination.key;
  if (!originKey || !destKey) {
    console.error("Keine Route (o/d) im Link und keine Standardroute gesetzt.");
    process.exit(1);
  }

  // Restore the WHOLE cached set for route+date (permissive server filters), then
  // apply the user's server filter + client filter exactly like the browser does.
  const permissive: SearchFilters = {
    ...DEFAULT_FILTERS,
    onlyPriced: false,
    onlyFullTicket: false,
    allowICE: true,
    allowIC: true,
    maxPrice: null,
    maxDurationMin: null,
    maxTransfers: null,
    maxFvMinutes: null,
    maxFvStops: null,
    minTransferMin: null,
  };
  let union: SearchResult[] = [];
  await runSearch(
    {
      originKey,
      destKey,
      travelDate: view.date,
      timeWindow: view.timeFrom,
      timeTo: view.timeTo,
      timeMode: view.timeMode,
      mode: view.mode,
      sort: view.sort,
      filters: permissive,
      restoreOnly: true,
    },
    {
      emit: (e: SearchEvent) => {
        if (e.type === "done") union = e.results;
      },
    },
  );

  const serverSet = applyFilters(union, view.filters); // what the browser received
  const reference = view.refFp
    ? (serverSet.find((r) => r.fingerprint === view.refFp) ?? null)
    : null;
  const refLeadKeys = refLeadKeysFor(reference);
  const timeWin = view.day ? null : timeFilterWindow(view.timeFrom, view.timeTo, view.timeMode);
  const visible = clientSort(
    clientFilter(serverSet, view.filters, view.refPrice, refLeadKeys, timeWin),
    view.sort,
  );
  const visibleFps = new Set(visible.map((r) => r.fingerprint));
  const ctx = {
    filters: view.filters,
    reference: view.refPrice,
    refLeadKeys,
    window: timeWin,
    anyPriced: union.some((r) => r.coverage.price != null),
  };
  const hidden = union
    .filter((r) => !visibleFps.has(r.fingerprint))
    .map((r) => ({
      r,
      reason: filterReason(r, ctx) ?? "vom Server-Filter entfernt",
    }));

  // ---- output ----
  const eur = (n: number | null | undefined) =>
    n == null
      ? "–"
      : `${n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const dur = (min: number) =>
    `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
  const changedFilters = (
    Object.keys(DEFAULT_FILTERS) as (keyof SearchFilters)[]
  )
    .filter((k) => view.filters[k] !== DEFAULT_FILTERS[k])
    .map((k) => `${k}=${String(view.filters[k] ?? "–")}`);

  if (flags.has("--json")) {
    const row = (r: SearchResult) => ({
      fp: r.fingerprint,
      dep: r.metrics.plannedDeparture,
      arr: r.metrics.plannedArrival,
      price: r.coverage.price,
      coverage: r.coverage.coverage,
      kind: r.resultKind,
      fvLegs: r.metrics.fvLegs,
      fvMinutes: r.metrics.fvMinutes,
      transfers: r.metrics.transfers,
      minTransferMin: r.metrics.minTransferMin,
      chain: r.chainLabel,
    });
    console.log(
      JSON.stringify(
        {
          view: { ...view, origin: originKey, dest: destKey },
          counts: {
            cached: union.length,
            afterServerFilter: serverSet.length,
            visible: visible.length,
          },
          reference: reference ? row(reference) : null,
          visible: visible.map(row),
          hidden: hidden.map(({ r, reason }) => ({ ...row(r), reason })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const originLabel = getProfile(originKey)?.label ?? originKey;
  const destLabel = getProfile(destKey)?.label ?? destKey;
  const dateHuman = new Date(`${view.date}T12:00:00`).toLocaleDateString(
    "de-DE",
    {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    },
  );
  console.log(
    `Ansicht   ${originLabel} → ${destLabel} · ${dateHuman} · ${view.timeMode === "arrival" ? "Ankunft" : "Abfahrt"} ${view.timeFrom}–${view.timeTo} · Modus ${view.mode} · Sortierung ${SORT_LABELS[view.sort]}`,
  );
  console.log(
    `Filter    ${changedFilters.length ? changedFilters.join(", ") : "Standard"}`,
  );
  if (view.refFp) {
    const ref = reference ?? loadResults([view.refFp])[0] ?? null;
    const where = reference
      ? "in der Liste des Browsers"
      : "NICHT in der Liste des Browsers (ausgefiltert/nicht im Cache)";
    console.log(
      `Referenz  ${view.refFp} · ${ref ? `${formatTime(ref.metrics.plannedDeparture)}→${formatTime(ref.metrics.plannedArrival)} · ${eur(ref.coverage.price)} · ${ref.resultKind}` : "unbekannt"} · Preis im Link ${eur(view.refPrice)} · ${where}`,
    );
    if (reference)
      console.log(
        `          Alternativen müssen mit denselben ersten Zügen starten: ${refLeadKeys?.join(" · ")}`,
      );
  }
  if (view.dialog) console.log(`Dialog    ${view.dialog} ist offen`);
  if (view.compare.length) console.log(`Vergleich ${view.compare.join(", ")}`);
  console.log(
    `Cache     ${union.length} Verbindungen für Route+Datum · ${serverSet.length} nach Server-Filter · ${visible.length} sichtbar`,
  );

  function flagsOf(r: SearchResult): string {
    const f: string[] = [];
    if (r.fingerprint === view.refFp) f.push("REF");
    if (view.open.includes(r.fingerprint)) f.push("OFFEN");
    if (view.compare.includes(r.fingerprint)) f.push("VERGL");
    return f.length ? ` [${f.join(",")}]` : "";
  }

  function line(r: SearchResult, i: number | null): string {
    const m = r.metrics;
    const idx = i == null ? "   " : `${String(i + 1).padStart(2)}.`;
    const fv = m.fvLegs ? `FV ${m.fvLegs}× ${m.fvMinutes} min` : "kein FV";
    const knapp =
      m.minTransferMin != null ? ` · knappster ${m.minTransferMin} min` : "";
    const rel = r.reliability;
    const pct = (p: number) => `${Math.round(p * 100)}%`;
    const punct = rel
      ? ` · Anschluss ${pct(rel.okPct)} · Flex ${pct(rel.flexPct)}${rel.complete ? "" : "*"} (${rel.basis})`
      : "";
    return `${idx} ${formatTime(m.plannedDeparture)}–${formatTime(m.plannedArrival)} ${dur(m.durationMin)} · ${m.transfers} Umst${knapp} · ${eur(r.coverage.price)} (${r.coverage.coverage}) · ${r.resultKind} · ${fv}${punct}${flagsOf(r)}\n     ${r.fingerprint}  ${r.chainLabel}`;
  }

  function itinerary(r: SearchResult): string {
    return r.legs
      .map((l, i) => {
        const t = formatTime(l.plannedDeparture);
        if (l.isWalking) {
          const w = walkWait(r.legs, i);
          const mark = w?.transfer
            ? w.min <= 5
              ? " ‼ knapp"
              : w.min <= 7
                ? " ! knapp"
                : ""
            : "";
          const wait = w
            ? ` · ${w.transfer ? "Umstieg" : "Puffer"} ${w.min} min${mark}`
            : "";
          const miss = r.reliability?.transfers.find((x) => x.afterLeg + 1 === i);
          const missTxt = miss ? ` · ${Math.round(miss.missPct * 100)}% verpasst` : "";
          return `       ${t}  ${l.fromName} — Fußweg ${l.durationMin} min${wait}${missTxt}`;
        }
        const stops = l.stops ? ` · ${l.stops} Zwischenhalte` : "";
        const direct = r.reliability?.transfers.find((x) => x.afterLeg + 1 === i);
        const miss = direct ? ` [Anschluss ${Math.round(direct.missPct * 100)}% verpasst]` : "";
        return `       ${t}  ${l.fromName} — ${l.lineName || l.productLabel} (${l.durationMin} min${stops}) → ${formatTime(l.plannedArrival)} ${l.toName}${miss}`;
      })
      .join("\n");
  }

  console.log(`\nSichtbar (${visible.length}):`);
  visible.forEach((r, i) => {
    console.log(line(r, i));
    if (view.open.includes(r.fingerprint)) console.log(itinerary(r));
  });
  const openHidden = view.open.filter((fp) => !visibleFps.has(fp));
  if (openHidden.length)
    console.log(`\nAufgeklappt, aber nicht sichtbar: ${openHidden.join(", ")}`);

  if (flags.has("--all")) {
    console.log(`\nAusgeblendet (${hidden.length}):`);
    for (const { r, reason } of hidden)
      console.log(`${line(r, null)}\n     → ${reason}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
