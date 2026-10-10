"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileUp, Plus } from "lucide-react";
import { AppHeader } from "@/components/AppHeader";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { BahnCards, CalendarSubscribe, Promos, Reminders, useAccount } from "@/components/trips/AccountPanel";
import { STATUS, legColor, legLabel } from "@/components/trips/tripUi";
import type { TripRow } from "@/db/schema";
import { planStates, type PlanInfo } from "@/lib/trips/plan";
import { berlinToIso, formatTime } from "@/lib/time";
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
  const { acc, load: loadAccount, act } = useAccount();
  const [nextIds, setNextIds] = React.useState<string[]>([]);
  /** Bumped after an import / new trip → side sections reload (not on month changes). */
  const [rev, setRev] = React.useState(0);

  async function importFiles(files: FileList) {
    setImporting(true);
    setImportMsg(null);
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("file", f);
    let d: { results?: unknown[] } = {};
    try {
      const res = await fetch("/api/trips/import", { method: "POST", body: fd });
      if (!res.ok) {
        setImporting(false);
        return setImportMsg({ ok: false, text: res.status === 413 ? "Import fehlgeschlagen: Datei zu groß" : `Import fehlgeschlagen (${res.status})` });
      }
      d = await res.json();
    } catch {
      setImporting(false);
      return setImportMsg({ ok: false, text: "Import fehlgeschlagen – keine Verbindung" });
    }
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
    if (!first) load(); // a month change reloads by itself
    loadAccount();
    setRev((r) => r + 1);
  }

  React.useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("m");
    if (m && /^\d{4}-\d{2}$/.test(m)) setMonth(m);
  }, []);

  const b = monthBounds(month);
  // Only the newest request may set the list (fast month clicks, ?m= on first load).
  const reqId = React.useRef(0);
  const load = React.useCallback(async () => {
    const id = ++reqId.current;
    try {
      const r = await fetch(`/api/trips?from=${b.from}&to=${b.to}`);
      const d = r.ok ? await r.json() : { trips: [] };
      if (id === reqId.current) setTrips(d.trips ?? []);
    } catch {
      /* offline: keep what is shown */
    }
  }, [b.from, b.to]);
  React.useEffect(() => {
    load();
    window.history.replaceState(null, "", `?m=${month}`);
  }, [load, month]);

  const remindersByDay = new Map<string, string[]>();
  for (const r of acc?.reminders ?? []) if (r.kind !== "trip") remindersByDay.set(r.date, [...(remindersByDay.get(r.date) ?? []), r.title]);
  const byDay = new Map<string, TripRow[]>();
  for (const t of trips) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
  const plans = planStates(trips);
  const today = todayStr();
  // Trips already shown under "Als Nächstes" aren't repeated below the calendar.
  const rest = trips.filter((t) => !nextIds.includes(t.id));
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
              {importing ? <Spinner /> : <FileUp className="h-4 w-4" />} Import
            </Button>
            <Button size="sm" onClick={() => setAdding((a) => !a)}>
              <Plus className="h-4 w-4" /> Eintragen
            </Button>
          </div>
        </div>
        {importMsg && <p className={cn("text-sm", importMsg.ok ? "text-success" : "text-danger")}>{importMsg.text}</p>}
        {adding && (
          <AddTrip
            onDone={(t) => {
              setAdding(false);
              if (t && t.date.slice(0, 7) !== month) setMonth(t.date.slice(0, 7));
              else load();
              setRev((r) => r + 1);
            }}
          />
        )}

        <NextTrips
          key={`n${rev}`}
          onShown={setNextIds}
          onChanged={() => {
            load();
            setRev((r) => r + 1);
          }}
        />

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
                  <div className={cn("mb-0.5 flex items-center justify-between text-xs", day === today ? "font-bold text-primary" : "text-muted-foreground")}>
                    {i + 1}
                    {remindersByDay.has(day) && (
                      <span title={remindersByDay.get(day)!.join("\n")} className="text-warning">
                        ⏰
                      </span>
                    )}
                  </div>
                  {list.map((t) => (
                    <Link
                      key={t.id}
                      href={`/reisen/${t.id}`}
                      className={cn(
                        "mb-0.5 flex items-center gap-0.5 overflow-hidden rounded bg-muted/60 px-0.5 py-0.5 hover:bg-muted sm:gap-1 sm:px-1",
                        t.status === "planned" && plans.get(t.id)?.state === "skip" && "line-through opacity-50",
                        t.status === "planned" && plans.get(t.id)?.state === "open" && "ring-1 ring-warning",
                      )}
                      title={`${formatTime(t.plannedDeparture)} ${t.originName} → ${t.destName} · ${STATUS[t.status]?.label ?? t.status}${planTitle(t, plans.get(t.id))}`}
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
          {rest.length > 0 && (
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              {rest.length < trips.length ? "Weitere Fahrten" : "Fahrten"} im {title}
            </h2>
          )}
          {trips.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Keine Fahrten in diesem Monat. In der Suche bei einer Verbindung auf <b>„Gebucht“</b> tippen oder oben eine
              Fahrt eintragen.
            </p>
          )}
          {rest.map((t) => (
            <TripCard key={t.id} t={t} plan={plans.get(t.id)} onChanged={load} />
          ))}
        </div>

        {acc && <Reminders list={acc.reminders} />}
        <ClaimsSummary key={`c${rev}`} />
        {acc && <BahnCards acc={acc} act={act} />}
        <Vouchers key={`v${rev}`} />
        {acc && <Promos list={acc.promos} />}
        {acc && <CalendarSubscribe url={acc.calendarUrl} act={act} />}
      </main>
    </>
  );
}

