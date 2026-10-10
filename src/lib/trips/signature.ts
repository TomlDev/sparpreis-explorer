import sharp from "sharp";
import { getSetting, setSetting } from "@/lib/repo/settings";
import { decrypt, encrypt } from "./crypto";

/** Handwritten signature for the claim form — a transparent PNG, stored encrypted only. */
const KEY = "claimant:signature:enc";
export const MAX_SIGNATURE_UPLOAD = 8 * 1024 * 1024;

export function getSignature(): Buffer | null {
  const blob = getSetting<string>(KEY);
  if (!blob) return null;
  try {
    return Buffer.from(decrypt(blob), "base64");
  } catch {
    return null;
  }
}

export function deleteSignature(): void {
  setSetting(KEY, null);
}

/**
 * Photo / screenshot of a signature on light paper → ink only on a transparent
 * background, cropped to the strokes. Throws when no ink is found.
 */
export async function processSignature(input: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(input, { limitInputPixels: 40_000_000 })
    .rotate() // EXIF orientation of phone photos
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .grayscale()
    .normalise() // grey paper in a photo → white
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const rgba = Buffer.alloc(w * h * 4);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0; i < w * h; i++) {
    const lum = data[i * info.channels];
    // Light paper → transparent, ink → opaque, soft edge in between.
    const a = lum >= 200 ? 0 : lum <= 110 ? 255 : Math.round(((200 - lum) / 90) * 255);
    rgba[i * 4] = 20; // dark blue-black ink
    rgba[i * 4 + 1] = 24;
    rgba[i * 4 + 2] = 48;
    rgba[i * 4 + 3] = a;
    if (a > 64) {
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || (maxX - minX) * (maxY - minY) < 200) throw new Error("Keine Unterschrift erkannt – bitte dunkle Schrift auf hellem Grund.");
  const pad = 6;
  const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
  return sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left, top, width: Math.min(w, maxX + pad + 1) - left, height: Math.min(h, maxY + pad + 1) - top })
    .resize({ width: 1200, height: 400, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

export async function saveSignature(input: Buffer): Promise<Buffer> {
  const png = await processSignature(input);
  setSetting(KEY, encrypt(png.toString("base64")));
  return png;
}
