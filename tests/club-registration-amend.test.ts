import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  getRegistrationByIdWithClient: vi.fn(),
  enqueueRegistrationUpdatedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/registrations/repository", () => ({
  getRegistrationByIdWithClient: dependencies.getRegistrationByIdWithClient,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueRegistrationUpdatedMessage: dependencies.enqueueRegistrationUpdatedMessage,
}));

import { sealSecret } from "@/lib/secret-box";
import { amendClubRegistration, ClubRegistrationError } from "@/modules/club-registrations/repository";
import { RegistrationAmendmentError } from "@/modules/registrations/amendments-repository";

const definition = {
  title: "Honors Weekend club registration",
  description: "",
  confirmationMessage: "Your club is registered.",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add" },
  sections: [
    { id: "contact", title: "Contact", description: "", fields: [
      { id: "c_first", key: "primary_contact_first_name", label: "First name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "c_last", key: "primary_contact_last_name", label: "Last name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "c_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
    ] },
    { id: "roster", title: "Roster", description: "", fields: [
      { id: "a_first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "a_last", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "a_age", key: "attendee_age", label: "Age", helpText: "", type: "NUMBER", scope: "ATTENDEE", required: true, options: [] },
      { id: "a_diet", key: "dietary_needs", label: "Dietary needs", helpText: "", type: "LONG_TEXT", scope: "ATTENDEE", required: false, options: [] },
    ] },
  ],
};

const registrationResponses = {
  primary_contact_first_name: "Test",
  primary_contact_last_name: "Director",
  email: "director@example.test",
};

const initialUpdatedAt = new Date("2026-10-15T12:00:00.000Z");

function attendee(id: string, memberId: string, firstName: string, lastName: string, age: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    personId: `person-${memberId}`,
    position: 0,
    attendeeType: "ATTENDEE",
    attendeeTypeDefinitionId: null,
    attendeeTypeDefinition: null,
    profileSnapshot: {
      firstName, lastName, email: null, phone: null, source: "CLUB_REGISTRATION",
      clubOrganizationId: "club-1", clubRosterMemberId: memberId, ageOnEventDate: age,
    },
    formResponses: { first_name: firstName, last_name: lastName, attendee_age: String(age), dietary_needs: "None" },
    person: { id: `person-${memberId}`, firstName, lastName, normalizedEmail: null, phone: null },
    checkIns: [],
    substitutionOperations: [],
    ...extra,
  };
}

function fixture({ registrationClosesOn = "2026-11-30", activeMembers = ["m1", "m3"], attendees = [attendee("attendee-m1", "m1", "Alex", "Sample", 11), attendee("attendee-m2", "m2", "Jordan", "Example", 38)] } = {}) {
  const registration = {
    id: "registration-1",
    eventId: "event-1",
    confirmationCode: "REG-CLUB",
    status: "SUBMITTED",
    totalAmount: 0,
    updatedAt: initialUpdatedAt,
    event: { id: "event-1", name: "Honors Weekend", timezone: "America/Chicago", capacity: null },
    accountHolderPerson: { id: "person-director", firstName: "Test", lastName: "Director", normalizedEmail: "director@example.test", phone: null },
    publicFormSubmission: {
      formVersionId: "version-1",
      createdAt: new Date("2026-10-01T12:00:00.000Z"),
      responses: { ...registrationResponses },
      pricingSnapshot: { totalCents: 0, pricingDate: "2026-10-01" },
      formVersion: { id: "version-1", versionNumber: 1, definition, form: { id: "form-1", name: "Club form", slug: "clubs" } },
    },
    attendees,
    payments: [],
    capacityReservations: [],
    promoCodeRedemption: null,
    operations: [] as Array<Record<string, unknown>>,
  };
  const rosterRows = [
    { id: "m1", personId: "person-m1", attendeeType: "YOUTH", role: "Pathfinder", gender: "FEMALE", sealedBirthDate: sealSecret("2014-12-06", "club-roster:birth-date"), person: { firstName: "Alex", lastName: "Sample" } },
    { id: "m3", personId: "person-m3", attendeeType: "YOUTH", role: "Pathfinder", gender: "MALE", sealedBirthDate: sealSecret("2013-05-02", "club-roster:birth-date"), person: { firstName: "Casey", lastName: "New" } },
  ].filter((row) => activeMembers.includes(row.id));
  const operations = new Map<string, Record<string, unknown>>();
  const prisma = {
    event: { findFirst: vi.fn(async () => ({
      id: "event-1", name: "Honors Weekend", startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T20:00:00Z"),
      timezone: "America/Chicago", location: "Camp", isPublished: true, registrationOpensOn: "2026-10-01", registrationClosesOn,
      waitlistEnabled: false, billingMode: "DEFERRED_ORGANIZATION_INVOICE", capacity: null,
    })) },
    registrationForm: { findFirst: vi.fn(async () => ({
      slug: "clubs",
      versions: [{ definition }],
    })) },
    clubEventRegistration: { findUnique: vi.fn(async (): Promise<{ registrationId: string } | null> => ({ registrationId: "registration-1" })) },
    registrationAttendee: {
      findMany: vi.fn(async () => registration.attendees.map((a) => ({ id: a.id, profileSnapshot: a.profileSnapshot }))),
      count: vi.fn(async () => 0),
      deleteMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        registration.attendees = registration.attendees.filter((a) => !where.id.in.includes(a.id));
        return { count: where.id.in.length };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const found = registration.attendees.find((a) => a.id === where.id)!;
        Object.assign(found, data);
        return found;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `attendee-${registration.attendees.length + 1}`, checkIns: [], substitutionOperations: [], person: { id: data.personId, firstName: "", lastName: "", normalizedEmail: null, phone: null }, ...data };
        registration.attendees.push(created as never);
        return created;
      }),
    },
    clubRosterMember: { findMany: vi.fn(async () => rosterRows) },
    attendeeAccount: { findUnique: vi.fn(async () => ({ displayName: "Test Director" })) },
    registration: {
      findFirst: vi.fn(async () => structuredClone(registration)),
      update: vi.fn(async ({ data }: { data: { totalAmount: number } }) => {
        registration.totalAmount = data.totalAmount;
        registration.updatedAt = new Date("2026-10-15T13:00:00.000Z");
        return registration;
      }),
    },
    eventAttendeeType: { findMany: vi.fn(async () => []) },
    registrationOperation: {
      findUnique: vi.fn(async ({ where }: { where: { eventId_clientRequestId: { clientRequestId: string } } }) => (
        operations.get(where.eventId_clientRequestId.clientRequestId) ?? null
      )),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        operations.set(String(data.clientRequestId), data);
        registration.operations.unshift({ id: data.id, afterSnapshot: data.afterSnapshot, createdAt: data.createdAt });
        return data;
      }),
    },
    registrationCapacityReservation: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
      upsert: vi.fn(async () => ({})),
    },
    promoCodeRedemption: { update: vi.fn() },
    registrationAdjustment: { aggregate: vi.fn().mockResolvedValue({ _sum: { amountCents: null } }) },
    person: { findUnique: vi.fn(async () => null), create: vi.fn(async ({ data }: { data: { firstName: string; lastName: string } }) => ({ id: `person-new-${data.firstName.toLowerCase()}`, ...data })) },
    auditLog: { create: vi.fn(async (call: { data: Record<string, unknown> }) => call) },
  };
  const client = { ...prisma, $transaction: vi.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma)) };
  dependencies.getPrisma.mockReturnValue(client);
  dependencies.getRegistrationByIdWithClient.mockImplementation(async () => ({
    id: registration.id,
    confirmationCode: registration.confirmationCode,
    publicSubmission: { responses: registration.publicFormSubmission.responses, pricingSnapshot: registration.publicFormSubmission.pricingSnapshot },
  }));
  return { registration, prisma };
}

