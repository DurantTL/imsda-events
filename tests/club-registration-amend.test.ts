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
import {
  amendRegistration,
  previewRegistrationAmendment,
  RegistrationAmendmentError,
} from "@/modules/registrations/amendments-repository";
import { registrationAmendmentInputSchema } from "@/modules/registrations/schemas";

type TestDefinition = {
  title: string;
  description: string;
  confirmationMessage: string;
  attendeeRoster: Record<string, unknown>;
  sections: Array<{ id: string; title: string; description: string; fields: Array<Record<string, unknown>> }>;
};

const baseDefinition: TestDefinition = {
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

/** The same form, priced like Spring Camporee (#409): a per-person fee with
 * late pricing, and a registration-level meal-sponsorship credit capped at
 * the headcount. */
function pricedDefinitionWith(creditCentsPerUnit: number): TestDefinition {
  return {
    ...baseDefinition,
    sections: [
      baseDefinition.sections[0]!,
      { id: "meals", title: "Meals", description: "", fields: [
        { id: "s_sponsor_count", key: "meal_sponsorship_count", label: "People sponsored", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [], creditCentsPerUnit, capUnitsAtAttendeeCount: true },
      ] },
      { ...baseDefinition.sections[1]!, fields: [
        ...baseDefinition.sections[1]!.fields,
        { id: "a_fee", key: "registration_fee", label: "Registration fee", helpText: "", type: "CALCULATED", scope: "ATTENDEE", required: false, options: [], priceCents: 900, latePricing: { startsOn: "2026-10-05", label: "Late pricing", priceCents: 1400 } },
      ] },
    ],
  };
}

/** Priced like Spring Camporee (#409): $9/person fee with late pricing, and a
 * $5-per-person meal-sponsorship credit capped at the headcount. */
const pricedDefinition = pricedDefinitionWith(-500);

/** The same form with a required attendee question nobody's roster can prefill. */
const shirtDefinition: TestDefinition = {
  ...baseDefinition,
  sections: [
    baseDefinition.sections[0]!,
    { ...baseDefinition.sections[1]!, fields: [
      ...baseDefinition.sections[1]!.fields,
      { id: "a_shirt", key: "shirt_size", label: "Shirt size", helpText: "", type: "SELECT", scope: "ATTENDEE", required: true, options: ["Youth M", "Adult M"] },
    ] },
  ],
};

/** The same form with a class/seminar ranking question. */
const seminarDefinition: TestDefinition = {
  ...baseDefinition,
  sections: [
    baseDefinition.sections[0]!,
    { ...baseDefinition.sections[1]!, fields: [
      ...baseDefinition.sections[1]!.fields,
      {
        id: "a_seminar", key: "seminar_choices", label: "Seminar choices", helpText: "", type: "RANKED_CHOICE", scope: "ATTENDEE",
        required: false, options: ["Knots", "Stars"], availabilityMode: "RANKED_INTEREST",
      },
    ] },
  ],
};

const registrationResponses: Record<string, unknown> = {
  primary_contact_first_name: "Test",
  primary_contact_last_name: "Director",
  email: "director@example.test",
};

const initialUpdatedAt = new Date("2026-10-15T12:00:00.000Z");
const beforeDeadline = new Date("2026-10-16T12:00:00Z");

function attendee(id: string, memberId: string, firstName: string, lastName: string, age: number, extra: Record<string, unknown> = {}, responses: Record<string, unknown> = {}) {
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
    } as Record<string, unknown>,
    formResponses: { first_name: firstName, last_name: lastName, attendee_age: String(age), dietary_needs: "None", ...responses } as Record<string, unknown>,
    person: { id: `person-${memberId}`, firstName, lastName, normalizedEmail: null as string | null, phone: null },
    checkIns: [] as Array<{ id: string }>,
    substitutionOperations: [] as Array<{ id: string }>,
    ...extra,
  };
}

/** An extra person submitted before guests carried a `clubGuestId`. */
function legacyGuest(id: string) {
  const guest = attendee(id, "unused", "Riley", "Driver", 42);
  guest.personId = "person-guest";
  guest.person = { id: "person-guest", firstName: "Riley", lastName: "Driver", normalizedEmail: "guest@example.test", phone: null };
  guest.profileSnapshot = {
    firstName: "Riley", lastName: "Driver", email: "guest@example.test", phone: null, source: "CLUB_REGISTRATION",
    clubOrganizationId: "club-1", ageOnEventDate: 42, temporary: true, temporaryAttendeeType: "ADULT",
  };
  return guest;
}

