"use client";

import * as React from "react";
import { Button, Input, Spinner, Switch } from "@/components/ui";
import { SettingsSection } from "@/components/SettingsSection";

interface Profile {
  salutation: string;
  academic: string;
  firstName: string;
  lastName: string;
  company: string;
  addressExtra: string;
  street: string;
  houseNumber: string;
  postcode: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  replyByEmail: boolean;
  accountHolder: string;
  iban: string;
  bic: string;
  payout: "transfer" | "voucher";
  bahnBonusNumber: string;
}

/** Personal data for the passenger-rights form — stored encrypted on the server. */
export function ClaimantCard() {
  const [p, setP] = React.useState<Profile | null>(null);
  const [ibanMasked, setIbanMasked] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [sigRev, setSigRev] = React.useState(0);
  const [hasSig, setHasSig] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    fetch("/api/claimant/signature", { method: "HEAD" })
      .then((r) => setHasSig(r.ok))
      .catch(() => setHasSig(false));
  }, [sigRev]);

  React.useEffect(() => {
    fetch("/api/claimant")
      .then((r) => r.json())
      .then((d) => {
        setP(d.profile);
        setIbanMasked(d.ibanMasked ?? "");
      })
      .catch(() => {});
  }, []);
  if (!p || hasSig === null)
    return <SettingsSection id="fahrgastrechte" title="Fahrgastrechte: deine Daten" state="loading" />;

  const field = (k: keyof Profile, placeholder: string, opts: { className?: string; inputMode?: "numeric" | "email" | "tel" } = {}) => (
    <Input
      placeholder={placeholder}
      value={String(p[k] ?? "")}
      inputMode={opts.inputMode}
      className={opts.className}
      onChange={(e) => setP({ ...p, [k]: e.target.value })}
    />
  );

  async function save() {
    setErr(null);
    const res = await fetch("/api/claimant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return setErr(d.error ?? "Fehler");
    setP(d.profile);
    setIbanMasked(d.ibanMasked ?? "");
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  // Everything the DB form needs (bank account only for a transfer payout).
  const missing = [
    !(p.firstName && p.lastName) && "Name",
    !(p.street && p.postcode && p.city) && "Adresse",
    !p.email && "E-Mail",
    p.payout === "transfer" && !ibanMasked && "IBAN",
    !hasSig && "Unterschrift",
  ].filter(Boolean) as string[];
  const summary = missing.length
    ? `Fehlt: ${missing.join(", ")}`
    : `${p.firstName} ${p.lastName} · ${p.payout === "transfer" ? `Überweisung ${ibanMasked}` : "Gutschein"} · Unterschrift ✓`;

  return (
    <SettingsSection id="fahrgastrechte" title="Fahrgastrechte: deine Daten" state={missing.length ? "todo" : "done"} summary={summary}>
      <p className="mb-3 text-xs text-muted-foreground">
        Damit füllt die App das offizielle DB-Formular aus. Wird verschlüsselt auf dem Server gespeichert; die IBAN wird
        nie wieder vollständig angezeigt.
      </p>
      <div className="grid gap-2 sm:grid-cols-6">
        <select
          className="h-10 rounded-xl border border-input bg-background px-3 sm:col-span-2"
          value={p.salutation}
          onChange={(e) => setP({ ...p, salutation: e.target.value })}
        >
          <option value="">Anrede</option>
          <option>Frau</option>
          <option>Herr</option>
          <option>Neutrale Anrede</option>
        </select>
        {field("academic", "Titel", { className: "sm:col-span-1" })}
        {field("company", "Firma (optional)", { className: "sm:col-span-3" })}
        {field("firstName", "Vorname", { className: "sm:col-span-3" })}
        {field("lastName", "Nachname", { className: "sm:col-span-3" })}
        {field("street", "Straße", { className: "sm:col-span-4" })}
        {field("houseNumber", "Nr.", { className: "sm:col-span-2" })}
        {field("addressExtra", "Adresszusatz (optional)", { className: "sm:col-span-6" })}
        {field("postcode", "PLZ", { className: "sm:col-span-2", inputMode: "numeric" })}
        {field("city", "Ort", { className: "sm:col-span-4" })}
        {field("phone", "Telefon (optional)", { className: "sm:col-span-3", inputMode: "tel" })}
        {field("email", "E-Mail", { className: "sm:col-span-3", inputMode: "email" })}
      </div>
      <div className="mt-3">
        <Switch checked={p.replyByEmail} onChange={(v) => setP({ ...p, replyByEmail: v })} label="Antwort der DB per E-Mail" />
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-2 flex flex-wrap gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={p.payout === "transfer"} onChange={() => setP({ ...p, payout: "transfer" })} /> Überweisung
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={p.payout === "voucher"} onChange={() => setP({ ...p, payout: "voucher" })} /> Gutschein
          </label>
        </div>
        {p.payout === "transfer" && (
          <div className="grid gap-2 sm:grid-cols-6">
            {field("accountHolder", "Kontoinhaber (Name, Vorname)", { className: "sm:col-span-6" })}
            <Input
              className="sm:col-span-4"
              placeholder={ibanMasked ? `IBAN gespeichert: ${ibanMasked} – leer lassen = behalten` : "IBAN"}
              value={p.iban}
              autoComplete="off"
              onChange={(e) => setP({ ...p, iban: e.target.value })}
            />
            {field("bic", "BIC", { className: "sm:col-span-2" })}
          </div>
        )}
        <div className="mt-2 grid gap-2 sm:grid-cols-2">{field("bahnBonusNumber", "BahnBonus-Nummer (nur wenn Punkte eingelöst)")}</div>
      </div>
      <SignatureField has={hasSig} rev={sigRev} onChanged={() => setSigRev((r) => r + 1)} />
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <Button className="mt-3" onClick={save}>
        {saved ? "Gespeichert ✓" : "Speichern"}
      </Button>
    </SettingsSection>
  );
}

/** Signature for the form: a photo / screenshot, background removed on the server. */
function SignatureField({ has, rev, onChanged }: { has: boolean; rev: number; onChanged: () => void }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/claimant/signature", { method: "POST", body });
      if (!res.ok) setErr((await res.json().catch(() => ({}))).error ?? "Hochladen fehlgeschlagen");
      onChanged();
    } catch {
      setErr("Hochladen fehlgeschlagen – keine Verbindung");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border-t border-border pt-3">
      <h3 className="mb-1 text-sm font-medium">Unterschrift</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        Foto oder Screenshot deiner Unterschrift (dunkel auf hellem Grund). Der Hintergrund wird entfernt, dann steht sie auf
        jedem erzeugten Formular.
      </p>
      {has && (
        <img
          src={`/api/claimant/signature?v=${rev}`}
          alt="Gespeicherte Unterschrift"
          className="mb-2 h-16 max-w-full rounded-lg border border-border bg-white object-contain p-1"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? <Spinner /> : has ? "Ersetzen" : "Bild hochladen"}
        </Button>
        {has && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={async () => {
              if (!confirm("Unterschrift löschen?")) return;
              await fetch("/api/claimant/signature", { method: "DELETE" }).catch(() => {});
              onChanged();
            }}
          >
            Entfernen
          </Button>
        )}
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
    </div>
  );
}