const planTitle = (t: TripRow, p: PlanInfo | undefined) =>
  t.status !== "planned" || !p?.state ? "" : p.state === "take" ? " · nehme ich" : p.state === "skip" ? " · nehme ich nicht" : " · doppelt gebucht";

async function setPlan(id: string, plan: "take" | "skip" | null) {
  await fetch(`/api/trips/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan }) }).catch(() => {});
}

function TripCard({ t, plan, onChanged }: { t: TripRow; plan?: PlanInfo; onChanged?: () => void }) {
  const state = t.status === "planned" ? (plan?.state ?? null) : null;
  return (
    <Link href={`/reisen/${t.id}`} className="block">
      <Card className={cn("flex items-center gap-3 p-3 hover:bg-muted/40", state === "skip" && "opacity-60", state === "open" && "border-warning")}>
        <div className="w-24 shrink-0 text-sm">
          <div className="font-semibold">
            {new Date(`${t.date}T12:00:00Z`).toLocaleDateString("de-DE", {
              weekday: "short",
              day: "numeric",
              month: "short",
            })}
          </div>
          <div className="tabular-nums text-xs text-muted-foreground">
            {t.plannedDeparture ? `${formatTime(t.plannedDeparture)}–${formatTime(t.plannedArrival)}` : "Zeit unbekannt"}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {t.originName} → {t.destName}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {t.legs
              .filter((l) => !l.isWalking && (l.product || l.lineName))
              .map((l, i) => (
                <span key={i} className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", legColor(l))}>
                  {legLabel(l)}
                </span>
              ))}
            {t.ticket?.scheduleChange?.zugbindungLifted && (
              <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">Zugbindung aufgehoben</span>
            )}
            {t.movedFrom && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">🔁 Ersatzfahrt</span>}
            {state === "take" && !plan?.implied && (
              <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success">✓ Nehme ich</span>
            )}
            {state === "skip" && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">Nehme ich nicht</span>}
            {state === "open" && (
              <>
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">Doppelt gebucht</span>
                <button
                  type="button"
                  className="rounded border border-success px-1.5 py-0.5 text-[10px] font-semibold text-success hover:bg-success/10"
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await setPlan(t.id, "take");
                    onChanged?.();
                  }}
                >
                  ✓ Die nehme ich
                </button>
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS[t.status]?.cls)}>{STATUS[t.status]?.label ?? t.status}</span>
          {t.price != null && <span className="text-xs text-muted-foreground">{formatEuro(t.price)}</span>}
        </div>
      </Card>
    </Link>
  );
}

/** The next trip from today on — independent of the month shown. */
function NextTrips({ onShown, onChanged }: { onShown: (ids: string[]) => void; onChanged: () => void }) {
  const [list, setList] = React.useState<TripRow[] | null>(null);
  const [plans, setPlans] = React.useState<Map<string, PlanInfo>>(new Map());
  React.useEffect(() => {
    const from = todayStr();
    const to = new Date(Date.now() + 365 * 86_400_000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    fetch(`/api/trips?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : { trips: [] }))
      .then((d) => {
        const now = Date.now();
        // still to come (or under way today); skip trips that didn't take place
        const all = (d.trips ?? []) as TripRow[];
        const plans = planStates(all);
        setPlans(plans);
        const up = all.filter(
          (t) =>
            !["not_started", "cancelled", "moved"].includes(t.status) &&
            plans.get(t.id)?.state !== "skip" &&
            (!t.plannedArrival || new Date(t.plannedArrival).getTime() > now - 3600_000),
        );
        setList(up.slice(0, 1));
        onShown(up.slice(0, 1).map((t) => t.id));
      })
      .catch(() => setList([]));
  }, [onShown]);
  if (!list?.length) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Nächste Fahrt</h2>
      {list.map((t) => (
        <TripCard key={t.id} t={t} plan={plans.get(t.id)} onChanged={onChanged} />
      ))}
    </div>
  );
}

