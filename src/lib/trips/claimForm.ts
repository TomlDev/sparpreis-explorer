import fs from "node:fs";
import path from "node:path";
import { PDFCheckBox, PDFDocument, PDFRadioGroup, PDFSignature, PDFTextField } from "pdf-lib";
import { formatInTimeZone } from "date-fns-tz";
import type { TripRow } from "@/db/schema";
import type { ClaimantProfile } from "./profile";
import { ticketSpan, type FormJourney } from "./rules";
import { uploadsDir } from "./repo";

/**
 * Fills DB's official "Fahrgastrechte-Formular" (fillable PDF, Formular 2025).
 * The blank form is downloaded from DB once and cached next to the uploads;
 * it is not shipped with the app.
 */
export const FORM_URL =
  "https://cms.static-bahn.de/wmedia/redaktion/aushaenge/fahrgastrechte/Fahrgastrechte-Formular_deutsch-feb25-2.pdf";
export const FORM_ADDRESS = "DB Fernverkehr AG, Servicecenter Fahrgastrechte, 60647 Frankfurt am Main";

const JOURNEY_OPTION: Record<FormJourney, number> = {
  delay: 0,
  not_started: 1,
  aborted_return: 2,
  continued_extra: 3,
};

async function blankForm(): Promise<Uint8Array> {
  const file = path.join(/*turbopackIgnore: true*/ path.dirname(uploadsDir()), "forms", "fahrgastrechte-formular.pdf");
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const res = await fetch(FORM_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Formular: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length || Buffer.from(bytes.subarray(0, 4)).toString() !== "%PDF") throw new Error("Formular konnte nicht geladen werden");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return bytes;
}

export interface ClaimFormInput {
  trip: TripRow;
  profile: ClaimantProfile;
  journey: FormJourney;
  /** Station where the trip was broken off / interrupted. */
  station?: string | null;
  extra?: { ticket?: boolean; transport?: boolean; overnight?: boolean; other?: boolean };
  reservationUnused?: boolean;
  /** Transparent PNG of the claimant's signature, placed on the signature line. */
  signature?: Buffer | null;
}

const TZ = "Europe/Berlin";

/** Shorten long station names to the field width instead of cutting them off. */
export function fit(value: string, max: number): string {
  if (value.length <= max) return value;
  const short = value
    .replace(/Hauptbahnhof/g, "Hbf")
    .replace(/Fernbahnhof|Fernbf\b/g, "Fbf")
    .replace(/Flughafen/g, "Flugh.")
    .replace(/Bahnhof/g, "Bf")
    .replace(/\s*\(([^)]*)\)/g, "($1)")
    .replace(/ im Schwarzwald/g, "/Schw.")
    .replace(/Frankfurt\(M(ain)?\)/g, "Ffm");
  if (short.length <= max) return short;
  // Still too long: the region after the town goes first ("…, Gutach im Breisgau" → "…,Gutach").
  const bare = short
    .replace(/\s+(im|am|an der|in der|ob der)\s+[^,]+$|\/Schw\.$|\s*\([^)]*\)$/, "")
    .replace(/,\s+/g, ",");
  return bare.slice(0, max);
}

const COUNTRY: Record<string, string> = {
  deutschland: "", germany: "", d: "", de: "",
  österreich: "A", austria: "A", schweiz: "CH", switzerland: "CH", niederlande: "NL", belgien: "B",
  frankreich: "F", luxemburg: "L", dänemark: "DK", polen: "PL", tschechien: "CZ", italien: "I",
  spanien: "E", portugal: "P", schweden: "S", norwegen: "N", finnland: "FIN", ungarn: "H",
  großbritannien: "GB", "vereinigtes königreich": "GB", irland: "IRL", liechtenstein: "FL",
};
/** International vehicle-style code ("A", "CH", "NL"); "" for Germany. */
export function countryCode(country: string | null | undefined): string {
  const c = (country ?? "").trim();
  if (!c) return "";
  const known = COUNTRY[c.toLowerCase()];
  if (known !== undefined) return known;
  return c.length <= 3 ? c.toUpperCase() : c.slice(0, 3);
}
const part = (iso: string, fmt: string) => formatInTimeZone(new Date(iso), TZ, fmt);

