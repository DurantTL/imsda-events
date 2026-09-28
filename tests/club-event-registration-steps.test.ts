import { describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { clubEventRegistrationSteps, type ClubEventSummary } from "@/modules/club-registrations/repository";

/**
 * Club home's "What's next" (#478): a director should never wonder where to
 * register their club — an open club event gets a step here, worded to
 * match whether a draft is already in progress, and drops off once the
 * club is registered.
 */

function event(overrides: Partial<ClubEventSummary> & { id: string }): ClubEventSummary {
  return {
    name: "Fall Camporee",
    startsAt: "2026-11-06T15:00:00.000Z",
    endsAt: "2026-11-08T20:00:00.000Z",
    timezone: "America/New_York",
    location: "Camp Fictitious",
    phase: "OPEN",
    registrationClosesOn: null,
    available: true,
    problem: null,
    registration: null,
    draft: null,
    ...overrides,
  };
}

describe("clubEventRegistrationSteps (#478)", () => {
  it("adds a step for an open club event the club hasn't registered for, linking to it", () => {
    const steps = clubEventRegistrationSteps([event({ id: "evt-1" })], "/account/clubs/org-1");
    expect(steps).toEqual([
      { key: "evt-1", text: "Register for Fall Camporee.", href: "/account/clubs/org-1/events/evt-1", action: "Register" },
    ]);
  });

  it("mentions the registration deadline when the event has one", () => {
    const steps = clubEventRegistrationSteps(
      [event({ id: "evt-1", registrationClosesOn: "2026-10-15" })],
      "/account/clubs/org-1",
    );
    expect(steps[0].text).toBe("Register for Fall Camporee by October 15, 2026.");
  });

  it("offers to continue, not register, when a draft is already saved", () => {
    const steps = clubEventRegistrationSteps(
      [event({ id: "evt-1", draft: { updatedAt: "2026-10-01T00:00:00.000Z", selectedCount: 3 } })],
      "/account/clubs/org-1",
    );
    expect(steps[0]).toMatchObject({ text: "Finish registering for Fall Camporee.", action: "Continue" });
  });

  it("leaves out an event the club has already registered for", () => {
    const steps = clubEventRegistrationSteps(
      [event({ id: "evt-1", registration: { confirmationCode: "ABC123", status: "CONFIRMED", attendeeCount: 12, amountOwedCents: 0 } })],
      "/account/clubs/org-1",
    );
    expect(steps).toEqual([]);
  });

  it("leaves out an event that isn't available to clubs yet (no usable form)", () => {
    const steps = clubEventRegistrationSteps(
      [event({ id: "evt-1", available: false, problem: "The event has no published registration form yet." })],
      "/account/clubs/org-1",
    );
    expect(steps).toEqual([]);
  });

  it("leaves out an event whose registration window isn't open", () => {
    const upcoming = clubEventRegistrationSteps([event({ id: "evt-1", phase: "UPCOMING" })], "/account/clubs/org-1");
    const closed = clubEventRegistrationSteps([event({ id: "evt-2", phase: "CLOSED" })], "/account/clubs/org-1");
    expect(upcoming).toEqual([]);
    expect(closed).toEqual([]);
  });

  it("returns one step per open, unregistered event, in the given order", () => {
    const steps = clubEventRegistrationSteps(
      [
        event({ id: "evt-1", name: "Fall Camporee" }),
        event({ id: "evt-2", name: "Honors Weekend" }),
      ],
      "/account/clubs/org-1",
    );
    expect(steps.map((step) => step.key)).toEqual(["evt-1", "evt-2"]);
  });
});