/** Minimal manual entry: one train (more detail can be added later). */
function AddTrip({ onDone }: { onDone: (t: TripRow | null) => void }) {
  const [f, setF] = React.useState({ from: "", to: "", date: todayStr(), dep: "", arr: "", train: "", price: "", order: "" });
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((o) => ({ ...o, [k]: e.target.value }));
  const iso = (time: string) => berlinToIso(f.date, time);

  async function save() {
    setErr(null);
    const dep = iso(f.dep);
    let arr = iso(f.arr);
    if (!f.from || !f.to || !dep || !arr) return setErr("Von, Nach, Abfahrt und Ankunft ausfüllen.");
    if (arr < dep) arr = new Date(new Date(arr).getTime() + 86_400_000).toISOString(); // over midnight
    const price = f.price.trim() ? Number(f.price.replace(",", ".")) : null;
    if (price != null && (!Number.isFinite(price) || price < 0)) return setErr("Preis prüfen.");
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "manual",
          price,
          orderNumber: f.order.trim() || null,
          legs: [{ fromName: f.from.trim(), toName: f.to.trim(), lineName: f.train.trim() || undefined, plannedDeparture: dep, plannedArrival: arr }],
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setErr(d.error ?? "Fehler");
      onDone(d.trip);
    } catch {
      setErr("Keine Verbindung – bitte erneut versuchen.");
    } finally {
      setBusy(false);
    }
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
        <Button onClick={save} disabled={busy}>
          {busy ? <Spinner /> : "Speichern"}
        </Button>
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

const CLAIM_LABEL: Record<string, string> = { draft: "Formular erstellt", submitted: "Eingereicht", paid: "Ausgezahlt", rejected: "Abgelehnt" };

/** Passenger-rights overview: money received, open and rejected claims. */
function ClaimsSummary() {
  const [d, setD] = React.useState<ClaimsOverview | null>(null);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    fetch("/api/claims")
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => x?.claims && setD(x))
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

interface Voucher {
  number: string;
  value: number;
  validUntil: string | null;
  orderNumber: string | null;
  receivedAt: string;
  redeemed: boolean;
}

/** DB vouchers: from mails (remaining value after paying with a voucher) or entered by hand. */
function Vouchers() {
  const [list, setList] = React.useState<Voucher[]>([]);
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ number: "", value: "", validUntil: "" });
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => {
    fetch("/api/vouchers")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setList(d?.vouchers ?? []))
      .catch(() => {});
  }, []);
  async function post(body: Record<string, unknown>): Promise<boolean> {
    setErr(null);
    try {
      const res = await fetch("/api/vouchers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(d.error ?? "Fehler");
        return false;
      }
      setList(d.vouchers ?? []);
      return true;
    } catch {
      setErr("Keine Verbindung");
      return false;
    }
  }
  const t = todayStr();
  const openOnes = list.filter((v) => !v.redeemed && (!v.validUntil || v.validUntil >= t)).sort((a, b) => b.value - a.value);
  const done = list.filter((v) => !openOnes.includes(v)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const sum = openOnes.reduce((x, v) => x + (v.value ?? 0), 0);
  const row = (v: Voucher) => (
    <div key={v.number} className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5", v.redeemed && "opacity-50")}>
      <span className="font-mono">{v.number}</span>
      <Input
        key={`${v.number}-${v.value}`}
        className="h-7 w-20 text-right"
        inputMode="decimal"
        placeholder="?"
        defaultValue={v.value != null ? v.value.toFixed(2).replace(".", ",") : ""}
        onBlur={(e) => {
          const raw = e.target.value.trim();
          const n = Number(raw.replace(",", "."));
          // empty or not a number → back to the stored amount, never 0 €
          if (!raw || !Number.isFinite(n) || n < 0) e.target.value = v.value != null ? v.value.toFixed(2).replace(".", ",") : "";
          else if (n !== v.value) post({ action: "update", number: v.number, value: n });
        }}
        aria-label="Betrag"
      />
      €
      <span className="text-xs text-muted-foreground">
        {v.validUntil ? `gültig bis ${new Date(`${v.validUntil}T12:00:00Z`).toLocaleDateString("de-DE")}` : "Gültigkeit unbekannt"}
        {v.orderNumber ? ` · aus Auftrag ${v.orderNumber}` : ""}
      </span>
      <label className="ml-auto flex items-center gap-1 text-xs">
        <input type="checkbox" checked={v.redeemed} onChange={() => post({ action: "update", number: v.number, redeemed: !v.redeemed })} />{" "}
        eingelöst
      </label>
    </div>
  );
  return (
    <Card className="p-3 sm:p-4">
      <button className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 text-left text-sm" onClick={() => setOpen((o) => !o)}>
        <span className="font-semibold">Gutscheine</span>
        {openOnes.length ? (
          <span>
            <b>{formatEuro(sum)}</b> offen in {openOnes.length} {openOnes.length === 1 ? "Gutschein" : "Gutscheinen"}
          </span>
        ) : (
          <span className="text-muted-foreground">keine offenen</span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{open ? "ausblenden" : "anzeigen"}</span>
      </button>
      {open && (
        <div className="mt-2 text-sm">
          <div className="divide-y divide-border">{openOnes.map(row)}</div>
          <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-border pt-2">
            <Input className="h-8 w-32 font-mono" placeholder="Nummer" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
            <Input className="h-8 w-24" inputMode="decimal" placeholder="Betrag €" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            <Input className="h-8 w-36" type="date" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} aria-label="gültig bis" />
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const value = Number(form.value.replace(",", "."));
                if (!form.number.trim() || !form.value.trim() || !Number.isFinite(value) || value <= 0)
                  return setErr("Nummer und Betrag eintragen.");
                if (await post({ action: "add", number: form.number, value, validUntil: form.validUntil || null }))
                  setForm({ number: "", value: "", validUntil: "" });
              }}
            >
              Hinzufügen
            </Button>
          </div>
          {err && <p className="mt-1 text-xs text-danger">{err}</p>}
          <p className="mt-2 text-xs text-muted-foreground">
            Zahlst du mit einem Gutschein, stellt die DB für den Rest einen neuen aus (kommt per Mail) – den alten dann als
            eingelöst abhaken.
          </p>
          {done.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">{done.length} eingelöst / abgelaufen</summary>
              <div className="divide-y divide-border">{done.map(row)}</div>
            </details>
          )}
        </div>
      )}
    </Card>
  );
}
