import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEuro(amount: number | null | undefined): string {
  if (amount == null) return "–";
  return amount.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

export function formatDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return `${h}:${String(m).padStart(2, "0")} h`;
}
