"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileUp, Plus } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { STATUS, legColor, legLabel } from "@/components/trips/tripUi";
import type { TripRow } from "@/db/schema";
import { formatTime } from "@/lib/time";
import { cn, formatEuro } from "@/lib/utils";

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

function monthBounds(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday-first
  return { y, m, days, lead, from: `${ym}-01`, to: `${ym}-${String(days).padStart(2, "0")}` };
}
const shiftMonth = (ym: string, d: number) => {
  const [y, m] = ym.split("-").map(Number);
  const i = y * 12 + (m - 1) + d;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
};
const todayStr = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

export default function TripsPage() {
  const [month, setMonth] = React.useState(() => todayStr().slice(0, 7));
  const [trips, setTrips] = React.useState<TripRow[]>([]);
  const [adding, setAdding] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importMsg, setImportMsg] = React.useState<{ ok: boolean; text: string } | null>(null);
  const importRef = React.useRef<HTMLInputElement>(null);

  async function importFiles(files: FileList) {
    setImporting(true);
    setImportMsg(null);
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("file", f);
    const d = await fetch("/api/trips/import", { method: "POST", body: fd })
      .then((r) => r.json())
      .catch(() => ({ results: [] }));
    setImporting(false);
    type R = { file: string; error?: string; created?: TripRow[]; updated?: TripRow[]; warnings?: string[]; claims?: unknown[]; skipped?: string };
    const results = (d.results ?? []) as R[];
    const created = results.flatMap((r) => r.created ?? []);
    const updated = results.flatMap((r) => r.updated ?? []);
    const errors = results.filter((r) => r.error).map((r) => `${r.file}: ${r.error}`);
    const warn = results.flatMap((r) => r.warnings ?? []);
    const claimCount = results.reduce((n, r) => n + (r.claims?.length ?? 0), 0);
    const skipped = results.flatMap((r) => (r.skipped ? [r.skipped] : []));
    const first = created[0] ?? updated[0];
    if (first) setMonth(first.date.slice(0, 7));
    setImportMsg({
      ok: errors.length === 0,
      text: [
        created.length ? `${created.length} Fahrt(en) importiert` : "",
        updated.length ? `${updated.length} aktualisiert` : "",
        claimCount ? `${claimCount} Fahrgastrechte-Antrag/-Bescheid übernommen` : "",
        ...skipped,
        ...warn,
        ...errors,
      ]
        .filter(Boolean)
        .join(" · ") || "Nichts gefunden",
    });
    load();
  }

  React.useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("m");
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m);
  }, []);

  const b = monthBounds(month);
  const load = React.useCallback(async () => {
    const d = await fetch(`/api/trips?from=${b.from}&to=${b.to}`).then((r) => r.json());
    setTrips(d.trips ?? []);
  }, [b.from, b.to]);
  React.useEffect(() => {
    load().catch(() => {});
    window.history.replaceState(null, "", `?m=${month}`);
  }, [load, month]);

  const byDay = new Map<string, TripRow[]>();
  for (const t of trips) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  const today = todayStr();
  const title = new Date(Date.UTC(b.y, b.m - 1, 15)).toLocaleDateString("de-DE", { month: "long", year: "numeric" });

  return (
    <>
      <AppHeader />
      <main className="container max-w-4xl space-y-4 py-5">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-xl font-semibold">Meine Reisen</h1>
          <div className="flex gap-2">
            <input
              ref={importRef}
              type="file"
              multiple
              accept=".eml,.pdf,.ics,message/rfc822,application/pdf,text/calendar"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) importFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Button size="sm" variant="outline" disabled={importing} onClick={() => importRef.current?.click()} title="DB-Buchungsmail (.eml), Ticket-PDF oder .ics">
              {importing ? <Spinner /> : <FileUp className="h-4 w-4" />} Ticket importieren
            </Button>
            <Button size="sm" onClick={() => setAdding((a) => !a)}>
              <Plus className="h-4 w-4" /> Eintragen
            </Button>
          </div>
        </div>
        {importMsg && <p className={cn("text-sm", importMsg.ok ? "text-success" : "text-danger")}>{importMsg.text}</p>}
        <ClaimsSummary key={trips.length + (importMsg?.text ?? "")} />
        {adding && (
          <AddTrip
            onDone={(t) => {
              setAdding(false);
              if (t) setMonth(t.date.slice(0, 7));
              load();
            }}
          />
        )}

        <Card className="p-3 sm:p-4">
          <div className="mb-3 flex items-center justify-between">
            <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, -1))} aria-label="Voriger Monat">
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <button className="font-semibold" onClick={() => setMonth(today.slice(0, 7))} title="Zum aktuellen Monat">
              {title}
            </button>
            <Button variant="ghost" size="icon" onClick={() => setMonth((m) => shiftMonth(m, 1))} aria-label="Nächster Monat">
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted-foreground">
            {WEEKDAYS.map((w) => (
              <div key={w}>{w}</div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {Array.from({ length: b.lead }, (_, i) => (
              <div key={`l${i}`} />
            ))}
            {Array.from({ length: b.days }, (_, i) => {
              const day = `${month}-${String(i + 1).padStart(2, "0")}`;
              const list = byDay.get(day) ?? [];
              return (
                <div
                  key={day}
                  className={cn(
                    "min-h-[3.5rem] rounded-lg border border-border p-0.5 text-left text-[10px] sm:min-h-[4.5rem] sm:p-1 sm:text-[11px]",
                    day === today && "border-primary ring-1 ring-primary",
                    list.length === 0 && "opacity-70",
                  )}
                >
                  <div className={cn("mb-0.5 text-xs", day === today ? "font-bold text-primary" : "text-muted-foreground")}>
                    {i + 1}
                  </div>
                  {list.map((t) => (
                    <Link
                      key={t.id}
                      href={`/reisen/${t.id}`}
                      className="mb-0.5 flex items-center gap-0.5 overflow-hidden rounded bg-muted/60 px-0.5 py-0.5 hover:bg-muted sm:gap-1 sm:px-1"
                      title={`${formatTime(t.plannedDeparture)} ${t.originName} → ${t.destName} · ${STATUS[t.status]?.label ?? t.status}`}
                    >
                      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS[t.status]?.dot)} />
                      <span className="tabular-nums">{formatTime(t.plannedDeparture)}</span>
                      <span className="hidden truncate sm:inline">{t.destName}</span>
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        </Card>

        <div className="space-y-2">
          {trips.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Keine Fahrten in diesem Monat. In der Suche bei einer Verbindung auf <b>„Gebucht“</b> tippen oder oben eine
              Fahrt eintragen.
            </p>
          )}
          {trips.map((t) => (
            <Link key={t.id} href={`/reisen/${t.id}`} className="block">
              <Card className="flex items-center gap-3 p-3 hover:bg-muted/40">
                <div className="w-24 shrink-0 text-sm">
                  <div className="font-semibold">
                    {new Date(`${t.date}T12:00:00Z`).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" })}
                  </div>
                  <div className="tabular-nums text-xs text-muted-foreground">
                    {formatTime(t.plannedDeparture)}–{formatTime(t.plannedArrival)}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {t.originName} → {t.destName}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {t.legs
                      .filter((l) => !l.isWalking)
                      .map((l, i) => (
                        <span key={i} className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", legColor(l))}>
                          {legLabel(l)}
                        </span>
                      ))}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS[t.status]?.cls)}>
                    {STATUS[t.status]?.label ?? t.status}
                  </span>
                  {t.price != null && <span className="text-xs text-muted-foreground">{formatEuro(t.price)}</span>}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}

/** Minimal manual entry: one train (more detail can be added later). */
function AddTrip({ onDone }: { onDone: (t: TripRow | null) => void }) {
  const [f, setF] = React.useState({ from: "", to: "", date: todayStr(), dep: "", arr: "", train: "", price: "", order: "" });
  const [err, setErr] = React.useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((o) => ({ ...o, [k]: e.target.value }));
  const iso = (time: string) => {
    if (!/^\d{2}:\d{2}$/.test(time)) return null;
    // Local Berlin wall time → ISO with the right offset.
    const guess = new Date(`${f.date}T${time}:00Z`);
    const local = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const utc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
    return new Date(guess.getTime() - (local.getTime() - utc.getTime())).toISOString();
  };

  async function save() {
    setErr(null);
    const dep = iso(f.dep);
    let arr = iso(f.arr);
    if (!f.from || !f.to || !dep || !arr) return setErr("Von, Nach, Abfahrt und Ankunft ausfüllen.");
    if (arr < dep) arr = new Date(new Date(arr).getTime() + 86_400_000).toISOString(); // over midnight
    const res = await fetch("/api/trips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "manual",
        price: f.price ? Number(f.price.replace(",", ".")) : null,
        orderNumber: f.order || null,
        legs: [{ fromName: f.from, toName: f.to, lineName: f.train || undefined, plannedDeparture: dep, plannedArrival: arr }],
      }),
    });
    const d = await res.json();
    if (!res.ok) return setErr(d.error ?? "Fehler");
    onDone(d.trip);
  }

  return (
    <Card className="space-y-3 p-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="Von (Bahnhof)" value={f.from} onChange={set("from")} />
        <Input placeholder="Nach (Bahnhof)" value={f.to} onChange={set("to")} />
        <Input type="date" value={f.date} onChange={set("date")} />
        <div className="flex gap-2">
          <Input type="time" value={f.dep} onChange={set("dep")} aria-label="Abfahrt" />
          <Input type="time" value={f.arr} onChange={set("arr")} aria-label="Ankunft" />
        </div>
        <Input placeholder="Zug (optional, z. B. ICE 105)" value={f.train} onChange={set("train")} />
        <div className="flex gap-2">
          <Input placeholder="Preis €" inputMode="decimal" value={f.price} onChange={set("price")} />
          <Input placeholder="Auftragsnummer" value={f.order} onChange={set("order")} />
        </div>
      </div>
      {err && <p className="text-sm text-danger">{err}</p>}
      <div className="flex gap-2">
        <Button onClick={save}>Speichern</Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Abbrechen
        </Button>
      </div>
    </Card>
  );
}

interface ClaimsOverview {
  paidTotal: number;
  paidCount: number;
  pending: number;
  drafts: number;
  rejected: number;
  claims: { id: string; caseId: string | null; status: string; paidAmount: number | null; amount: number | null; tripId: string; date: string; route: string }[];
}

const CLAIM_LABEL: Record<string, string> = { draft: "Formular erstellt", submitted: "eingereicht", paid: "ausgezahlt", rejected: "abgelehnt" };

/** Passenger-rights overview: money received, open and rejected claims. */
function ClaimsSummary() {
  const [d, setD] = React.useState<ClaimsOverview | null>(null);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    fetch("/api/claims")
      .then((r) => r.json())
      .then(setD)
      .catch(() => {});
  }, []);
  if (!d || d.claims.length === 0) return null;
  return (
    <Card className="p-3 sm:p-4">
      <button className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left text-sm" onClick={() => setOpen((o) => !o)}>
        <span className="font-semibold">Fahrgastrechte</span>
        <span className="font-semibold text-success">{formatEuro(d.paidTotal)} erstattet</span>
        {d.pending > 0 && <span>{d.pending} offen</span>}
        {d.drafts > 0 && <span className="text-muted-foreground">{d.drafts} noch nicht eingereicht</span>}
        {d.rejected > 0 && <span className="text-danger">{d.rejected} abgelehnt</span>}
        <span className="ml-auto text-xs text-muted-foreground">{open ? "ausblenden" : `${d.claims.length} Anträge anzeigen`}</span>
      </button>
      {open && (
        <div className="mt-2 divide-y divide-border text-sm">
          {d.claims.map((c) => (
            <Link key={c.id} href={`/reisen/${c.tripId}`} className="flex flex-wrap items-center gap-x-3 py-1.5 hover:bg-muted/40">
              <span className="w-20 tabular-nums text-muted-foreground">{new Date(`${c.date}T12:00:00Z`).toLocaleDateString("de-DE")}</span>
              <span className="min-w-0 flex-1 truncate">{c.route}</span>
              <span
                className={cn(
                  "text-xs",
                  c.status === "paid" ? "text-success" : c.status === "rejected" ? "text-danger" : "text-muted-foreground",
                )}
              >
                {CLAIM_LABEL[c.status] ?? c.status}
                {c.status === "paid" && c.paidAmount != null ? ` ${formatEuro(c.paidAmount)}` : ""}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
