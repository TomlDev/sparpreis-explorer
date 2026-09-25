import {
  type NormDeparture,
  type NormJourney,
  type NormJourneysResult,
  type NormLeg,
  type NormLocation,
  type NormTrip,
  type RailProvider,
  type SearchJourneysOptions,
} from "./types";

/**
 * Deterministic offline provider. Models an example NRW ↔ Black Forest
 * corridor (Bochum ↔ Triberg) closely enough to exercise the whole pipeline (FV detection, ticket
 * coverage green/yellow/red, ranking, learning) without any network access.
 * Used for RAIL_PROVIDER=mock and by the unit tests.
 */

const STATIONS: NormLocation[] = [
  { id: "mock:start-stop", name: "Bochum-Langendreer", type: "stop", lat: 51.476, lng: 7.325 },
  { id: "mock:start-hbf", name: "Bochum Hbf", type: "station", lat: 51.478, lng: 7.223 },
  { id: "mock:do", name: "Dortmund Hbf", type: "station", lat: 51.518, lng: 7.459 },
  { id: "mock:hamm", name: "Hamm (Westf) Hbf", type: "station", lat: 51.678, lng: 7.809 },
  { id: "mock:koeln", name: "Köln Hbf", type: "station", lat: 50.943, lng: 6.958 },
  { id: "mock:offenburg", name: "Offenburg", type: "station", lat: 48.474, lng: 7.947 },
  { id: "mock:villingen", name: "Villingen(Schwarzw)", type: "station", lat: 48.06, lng: 8.46 },
  { id: "mock:dest", name: "Triberg", type: "stop", lat: 48.131, lng: 8.232 },
];

function iso(base: Date, addMin: number): string {
  return new Date(base.getTime() + addMin * 60_000).toISOString();
}

function leg(
  product: string | null,
  lineName: string | null,
  trainNumber: string | null,
  fromName: string,
  fromId: string,
  toName: string,
  toId: string,
  base: Date,
  depMin: number,
  arrMin: number,
): NormLeg {
  return {
    product: product ?? undefined,
    lineName: lineName ?? undefined,
    trainNumber: trainNumber ?? undefined,
    origin: { id: fromId, name: fromName },
    destination: { id: toId, name: toName },
    plannedDeparture: iso(base, depMin),
    plannedArrival: iso(base, arrMin),
    departure: iso(base, depMin),
    arrival: iso(base, arrMin),
    isWalking: product === null,
    stopovers: [],
  };
}

const tokenStore = new Map<string, NormJourney>();

function baseTimeFor(opts: SearchJourneysOptions): Date {
  const t = opts.departure ?? opts.arrival ?? new Date();
  // Normalize to a whole hour so results are stable.
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d;
}

export class MockProvider implements RailProvider {
  readonly name = "mock";

  async searchLocations(query: string): Promise<NormLocation[]> {
    const q = query.toLowerCase();
    const hits = STATIONS.filter((s) => s.name.toLowerCase().includes(q));
    return hits.length ? hits : STATIONS.slice(0, 3);
  }

