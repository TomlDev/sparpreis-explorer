"use client";

import * as React from "react";
import type { SearchResult } from "@/lib/domain/result";
import type { SearchMeta } from "@/lib/engine/types";

export interface SearchState {
  running: boolean;
  phase: "idle" | "searching" | "done" | "error";
  results: SearchResult[];
  meta: SearchMeta | null;
  status: string | null;
  progress: { checked: number; total: number; bestPrice: number | null; bestFvMinutes: number | null } | null;
  cached: boolean;
  error: string | null;
}

const INITIAL: SearchState = {
  running: false,
  phase: "idle",
  results: [],
  meta: null,
  status: null,
  progress: null,
  cached: false,
  error: null,
};

export function useSearch() {
  const [state, setState] = React.useState<SearchState>(INITIAL);
  const controllerRef = React.useRef<AbortController | null>(null);

  const abort = React.useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setState((s) => ({ ...s, running: false, phase: s.results.length ? "done" : "idle", status: null }));
  }, []);

  const run = React.useCallback(async (body: unknown) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((s) => ({
      ...INITIAL,
      running: true,
      phase: "searching",
      // keep previous results visible until fresh ones arrive
      results: s.results,
      cached: s.results.length > 0,
    }));

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const msg = res.status === 401 ? "Sitzung abgelaufen – bitte neu anmelden." : `Fehler ${res.status}`;
        setState((s) => ({ ...s, running: false, phase: "error", error: msg }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          dispatch(setState, ev);
        }
      }
      setState((s) => ({ ...s, running: false, phase: s.phase === "error" ? "error" : "done" }));
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      // If the stream drops (e.g. proxy cut a long/large response) but we already
      // received results, keep them and finish quietly instead of wiping to an error.
      setState((s) =>
        s.results.length
          ? { ...s, running: false, phase: "done", status: null }
          : { ...s, running: false, phase: "error", error: (err as Error).message },
      );
    }
  }, []);

  return { state, run, abort };
}

/** One-shot search that just returns the final best price + count (used by the
 *  multi-day calendar). Always runs in "fast" mode to stay API-friendly. */
export async function quickSearch(
  body: Record<string, unknown>,
): Promise<{ bestPrice: number | null; count: number }> {
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, mode: "fast" }),
  });
  if (!res.ok || !res.body) return { bestPrice: null, count: 0 };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bestPrice: number | null = null;
  let count = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const ev = JSON.parse(line.slice(6));
        if ((ev.type === "results" || ev.type === "done") && Array.isArray(ev.results)) {
          count = ev.results.length;
          const prices = ev.results
            .map((r: { coverage?: { price?: number | null } }) => r.coverage?.price)
            .filter((p: number | null | undefined): p is number => p != null);
          if (prices.length) bestPrice = Math.min(...prices);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return { bestPrice, count };
}

function dispatch(
  setState: React.Dispatch<React.SetStateAction<SearchState>>,
  ev: Record<string, unknown>,
) {
  const type = ev.type as string;
  setState((s) => {
    switch (type) {
      case "cached":
        return {
          ...s,
          results: (ev.results as SearchResult[]) ?? s.results,
          meta: (ev.meta as SearchMeta) ?? s.meta,
          cached: true,
        };
      case "status":
        return { ...s, status: (ev.message as string) ?? null };
      case "progress":
        return {
          ...s,
          progress: {
            checked: ev.checked as number,
            total: ev.total as number,
            bestPrice: (ev.bestPrice as number) ?? null,
            bestFvMinutes: (ev.bestFvMinutes as number) ?? null,
          },
        };
      case "results":
        return {
          ...s,
          results: (ev.results as SearchResult[]) ?? s.results,
          meta: (ev.meta as SearchMeta) ?? s.meta,
          cached: false,
        };
      case "done":
        return {
          ...s,
          results: (ev.results as SearchResult[]) ?? s.results,
          meta: (ev.meta as SearchMeta) ?? s.meta,
          cached: false,
          running: false,
          phase: "done",
          status: null,
        };
      case "error":
        return {
          ...s,
          results: (ev.results as SearchResult[]) ?? s.results,
          error: (ev.message as string) ?? "Unbekannter Fehler",
          phase: s.results.length || (ev.results as SearchResult[])?.length ? "done" : "error",
        };
      default:
        return s;
    }
  });
}
