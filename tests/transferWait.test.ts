import { describe, expect, it } from "vitest";
import { waitClass, walkWait, type WaitLeg } from "@/lib/domain/transferWait";

const t = (hhmm: string) => `2026-10-18T${hhmm}:00+02:00`;
const ride = (dep: string, arr: string): WaitLeg => ({ isWalking: false, plannedDeparture: t(dep), plannedArrival: t(arr) });
const walk = (dep: string, arr: string): WaitLeg => ({ isWalking: true, plannedDeparture: t(dep), plannedArrival: t(arr) });

describe("Umstiegszeit im Reiseverlauf", () => {
  it("zeigt die echte Umstiegszeit inkl. Fußweg (Tram an 06:52, 5 min Fußweg, ab 06:59 → 7 min)", () => {
    const legs = [ride("06:40", "06:52"), walk("06:52", "06:57"), ride("06:59", "08:00")];
    expect(walkWait(legs, 1)).toEqual({ min: 7, transfer: true });
  });

  it("färbt ≤5 min fett rot, 6–7 min fett dunkelrot, sonst neutral", () => {
    expect(waitClass({ min: 5, transfer: true })).toBe("font-bold text-transfer-critical");
    expect(waitClass({ min: 0, transfer: true })).toBe("font-bold text-transfer-critical");
    expect(waitClass({ min: 6, transfer: true })).toBe("font-bold text-transfer-tight");
    expect(waitClass({ min: 7, transfer: true })).toBe("font-bold text-transfer-tight");
    expect(waitClass({ min: 8, transfer: true })).toBe("font-normal text-muted-foreground");
  });

  it("Fußweg vor der ersten Fahrt ist kein Umstieg: Puffer ohne Warnfarbe", () => {
    const legs = [walk("06:40", "06:45"), ride("06:48", "07:30")];
    const w = walkWait(legs, 0);
    expect(w).toEqual({ min: 3, transfer: false });
    expect(waitClass(w!)).toBe("font-normal text-muted-foreground");
  });

  it("mehrere Fußwege hintereinander: einmal anzeigen, über alle Fußwege gerechnet", () => {
    const legs = [ride("06:00", "06:50"), walk("06:50", "06:53"), walk("06:53", "06:56"), ride("07:01", "08:00")];
    expect(walkWait(legs, 1)).toEqual({ min: 11, transfer: true });
    expect(walkWait(legs, 2)).toBeNull();
  });

  it("Fußweg zum Ziel am Ende: keine Wartezeit", () => {
    const legs = [ride("06:00", "06:50"), walk("06:50", "06:55")];
    expect(walkWait(legs, 1)).toBeNull();
  });
});
