"use client";

import * as React from "react";
import { AppHeader } from "@/components/AppHeader";
import { Badge, Card, Spinner } from "@/components/ui";
import { formatAgo } from "@/lib/time";
import { formatEuro } from "@/lib/utils";

interface ProviderStat {
  name: string;
  reachable: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  queued: number;
}
interface Stats {
  counts: Record<string, number>;
  providers: {
    routing: ProviderStat;
    pricing: ProviderStat | null;
    pricingMode: string;
    priceCheckAvailable: boolean;
  };
  edges: {
    id: string;
    fromName: string;
    toName: string;
    product: string;
    typicalDurationMin: number;
    stopsBetween: number;
    timesSeen: number;
  }[];
  hubs: { stationName: string; appearances: number; longDistanceConnections: number; score: number }[];
  strategy: {
    totalDecisions: number;
    epsilon: number;
    reasons: { exploit: number; explore: number };
    topSegments: {
      segmentSignature: string;
      fromName: string | null;
      toName: string | null;
      product: string | null;
      fvMinutes: number;
      fvStops: number;
      tries: number;
      greens: number;
      bestPrice: number | null;
      exploreCount: number;
    }[];
    recent: {
      id: string;
      fromName: string | null;
      toName: string | null;
      reason: string;
      observedPrice: number | null;
      coverage: string;
      travelDate: string | null;
      createdAt: number;
    }[];
  };
  runs: {
    id: string;
    mode: string;
    travelDate: string | null;
    startedAt: number;
    requestsUsed: number;
    resultsFound: number;
    bestPrice: number | null;
    status: string;
  }[];
}

const COUNT_LABELS: Record<string, string> = {
  locations: "Locations",
  tripPatterns: "Zugmuster",
  longDistanceEdges: "FV-Kanten",
  journeyQueries: "Journey-Cache",
  journeys: "Journeys",
  priceSnapshots: "Preis-Snapshots",
  candidatePatterns: "Kandidatenmuster",
};

export default function LabPage() {
  const [stats, setStats] = React.useState<Stats | null>(null);

  React.useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  return (
    <>
      <AppHeader />
      <main className="container max-w-3xl space-y-5 py-5">
        <h1 className="text-xl font-semibold">Lab</h1>

        {!stats ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Spinner /> lädt …
          </div>
        ) : (
          <>
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Cache-Statistik
              </h2>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Object.entries(stats.counts).map(([k, v]) => (
                  <div key={k} className="rounded-xl bg-muted/40 p-3">
                    <div className="text-2xl font-bold tabular-nums">{v.toLocaleString("de-DE")}</div>
                    <div className="text-xs text-muted-foreground">{COUNT_LABELS[k] ?? k}</div>
                  </div>
                ))}
              </div>
            </Card>

            <Card className="p-4">
              <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Provider-Status
              </h2>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={stats.providers.routing.reachable ? "success" : "danger"}>
                    MOTIS (Fahrplan) {stats.providers.routing.reachable ? "✓ erreichbar" : "✗ offline"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    zuletzt ok: {formatAgo(stats.providers.routing.lastSuccessAt ?? undefined)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {stats.providers.pricing ? (
                    <Badge variant={stats.providers.pricing.reachable ? "success" : "danger"}>
                      Preisprüfung ({stats.providers.pricing.name}){" "}
                      {stats.providers.pricing.reachable ? "✓ erreichbar" : "✗ offline"}
                    </Badge>
                  ) : (
                    <Badge variant="warning">
                      Preisprüfung nicht konfiguriert (Modus: {stats.providers.pricingMode})
                    </Badge>
                  )}
                  <Badge variant={stats.providers.priceCheckAvailable ? "success" : "muted"}>
                    {stats.providers.priceCheckAvailable ? "Preisprüfung verfügbar" : "nur Fahrplan"}
                  </Badge>
                </div>
                {stats.providers.pricing?.lastError && (
                  <p className="text-xs text-danger">Letzter Fehler: {stats.providers.pricing.lastError}</p>
                )}
              </div>
            </Card>

            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Bekannte kurze FV-Segmente
              </h2>
              {stats.edges.length === 0 ? (
                <p className="text-sm text-muted-foreground">Noch keine gelernt – nach ein paar Suchen erscheinen hier Kanten.</p>
              ) : (
                <div className="space-y-2">
                  {stats.edges.map((e) => (
                    <div key={e.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate">
                        {e.fromName} → {e.toName}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {e.product === "nationalExpress" ? "ICE" : "IC/EC"} · {e.typicalDurationMin} min · {e.timesSeen}×
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Gelernte Hubs</h2>
              {stats.hubs.length === 0 ? (
                <p className="text-sm text-muted-foreground">Noch keine.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {stats.hubs.map((h) => (
                    <Badge key={h.stationName} variant="outline">
                      {h.stationName} · {h.appearances}×
                    </Badge>
                  ))}
                </div>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Preis-Strategie (Explore/Exploit)
              </h2>
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="primary">ε = {stats.strategy.epsilon.toLocaleString("de-DE")}</Badge>
                <Badge variant="outline">Entscheidungen: {stats.strategy.totalDecisions}</Badge>
                <Badge variant="outline">exploit: {stats.strategy.reasons.exploit}</Badge>
                <Badge variant="outline">explore: {stats.strategy.reasons.explore}</Badge>
                <span className="text-xs text-muted-foreground">
                  {stats.strategy.epsilon > 0.3
                    ? "Kalibrierungsphase – erkundet noch viel"
                    : "eingespielt – nutzt bewährte Segmente"}
                </span>
              </div>
              {stats.strategy.topSegments.length > 0 && (
                <>
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    Beste FV-Segmente (günstigster beobachteter Preis)
                  </div>
                  <div className="space-y-1">
                    {stats.strategy.topSegments.map((s) => (
                      <div key={s.segmentSignature} className="flex items-center justify-between gap-2 text-sm">
                        <span className="truncate">
                          {s.fromName} → {s.toName}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {s.bestPrice != null ? formatEuro(s.bestPrice) : "–"} · {s.fvMinutes}min/{s.fvStops}H · {s.greens}/{s.tries} grün
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {stats.strategy.recent.length > 0 && (
                <>
                  <div className="mb-1 mt-3 text-xs font-medium text-muted-foreground">Letzte Preis-Checks</div>
                  <div className="space-y-1">
                    {stats.strategy.recent.slice(0, 12).map((d) => (
                      <div key={d.id} className="flex items-center justify-between gap-2 text-xs">
                        <span className="truncate">
                          <Badge variant={d.reason === "explore" ? "warning" : "muted"} className="mr-1">
                            {d.reason}
                          </Badge>
                          {d.fromName} → {d.toName}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {d.observedPrice != null ? formatEuro(d.observedPrice) : d.coverage} · {formatAgo(d.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </Card>

            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Letzte Suchen</h2>
              <div className="space-y-1 text-sm">
                {stats.runs.map((r) => (
                  <div key={r.id} className="flex justify-between gap-2">
                    <span className="text-muted-foreground">
                      {r.mode} · {r.travelDate} · {formatAgo(r.startedAt)}
                    </span>
                    <span>
                      {r.resultsFound} Treffer · {r.requestsUsed} Anfragen
                      {r.bestPrice != null && ` · ${formatEuro(r.bestPrice)}`}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </main>
    </>
  );
}
