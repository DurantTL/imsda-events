import { describe, expect, it } from "vitest";
import {
  decideEventCapacity,
  evaluateEventRegistrationAdmission,
  evaluateEventRegistrationPhase,
} from "@/modules/events/lifecycle";

const openEvent = {
  isPublished: true,
  timezone: "America/Chicago",
  registrationOpensOn: "2026-08-01",
  registrationClosesOn: "2026-09-17",
  waitlistEnabled: true,
  capacity: 2,
};

describe("event registration lifecycle", () => {
  it("uses the event-local calendar date for opening and keeps the closing date inclusive", () => {
    expect(evaluateEventRegistrationPhase(openEvent, new Date("2026-08-01T04:59:59.999Z"))).toBe("UPCOMING");
    expect(evaluateEventRegistrationPhase(openEvent, new Date("2026-08-01T05:00:00.000Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(openEvent, new Date("2026-09-18T04:59:59.999Z"))).toBe("OPEN");
    expect(evaluateEventRegistrationPhase(openEvent, new Date("2026-09-18T05:00:00.000Z"))).toBe("CLOSED");
  });

  it("does not expose an unpublished event as upcoming or open", () => {
    expect(evaluateEventRegistrationPhase(
      { ...openEvent, isPublished: false },
      new Date("2026-08-15T12:00:00.000Z"),
    )).toBe("DRAFT");
  });

  it("distinguishes registration, waitlist, and full capacity decisions", () => {
    expect(decideEventCapacity({
      capacity: 2,
      occupied: 1,
      requested: 1,
      waitlistEnabled: true,
    })).toBe("REGISTER");
    expect(decideEventCapacity({
      capacity: 2,
      occupied: 1,
      requested: 2,
      waitlistEnabled: true,
    })).toBe("WAITLIST");
    expect(decideEventCapacity({
      capacity: 2,
      occupied: 2,
      requested: 1,
      waitlistEnabled: false,
    })).toBe("FULL");
  });

  it("combines phase and capacity without offering admission outside the open window", () => {
    expect(evaluateEventRegistrationAdmission(
      openEvent,
      { occupied: 2, requested: 1 },
      new Date("2026-08-15T12:00:00.000Z"),
    )).toEqual({
      phase: "OPEN",
      capacityDecision: "WAITLIST",
      remainingSpots: 0,
    });

    expect(evaluateEventRegistrationAdmission(
      openEvent,
      { occupied: 0, requested: 1 },
      new Date("2026-07-15T12:00:00.000Z"),
    )).toEqual({
      phase: "UPCOMING",
      capacityDecision: null,
      remainingSpots: 2,
    });
  });

  it("keeps unlimited events open regardless of occupied count", () => {
    expect(evaluateEventRegistrationAdmission(
      { ...openEvent, capacity: null },
      { occupied: 1000, requested: 50 },
      new Date("2026-08-15T12:00:00.000Z"),
    )).toEqual({
      phase: "OPEN",
      capacityDecision: "REGISTER",
      remainingSpots: null,
    });
  });
});