type FixtureOptions = {
  registrationClosesOn?: string | null;
  registrationOpensOn?: string;
  activeMembers?: string[];
  attendees?: Array<ReturnType<typeof attendee>>;
  definition?: TestDefinition;
  rosterNames?: Record<string, { firstName: string; lastName: string }>;
};

function fixture({
  registrationClosesOn = "2026-11-30",
  registrationOpensOn = "2026-10-01",
  activeMembers = ["m1", "m3"],
  attendees = [attendee("attendee-m1", "m1", "Alex", "Sample", 11), attendee("attendee-m2", "m2", "Jordan", "Example", 38)],
  definition = baseDefinition,
  rosterNames = {},
}: FixtureOptions = {}) {
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
    { id: "m1", personId: "person-m1", attendeeType: "YOUTH", role: "Pathfinder", gender: "FEMALE", sealedBirthDate: sealSecret("2014-12-06", "club-roster:birth-date"), person: rosterNames.m1 ?? { firstName: "Alex", lastName: "Sample" } },
    { id: "m3", personId: "person-m3", attendeeType: "YOUTH", role: "Pathfinder", gender: "MALE", sealedBirthDate: sealSecret("2013-05-02", "club-roster:birth-date"), person: rosterNames.m3 ?? { firstName: "Casey", lastName: "New" } },
  ].filter((row) => activeMembers.includes(row.id));
  const operations = new Map<string, Record<string, unknown>>();
  const prisma = {
    event: { findFirst: vi.fn(async () => ({
      id: "event-1", name: "Honors Weekend", startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T20:00:00Z"),
      timezone: "America/Chicago", location: "Camp", isPublished: true, registrationOpensOn, registrationClosesOn,
      waitlistEnabled: false, billingMode: "DEFERRED_ORGANIZATION_INVOICE", capacity: null,
    })) },
    registrationForm: { findFirst: vi.fn(async () => ({
      slug: "clubs",
      versions: [{ definition }],
    })) },
    clubEventRegistration: { findUnique: vi.fn(async (): Promise<{ registrationId: string } | null> => ({ registrationId: "registration-1" })) },
    registrationAttendee: {
      findMany: vi.fn(async () => registration.attendees.map((a) => ({ id: a.id, personId: a.personId, profileSnapshot: a.profileSnapshot, formResponses: a.formResponses }))),
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
    person: {
      findUnique: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
      create: vi.fn(async ({ data }: { data: { firstName: string; lastName: string } }) => ({ id: `person-new-${data.firstName.toLowerCase()}`, ...data })),
    },
    auditLog: { create: vi.fn(async (call: { data: Record<string, unknown> }) => call) },
  };
  const client = { ...prisma, $transaction: vi.fn(async (operation: (tx: typeof prisma) => unknown) => operation(prisma)) };
  dependencies.getPrisma.mockReturnValue(client);
  dependencies.getRegistrationByIdWithClient.mockImplementation(async () => ({
    id: registration.id,
    confirmationCode: registration.confirmationCode,
    updatedAt: registration.updatedAt.toISOString(),
    // Staff-only detail the club response must never carry.
    adjustments: [{ reason: "Staff-only scholarship note", createdByName: "Staff Person" }],
    publicSubmission: { responses: registration.publicFormSubmission.responses, pricingSnapshot: registration.publicFormSubmission.pricingSnapshot },
  }));
  return { registration, prisma };
}

const baseEdit = () => ({
  clientRequestId: "2f0e3c1a-7a55-4c43-8e1c-2f6f6f4a9a10",
  expectedUpdatedAt: initialUpdatedAt.toISOString(),
  selectedMemberIds: ["m1"],
  keptGuestIds: [] as string[],
  keptOffRosterAttendeeIds: [] as string[],
  newGuests: [] as Array<{ id: string; firstName: string; lastName: string; age: number; email: string | null }>,
  attendeeResponses: {} as Record<string, Record<string, unknown>>,
});

