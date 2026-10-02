"use client";

import * as React from "react";
import { Button, Card, Input, Switch } from "@/components/ui";

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

  React.useEffect(() => {
    fetch("/api/claimant")
      .then((r) => r.json())
      .then((d) => {
        setP(d.profile);
        setIbanMasked(d.ibanMasked ?? "");
      })
      .catch(() => {});
  }, []);
  if (!p) return null;

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

  return (
    <Card className="p-4" id="fahrgastrechte">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Fahrgastrechte: deine Daten</h2>
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
      {err && <p className="mt-2 text-sm text-danger">{err}</p>}
      <Button className="mt-3" onClick={save}>
        {saved ? "Gespeichert ✓" : "Speichern"}
      </Button>
    </Card>
  );
}
