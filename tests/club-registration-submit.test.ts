import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  enqueuePublicRegistrationMessages: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: dependencies.processQueuedMessageIdsAfterCommit,
  enqueuePublicRegistrationMessages: dependencies.enqueuePublicRegistrationMessages,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({ enqueueWaitlistJoinedMessage: vi.fn() }));

import { sealSecret } from "@/lib/secret-box";
import { clubAttendeePreparer } from "@/modules/club-registrations/repository";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { submitPublicRegistration, type ClubSubmissionContext } from "@/modules/forms/public-repository";

const field = (id: string, key: string, label: string, type: string, scope: "ATTENDEE" | "REGISTRATION", required = false) => (
  { id, key, label, helpText: "", type, scope, required, options: [] }
);

function definition(extraAttendeeFields: ReturnType<typeof field>[] = []) {
  return registrationFormDefinitionSchema.parse({
    title: "Honors Weekend club registration",
    description: "Fictitious club form.",
    confirmationMessage: "Your club is registered.",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add" },
    sections: [
      { id: "contact", title: "Contact", description: "", fields: [
        field("c_first", "primary_contact_first_name", "First name", "TEXT", "REGISTRATION", true),
        field("c_last", "primary_contact_last_name", "Last name", "TEXT", "REGISTRATION", true),
        field("c_email", "email", "Email", "EMAIL", "REGISTRATION", true),
      ] },
      { id: "roster", title: "Roster", description: "", fields: [
        field("a_first", "first_name", "First name", "TEXT", "ATTENDEE", true),
        field("a_last", "last_name", "Last name", "TEXT", "ATTENDEE", true),
        field("a_age", "attendee_age", "Age", "NUMBER", "ATTENDEE", true),
        field("a_diet", "dietary_needs", "Dietary needs", "LONG_TEXT", "ATTENDEE"),
        ...extraAttendeeFields,
      ] },
    ],
  });
}

const baseInput: {
  versionId: string;
  idempotencyKey: string;
  responses: Record<string, unknown>;
  attendees: Array<{ clientId: string; responses: Record<string, unknown> }>;
  website: "";
} = {
  versionId: "version-1",
  idempotencyKey: "2f0e3c1a-7a55-4c43-8e1c-2f6f6f4a9a10",
  responses: { primary_contact_first_name: "Test", primary_contact_last_name: "Director", email: "director@example.test" },
  attendees: [
    { clientId: "member:m1", responses: { first_name: "Somebody", last_name: "Else", attendee_age: "40", dietary_needs: "Vegetarian" } },
    { clientId: "member:m2", responses: {} },
  ],
  website: "",
};

function fixture({ billingMode = "DEFERRED_ORGANIZATION_INVOICE", form = definition(), registrationClosesOn = "2026-11-30" } = {}) {
  const members = [
    { id: "m1", personId: "person-m1", attendeeType: "YOUTH", role: "Pathfinder", gender: "FEMALE", sealedBirthDate: sealSecret("2014-12-06", "club-roster:birth-date"), person: { firstName: "Alex", lastName: "Sample" } },
    { id: "m2", personId: "person-m2", attendeeType: "STAFF", role: "Counselor", gender: null, sealedBirthDate: sealSecret("1988-03-02", "club-roster:birth-date"), person: { firstName: "Jordan", lastName: "Example" } },
  ];
  const tx = {
    registrationForm: { findFirst: vi.fn().mockResolvedValue({
      id: "form-1", slug: "clubs", eventId: "event-1",
      event: {
        id: "event-1", name: "Honors Weekend", slug: "honors-weekend",
        startsAt: new Date("2026-12-05T15:00:00.000Z"), endsAt: new Date("2026-12-06T20:00:00.000Z"),
        timezone: "America/Chicago", location: "Camp", capacity: null, isPublished: true,
        registrationOpensOn: "2026-10-01", registrationClosesOn, waitlistEnabled: false, billingMode, attendeeTypes: [],
      },
      versions: [{ id: "version-1", versionNumber: 1, definition: form, publishedAt: new Date("2026-09-01T00:00:00Z") }],
    }) },
    clubRosterMember: { findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) => (where.organizationId === "club-1" ? members : [])) },
    clubEventRegistration: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "cer-1" }) },
    clubRegistrationDraft: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    publicRegistrationSubmission: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "submission-1" }) },
    registrationCapacityReservation: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() },
    registrationAttendee: { count: vi.fn().mockResolvedValue(0), create: vi.fn(async ({ data }: { data: { personId: string; profileSnapshot?: Record<string, unknown>; formResponses?: Record<string, unknown> } }) => ({ id: `attendee-${data.personId}` })) },
    person: {
      upsert: vi.fn().mockResolvedValue({ id: "person-director", firstName: "Test", lastName: "Director", normalizedEmail: "director@example.test" }),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    registration: {
      create: vi.fn().mockResolvedValue({ id: "registration-1" }),
      findUnique: vi.fn().mockResolvedValue({ eventId: "event-1", confirmationCode: "REG-CLUB", event: { endsAt: new Date("2026-12-06T20:00:00Z") } }),
    },
    registrationAccessToken: { create: vi.fn().mockResolvedValue({ id: "access-1" }) },
    registrationWaitlistEntry: { aggregate: vi.fn(), create: vi.fn() },
    messageOutbox: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
  };
  dependencies.getPrisma.mockReturnValue({ $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)) });
  return tx;
}