function updateFor(prisma: ReturnType<typeof fixture>["prisma"], attendeeId: string) {
  return prisma.registrationAttendee.update.mock.calls.find(([call]) => call.where.id === attendeeId)?.[0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" });
  dependencies.enqueueRegistrationUpdatedMessage.mockResolvedValue({
    messageIds: ["message-1"], pendingMessageIds: ["message-1"], deliveryMode: "LOCAL_CAPTURE", skippedReason: null,
  });
});

describe("club registration edit (H3b, #366)", () => {
  it("adds a roster person as that roster person and removes someone the director unticked, before the deadline", async () => {
    const { prisma } = fixture();
    const { result, pendingMessageIds } = await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      selectedMemberIds: ["m1", "m3"],
    }, beforeDeadline);

    // Only the club summary: none of the engine's staff view.
    expect(result).toEqual({ confirmationCode: "REG-CLUB", updatedAt: "2026-10-15T13:00:00.000Z", attendeeCount: 2 });
    expect(pendingMessageIds).toEqual(["message-1"]);
    // m2 (off the roster, explicitly not kept) is removed.
    expect(prisma.registrationAttendee.deleteMany).toHaveBeenCalledWith({ where: { registrationId: "registration-1", id: { in: ["attendee-m2"] } } });
    expect(updateFor(prisma, "attendee-m1")).toBeDefined();
    // m3 is linked to the roster member's own person, never a new or
    // name-matched one (B1).
    const created = prisma.registrationAttendee.create.mock.calls[0]![0].data;
    expect(created.personId).toBe("person-m3");
    expect(prisma.person.create).not.toHaveBeenCalled();
    expect(prisma.person.findUnique).not.toHaveBeenCalled();
    expect(created).toMatchObject({
      profileSnapshot: expect.objectContaining({ firstName: "Casey", lastName: "New", clubRosterMemberId: "m3", clubOrganizationId: "club-1", ageOnEventDate: 13 }),
      formResponses: expect.objectContaining({ first_name: "Casey", last_name: "New", attendee_age: "13" }),
    });
    expect(JSON.stringify(created)).not.toMatch(/2013-05-02|birth/i);

    // Audited with the director's attendee account id, never a name or birth date.
    const operationCall = prisma.registrationOperation.create.mock.calls[0]![0].data;
    expect(operationCall.actorUserId).toBeNull();
    expect(operationCall.actorAttendeeAccountId).toBe("director-1");
    const auditCall = prisma.auditLog.create.mock.calls[0]![0].data;
    expect(auditCall.actorUserId).toBeNull();
    expect(auditCall.metadata).toMatchObject({ actorKind: "CLUB_DIRECTOR", actorAttendeeAccountId: "director-1" });
    expect(JSON.stringify(auditCall.metadata)).not.toMatch(/Alex|Sample|Jordan|Example|Casey|2014-12-06|2013-05-02/);
  });

  it("attributes a staff \"act as\" director's edit to the staff user and the act-as, never an attendee account (#442)", async () => {
    const { prisma } = fixture();
    await amendClubRegistration("club-1", "event-1", { userId: "admin-1", actAsId: "act-1" }, {
      ...baseEdit(),
      selectedMemberIds: ["m1", "m3"],
    }, beforeDeadline);
    const operationCall = prisma.registrationOperation.create.mock.calls[0]![0].data;
    expect(operationCall.actorUserId).toBe("admin-1");
    expect(operationCall.actorAttendeeAccountId).toBeNull();
    const auditCall = prisma.auditLog.create.mock.calls[0]![0].data;
    expect(auditCall.actorUserId).toBe("admin-1");
    expect(auditCall.metadata).toMatchObject({ actorKind: "STAFF_ACTING_DIRECTOR", actorAttendeeAccountId: null, actAsId: "act-1" });
  });

  it("holds a staff \"act as\" director to the club's own deadline, like a real director (#442)", async () => {
    const { prisma } = fixture({ registrationClosesOn: "2026-11-30" });
    await expect(amendClubRegistration("club-1", "event-1", { userId: "admin-1", actAsId: "act-1" }, baseEdit(), new Date("2026-12-01T06:30:00Z")))
      .rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(prisma.registrationOperation.create).not.toHaveBeenCalled();
  });

  it("keeps someone moved off the roster between submit and edit, exactly as registered, unless unticked", async () => {
    const { prisma } = fixture();
    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      keptOffRosterAttendeeIds: ["attendee-m2"],
    }, beforeDeadline);

    expect(prisma.registrationAttendee.deleteMany).not.toHaveBeenCalled();
    const kept = updateFor(prisma, "attendee-m2")!;
    expect(kept.profileSnapshot).toMatchObject({ firstName: "Jordan", lastName: "Example", clubRosterMemberId: "m2", ageOnEventDate: 38 });
    expect(kept.formResponses).toMatchObject({ first_name: "Jordan", last_name: "Example", attendee_age: "38", dietary_needs: "None" });
    // No roster lookup for them: they aren't on it.
    expect(prisma.person.create).not.toHaveBeenCalled();
  });

  it("refuses a kept off-roster person the client can't name correctly", async () => {
    fixture();
    await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      keptOffRosterAttendeeIds: ["attendee-m1"],
    }, beforeDeadline)).rejects.toMatchObject({ code: "ATTENDEES_INVALID" });
  });

  it("refuses removing an off-roster person who has checked in", async () => {
    fixture({
      attendees: [
        attendee("attendee-m1", "m1", "Alex", "Sample", 11),
        attendee("attendee-m2", "m2", "Jordan", "Example", 38, { checkIns: [{ id: "checkin-1" }] }),
      ],
    });
    const refusal = amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, baseEdit(), beforeDeadline);
    await expect(refusal).rejects.toBeInstanceOf(RegistrationAmendmentError);
    await expect(refusal).rejects.toMatchObject({ code: "ATTENDEE_HAS_HISTORY", details: { attendeeName: "Jordan Example" } });
  });

  it("keeps an extra person submitted before guests carried an id on an unrelated edit, with their email", async () => {
    const { prisma } = fixture({
      attendees: [attendee("attendee-m1", "m1", "Alex", "Sample", 11), legacyGuest("attendee-g1")],
    });
    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      keptGuestIds: ["attendee-g1"],
      attendeeResponses: { "member:m1": { first_name: "Alex", last_name: "Sample", attendee_age: "11", dietary_needs: "Vegetarian" } },
    }, beforeDeadline);

    expect(prisma.registrationAttendee.deleteMany).not.toHaveBeenCalled();
    const guest = updateFor(prisma, "attendee-g1")!;
    expect(guest.profileSnapshot).toMatchObject({
      firstName: "Riley", lastName: "Driver", email: "guest@example.test", temporary: true, temporaryAttendeeType: "ADULT", clubGuestId: "attendee-g1",
    });
    expect(updateFor(prisma, "attendee-m1")!.formResponses).toMatchObject({ dietary_needs: "Vegetarian" });
  });

  it("carries a new extra person's email into person matching and the snapshot", async () => {
    const { prisma } = fixture();
    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      keptOffRosterAttendeeIds: ["attendee-m2"],
      newGuests: [{ id: "guestabc123", firstName: "Sam", lastName: "Parent", age: 45, email: "sam.parent@example.test" }],
    }, beforeDeadline);

    expect(prisma.person.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { normalizedEmail: "sam.parent@example.test" } }));
    const created = prisma.registrationAttendee.create.mock.calls[0]![0].data;
    expect(created.profileSnapshot).toMatchObject({
      firstName: "Sam", lastName: "Parent", email: "sam.parent@example.test", temporary: true, temporaryAttendeeType: "ADULT", clubGuestId: "guestabc123",
    });
  });

  describe("deadline, in the event's time zone", () => {
    it("allows an edit at 23:30 local on the closing day", async () => {
      fixture({ registrationClosesOn: "2026-11-30" });
      await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, { ...baseEdit(), keptOffRosterAttendeeIds: ["attendee-m2"] }, new Date("2026-12-01T05:30:00Z")))
        .resolves.toMatchObject({ result: { confirmationCode: "REG-CLUB" } });
    });

    it("refuses the next day with a clear message, changing nothing", async () => {
      const { prisma } = fixture({ registrationClosesOn: "2026-11-30" });
      const refusal = amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, baseEdit(), new Date("2026-12-01T06:30:00Z"));
      await expect(refusal).rejects.toBeInstanceOf(ClubRegistrationError);
      await expect(refusal).rejects.toMatchObject({
        code: "REGISTRATION_CLOSED",
        message: "Registration closed after November 30, 2026. Contact the event team to add or remove someone.",
      });
      expect(prisma.registrationAttendee.update).not.toHaveBeenCalled();
      expect(prisma.registrationAttendee.deleteMany).not.toHaveBeenCalled();
    });

    it("with no closing date, allows edits before the event and refuses once its start date has passed", async () => {
      fixture({ registrationClosesOn: null });
      await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, { ...baseEdit(), keptOffRosterAttendeeIds: ["attendee-m2"] }, new Date("2026-12-04T18:00:00Z")))
        .resolves.toBeDefined();
      fixture({ registrationClosesOn: null });
      await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, baseEdit(), new Date("2026-12-06T18:00:00Z")))
        .rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    });

    it("refuses while registration isn't open yet", async () => {
      fixture({ registrationOpensOn: "2026-11-01" });
      await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, baseEdit(), beforeDeadline))
        .rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    });
  });

  describe("answers in the same form (N1)", () => {
    const withShirts = () => [
      attendee("attendee-m1", "m1", "Alex", "Sample", 11, {}, { shirt_size: "Youth M" }),
      attendee("attendee-m2", "m2", "Jordan", "Example", 38, {}, { shirt_size: "Adult M" }),
    ];

    it("refuses adding someone without a required answer, naming the person and question", async () => {
      fixture({ definition: shirtDefinition, attendees: withShirts() });
      const refusal = amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
        ...baseEdit(),
        selectedMemberIds: ["m1", "m3"],
        keptOffRosterAttendeeIds: ["attendee-m2"],
      }, beforeDeadline);
      await expect(refusal).rejects.toMatchObject({ code: "INVALID_AMENDMENT" });
      const error = await refusal.then(() => null, (caught: RegistrationAmendmentError) => caught);
      expect(error?.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "shirt_size", clientId: "member:m3" }),
      ]));
    });

    it("accepts the added person once the answer is given, and a changed answer on a kept person", async () => {
      const { prisma } = fixture({ definition: shirtDefinition, attendees: withShirts() });
      await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
        ...baseEdit(),
        selectedMemberIds: ["m1", "m3"],
        keptOffRosterAttendeeIds: ["attendee-m2"],
        attendeeResponses: {
          "member:m1": { first_name: "Alex", last_name: "Sample", attendee_age: "11", dietary_needs: "None", shirt_size: "Adult M" },
          // A client can't rename anyone: roster-owned answers are overwritten.
          "member:m3": { first_name: "Someone", last_name: "Else", shirt_size: "Youth M" },
        },
      }, beforeDeadline);
      expect(updateFor(prisma, "attendee-m1")!.formResponses).toMatchObject({ shirt_size: "Adult M" });
      const created = prisma.registrationAttendee.create.mock.calls[0]![0].data;
      expect(created.formResponses).toMatchObject({ first_name: "Casey", last_name: "New", shirt_size: "Youth M" });
      // Kept people with no answers sent keep theirs.
      expect(updateFor(prisma, "attendee-m2")!.formResponses).toMatchObject({ shirt_size: "Adult M" });
    });
  });

  it("refuses changing a kept person's seminar choices with a director message, but an ordinary edit goes through", async () => {
    fixture({
      definition: seminarDefinition,
      attendees: [attendee("attendee-m1", "m1", "Alex", "Sample", 11, {}, { seminar_choices: ["Knots"] })],
    });
    await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      attendeeResponses: { "member:m1": { first_name: "Alex", last_name: "Sample", attendee_age: "11", seminar_choices: ["Stars"] } },
    }, beforeDeadline)).rejects.toMatchObject({ code: "CLASS_CHOICES_NOT_EDITABLE", message: expect.stringContaining("ask the event team") });

    const { prisma } = fixture({
      definition: seminarDefinition,
      attendees: [attendee("attendee-m1", "m1", "Alex", "Sample", 11, {}, { seminar_choices: ["Knots"] })],
    });
    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      attendeeResponses: { "member:m1": { first_name: "Alex", last_name: "Sample", attendee_age: "11", seminar_choices: ["Knots"], dietary_needs: "Vegan" } },
    }, beforeDeadline);
    expect(updateFor(prisma, "attendee-m1")!.formResponses).toMatchObject({ dietary_needs: "Vegan", seminar_choices: ["Knots"] });
  });

  it("takes a name corrected on the roster since submitting, audited without names (N4)", async () => {
    const { prisma } = fixture({ rosterNames: { m1: { firstName: "Alexandra", lastName: "Sample" } } });
    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      keptOffRosterAttendeeIds: ["attendee-m2"],
    }, beforeDeadline);
    const kept = updateFor(prisma, "attendee-m1")!;
    expect(kept.profileSnapshot).toMatchObject({ firstName: "Alexandra", lastName: "Sample", clubRosterMemberId: "m1" });
    expect(kept.formResponses).toMatchObject({ first_name: "Alexandra", last_name: "Sample" });
    const metadata = prisma.auditLog.create.mock.calls[0]![0].data.metadata as Record<string, unknown>;
    expect(metadata.rosterNameUpdatedCount).toBe(1);
    expect(JSON.stringify(metadata)).not.toMatch(/Alex|Sample/);
  });

  it("still refuses a staff amendment that renames someone (Substitute rule unchanged)", async () => {
    fixture({ rosterNames: { m1: { firstName: "Alexandra", lastName: "Sample" } } });
    await expect(previewRegistrationAmendment("event-1", "registration-1", {
      clientRequestId: "7d8b2b54-7f3a-4f0c-9d1c-0c9d8d0b1a11",
      expectedUpdatedAt: initialUpdatedAt.toISOString(),
      reason: "",
      responses: registrationResponses,
      attendees: [
        { attendeeId: "attendee-m1", clientId: "a1", responses: { first_name: "Alexandra", last_name: "Sample", attendee_age: "11", dietary_needs: "None" } },
        { attendeeId: "attendee-m2", clientId: "a2", responses: { first_name: "Jordan", last_name: "Example", attendee_age: "38", dietary_needs: "None" } },
      ],
      previewOnly: true,
    })).rejects.toMatchObject({ code: "ATTENDEE_IDENTITY_CHANGED" });
  });

  it("returns only the club summary on an idempotent replay too", async () => {
    fixture();
    const edit = { ...baseEdit(), keptOffRosterAttendeeIds: ["attendee-m2"] };
    const first = await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, edit, beforeDeadline);
    const replay = await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, edit, beforeDeadline);
    expect(replay.result).toEqual(first.result);
    expect(Object.keys(replay.result).sort()).toEqual(["attendeeCount", "confirmationCode", "updatedAt"]);
    expect(JSON.stringify(replay)).not.toMatch(/Staff-only|Staff Person|adjustments|lineItems/);
  });

  it("refuses a reused request ID with different content instead of replaying the first save", async () => {
    const { prisma } = fixture();
    const edit = { ...baseEdit(), keptOffRosterAttendeeIds: ["attendee-m2"] };
    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, edit, beforeDeadline);
    const changed = { ...edit, keptOffRosterAttendeeIds: [] as string[] };
    await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, changed, beforeDeadline))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(prisma.registrationOperation.create).toHaveBeenCalledTimes(1);
  });

  it("refuses adding a roster person who is already on the registration as another entry, with a clear message", async () => {
    const { prisma } = fixture({
      attendees: [attendee("attendee-m1", "m1", "Alex", "Sample", 11), { ...legacyGuest("attendee-g1"), personId: "person-m3" }],
    });
    await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      selectedMemberIds: ["m1", "m3"],
      keptGuestIds: ["attendee-g1"],
    }, beforeDeadline)).rejects.toMatchObject({
      code: "ATTENDEES_INVALID",
      message: expect.stringMatching(/Casey New is already on this registration/),
    });
    expect(prisma.registrationOperation.create).not.toHaveBeenCalled();
  });

  it("refuses selecting someone who isn't active on the roster", async () => {
    fixture();
    await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      selectedMemberIds: ["m1", "someone-else"],
    }, beforeDeadline)).rejects.toMatchObject({ code: "MEMBER_NOT_ON_ROSTER" });
  });

  it("refuses removing every attendee", async () => {
    fixture();
    await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      selectedMemberIds: [],
    }, beforeDeadline)).rejects.toMatchObject({ code: "ATTENDEES_INVALID" });
  });

  it("refuses editing a registration that was never submitted for this club", async () => {
    const { prisma } = fixture();
    prisma.clubEventRegistration.findUnique.mockResolvedValue(null);
    await expect(amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, baseEdit(), beforeDeadline))
      .rejects.toMatchObject({ code: "REGISTRATION_NOT_FOUND" });
  });

  it("re-prices a priced registration the same way submit does: original pricing date, meal credit capped at the new headcount (#409)", async () => {
    const { registration, prisma } = fixture({ definition: pricedDefinition });
    // Submitted 2026-10-01, before the 2026-10-05 late date; the edit itself
    // happens after that date (`beforeDeadline` = 2026-10-16), but H3b keeps
    // pricing on the original submit date, so the $9 (not $14) fee applies.
    registration.publicFormSubmission.responses = { ...registration.publicFormSubmission.responses, meal_sponsorship_count: 5 };

    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      selectedMemberIds: ["m1", "m3"],
    }, beforeDeadline);

    // 2 people × $9 (original-date pricing, not the $14 late fee) − meal
    // credit capped at the 2-person headcount (not the 5 claimed): 1800 − 1000.
    expect(prisma.registration.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totalAmount: 8 }) }));
  });

  it("floors a priced registration's amount owed at $0 on amendment when the meal credit would exceed the fees (#409)", async () => {
    // A credit equal to the per-person fee: crediting the whole headcount
    // would land exactly on $0 (never negative) once floored.
    const { registration, prisma } = fixture({
      definition: pricedDefinitionWith(-900),
      attendees: [attendee("attendee-m1", "m1", "Alex", "Sample", 11)],
    });
    registration.publicFormSubmission.responses = { ...registration.publicFormSubmission.responses, meal_sponsorship_count: 1 };

    await amendClubRegistration("club-1", "event-1", { accountId: "director-1" }, {
      ...baseEdit(),
      selectedMemberIds: ["m1"],
    }, beforeDeadline);

    // 1 person × $9 − 1 person fed × $9 = $0, floored (never negative).
    expect(prisma.registration.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ totalAmount: 0 }) }));
  });
});

