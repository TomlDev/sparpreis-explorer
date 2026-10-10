"use client";

import * as React from "react";
import { effectiveMinTransfer, ticketTransfers } from "@/lib/domain/ticketTransfers";
import {
  ArrowUpRight,
  CalendarPlus,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Footprints,
  HelpCircle,
  Sparkles,
  Star,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import type { SearchResult } from "@/lib/domain/result";
import { waitClass, walkWait } from "@/lib/domain/transferWait";
import { formatTime } from "@/lib/time";
import { cn, formatDuration, formatEuro } from "@/lib/utils";
import { Badge, Button, Card, buttonClass } from "@/components/ui";
import { MissChance, ReliabilityBadges, ReliabilityDetails, transferInto } from "@/components/Reliability";

function CoverageBadge({ coverage, reason }: { coverage: SearchResult["coverage"]["coverage"]; reason: string }) {
  if (coverage === "green")
    return (
      <Badge variant="success" title={reason}>
        <Check className="h-3.5 w-3.5" /> Durchgehendes Ticket
      </Badge>
    );
  if (coverage === "yellow")
    return (
      <Badge variant="warning" title={reason}>
        <HelpCircle className="h-3.5 w-3.5" /> Abdeckung unklar
      </Badge>
    );
  if (coverage === "red")
    return (
      <Badge variant="danger" title={reason}>
        <XCircle className="h-3.5 w-3.5" /> Teilstreckenpreis
      </Badge>
    );
  if (coverage === "unpriced")
    return (
      <Badge variant="muted" title={reason}>
        <TriangleAlert className="h-3.5 w-3.5" /> Preis nicht geprüft
      </Badge>
    );
  return (
    <Badge variant="muted" title={reason}>
      <TriangleAlert className="h-3.5 w-3.5" /> Kein durchgehender Preis
    </Badge>
  );
}

function Stars({ n }: { n: number }) {
  if (n <= 0) return null;
  const cfg =
    n >= 3
      ? { label: "Sehr interessant", cls: "text-[#1B873F]" }
      : n === 2
        ? { label: "Interessant", cls: "text-[#1455C0]" }
        : { label: "Beachtenswert", cls: "text-[#EAA300]" };
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm font-medium", cfg.cls)}>
      <Sparkles className="h-4 w-4" /> {cfg.label}
    </span>
  );
}

interface PriceRow {
  date: string;
  travelDate: string;
  price: number | null;
  coverage: string;
}

