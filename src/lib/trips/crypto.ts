import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for personal data (address, IBAN, …): AES-256-GCM.
 * Key: DATA_KEY if set, else derived from AUTH_SECRET (HKDF) — so changing
 * AUTH_SECRET without setting DATA_KEY makes stored personal data unreadable.
 */
function key(): Buffer {
  const own = process.env.DATA_KEY;
  if (own && own.length >= 32) return createHash("sha256").update(own).digest();
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET/DATA_KEY fehlt");
    return createHash("sha256").update("insecure-dev-data-key").digest();
  }
  return Buffer.from(hkdfSync("sha256", secret, "bahn-finder", "personal-data v1", 32));
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
}

export function decrypt(blob: string): string {
  if (!blob.startsWith("v1:")) throw new Error("unknown format");
  const raw = Buffer.from(blob.slice(3), "base64");
  const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