describe("server-only amendment attendee options (B4)", () => {
  it("are not part of the public amendment schema", () => {
    const parsed = registrationAmendmentInputSchema.safeParse({
      clientRequestId: "7d8b2b54-7f3a-4f0c-9d1c-0c9d8d0b1a11",
      expectedUpdatedAt: initialUpdatedAt.toISOString(),
      responses: registrationResponses,
      attendees: [{ attendeeId: "attendee-m1", clientId: "a1", responses: {}, attendeeMetadata: { firstName: "Forged" } }],
    });
    expect(parsed.success).toBe(false);
  });

  it("write only allowlisted markers, before identity, so they can't override who someone is", async () => {
    const { prisma } = fixture();
    const input = {
      clientRequestId: "7d8b2b54-7f3a-4f0c-9d1c-0c9d8d0b1a11",
      expectedUpdatedAt: initialUpdatedAt.toISOString(),
      reason: "",
      responses: registrationResponses,
      attendees: [
        { attendeeId: "attendee-m1", clientId: "a1", responses: { first_name: "Alex", last_name: "Sample", attendee_age: "11", dietary_needs: "None" } },
        { attendeeId: "attendee-m2", clientId: "a2", responses: { first_name: "Jordan", last_name: "Example", attendee_age: "38", dietary_needs: "None" } },
      ],
      previewOnly: true,
    };
    const preview = await previewRegistrationAmendment("event-1", "registration-1", input);
    await amendRegistration(
      "event-1",
      "registration-1",
      { ...input, previewOnly: false, quoteFingerprint: preview.quoteFingerprint },
      { kind: "STAFF", id: "user-1", displayName: "Staff User" },
      beforeDeadline,
      { attendees: new Map([["a1", { profileMetadata: { firstName: "Forged", birthDate: "2014-12-06", ageOnEventDate: 12 } as never }]]) },
    );
    const snapshot = updateFor(prisma, "attendee-m1")!.profileSnapshot as Record<string, unknown>;
    expect(snapshot.firstName).toBe("Alex");
    expect(snapshot.ageOnEventDate).toBe(12);
    expect(snapshot).not.toHaveProperty("birthDate");
  });
});
