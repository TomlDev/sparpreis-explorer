"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * A short note at the bottom of the screen with an action ("Rückgängig"),
 * closing by itself after a few seconds.
 */
export function Toast({
  text,
  action,
  onAction,
  onClose,
  ms = 8000,
}: {
  text: React.ReactNode;
  action?: string;
  onAction?: () => void;
  onClose: () => void;
  ms?: number;
}) {
  const close = React.useRef(onClose);
  React.useEffect(() => {
    close.current = onClose;
  });
  React.useEffect(() => {
    const t = setTimeout(() => close.current(), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-50 mx-auto flex w-[calc(100%-2rem)] max-w-md items-center gap-3 rounded-2xl border border-border bg-foreground px-4 py-3 text-sm text-background shadow-xl"
    >
      <span className="min-w-0 flex-1">{text}</span>
      {action && onAction && (
        <button type="button" className="shrink-0 font-semibold underline underline-offset-2" onClick={onAction}>
          {action}
        </button>
      )}
      <button type="button" className="shrink-0 opacity-70 hover:opacity-100" onClick={onClose} aria-label="Schließen">
        <X className="h-4 w-4" />
      </button>
    </div>,
    document.body,
  );
}