const club = (organizationId = "club-1"): ClubSubmissionContext => ({
  organizationId,
  submittedByAccountId: "director-1",
  prepareAttendees: clubAttendeePreparer(organizationId),
});
const now = new Date("2026-10-15T15:00:00.000Z");
const submit = (input = baseInput, context = club(), at = now) =>
  submitPublicRegistration("honors-weekend", "clubs", publicRegistrationInputSchema.parse(input), at, context);

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" });
  dependencies.processQueuedMessageIdsAfterCommit.mockResolvedValue({ capturedIds: [], sentIds: [], failedIds: [], rescheduledIds: [], skippedIds: [] });
  dependencies.enqueuePublicRegistrationMessages.mockResolvedValue({ messageIds: ["m"], pendingMessageIds: ["m"], registrantMessageIds: ["m"], deliveryMode: "LOCAL_CAPTURE" });
});

describe("club registration submit", () => {
  it("registers roster people by their roster identity, with age and no birth date", async () => {
    const tx = fixture();
    await submit();

    const attendeeCalls = tx.registrationAttendee.create.mock.calls.map(([call]) => call.data);
    expect(attendeeCalls.map((data) => data.personId)).toEqual(["person-m1", "person-m2"]);
    expect(attendeeCalls[0].profileSnapshot).toMatchObject({
      firstName: "Alex", lastName: "Sample", source: "CLUB_REGISTRATION",
      clubOrganizationId: "club-1", clubRosterMemberId: "m1", ageOnEventDate: 11,
    });
    expect(attendeeCalls[0].formResponses).toMatchObject({ first_name: "Alex", last_name: "Sample", attendee_age: "11", dietary_needs: "Vegetarian" });
    expect(attendeeCalls[1].profileSnapshot).toMatchObject({ ageOnEventDate: 38 });
    expect(tx.person.create).not.toHaveBeenCalled();

    const everything = JSON.stringify([...tx.registrationAttendee.create.mock.calls, ...tx.publicRegistrationSubmission.create.mock.calls, ...tx.auditLog.create.mock.calls]);
    expect(everything).not.toMatch(/2014-12-06|1988-03-02/);
    expect(everything).not.toContain("Somebody");

    expect(tx.clubEventRegistration.create).toHaveBeenCalledWith({ data: { eventId: "event-1", organizationId: "club-1", registrationId: "registration-1", submittedByAccountId: "director-1", submittedByUserId: null } });
    expect(tx.clubRegistrationDraft.deleteMany).toHaveBeenCalledWith({ where: { eventId: "event-1", organizationId: "club-1" } });
    expect(tx.auditLog.create.mock.calls.map(([call]) => call.data.action)).toContain("CLUB_REGISTRATION_SUBMITTED");
    expect(tx.registration.create.mock.calls[0][0].data).toMatchObject({ totalAmount: 0 });
  });

  it("refuses someone who isn't active on this club's roster, including another club's member", async () => {
    const tx = fixture();
    await expect(submit({ ...baseInput, attendees: [{ clientId: "member:someone-else", responses: {} }] }))
      .rejects.toMatchObject({ code: "CLUB_ATTENDEES_INVALID" });
    await expect(submit(baseInput, club("club-2"))).rejects.toMatchObject({ code: "CLUB_ATTENDEES_INVALID" });
    await expect(submit({ ...baseInput, attendees: [{ clientId: "new-person", responses: { first_name: "Walk", last_name: "In" } }] }))
      .rejects.toMatchObject({ code: "CLUB_ATTENDEES_INVALID" });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("registers an extra person for this event only, from the saved draft, never onto the roster (#388)", async () => {
    const tx = fixture();
    tx.clubRegistrationDraft.findUnique.mockResolvedValue({
      guests: [{ id: "guestabc123", firstName: "Pat", lastName: "Driver", age: 42, email: "pat.driver@example.test" }],
    });
    tx.person.create.mockResolvedValue({ id: "person-guest" });
    await submit({
      ...baseInput,
      attendees: [
        { clientId: "member:m1", responses: {} },
        { clientId: "guest:guestabc123", responses: { first_name: "Somebody", last_name: "Else", attendee_age: "9", dietary_needs: "None" } },
      ],
    });

    const guestCall = tx.registrationAttendee.create.mock.calls[1]![0].data;
    expect(guestCall.personId).toBe("person-guest");
    expect(guestCall.profileSnapshot).toMatchObject({
      firstName: "Pat", lastName: "Driver", email: "pat.driver@example.test", ageOnEventDate: 42,
      temporary: true, temporaryAttendeeType: "ADULT", clubOrganizationId: "club-1",
    });
    expect(guestCall.profileSnapshot).not.toHaveProperty("clubRosterMemberId");
    expect(guestCall.formResponses).toMatchObject({ first_name: "Pat", last_name: "Driver", attendee_age: "42", dietary_needs: "None" });
    expect(tx.person.create).toHaveBeenCalledWith({ data: expect.objectContaining({ firstName: "Pat", lastName: "Driver" }) });
    // The roster is only read, never written.
    expect(Object.keys(tx.clubRosterMember)).toEqual(["findMany"]);
  });

  it("refuses an extra person who isn't in the saved draft", async () => {
    const tx = fixture();
    await expect(submit({ ...baseInput, attendees: [{ clientId: "guest:notsaved01", responses: { first_name: "Walk", last_name: "In", attendee_age: "30" } }] }))
      .rejects.toMatchObject({ code: "CLUB_ATTENDEES_INVALID" });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("allows one registration per club per event", async () => {
    const tx = fixture();
    tx.clubEventRegistration.findUnique.mockResolvedValue({ id: "existing" });
    await expect(submit()).rejects.toMatchObject({ code: "CLUB_ALREADY_REGISTERED" });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("returns the same confirmation for a repeated submit instead of registering twice", async () => {
    const tx = fixture();
    await submit();
    const stored = tx.publicRegistrationSubmission.create.mock.calls[0][0].data;
    tx.publicRegistrationSubmission.findUnique.mockResolvedValue({
      ...stored,
      registrationId: "registration-1",
      registration: { confirmationCode: "REG-EXISTING", status: "SUBMITTED", waitlistEntry: null },
    });
    tx.clubEventRegistration.findUnique.mockResolvedValue({ id: "cer-1" });
    const replay = await submit();
    expect(replay).toMatchObject({ confirmationCode: "REG-EXISTING" });
    expect(tx.registration.create).toHaveBeenCalledTimes(1);
  });

  it("prices a club registration like any other registration, instead of saving $0 (#409)", async () => {
    const pricedForm = registrationFormDefinitionSchema.parse({
      title: "Priced club form",
      description: "",
      confirmationMessage: "Registered.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add" },
      sections: [
        { id: "contact", title: "Contact", description: "", fields: [
          field("c_first", "primary_contact_first_name", "First name", "TEXT", "REGISTRATION", true),
          field("c_last", "primary_contact_last_name", "Last name", "TEXT", "REGISTRATION", true),
          field("c_email", "email", "Email", "EMAIL", "REGISTRATION", true),
        ] },
        { id: "meals", title: "Meals", description: "", fields: [
          { ...field("s_count", "meal_sponsorship_count", "People sponsored", "NUMBER", "REGISTRATION"), creditCentsPerUnit: -500, capUnitsAtAttendeeCount: true },
        ] },
        { id: "roster", title: "Roster", description: "", fields: [
          field("a_first", "first_name", "First name", "TEXT", "ATTENDEE", true),
          field("a_last", "last_name", "Last name", "TEXT", "ATTENDEE", true),
          field("a_age", "attendee_age", "Age", "NUMBER", "ATTENDEE", true),
          field("a_diet", "dietary_needs", "Dietary needs", "LONG_TEXT", "ATTENDEE"),
          { ...field("a_fee", "registration_fee", "Registration fee", "CALCULATED", "ATTENDEE"), priceCents: 900 },
        ] },
      ],
    });
    const tx = fixture({ form: pricedForm });
    await submit({ ...baseInput, responses: { ...baseInput.responses, meal_sponsorship_count: 1 } });

    // 2 people × $9 − 1 person fed × $5 = $13, not $0: this is what the
    // church owes, never an attendee balance or a card payment.
    expect(tx.registration.create.mock.calls[0][0].data).toMatchObject({ totalAmount: 13 });
  });

  it("prices a club submitted after the late date at the late fee, through the real submit path (#409)", async () => {
    const lateForm = registrationFormDefinitionSchema.parse({
      title: "Late-priced club form",
      description: "",
      confirmationMessage: "Registered.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add" },
      sections: [
        { id: "contact", title: "Contact", description: "", fields: [
          field("c_first", "primary_contact_first_name", "First name", "TEXT", "REGISTRATION", true),
          field("c_last", "primary_contact_last_name", "Last name", "TEXT", "REGISTRATION", true),
          field("c_email", "email", "Email", "EMAIL", "REGISTRATION", true),
        ] },
        { id: "roster", title: "Roster", description: "", fields: [
          field("a_first", "first_name", "First name", "TEXT", "ATTENDEE", true),
          field("a_last", "last_name", "Last name", "TEXT", "ATTENDEE", true),
          field("a_age", "attendee_age", "Age", "NUMBER", "ATTENDEE", true),
          field("a_diet", "dietary_needs", "Dietary needs", "LONG_TEXT", "ATTENDEE"),
          {
            ...field("a_fee", "registration_fee", "Registration fee", "CALCULATED", "ATTENDEE"),
            priceCents: 900,
            latePricing: { startsOn: "2026-10-10", label: "Late registration", priceCents: 1400 },
          },
        ] },
      ],
    });

    // Before the late date: 2 people × $9.
    const early = fixture({ form: lateForm });
    await submit(baseInput, club(), new Date("2026-10-05T15:00:00.000Z"));
    expect(early.registration.create.mock.calls[0][0].data).toMatchObject({ totalAmount: 18 });

    // After the late date: 2 people × $14, still what the church owes.
    const late = fixture({ form: lateForm });
    await submit(baseInput, club(), new Date("2026-10-15T15:00:00.000Z"));
    expect(late.registration.create.mock.calls[0][0].data).toMatchObject({ totalAmount: 28 });
  });

  it("only runs for events billed to the church", async () => {
    const tx = fixture({ billingMode: "ATTENDEE_PAY" });
    await expect(submit()).rejects.toMatchObject({ code: "CLUB_REGISTRATION_UNAVAILABLE" });
    expect(tx.clubRosterMember.findMany).not.toHaveBeenCalled();
  });

  it("refuses a form that would copy birth dates into answers", async () => {
    fixture({ form: definition([field("a_dob", "date_of_birth", "Date of birth", "DATE", "ATTENDEE")]) });
    await expect(submit()).rejects.toMatchObject({ code: "CLUB_REGISTRATION_UNAVAILABLE" });
  });

  it("refuses a form that asks attendees for free-text medical notes (#408)", async () => {
    const tx = fixture({ form: definition([field("a_med", "medical_or_accessibility_notes", "Medical or accessibility notes", "LONG_TEXT", "ATTENDEE")]) });
    await expect(submit()).rejects.toMatchObject({ code: "CLUB_REGISTRATION_UNAVAILABLE" });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("refuses after the registration deadline", async () => {
    const tx = fixture({ registrationClosesOn: "2026-10-10" });
    await expect(submit()).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });
});
