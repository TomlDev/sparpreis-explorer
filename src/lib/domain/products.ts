import { LONG_DISTANCE_PRODUCTS, PRODUCT_LABELS } from "@/lib/config";
import type { NormLeg } from "@/lib/rail/types";

/** Is this product a long-distance (Fernverkehr) train? ICE / IC / EC. */
export function isLongDistanceProduct(product?: string | null): boolean {
  if (!product) return false;
  return LONG_DISTANCE_PRODUCTS.has(product);
}

/** Is this leg an actual Fernverkehr ride (not walking, not regional)? */
export function isLongDistanceLeg(leg: NormLeg): boolean {
  return !leg.isWalking && isLongDistanceProduct(leg.product);
}

const EXTRA_PRODUCT_LABELS: Record<string, string> = {
  flixtrain: "FlixTrain",
};

export function productLabel(product?: string | null): string {
  if (!product) return "Fußweg";
  return PRODUCT_LABELS[product] ?? EXTRA_PRODUCT_LABELS[product] ?? product;
}

/** Compact vehicle chain like "Bus → RE → ICE → RE → Bus". Walking/transfer
 *  legs are omitted so the ride sequence stays readable (MOTIS inserts a walk
 *  leg at every station change). */
export function legChainLabel(legs: NormLeg[]): string {
  const chain = legs.filter((l) => !l.isWalking).map((l) => productLabel(l.product));
  return chain.length ? chain.join(" → ") : "Fußweg";
}

/** Number of intermediate stops a leg passes (excludes its own endpoints). */
export function legStopCount(leg: NormLeg): number {
  if (!leg.stopovers || leg.stopovers.length < 2) return 0;
  return Math.max(0, leg.stopovers.length - 2);
}
