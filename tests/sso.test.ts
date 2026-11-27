import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySso } from "@/lib/sso";

const SECRET = "x".repeat(40);
const NOW = 1_800_000_000_000;
const token = (o: Record<string, unknown>, secret = SECRET) => {
  const p = Buffer.from(JSON.stringify({ sub: "admin", aud: "bahn", exp: NOW / 1000 + 60, jti: "abcdefghij", ...o })).toString("base64url");
  return `${p}.${createHmac("sha256", secret).update(p).digest("base64url")}`;
};

describe("Anmeldung vom Home-Portal", () => {
  it("nimmt ein gültiges Token", () => {
    expect(verifySso(token({}), SECRET, NOW)).toMatchObject({ aud: "bahn", jti: "abcdefghij" });
  });
  it("lehnt falsche Signatur, anderes Ziel, Ablauf und zu weit in der Zukunft ab", () => {
    expect(verifySso(token({}, "y".repeat(40)), SECRET, NOW)).toBeNull();
    expect(verifySso(token({ aud: "klima" }), SECRET, NOW)).toBeNull();
    expect(verifySso(token({ exp: NOW / 1000 - 1 }), SECRET, NOW)).toBeNull();
    expect(verifySso(token({ exp: NOW / 1000 + 600 }), SECRET, NOW)).toBeNull();
    expect(verifySso(token({}), "kurz", NOW)).toBeNull();
    expect(verifySso("unsinn", SECRET, NOW)).toBeNull();
  });
});