const baseEdit = () => ({
  clientRequestId: "2f0e3c1a-7a55-4c43-8e1c-2f6f6f4a9a10",
  expectedUpdatedAt: initialUpdatedAt.toISOString(),
  selectedMemberIds: ["m1"],
  keptGuestIds: [],
  newGuests: [],
  attendeeResponses: {},
});

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" });
  dependencies.enqueueRegistrationUpdatedMessage.mockResolvedValue({
    messageIds: ["message-1"], pendingMessageIds: ["message-1"], deliveryMode: "LOCAL_CAPTURE", skippedReason: null,
  });
});

describe("club registration edit (H3b, #366)", () => {
  it("lets a director add a new roster person and drop someone no longer on the roster, before the deadline", async () => {
    const { prisma } = fixture();
    const result = await amendClubRegistration("club-1", "event-1", "director-1", {
      ...baseEdit(),
      selectedMemberIds: ["m1", "m3"],
    }, new Date("2026-10-16T12:00:00Z"));

    expect(result.registration.confirmationCode).toBe("REG-CLUB");
    // m2 (no longer active on the roster) is removed, with no check-in history to block it.
    expect(prisma.registrationAttendee.deleteMany).toHaveBeenCalledWith({ where: { registrationId: "registration-1", id: { in: ["attendee-m2"] } } });
    // m1 is retained (same attendee row updated, not recreated).
    expect(prisma.registrationAttendee.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "attendee-m1" } }));
    // m3 is newly added, with the roster markers an edit must carry the same as a fresh submission.
    const created = prisma.registrationAttendee.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      profileSnapshot: expect.objectContaining({ clubRosterMemberId: "m3", clubOrganizationId: "club-1", ageOnEventDate: 13 }),
      formResponses: expect.objectContaining({ first_name: "Casey", last_name: "New", attendee_age: "13" }),
    });

    // Audited with the director's attendee account id, never a name or birth date.
    const operationCall = prisma.registrationOperation.create.mock.calls[0]![0].data;
    expect(operationCall.actorUserId).toBeNull();
    expect(operationCall.actorAttendeeAccountId).toBe("director-1");
    const auditCall = prisma.auditLog.create.mock.calls[0]![0].data;
    expect(auditCall.actorUserId).toBeNull();
    expect(auditCall.metadata).toMatchObject({ actorKind: "CLUB_DIRECTOR", actorAttendeeAccountId: "director-1" });
    // The audit metadata itself (not the operational before/after snapshots
    // support relies on) never carries a name.
    const auditMetadata = JSON.stringify(auditCall.metadata);
    expect(auditMetadata).not.toMatch(/Alex|Sample|Jordan|Example|Casey/);
  });

  it("refuses an edit after the registration deadline", async () => {
    const { prisma } = fixture({ registrationClosesOn: "2026-10-10" });
    await expect(amendClubRegistration("club-1", "event-1", "director-1", baseEdit(), new Date("2026-10-16T12:00:00Z")))
      .rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(prisma.registrationAttendee.update).not.toHaveBeenCalled();
    expect(prisma.registrationAttendee.deleteMany).not.toHaveBeenCalled();
  });

  it("blocks removing someone who has been checked in", async () => {
    fixture({
      attendees: [
        attendee("attendee-m1", "m1", "Alex", "Sample", 11),
        attendee("attendee-m2", "m2", "Jordan", "Example", 38, { checkIns: [{ id: "checkin-1" }] }),
      ],
    });
    await expect(amendClubRegistration("club-1", "event-1", "director-1", baseEdit(), new Date("2026-10-16T12:00:00Z")))
      .rejects.toBeInstanceOf(RegistrationAmendmentError);
    await expect(amendClubRegistration("club-1", "event-1", "director-1", baseEdit(), new Date("2026-10-16T12:00:00Z")))
      .rejects.toMatchObject({ code: "ATTENDEE_HAS_HISTORY" });
  });

  it("refuses selecting someone who isn't active on the roster", async () => {
    fixture();
    await expect(amendClubRegistration("club-1", "event-1", "director-1", {
      ...baseEdit(),
      selectedMemberIds: ["m1", "someone-else"],
    }, new Date("2026-10-16T12:00:00Z"))).rejects.toMatchObject({ code: "MEMBER_NOT_ON_ROSTER" });
  });

  it("refuses removing every attendee", async () => {
    fixture();
    await expect(amendClubRegistration("club-1", "event-1", "director-1", {
      ...baseEdit(),
      selectedMemberIds: [],
    }, new Date("2026-10-16T12:00:00Z"))).rejects.toMatchObject({ code: "ATTENDEES_INVALID" });
  });

  it("refuses editing a registration that was never submitted for this club", async () => {
    const { prisma } = fixture();
    prisma.clubEventRegistration.findUnique.mockResolvedValue(null);
    await expect(amendClubRegistration("club-1", "event-1", "director-1", baseEdit(), new Date("2026-10-16T12:00:00Z")))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND" });
  });

  it("wraps club errors in ClubRegistrationError", async () => {
    fixture({ registrationClosesOn: "2026-10-10" });
    await expect(amendClubRegistration("club-1", "event-1", "director-1", baseEdit(), new Date("2026-10-16T12:00:00Z")))
      .rejects.toBeInstanceOf(ClubRegistrationError);
  });
});
