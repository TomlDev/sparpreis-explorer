import { describe, expect, it } from "vitest";
import type { TripLeg } from "@/db/schema";
import { tripTicketCover } from "@/lib/trips/ticketCover";

const leg = (product: string, fromName: string, toName: string, o: Partial<TripLeg> = {}): TripLeg => ({
  product,
  lineName: product,
  fromName,
  toName,
  plannedDeparture: null,
  plannedArrival: null,
  ...o,
});
const walk = (a: string, b: string): TripLeg => ({ fromName: a, toName: b, plannedDeparture: null, plannedArrival: null, isWalking: true });

describe("Was deckt das Ticket ab?", () => {
  const trip = [
    leg("tram", "Erle Krankenhaus, Bochum", "Hauptbahnhof, Bochum"),
    walk("Hauptbahnhof, Bochum", "Bochum Hbf"),
    leg("suburban", "Bochum Hbf", "Essen Hbf"),
    leg("nationalExpress", "Essen Hbf", "Offenburg"),
    leg("regional", "Offenburg", "Triberg"),
    leg("bus", "Triberg Bahnhof", "Marktplatz, Triberg"),
  ];

  it("City-Ticket am Start: die Straßenbahn in der Stadt ist drin, der Bus am Ziel nicht", () => {
    const c = tripTicketCover(trip, { from: "Bochum+City", to: "Triberg" })!;
    expect(c.legs).toEqual(["city", "walk", "in", "in", "in", "out"]);
    expect(c.cityFrom).toBe("Bochum");
  });

  it("ohne City-Ticket: Straßenbahn davor nicht im Ticket", () => {
    expect(tripTicketCover(trip, { from: "Bochum Hbf", to: "Triberg" })!.legs).toEqual(["out", "walk", "in", "in", "in", "out"]);
  });

  it("„Gilt nur für“ ab einem Zwischenhalt: der Zug davor ist nicht drin", () => {
    expect(tripTicketCover(trip, { from: "Essen Hbf", to: "Triberg" })!.legs.slice(2, 4)).toEqual(["out", "in"]);
  });

  it("ohne passenden Halt: unbekannt", () => {
    expect(tripTicketCover(trip, { from: "Köln Hbf", to: "Triberg" })).toBeNull();
    expect(tripTicketCover(trip, null)).toBeNull();
  });
});
