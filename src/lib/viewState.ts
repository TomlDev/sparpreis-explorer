import type { SortMode } from "@/lib/domain/ranking";
import { DEFAULT_FILTERS, type SearchFilters } from "@/lib/engine/types";
import { WINDOW_LABELS, windowToHHmm } from "@/lib/time";

/**
 * The complete, shareable state of the search page — everything needed to
 * reproduce exactly what the user is looking at. Round-trips through the URL
 * query (`parseView` ⇄ `serializeView`), so a pasted link restores the view and
 * `npm run view -- '<url>'` can recompute the visible list on the server.
 *
 * Query schema (defaults are omitted to keep links short):
 *   o, d            origin / destination profile keys
 *   date            travel date (yyyy-MM-dd)
 *   tw, tt          time window start / end (HH:mm)
 *   tm=arrival      window means arrival (default: departure)
 *   mode            fast | thorough | deep            (default thorough)
 *   sort            ranking mode                      (default cheapest)
 *   f.<filter>      a filter that differs from DEFAULT_FILTERS
 *                   (booleans 1/0, numbers, empty = no limit)
 *   ref, refp       chosen reference (fingerprint) and its price
 *   open            expanded result cards (comma-separated fingerprints)
 *   cmp             compare selection (comma-separated fingerprints)
 *   view            open dialog: filters | calendar | compare
 *   day=1           whole-day scan (cheapest Flex connection of the day)
 */
export type TimeMode = "departure" | "arrival";
export type SearchModeKey = "fast" | "thorough" | "deep";
export type ViewDialog = "filters" | "calendar" | "compare";

export interface ViewState {
  origin: string | null;
  dest: string | null;
  date: string | null;
  timeFrom: string;
  timeTo: string;
  timeMode: TimeMode;
  mode: SearchModeKey;
  sort: SortMode;
  filters: SearchFilters;
  refFp: string | null;
  refPrice: number | null;
  open: string[];
  compare: string[];
  dialog: ViewDialog | null;
  /** Whole-day scan instead of the time window. */
  day: boolean;
}

export const DEFAULT_VIEW: ViewState = {
  origin: null,
  dest: null,
  date: null,
  timeFrom: "06:00",
  timeTo: "10:00",
  timeMode: "departure",
  mode: "thorough",
  sort: "cheapest",
  filters: DEFAULT_FILTERS,
  refFp: null,
  refPrice: null,
  open: [],
  compare: [],
  dialog: null,
  day: false,
};

const SORTS: SortMode[] = [
  "proforma",
  "cheapest",
  "fastest",
  "least-fv",
  "fewest-transfers",
  "tight-transfers",
  "unreliable",
  "cheap-flex",
];
const MODES: SearchModeKey[] = ["fast", "thorough", "deep"];
const DIALOGS: ViewDialog[] = ["filters", "calendar", "compare"];
const HHMM = /^\d{1,2}:\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FP = /^[0-9a-f]{6,40}$/i;

function hhmm(v: string | null, fallback: string): string {
  if (!v) return fallback;
  // Old links may carry named windows ("morning") — map them like before.
  const t = WINDOW_LABELS[v] ? windowToHHmm(v) : v;
  if (!HHMM.test(t)) return fallback;
  const [h, m] = t.split(":").map(Number);
  if (h > 23 || m > 59) return fallback;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fpList(v: string | null): string[] {
  if (!v) return [];
  return [...new Set(v.split(",").map((s) => s.trim()).filter((s) => FP.test(s)))];
}

function encodeFilterValue(v: SearchFilters[keyof SearchFilters]): string {
  if (typeof v === "boolean") return v ? "1" : "0";
  return v == null ? "" : String(v);
}

function decodeFilterValue(
  raw: string,
  def: SearchFilters[keyof SearchFilters],
): SearchFilters[keyof SearchFilters] | undefined {
  if (typeof def === "boolean") {
    if (raw === "1" || raw === "true") return true;
    if (raw === "0" || raw === "false") return false;
    return undefined;
  }
  // number | null filters
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a query string / URLSearchParams into a complete view (defaults fill gaps). */
export function parseView(input: URLSearchParams | string): ViewState {
  const q =
    typeof input === "string"
      ? new URLSearchParams(input.includes("?") ? input.slice(input.indexOf("?") + 1) : input)
      : input;
  const filters: SearchFilters = { ...DEFAULT_FILTERS };
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof SearchFilters)[]) {
    const raw = q.get(`f.${key}`);
    if (raw == null) continue;
    const v = decodeFilterValue(raw, DEFAULT_FILTERS[key]);
    if (v !== undefined) (filters as unknown as Record<string, unknown>)[key] = v;
  }
  const sort = q.get("sort") as SortMode | null;
  const mode = q.get("mode") as SearchModeKey | null;
  const dialog = q.get("view") as ViewDialog | null;
  const date = q.get("date");
  const refPrice = q.get("refp");
  const refFp = q.get("ref");
  return {
    origin: q.get("o") || null,
    dest: q.get("d") || null,
    date: date && DATE.test(date) ? date : null,
    timeFrom: hhmm(q.get("tw"), DEFAULT_VIEW.timeFrom),
    timeTo: hhmm(q.get("tt"), DEFAULT_VIEW.timeTo),
    timeMode: q.get("tm") === "arrival" ? "arrival" : "departure",
    mode: mode && MODES.includes(mode) ? mode : DEFAULT_VIEW.mode,
    sort: sort && SORTS.includes(sort) ? sort : DEFAULT_VIEW.sort,
    filters,
    refFp: refFp && FP.test(refFp) ? refFp : null,
    refPrice: refPrice != null && refPrice !== "" && Number.isFinite(Number(refPrice)) ? Number(refPrice) : null,
    open: fpList(q.get("open")),
    compare: fpList(q.get("cmp")).slice(0, 3),
    dialog: dialog && DIALOGS.includes(dialog) ? dialog : null,
    day: q.get("day") === "1",
  };
}

/** Serialize a view to a query string (no leading "?"), omitting defaults.
 *  Key order is fixed so the same view always yields the same link. */
export function serializeView(v: ViewState): string {
  const q = new URLSearchParams();
  if (v.origin) q.set("o", v.origin);
  if (v.dest) q.set("d", v.dest);
  if (v.date) q.set("date", v.date);
  q.set("tw", v.timeFrom);
  q.set("tt", v.timeTo);
  if (v.timeMode === "arrival") q.set("tm", "arrival");
  if (v.mode !== DEFAULT_VIEW.mode) q.set("mode", v.mode);
  if (v.sort !== DEFAULT_VIEW.sort) q.set("sort", v.sort);
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof SearchFilters)[]) {
    if (v.filters[key] !== DEFAULT_FILTERS[key]) q.set(`f.${key}`, encodeFilterValue(v.filters[key]));
  }
  if (v.refFp) q.set("ref", v.refFp);
  if (v.refFp && v.refPrice != null) q.set("refp", String(v.refPrice));
  if (v.open.length) q.set("open", v.open.join(","));
  if (v.compare.length) q.set("cmp", v.compare.join(","));
  if (v.dialog) q.set("view", v.dialog);
  if (v.day) q.set("day", "1");
  // URLSearchParams escapes "," and ":" — keep them readable in the link.
  return q.toString().replace(/%2C/gi, ",").replace(/%3A/gi, ":");
}
