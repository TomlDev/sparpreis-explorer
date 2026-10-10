"use client";

import * as React from "react";
import { Button, Input, Spinner } from "@/components/ui";
import { SettingsSection } from "@/components/SettingsSection";
import { formatAgo } from "@/lib/time";

interface View {
  user: string;
  hasPassword: boolean;
  status: {
    lastRunAt: number | null;
    lastOk: boolean | null;
    lastMessage: string | null;
    unknown: { orderNumber: string; date: string | null; from: string | null; to: string | null; tariff: string | null }[];
  };
}

/** Settings: the DB customer account ("Meine Reisen": prices per direction, bookings). */
export function DbAccountCard() {
  const [v, setV] = React.useState<View | null>(null);
  const [user, setUser] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const apply = (d: View) => {
    setV(d);
    setUser(d.user);
    setPassword("");
  };
  React.useEffect(() => {
    fetch("/api/dbaccount")
      .then((r) => r.json())
      .then(apply)
      .catch(() => {});
  }, []);
  if (!v) return <SettingsSection id="db-konto" title="DB-Kundenkonto" state="loading" />;

  async function call(action: string, body: Record<string, unknown> = {}) {
    setBusy(action);
    setErr(null);
    try {
      const res = await fetch("/api/dbaccount", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setErr(d.error ?? "Fehler");
      if (d.status) apply(d);
    } catch {
      setErr("Keine Verbindung");
    } finally {
      setBusy(null);
    }
  }

  const s = v.status;
  const ok = !!(v.user && v.hasPassword) && s.lastOk !== false;
  const summary = !(v.user && v.hasPassword)
    ? "Nicht verbunden"
    : s.lastRunAt
      ? `${s.lastOk ? "Abgeglichen" : "Fehler"} ${formatAgo(s.lastRunAt)}${s.unknown.length ? ` · ${s.unknown.length} Buchung(en) nicht in der App` : ""}`
      : "Noch nicht abgeglichen";
  return (
    <SettingsSection id="db-konto" title="DB-Kundenkonto" state={ok ? "done" : "todo"} summary={summary}>
      <p className="mb-3 text-xs text-muted-foreground">
        Die App meldet sich einmal am Tag bei bahn.de an und liest „Meine Reisen“: Preis je Richtung bei Hin- und Rückfahrt und
        Buchungen, die noch nicht in der App sind. Das Passwort wird verschlüsselt auf dem Server gespeichert und nie wieder
        angezeigt.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input placeholder="E-Mail / Benutzername" autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
        <Input
          type="password"
          autoComplete="new-password"
          data-1p-ignore
          data-lpignore="true"
          placeholder={v.hasPassword ? "Passwort gespeichert – leer lassen = behalten" : "Passwort"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={!!busy} onClick={() => call("save", { user, password })}>
          {busy === "save" ? <Spinner /> : "Speichern"}
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy || !v.user || !v.hasPassword} onClick={() => call("sync")}>
          {busy === "sync" ? (
            <>
              <Spinner /> Meldet an … (bis zu 1 Min.)
            </>
          ) : (
            "Jetzt abgleichen"
          )}
        </Button>
        {(v.user || v.hasPassword) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => {
              if (confirm("Zugangsdaten und Login-Sitzung löschen?")) void call("forget");
            }}
          >
            Entfernen
          </Button>
        )}
      </div>
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      {s.lastRunAt && (
        <p className={`mt-2 text-sm ${s.lastOk ? "text-muted-foreground" : "text-danger"}`}>
          {formatAgo(s.lastRunAt)}: {s.lastMessage}
        </p>
      )}
      {s.lastOk && s.unknown.length > 0 && (
        <div className="mt-2 text-sm">
          <p className="text-xs text-muted-foreground">Im DB-Konto, aber nicht in der App (Buchungsmail fehlt?):</p>
          <ul className="mt-1 space-y-0.5">
            {s.unknown.map((u, i) => (
              <li key={i}>
                {u.date ? new Date(`${u.date}T12:00:00Z`).toLocaleDateString("de-DE") : "?"} · {u.from} → {u.to}
                {u.tariff ? ` · ${u.tariff}` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SettingsSection>
  );
}
