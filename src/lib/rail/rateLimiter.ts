import { RATE_LIMIT } from "@/lib/config";
import { dlog } from "@/lib/log";
import { ProviderError } from "./types";

/**
 * A defensive gate in front of the (unofficial) DB endpoints:
 *  - limited concurrency + minimum spacing between requests
 *  - in-flight request de-duplication (same key => one real request shared)
 *  - retry with exponential backoff + jitter
 *  - a circuit breaker that pauses the provider after repeated hard failures
 *
 * See spec: "API-schonendes Verhalten" and "Provider automatisch mit Backoff
 * pausieren".
 */

type Task<T> = () => Promise<T>;

interface QueueItem {
  run: () => Promise<void>;
}

export interface LimiterStatus {
  reachable: boolean;
  pausedUntil: number | null;
  consecutiveFailures: number;
  lastErrorAt: number | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  inFlight: number;
  queued: number;
}

export class RateLimiter {
  private queue: QueueItem[] = [];
  private active = 0;
  private lastStart = 0;
  private inflight = new Map<string, Promise<unknown>>();

  private consecutiveFailures = 0;
  private pausedUntil: number | null = null;
  private lastErrorAt: number | null = null;
  private lastError: string | null = null;
  private lastSuccessAt: number | null = null;

  status(): LimiterStatus {
    const paused = this.pausedUntil != null && this.pausedUntil > Date.now();
    return {
      reachable: !paused && this.consecutiveFailures < RATE_LIMIT.circuitThreshold,
      pausedUntil: paused ? this.pausedUntil : null,
      consecutiveFailures: this.consecutiveFailures,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      inFlight: this.active,
      queued: this.queue.length,
    };
  }

  isPaused(): boolean {
    return this.pausedUntil != null && this.pausedUntil > Date.now();
  }

  /** De-duplicate identical concurrent requests by key. */
  dedupe<T>(key: string, task: Task<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const p = this.schedule(task).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }

  /** Schedule a task through the concurrency/backoff gate. */
  schedule<T>(task: Task<T>): Promise<T> {
    if (this.isPaused()) {
      return Promise.reject(
        new ProviderError("provider paused (circuit open)", { isBlocked: true }),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        run: async () => {
          try {
            const result = await this.withRetry(task);
            this.onSuccess();
            resolve(result);
          } catch (err) {
            this.onFailure(err);
            reject(err);
          }
        },
      };
      this.queue.push(item);
      this.pump();
    });
  }

  private pump() {
    if (this.active >= RATE_LIMIT.concurrency) return;
    const item = this.queue.shift();
    if (!item) return;

    const since = Date.now() - this.lastStart;
    const wait = Math.max(0, RATE_LIMIT.minSpacingMs - since);
    this.active++;
    this.lastStart = Date.now() + wait;

    const launch = () => {
      item
        .run()
        .finally(() => {
          this.active--;
          this.pump();
        });
      // Allow more items if concurrency permits.
      if (this.active < RATE_LIMIT.concurrency) this.pump();
    };

    if (wait > 0) setTimeout(launch, wait);
    else launch();
  }

  private async withRetry<T>(task: Task<T>): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await task();
      } catch (err) {
        attempt++;
        const pe = normalizeError(err);
        // Retry rate limits, 5xx, network errors, flaky 404s (e.g. Transitous
        // load-balancer nodes), and anything explicitly flagged retryable.
        const retryable =
          pe.retryable || pe.isRateLimit || (pe.status ?? 0) >= 500 || pe.status == null;
        if (!retryable || attempt > RATE_LIMIT.maxRetries) {
          dlog("ratelimit", `giving up after ${attempt} attempt(s)`, {
            status: pe.status,
            msg: pe.message,
          });
          throw pe;
        }
        const backoff = Math.min(
          RATE_LIMIT.maxBackoffMs,
          RATE_LIMIT.baseBackoffMs * 2 ** (attempt - 1),
        );
        const jitter = backoff * 0.3 * Math.random();
        dlog("ratelimit", `retry ${attempt} in ${Math.round(backoff)}ms`, {
          status: pe.status,
        });
        await sleep(backoff + jitter);
      }
    }
  }

  private onSuccess() {
    this.consecutiveFailures = 0;
    this.pausedUntil = null;
    this.lastSuccessAt = Date.now();
  }

  private onFailure(err: unknown) {
    const pe = normalizeError(err);
    this.consecutiveFailures++;
    this.lastErrorAt = Date.now();
    this.lastError = pe.message;
    if (this.consecutiveFailures >= RATE_LIMIT.circuitThreshold) {
      this.pausedUntil = Date.now() + RATE_LIMIT.circuitCooldownMs;
      dlog("ratelimit", `circuit OPEN for ${RATE_LIMIT.circuitCooldownMs}ms`, {
        consecutiveFailures: this.consecutiveFailures,
        lastError: pe.message,
      });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function normalizeError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const anyErr = err as {
    statusCode?: number;
    status?: number;
    isHafasError?: boolean;
    message?: string;
    code?: string;
  };
  const status = anyErr?.statusCode ?? anyErr?.status;
  const msg = anyErr?.message || String(err);
  const isRateLimit = status === 429 || /rate.?limit|too many/i.test(msg);
  const isBlocked =
    status === 403 ||
    status === 401 ||
    /forbidden|blocked|denied/i.test(msg);
  return new ProviderError(msg, { status, isRateLimit, isBlocked });
}

// One shared limiter per process (keyed by provider name).
const limiters = new Map<string, RateLimiter>();
export function getLimiter(provider: string): RateLimiter {
  let l = limiters.get(provider);
  if (!l) {
    l = new RateLimiter();
    limiters.set(provider, l);
  }
  return l;
}
