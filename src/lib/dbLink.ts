import { formatInTimeZone } from "date-fns-tz";
import { TIMEZONE } from "@/lib/config";

/**
 * Deep link into bahn.de with the connection prefilled. The current bahn.de
 * REQUIRES station ids (soid/zoid + EVA soei/zoei) — station names alone error
 * out with "Verbindung gibt's nicht". The param set below mirrors a real,
 * working bahn.de search URL (incl. `vm`, `dlt/nfv/dltv`, and an `r` traveler
 * spec whose class matches `kl`).
 */
export function bahnDeLink(
  originName: string,
  destName: string,
  departureIso: string | null,
  ids?: {
    origin?: { soid: string; soei: string };
    dest?: { soid: string; soei: string };
  },
): string {
  const params: Record<string, string> = {
    sts: "true",
    so: originName,
    zo: destName,
    kl: "2",
    r: "13:16:KLASSE_2:1", // 1 Erwachsener, 2. Klasse (class must match kl=2)
    sot: "ST",
    zot: "ST",
    hza: "D",
    hz: "[]",
    ar: "false",
    s: "true",
    d: "false",
    vm: "00,01,02,03,04,05,06,07,08,09",
    fm: "false",
    bp: "false",
    dlt: "false",
    nfv: "false",
    dltv: "false",
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
