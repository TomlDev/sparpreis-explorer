"use client";

import * as React from "react";
import { AlertCircle, Check, ChevronDown } from "lucide-react";
import { Card } from "@/components/ui";
import { cn } from "@/lib/utils";

/** done = set up (starts collapsed), todo = needs input (starts open), info = nothing to set up (collapsed). */
export type SectionState = "loading" | "done" | "todo" | "info";

/**
 * A settings card that folds to its title + a one-line summary. Whether it
 * starts open is decided once, when its data has loaded: open if something is
 * missing or the page was opened with #id; afterwards only the user toggles it.
 */
export function SettingsSection({
  id,
  title,
  state,
  summary,
  nested,
  children,
}: {
  id?: string;
  title: React.ReactNode;
  state: SectionState;
  summary?: React.ReactNode;
  /** a section inside another one (e.g. one route profile) — lighter frame */
  nested?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState<boolean | null>(null);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (open !== null || state === "loading") return;
    const linked = !!id && typeof window !== "undefined" && window.location.hash === `#${id}`;
    setOpen(state === "todo" || linked);
    if (linked) requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start" }));
  }, [state, open, id]);

  const isOpen = open === true;
  const head = (
    <button
      type="button"
      onClick={() => setOpen(!isOpen)}
      aria-expanded={isOpen}
      className={cn(
        "flex w-full items-center gap-2 text-left",
        nested ? "rounded-xl px-3 py-2 hover:bg-muted/50" : "rounded-2xl px-4 py-3 hover:bg-muted/40",
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block font-semibold",
            nested ? "text-sm" : "text-sm uppercase tracking-wide text-muted-foreground",
          )}
        >
          {title}
        </span>
        {summary != null && summary !== "" && (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{summary}</span>
        )}
      </span>
      {state === "done" && <Check className="h-4 w-4 shrink-0 text-success" aria-label="eingerichtet" />}
      {state === "todo" && <AlertCircle className="h-4 w-4 shrink-0 text-warning" aria-label="noch offen" />}
      <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-180")} />
    </button>
  );

  const body = isOpen && children != null && (
    <div className={cn("border-t border-border", nested ? "px-3 pb-3 pt-2" : "px-4 pb-4 pt-3")}>{children}</div>
  );

  if (nested)
    return (
      <div ref={ref} id={id} className="scroll-mt-20 rounded-xl border border-border">
        {head}
        {body}
      </div>
    );
  return (
    <Card ref={ref} id={id} className="scroll-mt-20">
      {head}
      {body}
    </Card>
  );
}

/** Small heading between groups of sections. */
export function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="px-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/80">{title}</h2>
      {children}
    </section>
  );
}
