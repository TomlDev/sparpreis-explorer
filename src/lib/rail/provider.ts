import { pricingMode, routingProviderName } from "@/lib/config";
import { DbGatewayProvider } from "./dbGateway";
import { DbRestProvider } from "./dbRest";
import { DbVendoProvider } from "./dbVendo";
import { MockProvider } from "./mock";
import { MotisProvider } from "./motis";
import { getLimiter, type LimiterStatus } from "./rateLimiter";
import type { RailProvider } from "./types";

let routing: RailProvider | null = null;
let pricing: RailProvider | null | undefined = undefined;

/** Timetable / routing / graph provider (MOTIS by default). Always present. */
export function getRoutingProvider(): RailProvider {
  if (routing) return routing;
  routing = routingProviderName() === "mock" ? new MockProvider() : new MotisProvider();
  return routing;
}

/** Pricing provider (Sparpreis/ticket). May be null when pricing is "off" or a
 *  gateway is selected but not configured — the app then degrades to
 *  schedule-only results. */
export function getPricingProvider(): RailProvider | null {
  if (pricing !== undefined) return pricing;
  switch (pricingMode()) {
    case "mock":
      pricing = new MockProvider();
      break;
    case "direct":
      pricing = new DbVendoProvider();
      break;
    case "dbrest":
      pricing = new DbRestProvider();
      break;
    case "gateway":
      pricing = DbGatewayProvider.isConfigured() ? new DbGatewayProvider() : null;
      break;
    default:
      pricing = null;
  }
  return pricing;
}

/** Back-compat alias used by simple lookups (autocomplete) → routing provider. */
export function getProvider(): RailProvider {
  return getRoutingProvider();
}

export interface ProviderStatuses {
  routing: LimiterStatus & { name: string };
  pricing: (LimiterStatus & { name: string }) | null;
  pricingMode: string;
  priceCheckAvailable: boolean;
}

export function providerStatuses(): ProviderStatuses {
  const r = getRoutingProvider();
  const p = getPricingProvider();
  return {
    routing: { name: r.name, ...getLimiter(r.name).status() },
    pricing: p ? { name: p.name, ...getLimiter(p.name).status() } : null,
    pricingMode: pricingMode(),
    priceCheckAvailable: !!p && (p ? getLimiter(p.name).status().reachable : false),
  };
}

/** Legacy single-status shape (kept for the /api/stats compatibility). */
export function providerStatus(): LimiterStatus & { provider: string } {
  const r = getRoutingProvider();
  return { provider: r.name, ...getLimiter(r.name).status() };
}

/** Reset memoized providers (tests / after env change). */
export function resetProviders(): void {
  routing = null;
  pricing = undefined;
}

export type { RailProvider };
