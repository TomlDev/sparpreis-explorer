"use client";

import * as React from "react";
import { Button, Input, Spinner, Switch } from "@/components/ui";
import { SettingsSection } from "@/components/SettingsSection";
import { formatAgo } from "@/lib/time";

interface Account {
  id: string;
  config: { enabled: boolean; host: string; port: number; user: string; folder: string; sinceDays: number };
  hasPassword: boolean;
  status: { lastRunAt: number | null; lastOk: boolean | null; lastMessage: string | null; imported: number; seenCount: number };
}
interface View {
  accounts: Account[];
  /** address DB answers online claims at (claimant data) — and whether a mailbox here reads it */
  claimEmail: string | null;
  claimEmailRead: boolean;
  /** the user confirmed the claim address is forwarded to a mailbox read here */
  claimEmailForwarded: boolean;
}
type Call = (action: string, extra?: Record<string, unknown>) => Promise<(View & { folders?: string[] }) | null>;

const KNOWN: [RegExp, string][] = [
  [/@gmx\.(de|net|at|ch)$/i, "imap.gmx.net"],
  [/@web\.de$/i, "imap.web.de"],
  [/@(gmail|googlemail)\.com$/i, "imap.gmail.com"],
  [/@(outlook|hotmail|live)\.\w+$/i, "outlook.office365.com"],
  [/@t-online\.de$/i, "secureimap.t-online.de"],
  [/@posteo\.\w+$/i, "posteo.de"],
  [/@mailbox\.org$/i, "imap.mailbox.org"],
];

const isConfigured = (a: Account) => !!(a.config.host && a.config.user && a.hasPassword);