export function ResultCard({
  r,
  travelDate,
  compareOn,
  onToggleCompare,
  referencePrice,
  isReference,
  onSetReference,
  open: openProp,
  onOpenChange,
}: {
  r: SearchResult;
  travelDate: string;
  compareOn: boolean;
  onToggleCompare: () => void;
  referencePrice?: number | null;
  isReference?: boolean;
  onSetReference?: () => void;
  /** Controlled expand state (e.g. mirrored into the URL); local if omitted. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openLocal, setOpenLocal] = React.useState(false);
  const open = openProp ?? openLocal;
  const [history, setHistory] = React.useState<PriceRow[] | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [bookedId, setBookedId] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const m = r.metrics;

  function copyId(e: React.MouseEvent) {
    e.stopPropagation();
    const id = r.fingerprint;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(id).then(done).catch(done);
    } else {
      // fallback for non-secure contexts
      const ta = document.createElement("textarea");
      ta.value = id;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {}
      ta.remove();
      done();
    }
  }
  const stars = interestStars(r);

  function toggleDetails() {
    const next = !open;
    if (onOpenChange) onOpenChange(next);
    else setOpenLocal(next);
  }

  // Load the price history whenever the card is open — also when it was opened
  // via a shared link (controlled `open`), not only by clicking.
  React.useEffect(() => {
    if (!open || history != null) return;
    let cancelled = false;
    fetch(`/api/history?fp=${encodeURIComponent(r.fingerprint)}`)
      .then((res) => res.json())
      .catch(() => ({ history: [] }))
      .then((data: { history?: PriceRow[] }) => {
        if (!cancelled) setHistory(data.history ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, [open, history, r.fingerprint]);

  async function save() {
    setSaved(true);
    await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "journey",
        label: `${m.originName} → ${m.destinationName} · ${formatEuro(r.coverage.price)}`,
        refKey: r.fingerprint,
        data: { chainLabel: r.chainLabel, headlineFv: r.headlineFv, travelDate },
      }),
    }).catch(() => setSaved(false));
  }

  /** "Gebucht": put this connection into the travel calendar. */
  async function markBooked() {
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "search",
        fingerprint: r.fingerprint,
        refreshToken: r.refreshToken,
        price: r.coverage.price,
        klasse: r.coverage.klasse === 1 ? 1 : 2,
        ticketType: r.coverage.price != null ? "Sparpreis" : null,
        legs: r.legs.map((l) => ({
          product: l.product,
          lineName: l.lineName,
          trainNumber: l.trainNumber,
          fromId: l.fromId,
          fromName: l.fromName,
          toId: l.toId,
          toName: l.toName,
          plannedDeparture: l.plannedDeparture,
          plannedArrival: l.plannedArrival,
          isWalking: l.isWalking,
        })),
      }),
    });
    if (res.ok) setBookedId((await res.json()).trip.id);
  }

  // Always via the app: it knows the BahnCard / class, resolves the bahn.de ids (also for
  // results from the cache) and rebuilds the search that produced the shown price.
  const how = r.priceHow ?? (r.resultKind === "proforma" ? "proforma" : r.resultKind === "alternative" ? "via" : "plain");
  // "Früher aussteigen": the ticket to book is the one to the farther destination
  const ee = r.earlyExit;
  const fv = ee
    ? ee.fvLegs === 1 && ee.fvFrom && ee.fvTo
      ? { fvFrom: ee.fvFrom, fvTo: ee.fvTo }
      : null
    : r.metrics.fvLegs === 1 && r.headlineFv
      ? { fvFrom: r.headlineFv.fromName, fvTo: r.headlineFv.toName }
      : null;
  // Only transfers inside the ticket count as "knappster Umstieg" (tight ones before it: see Itinerary).
  const tightest = effectiveMinTransfer(r);
  const dbHref = `/api/dblink?${new URLSearchParams({
    from: ee?.ticketFrom ?? m.originName,
    to: ee?.ticketTo ?? m.destinationName,
    ...(m.plannedDeparture ? { dep: m.plannedDeparture } : {}),
    ...(how !== "plain" ? { kind: how } : {}),
    ...((how === "proforma" || how === "via") && fv ? fv : {}),
  })}`;

  return (
    <Card
      id={`r-${r.fingerprint}`}
      onClick={toggleDetails}
      className={cn(
        "group cursor-pointer overflow-hidden transition hover:border-primary/50 hover:shadow-md",
        compareOn && "ring-2 ring-primary",
        isReference && "ring-1 ring-primary/40 bg-primary/5",
      )}
    >
      <div className="p-3 sm:p-4">
        <div className="flex items-start gap-3">
          {/* left: the journey */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-base font-semibold tabular-nums">
                {formatTime(m.plannedDeparture)}–{formatTime(m.plannedArrival)}
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDuration(m.durationMin)} · {m.transfers} Umst.
                {tightest != null ? ` · knappster ${tightest} min` : ""}
              </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {m.originName} → {m.destinationName}
            </div>
            {ee ? (
              <div className="mt-0.5 text-xs font-medium text-primary">
                🚪 Früher aussteigen: Ticket bis {ee.ticketTo}, du steigst in {m.destinationName} aus
              </div>
            ) : (
              !!r.coverage.uncoveredLegs?.length && (
                <div className="mt-0.5 text-xs text-muted-foreground">
                  🎫 Ticket gilt {r.coverage.offerFromName} → {r.coverage.offerToName}
                </div>
              )
            )}
            <div className="mt-1.5">
              <ChainPills legs={r.legs} />
            </div>
            {r.headlineFv && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                <span className="font-medium text-primary">FV</span> {r.headlineFv.lineName} ·{" "}
                {r.headlineFv.fromName} → {r.headlineFv.toName} · {m.fvMinutes} min ·{" "}
                {m.fvStops} {m.fvStops === 1 ? "Halt" : "Halte"}
                {m.fvPercent > 0 ? ` · ${m.fvPercent.toLocaleString("de-DE")} %` : ""}
                {m.fvLegs > 0 ? ` · ${m.fvLegs}× FV` : ""}
              </div>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
              {/* green through-ticket check moves next to the price; only show a
                  badge here when coverage is NOT a clean through-ticket. */}
              {r.coverage.coverage !== "green" && (
                <CoverageBadge coverage={r.coverage.coverage} reason={r.coverage.reason} />
              )}
              {r.resultKind === "proforma" && <Badge variant="muted">Pro-Forma</Badge>}
              {r.variantLabel && <Badge variant="outline">ab {r.variantLabel}</Badge>}
              <ReliabilityBadges rel={r.reliability} />
            </div>
          </div>

          {/* right: price */}
          <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
            {r.coverage.price != null ? (
              <>
                <div className="flex items-center gap-1.5">
                  {r.coverage.coverage === "green" && (
                    <span title="Durchgehendes Ticket – ein Ticket für die ganze Strecke" className="shrink-0">
                      <Check className="h-5 w-5 text-[#1B873F]" />
                    </span>
                  )}
                  <div className="text-2xl font-bold leading-none tracking-tight">{formatEuro(r.coverage.price)}</div>
                </div>
                <span className="text-[11px] text-muted-foreground">{r.coverage.klasse !== 1 ? "2. Kl." : "1. Kl."}</span>
              </>
            ) : (
              <div className="text-sm font-semibold text-muted-foreground">Preis offen</div>
            )}
            {r.isProformaWin && <Badge variant="success">🎯 Bestpreis</Badge>}
            {referencePrice != null && r.coverage.price != null && r.coverage.price < referencePrice ? (
              <span className="text-[11px] font-medium text-success">
                {formatEuro(referencePrice - r.coverage.price)} günstiger als Referenz
              </span>
            ) : (
              r.savingsVsAnchor != null &&
              r.savingsVsAnchor > 0 && (
                <span className="text-[11px] font-medium text-success">−{formatEuro(r.savingsVsAnchor)}</span>
              )
            )}
            {stars > 0 && <Stars n={stars} />}
          </div>
          <ChevronDown
            className={cn("mt-1 h-5 w-5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </div>

        {r.reasons.length > 0 && (
          <div className="mt-1.5 truncate text-xs text-muted-foreground">
            💡 {r.reasons.slice(0, 2).join(" · ")}
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            onClick={copyId}
            aria-label="Verbindungs-ID kopieren"
            title={copied ? "ID kopiert ✓" : `Verbindungs-ID kopieren: ${r.fingerprint}`}
          >
            {copied ? <Check className="h-4 w-4 text-[#1B873F]" /> : <Copy className="h-4 w-4" />}
          </Button>
          <a href={dbHref} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={buttonClass("subtle", "sm")}>
            Bei DB prüfen <ArrowUpRight className="h-4 w-4" />
          </a>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              save();
            }}
            disabled={saved}
          >
            <Star className={cn("h-4 w-4", saved && "fill-warning text-warning")} /> {saved ? "Gemerkt" : "Merken"}
          </Button>
          {bookedId ? (
            <a href={`/reisen/${bookedId}`} onClick={(e) => e.stopPropagation()} className="text-sm font-medium text-success underline">
              Im Kalender ✓
            </a>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              title="Ich habe diese Verbindung gebucht – in meine Reisen übernehmen"
              onClick={(e) => {
                e.stopPropagation();
                markBooked();
              }}
            >
              <CalendarPlus className="h-4 w-4" /> Gebucht
            </Button>
          )}
          {isReference ? (
            <Badge variant="primary">Referenz</Badge>
          ) : (
            onSetReference && (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  onSetReference?.();
                }}
              >
                Als Referenz
              </Button>
            )
          )}
          <label
            onClick={(e) => e.stopPropagation()}
            className={cn(
              "ml-auto flex cursor-pointer items-center gap-2 text-sm text-muted-foreground transition-opacity",
              !compareOn && "opacity-0 group-hover:opacity-100",
            )}
          >
            <input type="checkbox" checked={compareOn} onChange={onToggleCompare} className="h-4 w-4 rounded" />
            Vergleichen
          </label>
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-muted/30 p-4 sm:p-5">
          <Itinerary legs={r.legs} reliability={r.reliability} uncovered={r.coverage.uncoveredLegs} />
          <ReliabilityDetails rel={r.reliability} />

          {history && history.length > 1 && (
            <div className="mt-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Preisverlauf</div>
              <div className="mt-2 flex items-end gap-1" style={{ height: 60 }}>
                {history.map((h, i) => {
                  const max = Math.max(...history.map((x) => x.price ?? 0), 1);
                  const pct = ((h.price ?? 0) / max) * 100;
                  return (
                    <div
                      key={i}
                      className="flex-1 rounded-t bg-primary/60"
                      style={{ height: `${pct}%` }}
                      title={`${new Date(h.date).toLocaleDateString("de-DE")}: ${formatEuro(h.price)}`}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {r.coverage.coverage !== "green" && (
            <p className="mt-3 text-xs text-muted-foreground">{r.coverage.reason}</p>
          )}
        </div>
      )}
    </Card>
  );
}

type Leg = SearchResult["legs"][number];

// DB-Navigator-style product colours.
function productStyle(leg: Leg): { pill: string; line: string } {
  if (leg.isWalking) return { pill: "bg-muted text-muted-foreground", line: "bg-transparent" };
  if (leg.isLongDistance) return { pill: "bg-[#EC0016] text-white", line: "bg-[#EC0016]" }; // ICE/IC
  switch (leg.product) {
    case "suburban":
      return { pill: "bg-[#008D4F] text-white", line: "bg-[#008D4F]" }; // S-Bahn
    case "subway":
      return { pill: "bg-[#1455C0] text-white", line: "bg-[#1455C0]" }; // U-Bahn
    case "tram":
      return { pill: "bg-[#D0006F] text-white", line: "bg-[#D0006F]" }; // Tram
    case "bus":
      return { pill: "bg-[#814997] text-white", line: "bg-[#814997]" }; // Bus
    default:
      return { pill: "bg-[#3C414B] text-white", line: "bg-[#3C414B]" }; // Regional
  }
}

function productPrefix(product?: string): string {
  switch (product) {
    case "nationalExpress":
      return "ICE";
    case "national":
      return "IC";
    case "regionalExpress":
      return "RE";
    case "regional":
      return "RB";
    case "suburban":
      return "S";
    case "subway":
      return "U";
    case "tram":
      return "STR";
    case "bus":
      return "Bus";
    case "ferry":
      return "F";
    default:
      return "";
  }
}

function legLabel(leg: Leg): string {
  const name = (leg.lineName || "").trim();
  const prefix = productPrefix(leg.product);
  // Some (pro-forma) legs only carry a bare train number (e.g. "25413") without
  // the product designation — prepend the product type so it reads "RE 25413".
  if (!name) return leg.productLabel || prefix || "";
  if (/^\d+$/.test(name)) return prefix ? `${prefix} ${name}` : name;
  return name;
}

/** Compact chain shown on the card — DB-app-style coloured product pills. */
function ChainPills({ legs }: { legs: Leg[] }) {
  const trains = legs.filter((l) => !l.isWalking);
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
      {trains.map((leg, i) => (
        <React.Fragment key={i}>
          {i > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />}
          <span
            className={cn(
              "rounded-md px-2 py-1 text-xs font-semibold leading-none",
              productStyle(leg).pill,
            )}
          >
            {legLabel(leg)}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

/** Expanded plan — DB-style vertical timeline (time · node/line · station/train). */
function Itinerary({ legs, reliability, uncovered }: { legs: Leg[]; reliability?: SearchResult["reliability"]; uncovered?: number[] }) {
  const last = legs[legs.length - 1];
  // Tight transfers before the ticket starts — missing the first train there can cost the ticket.
  const risky = uncovered?.length
    ? ticketTransfers(legs, uncovered).unprotected.filter((u) => u.where === "before" && u.risky)
    : [];
  return (
    <div className="text-sm">
      {legs.map((leg, i) => {
        const st = productStyle(leg);
        const wait = walkWait(legs, i);
        const miss = transferInto(reliability, i);
        return (
          <div key={i}>
            {risky
              .filter((u) => u.toLeg === i)
              .map((u) => (
                <div key={`risk-${i}`} className="grid grid-cols-[3.25rem_1.25rem_1fr]">
                  <span />
                  <span />
                  <p className="pb-1 text-xs font-medium text-warning">
                    ⚠ {u.minutes} min zum Umsteigen, vor Ticketbeginn – nicht geschützt: verpasst du deshalb den nächsten Zug, gilt das
                    Ticket nicht mehr
                  </p>
                </div>
              ))}
            {/* boarding stop */}
            <div className="grid grid-cols-[3.25rem_1.25rem_1fr] items-start">
              <div className="pt-0.5 tabular-nums font-semibold text-foreground">
                {formatTime(leg.plannedDeparture)}
              </div>
              <div className="flex justify-center">
                <span className="mt-1 h-2.5 w-2.5 rounded-full border-2 border-foreground bg-background" />
              </div>
              <div className="pt-0.5 font-medium">{leg.fromName}</div>
            </div>
            {/* the ride / walk */}
            <div className="grid grid-cols-[3.25rem_1.25rem_1fr] items-stretch">
              {/* transfer time (or start buffer) — left of the line */}
              <div className="flex flex-col justify-center pr-1">
                {wait && (wait.transfer ? wait.min >= 0 : wait.min > 0) && (
                  <span
                    className={cn("tabular-nums text-[11px]", waitClass(wait))}
                    title={wait.transfer ? "Umstiegszeit inkl. Fußweg" : "Puffer bis zur Abfahrt"}
                  >
                    {wait.min} min
                  </span>
                )}
                {miss && <MissChance t={miss} />}
              </div>
              <div className="flex justify-center">
                {leg.isWalking ? (
                  <span
                    className="my-0.5 w-0 self-stretch border-l-2 border-dashed border-muted-foreground/40"
                    style={{ minHeight: "2.4rem" }}
                  />
                ) : (
                  <span className={cn("my-0.5 w-1 self-stretch rounded", st.line)} style={{ minHeight: "2.4rem" }} />
                )}
              </div>
              <div className="flex items-center py-1">
                {leg.isWalking ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Footprints className="h-3.5 w-3.5" /> Fußweg · {leg.durationMin} min
                  </span>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn("rounded-md px-2.5 py-1 text-xs font-semibold leading-none", st.pill)}>
                      {legLabel(leg)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {leg.durationMin} min
                      {leg.stops > 0 ? ` · ${leg.stops} ${leg.stops === 1 ? "Zwischenhalt" : "Zwischenhalte"}` : ""}
                    </span>
                    {uncovered?.includes(i) && (
                      <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">nicht im Ticket</span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
      {/* final arrival */}
      <div className="grid grid-cols-[3.25rem_1.25rem_1fr] items-start">
        <div className="tabular-nums font-semibold text-foreground">{formatTime(last?.plannedArrival)}</div>
        <div className="flex justify-center">
          <span className="h-2.5 w-2.5 rounded-full border-2 border-foreground bg-foreground" />
        </div>
        <div className="font-semibold">{last?.toName}</div>
      </div>
    </div>
  );
}

// mirror of ranking.interestStars for client display
function interestStars(r: SearchResult): number {
  let s = 0;
  if (r.coverage.coverage === "green") s++;
  if (r.metrics.fvStops > 0 && r.metrics.fvStops <= 1) s++;
  if (r.metrics.fvPercent > 0 && r.metrics.fvPercent < 8) s++;
  return s;
}
