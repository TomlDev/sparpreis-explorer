/**
 * Brute-force protection for the login, keyed by the client IP as seen by the
 * ONE trusted reverse proxy (Apache on this host). Apache APPENDS the real peer
 * address to X-Forwarded-For, so only the LAST entry is trustworthy — earlier
 * entries are whatever the client chose to send (spoofable). The app listens
 * on 127.0.0.1 only, so every request comes through that proxy.
 *
 * Deliberately no global lockout: it would let anyone lock the owner out with
 * a few bad requests, and per-IP limits already make guessing a strong
 * password hopeless.
 */
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_PER_IP = 10;
const MAX_TRACKED = 10_000;

/** Client IP from the trusted proxy's view (last X-Forwarded-For entry). */
export function clientIp(headers: Headers): string {
  const parts = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "direct";
}

interface Entry {
  count: number;
  resetAt: number;
}

export class LoginRateLimiter {
  private failures = new Map<string, Entry>();

  constructor(
    private readonly maxFailed = MAX_FAILED_PER_IP,
    private readonly windowMs = WINDOW_MS,
  ) {}

  isBlocked(ip: string, now = Date.now()): boolean {
    const e = this.failures.get(ip);
    if (!e) return false;
    if (now > e.resetAt) {
      this.failures.delete(ip);
      return false;
    }
    return e.count >= this.maxFailed;
  }

  recordFailure(ip: string, now = Date.now()): void {
    const e = this.failures.get(ip);
    if (e && now <= e.resetAt) e.count += 1;
    else this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    if (this.failures.size > MAX_TRACKED) this.prune(now);
  }

  recordSuccess(ip: string): void {
    this.failures.delete(ip);
  }

  private prune(now: number): void {
    for (const [ip, e] of this.failures) if (now > e.resetAt) this.failures.delete(ip);
  }
}

export const loginLimiter = new LoginRateLimiter();