/** Settings: import DB mails (bookings, changes, claim answers) from one or more IMAP mailboxes automatically. */
export function MailSyncCard() {
  const [v, setV] = React.useState<View | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    fetch("/api/mailsync")
      .then((r) => r.json())
      .then((d) => d.accounts && setV(d))
      .catch(() => {});
  }, []);

  const call: Call = async (action, extra = {}) => {
    setBusy(`${extra.account ?? ""}:${action}`);
    setErr(null);
    try {
      const res = await fetch("/api/mailsync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setErr(d.error ?? "Fehler");
      if (d.accounts) setV(d);
      return res.ok ? d : null;
    } catch {
      setErr("Keine Verbindung zum Server");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const title = "Buchungsmails automatisch abrufen";
  if (!v) return <SettingsSection id="mails" title={title} state="loading" />;
  const ready = v.accounts.filter(isConfigured);
  const ok = ready.length > 0 && ready.every((a) => a.config.enabled && a.status.lastOk !== false) && v.claimEmailRead;
  const summary = !ready.length
    ? "Nicht eingerichtet"
    : [
        ready.length === 1 ? `alle 15 min aus „${ready[0].config.folder}“` : `${ready.length} Postfächer, alle 15 min`,
        ready.some((a) => a.status.lastOk === false) && "Fehler beim Abruf",
        !v.claimEmailRead && "Antwort-Adresse der Anträge wird nicht gelesen",
        `${ready.reduce((n, a) => n + a.status.imported, 0)} importiert`,
      ]
        .filter(Boolean)
        .join(" · ");

  return (
    <SettingsSection id="mails" title={title} state={ok ? "done" : "todo"} summary={summary}>
      <p className="mb-3 text-xs text-muted-foreground">
        Die App liest je Postfach einen Ordner (IMAP, nur lesen – nichts wird verschoben, markiert oder gelöscht) und
        übernimmt DB-Buchungen, Änderungsmails, Gutscheine und Fahrgastrechte-Bescheide. Passwörter werden verschlüsselt
        gespeichert. Bei GMX/WEB.DE muss in den Postfach-Einstellungen „POP3/IMAP Abruf“ erlaubt sein.
      </p>
      {!v.claimEmailRead && v.claimEmail && (
        <p className="mb-3 rounded-xl border border-warning/40 bg-warning/10 p-2.5 text-sm">
          Online eingereichte Fahrgastrechte-Anträge nennen <b>{v.claimEmail}</b> – dorthin schickt die DB ihre Bescheide. Dieses
          Postfach liest die App nicht: dorthin weiterleiten (z. B. den Alias beim Mailanbieter) oder unten als weiteres
          Postfach eintragen, sonst fehlen die Antworten.
          <label className="mt-2 flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4" disabled={!!busy} onChange={() => call("claimForwarded", { value: true })} />
            Wird an ein Postfach hier weitergeleitet
          </label>
        </p>
      )}
      {v.claimEmailForwarded && v.claimEmail && (
        <p className="mb-3 text-xs text-muted-foreground">
          Bescheide an {v.claimEmail} kommen per Weiterleitung an.{" "}
          <button type="button" className="underline" disabled={!!busy} onClick={() => call("claimForwarded", { value: false })}>
            Stimmt nicht mehr
          </button>
        </p>
      )}
      <div className="space-y-4">
        {v.accounts.map((a, i) => (
          <MailAccount key={a.id || "first"} a={a} n={i + 1} many={v.accounts.length > 1} call={call} busy={busy} />
        ))}
      </div>
      <div className="mt-3">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => call("add")}>
          + Weiteres Postfach
        </Button>
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </SettingsSection>
  );
}

function MailAccount({ a, n, many, call, busy }: { a: Account; n: number; many: boolean; call: Call; busy: string | null }) {
  const [f, setF] = React.useState({ ...a.config, port: String(a.config.port), password: "" });
  // a fresh answer from the server (save, sync) → take its values, keep a typed password out
  const saved = JSON.stringify(a.config);
  React.useEffect(() => setF({ ...a.config, port: String(a.config.port), password: "" }), [saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const [folders, setFolders] = React.useState<string[]>([]);
  const acc = { account: a.id };
  const save = () => call("save", { ...acc, ...f, port: Number(f.port) || 993, password: f.password || undefined });
  const is = (action: string) => busy === `${a.id}:${action}`;
  const configured = isConfigured(a);
  const v = a;

  return (
    <div className={many ? "rounded-xl border border-border p-3" : ""}>
      {many && (
        <div className="mb-2 text-sm font-semibold">
          Postfach {n}
          {a.config.user ? <span className="ml-2 font-normal text-muted-foreground">{a.config.user}</span> : null}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-6">
        <Input
          className="sm:col-span-3"
          placeholder="E-Mail-Adresse / Benutzer"
          autoComplete="off"
          name="imap-user"
          value={f.user}
          onChange={(e) => {
            const user = e.target.value;
            const known = KNOWN.find(([re]) => re.test(user))?.[1];
            setF((o) => ({ ...o, user, host: o.host || !known ? o.host : known }));
          }}
        />
        <Input
          className="sm:col-span-3"
          type="password"
          // Not "new-password": Chrome would offer to generate one, password
          // managers would insert some other saved password.
          autoComplete="off"
          name="imap-password"
          data-1p-ignore
          data-lpignore="true"
          placeholder={v.hasPassword ? "Passwort gespeichert – leer lassen = behalten" : "Passwort (ggf. App-Passwort)"}
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
        />
        <Input className="sm:col-span-4" placeholder="IMAP-Server, z. B. imap.gmx.net" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
        <Input className="sm:col-span-2" inputMode="numeric" placeholder="Port" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, "") })} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy}
          onClick={async () => {
            if (!(await save())) return;
            const d = await call("folders", acc);
            if (d?.folders) setFolders(d.folders);
          }}
        >
          {is("folders") || is("save") ? <Spinner /> : null} Verbindung testen & Ordner laden
        </Button>
        {folders.length > 0 && <span className="text-xs text-success">Verbindung ok ✓</span>}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Ordner mit den DB-Mails</span>
          {folders.length ? (
            <select className="h-10 rounded-xl border border-input bg-background px-3" value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })}>
              {folders.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          ) : (
            <Input value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} />
          )}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Mails berücksichtigen der letzten</span>
          <select
            className="h-10 rounded-xl border border-input bg-background px-3"
            value={f.sinceDays}
            onChange={(e) => setF({ ...f, sinceDays: Number(e.target.value) })}
          >
            {[
              [30, "30 Tage"],
              [90, "3 Monate"],
              [180, "6 Monate"],
              [365, "12 Monate"],
              [730, "2 Jahre"],
            ].map(([d, l]) => (
              <option key={d} value={d}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3">
        <Switch checked={f.enabled} onChange={(enabled) => setF({ ...f, enabled })} label="Automatisch alle 15 Minuten abrufen" />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={!!busy} onClick={() => save()}>
          Speichern
        </Button>
        <Button
          variant="outline"
          disabled={!!busy || !configured}
          onClick={async () => {
            if (await save()) await call("sync", acc);
          }}
        >
          {is("sync") ? <Spinner /> : null} Jetzt abrufen
        </Button>
        {configured && (
          <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => call("rescan", acc)} title="Alle Mails im Zeitraum noch einmal prüfen">
            Alle neu prüfen
          </Button>
        )}
        {(configured || a.id) && (
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            onClick={() =>
              confirm(a.id ? "Dieses Postfach entfernen?" : "Zugangsdaten löschen?") && call("forget", acc).then(() => setFolders([]))
            }
          >
            {a.id ? "Postfach entfernen" : "Zugang entfernen"}
          </Button>
        )}
      </div>
      {v.status.lastRunAt && (
        <p className={"mt-3 text-xs " + (v.status.lastOk ? "text-muted-foreground" : "text-danger")}>
          Letzter Abruf {formatAgo(v.status.lastRunAt)}: {v.status.lastMessage} · insgesamt {v.status.imported} importiert
        </p>
      )}
    </div>
  );
}
