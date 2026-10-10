"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  // Into <body>: opened from inside a floating panel it would otherwise sit in that
  // panel's layer, under the header and the floating buttons.
  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div
        className="absolute inset-0 bg-black/50 animate-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "absolute bg-card shadow-xl border-border",
          // bottom sheet on mobile, right drawer on desktop
          "inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl border-t",
          "sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[420px] sm:max-h-none sm:rounded-none sm:rounded-l-2xl sm:border-l sm:border-t-0",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 hover:bg-muted" aria-label="Schließen">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4" style={{ maxHeight: "calc(85vh - 60px)" }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
