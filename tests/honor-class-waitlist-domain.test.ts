import { describe, expect, it } from "vitest";
import {
  holdsConflictingClass,
  offerExpiresAt,
  offerIsLive,
  placeInLine,
  planOffers,
  seatsFree,
  waitingNote,
} from "@/modules/honors/waitlist-domain";

const one = (id: string, sessionId: string | null, span: "SINGLE_SESSION" | "ALL_SESSIONS" = "SINGLE_SESSION") => ({ id, span, sessionId });

describe("class waitlist: seats and offers", () => {
  it("counts free seats as capacity less seats taken and less live offers, never below zero", () => {
    expect(seatsFree(10, 8, 1)).toBe(1);
    expect(seatsFree(10, 10, 0)).toBe(0);
    expect(seatsFree(10, 9, 2)).toBe(0);
    expect(seatsFree(10, 12, 0)).toBe(0);
  });

  it("treats an offer as live until the instant it runs out", () => {
    const now = new Date("2026-11-01T12:00:00Z");
    expect(offerIsLive({ status: "OFFERED", offerExpiresAt: new Date("2026-11-01T12:00:01Z") }, now)).toBe(true);
    expect(offerIsLive({ status: "OFFERED", offerExpiresAt: now }, now)).toBe(false);
    expect(offerIsLive({ status: "WAITING", offerExpiresAt: null }, now)).toBe(false);
    expect(offerIsLive({ status: "ACCEPTED", offerExpiresAt: new Date("2027-01-01T00:00:00Z") }, now)).toBe(false);
  });

  it("sets the expiry from the event's window in hours", () => {
    expect(offerExpiresAt(new Date("2026-11-01T12:00:00Z"), 36).toISOString()).toBe("2026-11-03T00:00:00.000Z");
  });

  it("numbers the place in line by join order, from 1", () => {
    expect(placeInLine([4, 9, 12], 4)).toBe(1);
    expect(placeInLine([4, 9, 12], 12)).toBe(3);
    expect(placeInLine([12, 4, 9], 9)).toBe(2);
  });
});

describe("class waitlist: a class the youth already has", () => {
  it("conflicts with any class in the same session, an all-sessions class, or the class itself", () => {
    expect(holdsConflictingClass(one("a", "s1"), [one("b", "s1")])).toBe(true);
    expect(holdsConflictingClass(one("a", "s1"), [one("b", "s2")])).toBe(false);
    expect(holdsConflictingClass(one("a", "s1"), [one("all", null, "ALL_SESSIONS")])).toBe(true);
    expect(holdsConflictingClass(one("all", null, "ALL_SESSIONS"), [one("b", "s2")])).toBe(true);
    expect(holdsConflictingClass(one("a", "s1"), [one("a", "s1")])).toBe(true);
    expect(holdsConflictingClass(one("a", "s1"), [])).toBe(false);
  });
});

describe("class waitlist: who is offered the free seats", () => {
  const candidate = (id: string, organizationId: string | null, skipReason: string | null = null) => ({ id, organizationId, skipReason });
  const base = { perClubLimit: null, clubSeats: new Map<string, number>(), clubLiveOffers: new Map<string, number>() };

  it("offers in the order given, one seat each", () => {
    const plan = planOffers({ ...base, freeSeats: 2, candidates: [candidate("w1", "c1"), candidate("w2", "c2"), candidate("w3", "c3")] });
    expect(plan.offered).toEqual(["w1", "w2"]);
    expect(plan.skipped).toEqual([]);
  });

  it("offers nothing when no seat is free", () => {
    expect(planOffers({ ...base, freeSeats: 0, candidates: [candidate("w1", "c1")] }).offered).toEqual([]);
  });

  it("skips someone who can't take a seat and offers the next, who is not skipped over later", () => {
    const plan = planOffers({
      ...base,
      freeSeats: 1,
      candidates: [candidate("w1", "c1", waitingNote("HOLDS_CLASS_IN_SESSION")), candidate("w2", "c2")],
    });
    expect(plan.offered).toEqual(["w2"]);
    expect(plan.skipped.map((row) => row.id)).toEqual(["w1"]);
  });

  it("counts a club's seats and live offers, but never its waitlist spots, toward its limit", () => {
    const plan = planOffers({
      freeSeats: 3,
      perClubLimit: 2,
      // The club holds one seat and one live offer: at the limit. Its other waitlisted youth are not counted.
      clubSeats: new Map([["c1", 1]]),
      clubLiveOffers: new Map([["c1", 1]]),
      candidates: [candidate("w1", "c1"), candidate("w2", "c1"), candidate("w3", "c2"), candidate("w4", "c2")],
    });
    expect(plan.offered).toEqual(["w3", "w4"]);
    expect(plan.skipped.map((row) => row.id)).toEqual(["w1", "w2"]);
  });

  it("stops a club at its limit within one pass", () => {
    const plan = planOffers({
      freeSeats: 3,
      perClubLimit: 1,
      clubSeats: new Map(),
      clubLiveOffers: new Map(),
      candidates: [candidate("w1", "c1"), candidate("w2", "c1"), candidate("w3", "c2")],
    });
    expect(plan.offered).toEqual(["w1", "w3"]);
  });

  it("has fixed, free-text-free notes for a youth who is waiting but won't be offered", () => {
    expect(waitingNote("DEADLINE_PASSED")).toMatch(/closed/);
    expect(waitingNote("NOT_ELIGIBLE")).toMatch(/keep their place/);
  });
});
