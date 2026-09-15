import { describe, expect, it } from "vitest";
import type { RegistrationRecord } from "@/modules/registrations/repository";
import {
  buildDuplicateReport,
  normalizeNameKey,
  normalizePhone,
} from "@/modules/registrations/duplicate-detection";

type AttendeeSeed = {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  checkedIn?: boolean;
};

function registration(seed: {
  id: string;
  code: string;
  status?: string;
  contact?: { firstName: string; lastName: string; email?: string; phone?: string };
  attendees: AttendeeSeed[];
  submittedAt?: string;
}): RegistrationRecord {
  const contact = seed.contact ?? {
    firstName: seed.attendees[0].firstName,
    lastName: seed.attendees[0].lastName,
    email: seed.attendees[0].email,
    phone: seed.attendees[0].phone,
  };
  return {
    id: seed.id,
    confirmationCode: seed.code,
    status: seed.status ?? "CONFIRMED",
    totalAmountCents: 20_000,
    paidCents: 0,
    balanceCents: 20_000,
    submittedAt: seed.submittedAt ?? "2026-08-01T00:00:00.000Z",
    attendeeCount: seed.attendees.length,
    accountHolder: {
      id: `person-${seed.id}`,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email ?? "",
      phone: contact.phone ?? "",
    },
    attendees: seed.attendees.map((attendee, index) => ({
      id: attendee.id,
      firstName: attendee.firstName,
      lastName: attendee.lastName,
      email: attendee.email ?? "",
      phone: attendee.phone ?? "",
      attendeeType: "ATTENDEE",
      position: index,
      source: "PUBLIC_REGISTRATION",
      responses: {},
      checkedIn: attendee.checkedIn ?? false,
      checkInId: null,
      checkedInAt: null,
    })),
  } as unknown as RegistrationRecord;
}

describe("duplicate detection keys", () => {
  it("folds accents, punctuation, and field order into one name key", () => {
    expect(normalizeNameKey("Marta", "Álvarez"))
      .toBe(normalizeNameKey("Alvarez", "marta"));
    expect(normalizeNameKey("Sarah", "O'Brien"))
      .toBe(normalizeNameKey("Sarah", "OBrien"));
    expect(normalizeNameKey("Marta", "")).toBe("");
  });

  it("matches a phone number regardless of formatting and ignores short ones", () => {
    expect(normalizePhone("+1 (515) 555-0134")).toBe("5155550134");
    expect(normalizePhone("515.555.0134")).toBe("5155550134");
    expect(normalizePhone("5550134")).toBe("");
  });
});