export async function fillClaimForm(input: ClaimFormInput): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await blankForm());
  const form = doc.getForm();
  const text = (name: string, value: string | null | undefined) => {
    if (!value) return;
    const f = form.getField(name);
    if (!(f instanceof PDFTextField)) return;
    const max = f.getMaxLength();
    f.setText(max ? fit(value, max) : value);
  };
  const check = (name: string, on: boolean | undefined) => {
    const f = form.getField(name);
    if (on && f instanceof PDFCheckBox) f.check();
  };
  const radio = (name: string, option: string | number) => {
    const f = form.getField(name);
    if (!(f instanceof PDFRadioGroup)) return;
    const opts = f.getOptions();
    const v = typeof option === "number" ? opts[option] : opts.find((o) => o === option);
    if (v) f.select(v);
  };

  const { trip, profile: p } = input;
  radio("journey", JOURNEY_OPTION[input.journey]);
  if (input.journey === "aborted_return") text("journey_brokenoff_station", input.station ?? trip.abortedAt);
  if (input.journey === "continued_extra") text("journey_cutshort_station", input.station ?? trip.abortedAt);

  // Rail part of the ticket (tram/metro/walks don't count for passenger rights).
  const span = ticketSpan(trip);
  const dep = span.departure;
  const arr = span.arrival;
  if (dep) {
    text("planned_day", part(dep, "dd"));
    text("planned_month", part(dep, "MM"));
    text("planned_year", part(dep, "yy"));
    text("planned_departure_hours", part(dep, "HH"));
    text("planned_departure_minutes", part(dep, "mm"));
  }
  radio("planned_direction", trip.direction === "return" ? "Rückfahrt" : "Hinfahrt");
  text("planned_departure_station", span.from);
  text("planned_destination_station", span.to);
  if (arr) {
    text("planned_destination_hours", part(arr, "HH"));
    text("planned_destination_minutes", part(arr, "mm"));
  }
  // Actual arrival: not for "not started" / broken off at the start.
  if (trip.actualArrival && (input.journey === "delay" || input.journey === "continued_extra")) {
    const a = trip.actualArrival;
    text("arrived_day", part(a, "dd"));
    text("arrived_month", part(a, "MM"));
    text("arrived_year", part(a, "yy"));
    text("arrived_hours", part(a, "HH"));
    text("arrived_minutes", part(a, "mm"));
  }
  check("additional_ticket", input.extra?.ticket);
  check("additional_transport", input.extra?.transport);
  check("additional_overnight", input.extra?.overnight);
  check("additional_other", input.extra?.other);
  check("further_noseat", input.reservationUnused);

  if (trip.orderNumber) {
    check("ticket_digital", true);
    text("ticket_digital_number", trip.orderNumber);
  }
  if (p.bahnBonusNumber) {
    check("ticket_bahnbonus", true);
    text("ticket_bahnbonus_number", p.bahnBonusNumber);
  }

  if (p.payout === "voucher") radio("compensation", "Gutschein");
  else {
    radio("compensation", "Geldauszahlung/Überweisung");
    text("compensation_accountholder", p.accountHolder || `${p.lastName}, ${p.firstName}`);
    text("compensation_iban", p.iban);
    text("compensation_bic", p.bic);
  }

  text("personal_company", p.company);
  if (p.salutation) radio("personal", p.salutation);
  text("personal_academic", p.academic);
  text("personal_firstname", p.firstName);
  text("personal_lastname", p.lastName);
  text("personal_additional", p.addressExtra);
  text("personal_telephone", p.phone);
  text("personal_street", p.street);
  text("personal_housenumber", p.houseNumber);
  // "Staat (wenn nicht D)" — stays empty for Germany; 3 characters → country code.
  const country = countryCode(p.country);
  if (country) text("personal_country", country);
  text("personal_postcode", p.postcode);
  text("personal_city", p.city);
  if (p.email && p.replyByEmail) {
    check("personal_email", true);
    text("personal_emailaddress", p.email);
  }
  // Auto size follows the field height and would cut off the last digit of the year.
  const date = form.getField("date");
  if (date instanceof PDFTextField) {
    date.setFontSize(10);
    date.setText(formatInTimeZone(new Date(), TZ, "dd.MM.yyyy"));
  }

  if (input.signature) {
    const field = form.getField("signature");
    const widget = field.acroField.getWidgets()[0];
    const rect = widget.getRectangle();
    const page = doc.getPages().find((pg) => pg.ref === widget.P()) ?? doc.getPages()[1];
    const img = await doc.embedPng(input.signature);
    // Like ink: may run over the line and touch the text above.
    const scale = Math.min((rect.width - 8) / img.width, (rect.height * 1.6) / img.height);
    page.drawImage(img, { x: rect.x + 4, y: rect.y - 6, width: img.width * scale, height: img.height * scale });
    // An empty signature field would put a "sign here" overlay over the image in some viewers.
    if (field instanceof PDFSignature) form.removeField(field);
  }

  return doc.save();
}
