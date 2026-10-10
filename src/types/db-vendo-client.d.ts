declare module "db-vendo-client" {
  export function createClient(profile: unknown, userAgent: string, opt?: { enrichStations?: boolean }): unknown;
  export function createBusinessClient(profile: unknown, userAgent: string): unknown;
  export function loadEnrichedStationData(profile: unknown): unknown;
}

declare module "db-vendo-client/p/db/index.js" {
  export const profile: unknown;
}

declare module "db-vendo-client/p/dbnav/index.js" {
  export const profile: unknown;
}

declare module "db-vendo-client/p/dbweb/index.js" {
  export const profile: unknown;
}
