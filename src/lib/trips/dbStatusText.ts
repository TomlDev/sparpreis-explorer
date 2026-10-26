import type { DbTripStatus } from "@/db/schema";

/** DB's Reisebegleitung in words (shared by server and pages). */

const STATUS_TEXT: Record<string, string> = {
  FAHRBAR: "fahrbar",
  NICHT_REKONSTRUIERBAR: "so nicht mehr fahrbar",
  VORLAEUFIG_NICHT_REKONSTRUIERBAR: "vorläufig nicht fahrbar",
  // DB Navigator: "Aufgrund von aktuellen Ereignissen ist die Verbindung nicht mehr fahrbar."
  GEBROCHEN: "Verbindung nicht mehr fahrbar",
};
const ALT_TEXT: Record<string, string> = {
  ALTERNATIVEN_KANN: "Alternative möglich",
  ALTERNATIVEN_MUSS: "Alternative nötig",
};

/** "Zugbindung aufgehoben · fahrbar · Alternative möglich" */
export function dbStatusText(s: DbTripStatus): string {
  return [
    s.zugbindung === "AUFGEHOBEN" ? "Zugbindung aufgehoben" : s.zugbindung === "BESTEHT" ? "Zugbindung besteht" : null,
    s.status ? (STATUS_TEXT[s.status] ?? s.status.toLowerCase().replace(/_/g, " ")) : null,
    s.alternativen ? (ALT_TEXT[s.alternativen] ?? null) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** DB says the booking can't be travelled as it is / the Zugbindung is gone. */
export const dbLifted = (s: DbTripStatus) => s.zugbindung === "AUFGEHOBEN" || (!!s.status && s.status !== "FAHRBAR");