  async searchJourneys(
    from: string,
    to: string,
    opts: SearchJourneysOptions,
  ): Promise<NormJourneysResult> {
    const base = baseTimeFor(opts);
    const fromStation = STATIONS.find((s) => s.id === from);
    const toStation = STATIONS.find((s) => s.id === to);
    const fromName = fromStation?.name ?? "Start";
    const toName = toStation?.name ?? "Ziel";
    const journeys: NormJourney[] = [];

    // 1) Fast, expensive: big ICE share.
    journeys.push(
      makeJourney(
        [
          leg("regional", "RB 43", "43", fromName, from, "Dortmund Hbf", "mock:do", base, 0, 25),
          leg("nationalExpress", "ICE 512", "512", "Dortmund Hbf", "mock:do", "Offenburg", "mock:offenburg", base, 35, 275),
          leg("regional", "RB 41", "41", "Offenburg", "mock:offenburg", "Villingen(Schwarzw)", "mock:villingen", base, 290, 360),
          leg("bus", "Bus 7270", "7270", "Villingen(Schwarzw)", "mock:villingen", toName, to, base, 370, 405),
        ],
        89.9,
        true,
      ),
    );

    // 2) The pro-forma gem: tiny ICE segment Dortmund → Hamm, cheap, full ticket.
    journeys.push(
      makeJourney(
        [
          leg("regional", "RB 43", "43", fromName, from, "Dortmund Hbf", "mock:do", base, 5, 30),
          leg("nationalExpress", "ICE 612", "612", "Dortmund Hbf", "mock:do", "Hamm (Westf) Hbf", "mock:hamm", base, 40, 57),
          leg("regionalExpress", "RE 1", "1", "Hamm (Westf) Hbf", "mock:hamm", "Köln Hbf", "mock:koeln", base, 65, 185),
          leg("regionalExpress", "RE 2", "2", "Köln Hbf", "mock:koeln", "Villingen(Schwarzw)", "mock:villingen", base, 195, 395),
          leg("bus", "Bus 7270", "7270", "Villingen(Schwarzw)", "mock:villingen", toName, to, base, 405, 445),
        ],
        18.99,
        true,
      ),
    );

    // 3) Medium: short IC segment, full ticket.
    journeys.push(
      makeJourney(
        [
          leg("regionalExpress", "RE 2", "2", fromName, from, "Köln Hbf", "mock:koeln", base, 10, 95),
          leg("national", "IC 2013", "2013", "Köln Hbf", "mock:koeln", "Offenburg", "mock:offenburg", base, 105, 145),
          leg("regional", "RB 41", "41", "Offenburg", "mock:offenburg", "Villingen(Schwarzw)", "mock:villingen", base, 155, 225),
          leg("bus", "Bus 7270", "7270", "Villingen(Schwarzw)", "mock:villingen", toName, to, base, 235, 275),
        ],
        24.99,
        true,
      ),
    );

    // 4) Partial-coverage trap: price only covers Essen→Offenburg (red).
    journeys.push(
      makeJourney(
        [
          leg("regional", "RB 43", "43", fromName, from, "Dortmund Hbf", "mock:do", base, 0, 25),
          leg("nationalExpress", "ICE 512", "512", "Dortmund Hbf", "mock:do", "Offenburg", "mock:offenburg", base, 30, 270),
          leg("regional", "RB 41", "41", "Offenburg", "mock:offenburg", toName, to, base, 280, 360),
        ],
        15.0,
        false,
        { fromName: "Dortmund Hbf", toName: "Offenburg" },
      ),
    );

    return { journeys, earlierRef: "earlier", laterRef: "later" };
  }

  async refreshJourney(refreshToken: string): Promise<NormJourney> {
    const j = tokenStore.get(refreshToken);
    if (j) return j;
    throw new Error("unknown refresh token");
  }

  async getTrip(id: string): Promise<NormTrip> {
    return {
      id,
      product: "nationalExpress",
      lineName: "ICE 612",
      trainNumber: "612",
      stops: [
        { id: "mock:muenchen", name: "München Hbf" },
        { id: "mock:do", name: "Dortmund Hbf" },
        { id: "mock:hamm", name: "Hamm (Westf) Hbf" },
        { id: "mock:hannover", name: "Hannover Hbf" },
      ],
    };
  }

  async getDepartures(): Promise<NormDeparture[]> {
    return [
      {
        tripId: "mock:trip:612",
        product: "nationalExpress",
        lineName: "ICE 612",
        trainNumber: "612",
        direction: "Hamburg",
        plannedWhen: new Date().toISOString(),
      },
    ];
  }
}

function makeJourney(
  legs: NormLeg[],
  amount: number,
  fullRoute: boolean,
  offer?: { fromName: string; toName: string },
): NormJourney {
  const token = `mock:${legs.map((l) => l.trainNumber ?? "w").join("-")}:${amount}`;
  const j: NormJourney = {
    legs,
    refreshToken: token,
    price: {
      amount,
      currency: "EUR",
      fullRoute,
      hint: fullRoute ? null : "nur Teilstrecke",
    },
    ticketInfo: offer
      ? { fromName: offer.fromName, toName: offer.toName, klasse: 2 }
      : null,
  };
  tokenStore.set(token, j);
  return j;
}
