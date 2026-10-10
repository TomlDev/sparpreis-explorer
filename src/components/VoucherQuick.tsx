"use client";

import * as React from "react";
import Link from "next/link";
import { Ticket } from "lucide-react";
import { CopyCode } from "@/components/CopyCode";
import { Sheet } from "@/components/Sheet";
import { formatEuro } from "@/lib/utils";

interface Voucher {
  number: string;
  value: number;
  validUntil: string | null;
  redeemed: boolean;
}

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

/**
 * Open DB vouchers at hand while searching / booking: a small card with the
 * total, tap → the codes to copy into bahn.de's checkout.
 */
export function VoucherQuick({ className }: { className?: string }) {
  const [list, setList] = React.useState<Voucher[] | null>(null);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/vouchers")
      .then((r) => (r.ok ? r.json() : { vouchers: [] }))
      .then((d) => setList(d.vouchers ?? []))
      .catch(() => setList([]));
  }, []);

  const t = today();
  const usable = (list ?? [])
    .filter((v) => !v.redeemed && v.value != null && (!v.validUntil || v.validUntil >= t))
    .sort((a, b) => (a.validUntil ?? "9999").localeCompare(b.validUntil ?? "9999") || b.value - a.value);
  if (!usable.length) return null;
  const sum = usable.reduce((s, v) => s + v.value, 0);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          "flex items-center gap-2 rounded-2xl border border-border bg-card/95 px-3 py-2 text-left text-sm shadow-lg backdrop-blur hover:bg-muted " +
          (className ?? "")
        }
        title="Gutscheine anzeigen"
      >
        <Ticket className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Gutscheine</span>
          <span className="block font-semibold tabular-nums">
            {formatEuro(sum)} <span className="text-xs font-normal text-muted-foreground">in {usable.length}</span>
          </span>
        </span>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Deine Gutscheine">
        <p className="mb-3 text-sm text-muted-foreground">
          Bei der Buchung auf bahn.de unter „Gutschein einlösen“ eintragen – der Knopf neben der Nummer kopiert sie.
        </p>
        <ul className="divide-y divide-border">
          {usable.map((v) => (
            <li key={v.number} className="flex items-center gap-3 py-2">
              <CopyCode code={v.number} className="min-w-0 flex-1 text-sm" />
              <span className="text-right">
                <span className="block font-semibold tabular-nums">{formatEuro(v.value)}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {v.validUntil ? `bis ${new Date(`${v.validUntil}T12:00:00Z`).toLocaleDateString("de-DE")}` : "Gültigkeit ?"}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm">
          <span>
            Zusammen <b className="tabular-nums">{formatEuro(sum)}</b>
          </span>
          <Link href="/reisen#gutscheine" className="text-primary underline" onClick={() => setOpen(false)}>
            Verwalten
          </Link>
        </div>
      </Sheet>
    </>
  );
}
