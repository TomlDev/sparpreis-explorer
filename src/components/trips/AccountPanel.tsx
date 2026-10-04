"use client";

import * as React from "react";
import Link from "next/link";
import { Bell, CalendarPlus, Copy, CreditCard, Megaphone, RefreshCw, Star } from "lucide-react";
import { Badge, Button, Card, Input, buttonClass } from "@/components/ui";
import { cn, formatEuro } from "@/lib/utils";

export interface Reminder {
  id: string;
  date: string;
  title: string;
  detail: string;
  kind: string;
  href?: string;
}
interface BahnCard {
  id: string;
  product: string;
  number: string | null;
  price: number | null;
  validFrom: string | null;
  validUntil: string | null;
  autoRenew: boolean;
  cancelBy: string | null;
  confirmed: boolean;
  cancelled: boolean;
}
export interface Account {
  bahncards: BahnCard[];
  activeBahnCard: { id: string; product: string; code: string } | null;
  prefsBahncard: string | null;
  points: { asOf: string; praemien: number; status: number; expiring: { date: string; points: number } | null } | null;
  promos: { subject: string; receivedAt: string; deadline: string | null; snippet: string }[];
  reminders: Reminder[];
  calendarUrl: string;
}

const de = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString("de-DE") : "–");
const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
const daysUntil = (d: string) => Math.round((new Date(`${d}T12:00:00Z`).getTime() - new Date(`${today()}T12:00:00Z`).getTime()) / 86_400_000);

