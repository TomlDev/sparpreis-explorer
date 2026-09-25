import { randomUUID } from "node:crypto";

export function newId(prefix = ""): string {
  return prefix ? `${prefix}_${randomUUID()}` : randomUUID();
}

export function now(): number {
  return Date.now();
}
