import { getSetting, setSetting } from "@/lib/repo/settings";
import { decrypt, encrypt } from "./crypto";

/** Personal data for passenger-rights claims — stored encrypted only. */
export interface ClaimantProfile {
  salutation: "Frau" | "Herr" | "Neutrale Anrede" | "";
  academic: string;
  firstName: string;
  lastName: string;
  company: string;
  addressExtra: string;
  street: string;
  houseNumber: string;
  postcode: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  replyByEmail: boolean;
  accountHolder: string;
  iban: string;
  bic: string;
  payout: "transfer" | "voucher";
  bahnBonusNumber: string;
}

export const EMPTY_PROFILE: ClaimantProfile = {
  salutation: "",
  academic: "",
  firstName: "",
  lastName: "",
  company: "",
  addressExtra: "",
  street: "",
  houseNumber: "",
  postcode: "",
  city: "",
  country: "Deutschland",
  phone: "",
  email: "",
  replyByEmail: true,
  accountHolder: "",
  iban: "",
  bic: "",
  payout: "transfer",
  bahnBonusNumber: "",
};

const KEY = "claimant:enc";

export function getProfile(): ClaimantProfile {
  const blob = getSetting<string>(KEY);
  if (!blob) return { ...EMPTY_PROFILE };
  try {
    return { ...EMPTY_PROFILE, ...(JSON.parse(decrypt(blob)) as Partial<ClaimantProfile>) };
  } catch {
    return { ...EMPTY_PROFILE };
  }
}

export function setProfile(p: Partial<ClaimantProfile>): ClaimantProfile {
  const next = { ...getProfile() } as ClaimantProfile;
  for (const k of Object.keys(EMPTY_PROFILE) as (keyof ClaimantProfile)[]) {
    const v = p[k];
    if (v === undefined) continue;
    if (typeof EMPTY_PROFILE[k] === "boolean") (next[k] as boolean) = v === true;
    else (next[k] as string) = String(v).slice(0, 200).trim();
  }
  next.iban = next.iban.replace(/\s+/g, "").toUpperCase();
  next.bic = next.bic.replace(/\s+/g, "").toUpperCase();
  setSetting(KEY, encrypt(JSON.stringify(next)));
  return next;
}

/** IBAN check digits (ISO 13616 mod 97). */
export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** "DE89 3704 …" → "DE89 •••• •••• •••• •••• 00" for display. */
export function maskIban(iban: string): string {
  const s = iban.replace(/\s+/g, "");
  if (s.length < 8) return s ? "••••" : "";
  return `${s.slice(0, 4)} •••• •••• ${s.slice(-4)}`;
}
