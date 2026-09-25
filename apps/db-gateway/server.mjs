/**
 * DB-Vendo Gateway
 * ----------------
 * A minimal, hardened HTTP service that wraps db-vendo-client. Runs on a
 * *residential* connection (e.g. a Raspberry Pi at home) so the main app can
 * fetch DB Sparpreise/tickets without its datacenter IP being blocked.
 *
 * It exposes ONLY the operations the app needs — no generic proxy:
 *   GET  /health
 *   GET  /api/locations?query=&results=
 *   POST /api/journeys      { from, to, opts }
 *   POST /api/refresh       { refreshToken, opts }
 *   GET  /api/trip?id=
 *
 * Security: every /api/* request needs `Authorization: Bearer $GATEWAY_TOKEN`.
 * Defensive: limited concurrency, in-flight de-duplication, short TTL cache,
 * and it never logs tokens or full upstream responses.
 */
import http from "node:http";
import { createClient } from "db-vendo-client";

const PORT = Number(process.env.PORT || 3009);
const TOKEN = process.env.GATEWAY_TOKEN || "";
const PROFILE = (process.env.DB_PROFILE || "db").toLowerCase();
const USER_AGENT = process.env.USER_AGENT || "bahn-finder-db-gateway";
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 3);

if (!TOKEN) {
  console.error("[gateway] refusing to start: GATEWAY_TOKEN is not set");
  process.exit(1);
}

const { profile } = await import(`db-vendo-client/p/${PROFILE}/index.js`);
const client = createClient(profile, USER_AGENT);

// ---- tiny TTL cache (per kind) ----
const TTL = {
  locations: 30 * 24 * 60 * 60 * 1000,
  journeys: 20 * 60 * 1000,
  refresh: 45 * 60 * 1000,
  trip: 6 * 60 * 60 * 1000,
};
const cache = new Map(); // key -> { value, expires }
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return e.value;
}
function cacheSet(key, value, ttl) {
  cache.set(key, { value, expires: Date.now() + ttl });
}

// ---- concurrency gate + in-flight dedup ----
let active = 0;
const queue = [];
const inflight = new Map();
function runGated(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          const next = queue.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENCY) task();
    else queue.push(task);
  });
}
function dedup(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = runGated(fn).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ---- helpers ----
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}
function authed(req) {
  const h = req.headers["authorization"] || "";
  return h === `Bearer ${TOKEN}`;
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}
function reviveOpts(opts = {}) {
  const o = { ...opts };
  if (o.departure) o.departure = new Date(o.departure);
  if (o.arrival) o.arrival = new Date(o.arrival);
  return o;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/health") {
    return send(res, 200, { ok: true, profile: PROFILE, ts: Date.now() });
  }

  if (!path.startsWith("/api/")) return send(res, 404, { error: "not found" });
  if (!authed(req)) return send(res, 401, { error: "unauthorized" });

  try {
    if (path === "/api/locations" && req.method === "GET") {
      const query = url.searchParams.get("query") || "";
      const results = Number(url.searchParams.get("results") || 8);
      if (query.length < 2) return send(res, 200, { locations: [] });
      const key = `loc:${query}:${results}`;
      const cached = cacheGet(key);
      if (cached) return send(res, 200, { locations: cached });
      const locations = await dedup(key, () =>
        client.locations(query, { results, fuzzy: true, addresses: true, poi: true }),
      );
      cacheSet(key, locations, TTL.locations);
      return send(res, 200, { locations });
    }

    if (path === "/api/journeys" && req.method === "POST") {
      const { from, to, opts } = await readBody(req);
      if (!from || !to) return send(res, 400, { error: "from/to required" });
      const o = reviveOpts(opts);
      const key = `jny:${from}:${to}:${o.departure?.toISOString?.() || ""}:${o.via || ""}:${o.results || ""}`;
      const cached = cacheGet(key);
      if (cached) return send(res, 200, cached);
      // db-vendo-client treats departure and arrival as mutually exclusive, so
      // only ever pass one (departure takes precedence) and omit empty keys.
      const jopts = {
        results: o.results ?? 5,
        tickets: o.tickets ?? true,
        stopovers: o.stopovers ?? true,
        remarks: false,
        polylines: false,
      };
      if (o.departure) jopts.departure = o.departure;
      else if (o.arrival) jopts.arrival = o.arrival;
      if (o.via) jopts.via = o.via;
      if (typeof o.transfers === "number") jopts.transfers = o.transfers;
      if (typeof o.transferTime === "number") jopts.transferTime = o.transferTime;
      if (o.products) jopts.products = o.products;
      const result = await dedup(key, () => client.journeys(from, to, jopts));
      cacheSet(key, result, TTL.journeys);
      return send(res, 200, result);
    }

    if (path === "/api/refresh" && req.method === "POST") {
      const { refreshToken, opts } = await readBody(req);
      if (!refreshToken) return send(res, 400, { error: "refreshToken required" });
      const key = `ref:${refreshToken}`;
      const cached = cacheGet(key);
      if (cached) return send(res, 200, { journey: cached });
      const journey = await dedup(key, () =>
        client.refreshJourney(refreshToken, {
          tickets: opts?.tickets ?? true,
          stopovers: opts?.stopovers ?? true,
          remarks: false,
          polylines: false,
        }),
      );
      cacheSet(key, journey, TTL.refresh);
      return send(res, 200, { journey });
    }

    if (path === "/api/trip" && req.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return send(res, 400, { error: "id required" });
      const key = `trip:${id}`;
      const cached = cacheGet(key);
      if (cached) return send(res, 200, cached);
      const trip = await dedup(key, () => client.trip(id, { stopovers: true }));
      const payload = { trip };
      cacheSet(key, payload, TTL.trip);
      return send(res, 200, payload);
    }

    return send(res, 404, { error: "not found" });
  } catch (err) {
    // Never leak upstream payloads/tokens — just a short status.
    const status = err?.statusCode || err?.status || 502;
    console.error(`[gateway] ${req.method} ${path} -> error ${status}: ${err?.message || "?"}`);
    return send(res, 502, { error: "upstream error", status });
  }
});

server.listen(PORT, () => {
  console.log(`[gateway] listening on :${PORT} (profile=${PROFILE}, concurrency=${MAX_CONCURRENCY})`);
});
