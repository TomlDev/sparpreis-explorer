/**
 * Station / train keys for matching our journeys against the punctuality open
 * data (piebro/deutsche-bahn-data). The station rule MUST stay identical to
 * norm() in scripts/delay_ingest.py (tests/delayNormalize.test.ts checks both).
 */

/** Order-independent station key: "Freiburg Hauptbahnhof" ≡ "Freiburg Hbf",
 *  "Offenburg Bahnhof" ≡ "Offenburg". `loose` also drops "(…)" qualifiers:
 *  "Freiburg (Breisgau) Hbf" → "freiburg hbf". */
export function normStationKey(name: string, loose = false): string {
  let n = (name || "").toLowerCase().replaceAll("hauptbahnhof", "hbf");
  if (loose) n = n.replace(/\([^)]*\)/g, " ");
  return n
    .split(/[^a-z0-9ß-ÿ]+/)
    .filter((t) => t && t !== "bahnhof" && t !== "bf")
    .sort()
    .join(" ");
}

/** EVA number from a provider station id ("8000207", "008000207"), else null. */
export function evaFromId(id: string | null | undefined): string | null {
  const m = /^0*(8\d{6})$/.exec((id ?? "").trim());
  return m ? m[1] : null;
}

const FV_TYPES = /^(ICE|ECE|EC|IC|RJX|RJ|NJ|EN|FLX|TGV)(?=\d|\s|$)/;

export interface TrainKey {
  /** Train number ("4719", "101") — the most specific key. */
  number: string | null;
  /** Line key as in the data: "RE2", "S9", "RB32" — or the train type for
   *  long distance ("ICE", "IC"), which has no line number there. */
  line: string | null;
}

/**
 * Parse our leg labels. Sources:
 *  - db-vendo: lineName "ICE 109" / "RE 2" / "88366", trainNumber "109"
 *  - MOTIS:    "RB32 (31242)", "ICE 101", "RE2"
 */
export function trainKey(leg: { lineName?: string | null; trainNumber?: string | null }): TrainKey {
  const label = (leg.lineName ?? "").trim();
  const tn = (leg.trainNumber ?? "").trim();
  let number: string | null = null;
  if (/^\d+$/.test(tn)) number = tn;
  else {
    const paren = /\((\d+)\)/.exec(label) ?? /\((\d+)\)/.exec(tn);
    const fv = FV_TYPES.test(label.toUpperCase()) ? /(\d+)$/.exec(label) : null;
    number = paren?.[1] ?? fv?.[1] ?? null;
  }
  let line: string | null = null;
  const bare = label.replace(/\([^)]*\)/g, "").replace(/\s+/g, "").toUpperCase();
  const fvType = FV_TYPES.exec(bare);
  if (fvType) line = fvType[1];
  else if (/^[A-Z]+\d+[A-Z]?$/.test(bare)) line = bare; // "RE2", "S9", "RB32", "RS1"
  return { number: number ? number.replace(/^0+/, "") || null : null, line };
}