export function useAccount() {
  const [acc, setAcc] = React.useState<Account | null>(null);
  const load = React.useCallback(() => {
    fetch("/api/account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.reminders && setAcc(d))
      .catch(() => {});
  }, []);
  React.useEffect(load, [load]);
  const act = async (body: Record<string, unknown>) => {
    const d = await fetch("/api/account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (d?.reminders) setAcc(d);
  };
  return { acc, load, act };
}

/** Upcoming deadlines (BahnCard, points, vouchers, claims, trips to fill in). */
export function Reminders({ list }: { list: Reminder[] }) {
  const [all, setAll] = React.useState(false);
  const t = today();
  const relevant = list.filter((r) => r.kind === "trip" || r.date >= t);
  if (!relevant.length) return null;
  const shown = all ? relevant : relevant.slice(0, 4);
  return (
    <Card className="p-3 sm:p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Bell className="h-4 w-4 text-primary" /> Erinnerungen
      </div>
      <div className="divide-y divide-border text-sm">
        {shown.map((r) => {
          const d = daysUntil(r.date);
          const row = (
            <div className="flex gap-3 py-1.5">
              <span className={cn("w-24 shrink-0 whitespace-nowrap tabular-nums", d <= 14 && d >= 0 ? "font-semibold text-warning" : "text-muted-foreground")}>
                {r.kind === "trip" ? (
                  <>
                    {new Date(`${r.date}T12:00:00Z`).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric", year: "2-digit" })}
                    <span className="block text-[11px]">offen</span>
                  </>
                ) : d === 0 ? (
                  "heute"
                ) : d > 0 && d <= 60 ? (
                  `in ${d} T.`
                ) : (
                  de(r.date)
                )}
              </span>
              <span className="min-w-0">
                <span className="font-medium">{r.title}</span>
                <span className="block text-xs text-muted-foreground">{r.detail}</span>
              </span>
            </div>
          );
          return r.href ? (
            <Link key={r.id} href={r.href} className="block hover:bg-muted/40">
              {row}
            </Link>
          ) : (
            <div key={r.id}>{row}</div>
          );
        })}
      </div>
      {relevant.length > 4 && (
        <button className="mt-1 text-xs text-primary" onClick={() => setAll((a) => !a)}>
          {all ? "weniger" : `alle ${relevant.length} anzeigen`}
        </button>
      )}
    </Card>
  );
}

export function BahnCards({ acc, act }: { acc: Account; act: (b: Record<string, unknown>) => Promise<void> }) {
  if (!acc.bahncards.length && !acc.points) return null;
  const active = acc.activeBahnCard;
  return (
    <Card className="space-y-3 p-3 sm:p-4">
      {acc.bahncards.map((c) => (
        <div key={c.id} className="space-y-1.5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <CreditCard className="h-4 w-4 text-primary" />
            <span className="font-semibold">{c.product}</span>
            {c.number && <span className="font-mono text-xs text-muted-foreground">{c.number}</span>}
            {c.cancelled && <Badge variant="muted">gekündigt – gilt bis {de(c.validUntil)}</Badge>}
            {!c.confirmed && <Badge variant="warning">bitte prüfen</Badge>}
          </div>
          <div className="text-muted-foreground">
            gültig {de(c.validFrom)} – {de(c.validUntil)}
            {c.price != null ? ` · ${formatEuro(c.price)}` : ""}
            {c.autoRenew && !c.cancelled && c.cancelBy && (
              <>
                {" "}
                · <span className="text-foreground">kündigen bis {de(c.cancelBy)}</span>
              </>
            )}
          </div>
          {!c.confirmed && (
            <p className="text-xs text-warning">
              Die DB-Mails nennen kein Enddatum. Angenommen sind die üblichen Bedingungen: 1 Jahr gültig, verlängert sich
              automatisch, Kündigung bis 6 Wochen vor Ablauf. Bitte im DB-Kundenkonto prüfen und hier anpassen.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              gültig bis
              <Input
                type="date"
                className="h-8 w-36"
                defaultValue={c.validUntil ?? ""}
                onBlur={(e) => e.target.value && e.target.value !== c.validUntil && act({ action: "updateBahnCard", id: c.id, validUntil: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={c.autoRenew} onChange={(e) => act({ action: "updateBahnCard", id: c.id, autoRenew: e.target.checked })} />
              verlängert sich automatisch
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={c.cancelled} onChange={(e) => act({ action: "updateBahnCard", id: c.id, cancelled: e.target.checked })} />
              gekündigt
            </label>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={c.confirmed} onChange={(e) => act({ action: "updateBahnCard", id: c.id, confirmed: e.target.checked })} />
              Daten geprüft
            </label>
          </div>
        </div>
      ))}
      {active && acc.prefsBahncard !== active.code && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-primary/5 p-2 text-sm">
          <span>
            Gerade gültig: <b>{active.product}</b> – in der Preissuche ist {acc.prefsBahncard ? acc.prefsBahncard : "keine BahnCard"} eingestellt.
          </span>
          <Button size="sm" variant="outline" onClick={() => act({ action: "useBahnCardForSearch", code: active.code })}>
            Für Preise verwenden
          </Button>
        </div>
      )}
      {acc.points && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-sm">
          <Star className="h-4 w-4 text-warning" />
          <span className="font-semibold">BahnBonus</span>
          <span>{acc.points.praemien.toLocaleString("de-DE")} Prämienpunkte</span>
          <span className="text-muted-foreground">{acc.points.status.toLocaleString("de-DE")} Statuspunkte</span>
          <span className="text-xs text-muted-foreground">Stand {de(acc.points.asOf)}</span>
          {acc.points.expiring && (
            <span className={cn("text-xs", acc.points.expiring.points > 0 ? "font-semibold text-warning" : "text-muted-foreground")}>
              verfallen zum {de(acc.points.expiring.date)}: {acc.points.expiring.points.toLocaleString("de-DE")}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

export function Promos({ list }: { list: Account["promos"] }) {
  const [open, setOpen] = React.useState(false);
  if (!list.length) return null;
  const t = today();
  const current = list.filter((p) => p.deadline && p.deadline >= t);
  return (
    <Card className="p-3 sm:p-4">
      <button className="flex w-full items-center gap-2 text-left text-sm" onClick={() => setOpen((o) => !o)}>
        <Megaphone className="h-4 w-4 text-primary" />
        <span className="font-semibold">Aktionen der Bahn</span>
        <span className="text-muted-foreground">{current.length ? `${current.length} laufen noch` : "keine laufenden"}</span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "ausblenden" : `${list.length} anzeigen`}</span>
      </button>
      {open && (
        <div className="mt-2 divide-y divide-border text-sm">
          {list.map((p) => {
            const over = p.deadline != null && p.deadline < t;
            return (
              <details key={p.subject + p.receivedAt} className={cn("py-1.5", over && "opacity-50")}>
                <summary className="cursor-pointer">
                  <span className="font-medium">{p.subject}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {new Date(p.receivedAt).toLocaleDateString("de-DE")}
                    {p.deadline ? ` · ${over ? "vorbei seit" : "bis"} ${de(p.deadline)}` : ""}
                  </span>
                </summary>
                <p className="mt-1 text-xs text-muted-foreground">{p.snippet}…</p>
              </details>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** Subscribe link for phone calendars (trips + reminders). */
export function CalendarSubscribe({ url, act }: { url: string; act: (b: Record<string, unknown>) => Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const webcal = url.replace(/^https?:/, "webcal:");
  return (
    <Card className="p-3 sm:p-4">
      <button className="flex w-full items-center gap-2 text-left text-sm" onClick={() => setOpen((o) => !o)}>
        <CalendarPlus className="h-4 w-4 text-primary" />
        <span className="font-semibold">Im Handy-Kalender abonnieren</span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "ausblenden" : "anzeigen"}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Alle Fahrten (mit Zügen, Gleisen, Sitzplätzen) und Erinnerungen – z. B. BahnCard-Kündigungsfrist – erscheinen in
            deinem Kalender und aktualisieren sich von selbst. Wer den Link kennt, sieht deine Fahrten; bei Bedarf einen neuen
            erzeugen (der alte funktioniert dann nicht mehr).
          </p>
          <div className="flex gap-2">
            <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button
              variant="outline"
              size="icon"
              aria-label="Link kopieren"
              onClick={() => {
                navigator.clipboard?.writeText(url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "✓" : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={webcal} className={buttonClass("default", "sm")}>
              Kalender öffnen (iPhone/Mac)
            </a>
            <a
              href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal)}`}
              target="_blank"
              rel="noreferrer"
              className={buttonClass("outline", "sm")}
            >
              Google Kalender
            </a>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => confirm("Neuen Link erzeugen? Der alte funktioniert dann nicht mehr.") && act({ action: "rotateCalendar" })}
            >
              <RefreshCw className="h-4 w-4" /> Neuer Link
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
