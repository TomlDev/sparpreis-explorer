import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { TIMEZONE } from "./config";

export type TimeWindow =
  | "morning"
  | "midday"
  | "afternoon"
  | "evening"
  | "night"
  | string; // or "HH:mm"

/** Representative start time (HH:mm) for a named window. */
const WINDOW_START: Record<string, string> = {
  morning: "06:00",
  midday: "11:00",
  afternoon: "14:00",
  evening: "18:00",
  night: "22:00",
};

export const WINDOW_LABELS: Record<string, string> = {
  morning: "morgens",
  midday: "mittags",
  afternoon: "nachmittags",
  evening: "abends",
  night: "nachts",
};

export function windowToHHmm(win: TimeWindow): string {
  if (/^\d{1,2}:\d{2}$/.test(win)) return win.padStart(5, "0");
  return WINDOW_START[win] ?? "08:00";
}

/** UTC instant for a given local (Europe/Berlin) travel date + time window. */
export function localDeparture(travelDate: string, win: TimeWindow): Date {
  const hhmm = windowToHHmm(win);
  return fromZonedTime(`${travelDate}T${hhmm}:00`, TIMEZONE);
}

/** "HH:mm" → minutes since midnight (0 for anything unparsable). */
export function toMin(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return 0;
  return (Number(m[1]) % 24) * 60 + Number(m[2]);
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  try {
    return formatInTimeZone(new Date(iso), TIMEZONE, "HH:mm");
  } catch {
    return "–";
  }
}

export function formatDateHuman(dateStr: string): string {
  try {
    const d = fromZonedTime(`${dateStr}T12:00:00`, TIMEZONE);
    return formatInTimeZone(d, TIMEZONE, "EEE, d. MMM yyyy");
  } catch {
    return dateStr;
  }
}

export function formatDateTimeHuman(iso: string | null | undefined): string {
  if (!iso) return "–";
  try {
    return formatInTimeZone(new Date(iso), TIMEZONE, "d. MMM, HH:mm");
  } catch {
    return "–";
  }
}

/** yyyy-MM-dd for "today" in Europe/Berlin. */
export function todayLocal(): string {
  return formatInTimeZone(new Date(), TIMEZONE, "yyyy-MM-dd");
}

export function minutesBetween(a?: string | null, b?: string | null): number {
  if (!a || !b) return 0;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

export function relativeMinutesAgo(epochMs: number): number {
  return Math.max(0, Math.round((Date.now() - epochMs) / 60_000));
}

export function formatAgo(epochMs: number | null | undefined): string {
  if (!epochMs) return "unbekannt";
  const min = relativeMinutesAgo(epochMs);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} h`;
  const d = Math.round(h / 24);
  return `vor ${d} d`;
}

/** Berlin wall time ("2026-10-25", "01:30") → ISO instant; null for invalid input.
 *  DST-safe (a repeated hour resolves to its first occurrence). */
export function berlinToIso(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = fromZonedTime(`${date}T${time}:00`, TIMEZONE);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Calendar day (yyyy-MM-dd) of an instant in Europe/Berlin. */
export function berlinDay(at: string | number | Date): string {
  return formatInTimeZone(new Date(at), TIMEZONE, "yyyy-MM-dd");
}
