import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  checkPassword,
  createSessionToken,
  verifySessionToken,
} from "@/lib/auth";
import { LoginRateLimiter, clientIp } from "@/lib/loginRateLimit";
import { safeNextPath } from "@/lib/safeRedirect";
import { proxy } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

describe("Session-Token", () => {
  it("läuft nach 30 Tagen auch serverseitig ab", async () => {
    const t0 = Date.UTC(2026, 8, 1);
    const token = await createSessionToken("user", t0);
    expect(await verifySessionToken(token, t0 + 1000)).toBe(true);
    expect(await verifySessionToken(token, t0 + SESSION_MAX_AGE * 1000 - 1000)).toBe(true);
    expect(await verifySessionToken(token, t0 + SESSION_MAX_AGE * 1000 + 1000)).toBe(false);
  });

  it("lehnt manipulierte oder aus der Zukunft stammende Tokens ab", async () => {
    const now = Date.now();
    const token = await createSessionToken("user", now);
    const [payload, sig] = token.split(".");
    const forged = btoa(JSON.stringify({ u: "admin", iat: now })).replace(/=+$/, "");
    expect(await verifySessionToken(`${forged}.${sig}`, now)).toBe(false);
    expect(await verifySessionToken(`${payload}.${sig.slice(0, -2)}xx`, now)).toBe(false);
    expect(await verifySessionToken(await createSessionToken("user", now + 60 * 60 * 1000), now)).toBe(false);
    expect(await verifySessionToken("", now)).toBe(false);
    expect(await verifySessionToken("kein-token", now)).toBe(false);
  });

  it("verweigert in Produktion ohne echtes AUTH_SECRET (kein bekannter Fallback-Schlüssel)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", "zu-kurz");
    await expect(createSessionToken("user")).rejects.toThrow(/AUTH_SECRET/);
    expect(await verifySessionToken("abc.def")).toBe(false);
  });
});

describe("Passwort", () => {
  it("prüft korrekt, auch bei unterschiedlicher Länge", async () => {
    vi.stubEnv("APP_PASSWORD", "richtig-geheim");
    expect(await checkPassword("richtig-geheim")).toBe(true);
    expect(await checkPassword("richtig-gehei")).toBe(false);
    expect(await checkPassword("richtig-geheim-und-mehr")).toBe(false);
    expect(await checkPassword("")).toBe(false);
    vi.stubEnv("APP_PASSWORD", "");
    expect(await checkPassword("")).toBe(false); // no password configured → nobody gets in
  });
});

describe("Brute-Force-Schutz", () => {
  it("nimmt die IP, die Apache anhängt — nicht die vom Client mitgeschickte", () => {
    const h = new Headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" });
    expect(clientIp(h)).toBe("198.51.100.7");
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.7" }))).toBe("198.51.100.7");
    expect(clientIp(new Headers())).toBe("direct");
  });

  it("gefälschte X-Forwarded-For-Werte helfen nicht beim Durchprobieren", () => {
    const limiter = new LoginRateLimiter(10, 600_000);
    const t = 1_000_000;
    for (let i = 0; i < 10; i++) {
      const spoofed = new Headers({ "x-forwarded-for": `10.0.0.${i}, 198.51.100.7` });
      limiter.recordFailure(clientIp(spoofed), t);
    }
    expect(limiter.isBlocked("198.51.100.7", t)).toBe(true);
    expect(limiter.isBlocked("203.0.113.1", t)).toBe(false); // others unaffected
    expect(limiter.isBlocked("198.51.100.7", t + 600_001)).toBe(false); // window over
  });

  it("ein erfolgreicher Login setzt den Zähler zurück", () => {
    const limiter = new LoginRateLimiter(3, 600_000);
    limiter.recordFailure("a", 0);
    limiter.recordFailure("a", 0);
    limiter.recordSuccess("a");
    limiter.recordFailure("a", 0);
    expect(limiter.isBlocked("a", 0)).toBe(false);
  });
});

describe("Weiterleitung nach dem Login", () => {
  it("erlaubt nur Pfade auf der eigenen Seite", () => {
    expect(safeNextPath("/?o=nrw&date=2026-10-16&open=abc")).toBe("/?o=nrw&date=2026-10-16&open=abc");
    expect(safeNextPath("/settings")).toBe("/settings");
    for (const evil of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "javascript:alert(1)",
      "evil.example",
      "",
      null,
    ]) {
      expect(safeNextPath(evil)).toBe("/");
    }
  });
});

describe("Proxy (Zugangsschutz)", () => {
  it("leitet ohne Login auf /login um (gleicher Host → Next macht sie relativ) und behält den Link", async () => {
    const res = await proxy(new NextRequest("http://localhost:3005/?o=nrw&date=2026-10-16"));
    expect(res.status).toBe(307);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("localhost:3005"); // same origin as the request → relativized by Next's adapter
    expect(loc.pathname).toBe("/login");
    expect(loc.searchParams.get("next")).toBe("/?o=nrw&date=2026-10-16");
  });

  it("API ohne Login → 401, mit gültigem Cookie → durchgelassen", async () => {
    const denied = await proxy(new NextRequest("http://localhost:3005/api/search", { method: "POST" }));
    expect(denied.status).toBe(401);
    const token = await createSessionToken("user");
    const allowed = await proxy(
      new NextRequest("http://localhost:3005/api/search", {
        method: "POST",
        headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-middleware-next")).toBe("1");
  });

  it("Login-Seite und Health bleiben öffentlich, Ähnlich-Klingendes nicht", async () => {
    for (const path of ["/login", "/api/auth/login", "/api/health"]) {
      const res = await proxy(new NextRequest(`http://localhost:3005${path}`));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
    const sneaky = await proxy(new NextRequest("http://localhost:3005/api/healthz"));
    expect(sneaky.status).toBe(401);
  });
});
