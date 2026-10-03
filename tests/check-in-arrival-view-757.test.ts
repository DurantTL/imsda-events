import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { projectCheckInArrivals } from "@/modules/checkin/arrival-view";
import { serializeAttendee } from "@/modules/checkin/attendee-pass-repository";
import { inspectOfflineCheckInQueue } from "@/modules/checkin/domain";

const registration = {
  confirmationCode: "SYN-0002",
  balanceCents: 1000,
  isDeferredOrganizationBilling: false,
  attendees: [
    {
      id: "a1",
      firstName: "Sam",
      lastName: "Example",
      attendeeType: "ADULT",
      checkedIn: false,
      checkedInAt: null,
      responses: { diet: "SYNTHETIC-ANSWER" },
      email: "s@example.test",
      phone: "555-0100",
      checkInId: null,
    },
  ],
  publicSubmission: { responses: { medical: "SYNTHETIC-ANSWER" } },
};

describe("check-in projection (#757)", () => {
  it("copies only allow-listed fields, even from a record carrying answers", () => {
    const [arrival] = projectCheckInArrivals([registration], { showBalances: true });
    expect(Object.keys(arrival).sort()).toEqual([
      "attendeeType", "balanceCents", "checkedIn", "checkedInAt", "confirmationCode",
      "firstName", "id", "lastName", "partySize",
    ]);
    expect(JSON.stringify(arrival)).not.toContain("SYNTHETIC-ANSWER");
    expect(arrival.balanceCents).toBe(1000);
  });

  it("reports no balance when balances are hidden or church-billed", () => {
    expect(projectCheckInArrivals([registration], { showBalances: false })[0].balanceCents).toBe(0);
    expect(
      projectCheckInArrivals([{ ...registration, isDeferredOrganizationBilling: true }], { showBalances: true })[0].balanceCents,
    ).toBe(0);
  });
});

describe("scan resolution payload (#757)", () => {
  it("serializes attendees without answers, contact details or the raw profile", () => {
    const serialized = serializeAttendee({
      id: "a1",
      attendeeType: "YOUTH",
      profileSnapshot: {
        firstName: "Sam",
        lastName: "Example",
        email: "s@example.test",
        responses: { medical: "SYNTHETIC-ANSWER" },
      },
      person: { firstName: "Sam", lastName: "Example" },
      checkIns: [],
    });
    expect(Object.keys(serialized).sort()).toEqual([
      "attendeeType", "checkedIn", "checkedInAt", "firstName", "id", "lastName",
    ]);
    expect(JSON.stringify(serialized)).not.toContain("SYNTHETIC-ANSWER");
  });
});

describe("offline queue storage (#757)", () => {
  it("stores only attendee ids and bookkeeping; an item carrying answers is rejected", () => {
    const item = {
      operation: "CHECK_IN",
      attendeeId: "a1",
      idempotencyKey: crypto.randomUUID(),
      queuedAt: "2026-07-01T10:00:00.000Z",
      attempts: 0,
      state: "QUEUED",
      lastErrorCode: "NETWORK_UNAVAILABLE",
    };
    expect(inspectOfflineCheckInQueue(JSON.stringify([item])).items).toHaveLength(1);
    expect(
      inspectOfflineCheckInQueue(JSON.stringify([{ ...item, responses: { a: 1 } }])).invalidItemCount,
    ).toBe(1);
  });
});
