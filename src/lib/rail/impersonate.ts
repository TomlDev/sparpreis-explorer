import { spawn } from "node:child_process";
import path from "node:path";
import { dlog } from "@/lib/log";

/**
 * Bridges db-vendo-client's HTTP layer to a TLS-impersonating transport
 * (curl_cffi via scripts/db_impersonate.py). DB's Akamai edge blocks Node's TLS
 * fingerprint (OPS_BLOCKED / HTTP 452) on every IP; a browser TLS fingerprint
 * gets through. We keep db-vendo-client for request formatting + response
 * parsing and only swap the network call.
 */

interface ImpersonateRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  impersonate?: string;
  timeout?: number;
}
interface ImpersonateResponse {
  status: number;
  body?: string;
  error?: string;
}

function pythonBin(): string {
  return process.env.DB_IMPERSONATE_PYTHON || "python3";
}

let healthCache: { value: { ok: boolean; error?: string }; at: number } | null = null;

/** Checks that the Python impersonation helper's dependency (curl_cffi) is
 *  importable. Result is cached for 60s to avoid spawning on every health hit. */
export function impersonateHealth(): Promise<{ ok: boolean; error?: string }> {
  if (healthCache && Date.now() - healthCache.at < 60_000) {
    return Promise.resolve(healthCache.value);
  }
  return new Promise((resolve) => {
    const finish = (value: { ok: boolean; error?: string }) => {
      healthCache = { value, at: Date.now() };
      resolve(value);
    };
    const child = spawn(/*turbopackIgnore: true*/ pythonBin(), ["-c", "import curl_cffi"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ ok: false, error: (e as Error).message }));
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true });
      else finish({ ok: false, error: err.trim() || `exit ${code}` });
    });
  });
}

export function callImpersonate(req: ImpersonateRequest): Promise<ImpersonateResponse> {
  return new Promise((resolve, reject) => {
    const script = path.join(/*turbopackIgnore: true*/ process.cwd(), "scripts", "db_impersonate.py");
    const child = spawn(/*turbopackIgnore: true*/ pythonBin(), [script], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const started = Date.now();
    const shortUrl = req.url.replace(/^https?:\/\/[^/]+/, "");
    const to = setTimeout(() => child.kill("SIGKILL"), (req.timeout ?? 30) * 1000 + 5000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(to);
      dlog("db", `${req.method} ${shortUrl} -> spawn error`, { err: (e as Error).message });
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(to);
      try {
        const parsed = JSON.parse(out) as ImpersonateResponse;
        dlog("db", `${req.method} ${shortUrl} -> ${parsed.status} (${Date.now() - started}ms)`);
        resolve(parsed);
      } catch {
        dlog("db", `${req.method} ${shortUrl} -> bad output`, { out: out.slice(0, 120), err: err.slice(0, 120) });
        reject(new Error(`impersonate helper output invalid: ${out.slice(0, 200)} ${err.slice(0, 200)}`));
      }
    });
    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}

type Ctx = {
  profile: {
    transformReqBody: (ctx: Ctx, body: unknown) => unknown;
    transformReq: (ctx: Ctx, opts: Record<string, unknown>) => Record<string, unknown>;
    defaultLanguage?: string;
  };
  opt: { language?: string };
};

interface ReqData {
  endpoint: string;
  method: string;
  body?: unknown;
  headers?: Record<string, string>;
  path?: string;
  query?: Record<string, string> | null;
}

/**
 * Drop-in replacement for db-vendo-client's `profile.request`. Mirrors the
 * original (transformReqBody/transformReq + header defaults + error check) but
 * routes the actual HTTP call through the impersonating transport.
 */
/**
 * Query string the way db-vendo-client's own request does it (qs, arrayFormat
 * "brackets", values encoded): undefined/null are left out instead of being
 * sent as "undefined", arrays become `key[]=a&key[]=b` (bahn.de rejects
 * "a,b" for e.g. verkehrsmittel with HTTP 422).
 */
export function queryString(query: Record<string, unknown> | null | undefined): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) parts.push(`${k}[]=${encodeURIComponent(String(x))}`);
    else parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

export function makeImpersonatingRequest(impersonate = process.env.DB_IMPERSONATE_TARGET || "chrome") {
  return async function request(ctx: Ctx, userAgent: string, reqData: ReqData) {
    const { profile, opt } = ctx;
    const endpoint = reqData.endpoint;

    const rawReqBody = profile.transformReqBody(ctx, reqData.body);
    const reqOptions = profile.transformReq(ctx, {
      method: reqData.method,
      body: JSON.stringify(rawReqBody),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": opt.language || profile.defaultLanguage || "en",
        "user-agent": userAgent,
        ...(reqData.headers || {}),
      },
      query: reqData.query,
    }) as { method: string; body?: string; headers: Record<string, string>; query?: Record<string, string> | null };

    let url = endpoint + (reqData.path || "");
    const qs = queryString(reqOptions.query);
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;

    const res = await callImpersonate({
      method: reqOptions.method,
      url,
      headers: reqOptions.headers,
      body: reqOptions.body ?? null,
      impersonate,
    });

    if (res.status === 0) {
      throw new Error(`impersonate transport error: ${res.error || "unknown"}`);
    }
    if (res.status < 200 || res.status >= 300) {
      if (process.env.DEBUG_DB_BODY) console.error(`[db-body] ${res.status} ${url}\n${(res.body || "").slice(0, 800)}`);
      const err = new Error(`HTTP ${res.status}`) as Error & { statusCode?: number };
      err.statusCode = res.status;
      throw err;
    }
    const body = JSON.parse(res.body || "{}");
    // Mirror db-vendo-client's error surface (fehlerNachricht / errors).
    if (body && (body.fehlerNachricht || body.errors)) {
      const msg = body.fehlerNachricht?.ueberschrift || body.fehlerNachricht?.text || "DB API error";
      const e = new Error(msg) as Error & { code?: string };
      e.code = body.fehlerNachricht?.code;
      throw e;
    }
    return { res: body, common: {} };
  };
}
