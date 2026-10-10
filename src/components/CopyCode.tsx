"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** A code (voucher number …) with a button that copies it. */
export function CopyCode({ code, className }: { code: string; className?: string }) {
  const [done, setDone] = React.useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // older browsers / no permission: select-and-copy fallback
      const ta = document.createElement("textarea");
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  }
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span className="select-all font-mono">{code}</span>
      <button
        type="button"
        onClick={copy}
        className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label={`${code} kopieren`}
        title={done ? "Kopiert" : "Kopieren"}
      >
        {done ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
      </button>
    </span>
  );
}
