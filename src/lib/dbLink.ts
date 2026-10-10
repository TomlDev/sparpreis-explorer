import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/config";

/**
 * Deep link into bahn.de with the connection prefilled. The current bahn.de
 * REQUIRES station ids (soid/zoid + EVA soei/zoei) — station names alone error
 * out with "Verbindung gibt's nicht". The param set below mirrors a real,
 * working bahn.de search URL (incl. `vm`, `dlt/nfv/dltv`, and an `r` traveler
 * spec whose class matches `kl`).
 */
/** bahn.de product codes (URL params vm / hz). */
export const FV_CODES = ["00", "01", "02"]; // ICE, EC/IC, IR
export const NV_CODES = ["03", "04", "05", "06", "07", "08", "09"]; // Regio, S-Bahn, Bus, Schiff, U-Bahn, Tram, Rufbus
const ALL_CODES = [...FV_CODES, ...NV_CODES];

/** A Zwischenhalt as bahn.de's URL carries it: [id, name, Aufenthalt, Verkehrsmittel of the next section]. */
export interface DbLinkVia {
  lid: string;
  name: string;
  dwell?: number;
  nextProducts?: string[];
}

export interface ViaPlan {
  vias: { name: string; dwell?: number; nextProducts?: string[] }[];
  firstProducts?: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/g, "");

/**
 * Zwischenhalte that make bahn.de price the connection the app found:
 *  - pro-forma: regional to the Fernverkehr, Fernverkehr only between A and B,
 *    regional again after B (one ticket, one FV section);
 *  - via-priced alternatives: both ends of the FV section, 5 min at the first
 *    (exactly how the app priced them).
 */
export function viaPlan(kind: string, fv: { fromName: string; toName: string } | null, origin: string, dest: string): ViaPlan | null {
  // priced without ICE (the "less Fernverkehr" search): same products on bahn.de
  if (kind === "lowfv") return { vias: [], firstProducts: ALL_CODES.filter((c) => c !== "00") };
  if (!fv) return null;
  const startsHere = norm(fv.fromName) === norm(origin);
  const endsThere = norm(fv.toName) === norm(dest);
  if (kind === "proforma") {
    const vias: ViaPlan["vias"] = [];
    if (!startsHere) vias.push({ name: fv.fromName, nextProducts: FV_CODES });
    if (!endsThere) vias.push({ name: fv.toName, nextProducts: NV_CODES });
    return { vias, firstProducts: startsHere ? FV_CODES : NV_CODES };
  }
  // "alternative" = links from before the price kind was stored (via-forced)
  if (kind === "via" || kind === "alternative") {
    const vias = [fv.fromName, fv.toName].filter((n) => norm(n) !== norm(origin) && norm(n) !== norm(dest));
    return vias.length ? { vias: vias.map((name, i) => ({ name, dwell: i === 0 ? 5 : 0 })) } : null;
  }
  return null;
}

export function bahnDeLink(
  originName: string,
  destName: string,
  departureIso: string | null,
  ids?: {
    origin?: { soid: string; soei: string };
    dest?: { soid: string; soei: string };
  },
  opts?: {
    vias?: DbLinkVia[];
    firstProducts?: string[];
    /** The user's card and class — the app's prices include them, bahn.de's must too. */
    traveller?: { bahncard?: string | null; klasse?: 1 | 2; deutschlandTicket?: boolean };
  },
): string {
  const klasse = opts?.traveller?.klasse === 1 ? 1 : 2;
  const card = String(opts?.traveller?.bahncard ?? "").match(/(25|50|100)/)?.[1];
  // bahn.de reduction ids: 16 none, 17 BahnCard 25, 23 BahnCard 50, 24 BahnCard 100
  const reduction = card === "25" ? 17 : card === "50" ? 23 : card === "100" ? 24 : 16;
  const params: Record<string, string> = {
    sts: "true",
    so: originName,
    zo: destName,
    kl: String(klasse),
    r: `13:${reduction}:KLASSE_${klasse}:1`, // 1 Erwachsener (13), Ermäßigung, Klasse (must match kl)
    sot: "ST",
    zot: "ST",
    hza: "D",
    hz: JSON.stringify(
      (opts?.vias ?? []).map((v) => [v.lid, v.name, v.dwell ?? 0, ...(v.nextProducts ? [v.nextProducts.join(",")] : [])]),
    ),
    ar: "false",
    s: "true",
    d: "false",
    vm: (opts?.firstProducts ?? ALL_CODES).join(","),
    fm: "false",
    bp: "false",
    dlt: "false",
    nfv: "false",
    dltv: String(!!opts?.traveller?.deutschlandTicket),
  };
  if (ids?.origin) {
    params.soid = ids.origin.soid;
    params.soei = ids.origin.soei;
  }
  if (ids?.dest) {
    params.zoid = ids.dest.soid;
    params.zoei = ids.dest.soei;
  }
  if (departureIso) {
    // bahn.de expects local (Europe/Berlin) time without an offset.
    try {
      params.hd = formatInTimeZone(new Date(departureIso), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
    } catch {
      params.hd = departureIso;
    }
  }
  const query = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `https://www.bahn.de/buchung/fahrplan/suche#${query}`;
}
