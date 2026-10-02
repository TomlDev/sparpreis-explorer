"use client";

import * as React from "react";
import { Button, Card, Input, Spinner, Switch } from "@/components/ui";
import { formatAgo } from "@/lib/time";

interface View {
  config: { enabled: boolean; host: string; port: number; user: string; folder: string; sinceDays: number };
  hasPassword: boolean;
  status: { lastRunAt: number | null; lastOk: boolean | null; lastMessage: string | null; imported: number; seenCount: number };
}

const KNOWN: [RegExp, string][] = [
  [/@gmx\.(de|net|at|ch)$/i, "imap.gmx.net"],
  [/@web\.de$/i, "imap.web.de"],
  [/@(gmail|googlemail)\.com$/i, "imap.gmail.com"],
  [/@(outlook|hotmail|live)\.\w+$/i, "outlook.office365.com"],
  [/@t-online\.de$/i, "secureimap.t-online.de"],
  [/@posteo\.\w+$/i, "posteo.de"],
  [/@mailbox\.org$/i, "imap.mailbox.org"],
];

/** Settings: import DB booking mails from one IMAP folder automatically. */
export function MailSyncCard() {
  const [v, setV] = React.useState<View | null>(null);
  const [f, setF] = React.useState({ host: "", port: "993", user: "", password: "", folder: "INBOX", sinceDays: 180, enabled: false });
  const [folders, setFolders] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const apply = (d: View) => {
    setV(d);
    setF((o) => ({ ...o, ...d.config, port: String(d.config.port), password: "" }));
  };
  React.useEffect(() => {
    fetch("/api/mailsync")
      .then((r) => r.json())
      .then(apply)
      .catch(() => {});
  }, []);

  async function call(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setErr(null);
    const res = await fetch("/api/mailsync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) setErr(d.error ?? "Fehler");
    if (d.config) apply(d);
    return res.ok ? d : null;
  }
  const save = (extra: Record<string, unknown> = {}) =>
    call("save", { ...f, port: Number(f.port) || 993, password: f.password || undefined, ...extra });

  if (!v) return null;
  const configured = !!(v.config.host && v.config.user && v.hasPassword);

  return (
    <Card className="p-4">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Buchungsmails automatisch abrufen</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        Die App liest einen Ordner deines Postfachs (IMAP, nur lesen – nichts wird verschoben, markiert oder gelöscht)
        und übernimmt jede DB-Buchungsbestätigung als Fahrt. Das Passwort wird verschlüsselt gespeichert. Bei GMX/WEB.DE
        muss in den Postfach-Einstellungen „POP3/IMAP Abruf“ erlaubt sein.
      </p>
      <div className="grid gap-2 sm:grid-cols-6">
        <Input
          className="sm:col-span-3"
          placeholder="E-Mail-Adresse / Benutzer"
          autoComplete="off"
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
          autoComplete="new-password"
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
            const d = await call("folders");
            if (d?.folders) setFolders(d.folders);
          }}
        >
          {busy === "folders" || busy === "save" ? <Spinner /> : null} Verbindung testen & Ordner laden
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
            if (await save()) await call("sync");
          }}
        >
          {busy === "sync" ? <Spinner /> : null} Jetzt abrufen
        </Button>
        {configured && (
          <>
            <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => call("rescan")} title="Alle Mails im Zeitraum noch einmal prüfen">
              Alle neu prüfen
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-danger"
              onClick={() => confirm("Zugangsdaten löschen?") && call("forget").then(() => setFolders([]))}
            >
              Zugang entfernen
            </Button>
          </>
        )}
      </div>
      {v.status.lastRunAt && (
        <p className={"mt-3 text-xs " + (v.status.lastOk ? "text-muted-foreground" : "text-danger")}>
          Letzter Abruf {formatAgo(v.status.lastRunAt)}: {v.status.lastMessage} · insgesamt {v.status.imported} importiert
        </p>
      )}
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </Card>
  );
}