describe("duplicate report", () => {
  it("flags the same person registered twice by email", () => {
    const report = buildDuplicateReport([
      registration({
        id: "reg-1",
        code: "WR26-1001",
        attendees: [{ id: "a1", firstName: "Marta", lastName: "Alvarez", email: "Marta@example.test" }],
      }),
      registration({
        id: "reg-2",
        code: "WR26-1002",
        submittedAt: "2026-08-04T00:00:00.000Z",
        attendees: [{ id: "a2", firstName: "Marta", lastName: "Alvarez", email: "marta@example.test" }],
      }),
    ]);

    expect(report.attendeeGroups).toHaveLength(1);
    expect(report.attendeeGroups[0]).toMatchObject({
      confidence: "LIKELY",
      reason: "Same email address",
      withinSingleRegistration: false,
    });
    expect(report.attendeeGroups[0].members.map((member) => member.confirmationCode))
      .toEqual(["WR26-1001", "WR26-1002"]);
    expect(report.duplicatedAttendeeCount).toBe(2);
  });

  it("does not report the same people twice under a weaker rule", () => {
    const report = buildDuplicateReport([
      registration({
        id: "reg-1",
        code: "WR26-1001",
        attendees: [{ id: "a1", firstName: "Marta", lastName: "Alvarez", email: "marta@example.test", phone: "515-555-0134" }],
      }),
      registration({
        id: "reg-2",
        code: "WR26-1002",
        attendees: [{ id: "a2", firstName: "Marta", lastName: "Alvarez", email: "marta@example.test", phone: "(515) 555-0134" }],
      }),
    ]);

    expect(report.attendeeGroups).toHaveLength(1);
    expect(report.attendeeGroups[0].reason).toBe("Same email address");
  });

  it("flags a name repeated inside one registration", () => {
    const report = buildDuplicateReport([
      registration({
        id: "reg-1",
        code: "WR26-1001",
        attendees: [
          { id: "a1", firstName: "Rosalind", lastName: "Nkemdirim" },
          { id: "a2", firstName: "Rosalind", lastName: "Nkemdirim" },
        ],
      }),
    ]);

    expect(report.attendeeGroups).toHaveLength(1);
    expect(report.attendeeGroups[0]).toMatchObject({
      confidence: "POSSIBLE",
      reason: "Same name",
      withinSingleRegistration: true,
    });
  });

  it("matches a swapped first and last name", () => {
    const report = buildDuplicateReport([
      registration({ id: "reg-1", code: "WR26-1001", attendees: [{ id: "a1", firstName: "Marta", lastName: "Alvarez" }] }),
      registration({ id: "reg-2", code: "WR26-1002", attendees: [{ id: "a2", firstName: "Alvarez", lastName: "Marta" }] }),
    ]);

    expect(report.attendeeGroups).toHaveLength(1);
    expect(report.attendeeGroups[0].reason).toBe("Same name");
  });

  it("ignores cancelled registrations and blank contact fields", () => {
    const report = buildDuplicateReport([
      registration({ id: "reg-1", code: "WR26-1001", attendees: [{ id: "a1", firstName: "Marta", lastName: "Alvarez", email: "marta@example.test" }] }),
      registration({
        id: "reg-2",
        code: "WR26-1002",
        status: "CANCELLED",
        attendees: [{ id: "a2", firstName: "Marta", lastName: "Alvarez", email: "marta@example.test" }],
      }),
      registration({ id: "reg-3", code: "WR26-1003", attendees: [{ id: "a3", firstName: "Joy", lastName: "Kimani" }] }),
      registration({ id: "reg-4", code: "WR26-1004", attendees: [{ id: "a4", firstName: "Esther", lastName: "Boateng" }] }),
    ]);

    expect(report.attendeeGroups).toEqual([]);
    expect(report.registrationGroups).toEqual([]);
    expect(report.scannedRegistrationCount).toBe(3);
    expect(report.scannedAttendeeCount).toBe(3);
  });

  it("flags one contact holding two separate registrations", () => {
    const report = buildDuplicateReport([
      registration({
        id: "reg-1",
        code: "WR26-1001",
        contact: { firstName: "Marta", lastName: "Alvarez", email: "marta@example.test" },
        attendees: [{ id: "a1", firstName: "Joy", lastName: "Kimani" }],
      }),
      registration({
        id: "reg-2",
        code: "WR26-1002",
        contact: { firstName: "Marta", lastName: "Alvarez", email: "marta@example.test" },
        attendees: [{ id: "a2", firstName: "Esther", lastName: "Boateng" }],
      }),
    ]);

    expect(report.registrationGroups).toHaveLength(1);
    expect(report.registrationGroups[0]).toMatchObject({
      confidence: "LIKELY",
      reason: "Same contact email",
    });
    expect(report.attendeeGroups).toEqual([]);
  });

  it("orders likely matches before possible ones", () => {
    const report = buildDuplicateReport([
      registration({ id: "reg-1", code: "WR26-1001", attendees: [{ id: "a1", firstName: "Joy", lastName: "Kimani" }] }),
      registration({ id: "reg-2", code: "WR26-1002", attendees: [{ id: "a2", firstName: "Joy", lastName: "Kimani" }] }),
      registration({ id: "reg-3", code: "WR26-1003", attendees: [{ id: "a3", firstName: "Esther", lastName: "Boateng", email: "esther@example.test" }] }),
      registration({ id: "reg-4", code: "WR26-1004", attendees: [{ id: "a4", firstName: "Esther", lastName: "Boateng", email: "esther@example.test" }] }),
    ]);

    expect(report.attendeeGroups.map((group) => group.confidence))
      .toEqual(["LIKELY", "POSSIBLE"]);
  });
});
