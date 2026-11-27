"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const KEY = (id: string) => `bf:open:${id}`;

/**
 * Open / closed per section, remembered in this browser. `toggle` is the user's
 * choice and is kept; `show` opens for a moment (a link to it, something to
 * answer) without changing what is remembered.
 */
export function useStoredOpen(id: string, initial: boolean) {
  const [open, setOpen] = React.useState(initial);
  React.useEffect(() => {
    try {
      const v = localStorage.getItem(KEY(id));
      if (v === "1" || v === "0") setOpen(v === "1");
    } catch {
      /* private mode: just the default */
    }
  }, [id]);
  const toggle = React.useCallback(() => {
    setOpen((o) => {
      try {
        localStorage.setItem(KEY(id), o ? "0" : "1");
      } catch {
        /* not kept */
      }
      return !o;
    });
  }, [id]);
  const show = React.useCallback(() => setOpen(true), []);
  return { open, toggle, show };
}

export function Chevron({ open, className }: { open: boolean; className?: string }) {
  return <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180", className)} />;
}

/** A small uppercase heading above a list ("Nächste Fahrt") that folds what follows. */
export function FoldHeading({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-1.5 text-left">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{children}</h2>
      <Chevron open={open} />
    </button>
  );
}
