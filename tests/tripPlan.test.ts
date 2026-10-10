import { describe, expect, it } from "vitest";
import { competing, planStates, type PlanTrip } from "@/lib/trips/plan";

const trip = (id: string, dep: string, arr: string, o: Partial<PlanTrip> = {}): PlanTrip => ({
  id,
  date: "2026-11-20",
  originName: "Bochum Hbf",
  destName: "Triberg",
  plannedDeparture: `2026-11-20T${dep}:00+01:00`,
  plannedArrival: `2026-11-20T${arr}:00+01:00`,
  status: "planned",
  ...o,
});

describe("trip plan", () => {
  it("same day, same way → competing; return trip is not", () => {
    const out = trip("a", "08:00", "14:00");
    expect(competing(out, trip("b", "15:00", "21:00"))).toBe(true);
    expect(competing(out, trip("c", "16:00", "22:00", { originName: "Triberg", destName: "Bochum Hbf" }))).toBe(false);
    expect(competing(out, trip("d", "08:00", "14:00", { date: "2026-11-21" }))).toBe(false);
  });

  it("no mark → open; one taken → the other is skipped (implied)", () => {
    const a = trip("a", "08:00", "14:00");
    const b = trip("b", "15:00", "21:00");
    expect(planStates([a, b]).get("a")?.state).toBe("open");
    const s = planStates([{ ...a, plan: "take" }, b]);
    expect(s.get("a")).toMatchObject({ state: "take", implied: false });
    expect(s.get("b")).toMatchObject({ state: "skip", implied: true, rivals: ["a"] });
  });

  it("the rival marked skip or not started → this one is taken", () => {
    const a = trip("a", "08:00", "14:00", { status: "not_started" });
    const b = trip("b", "15:00", "21:00");
    expect(planStates([a, b]).get("b")?.state).toBe("take");
    expect(planStates([trip("x", "08:00", "14:00", { plan: "skip" }), b]).get("b")?.state).toBe("take");
  });

  it("a single trip without a mark has no plan state", () => {
    expect(planStates([trip("a", "08:00", "14:00")]).get("a")).toEqual({ state: null, implied: false, rivals: [] });
  });
});
