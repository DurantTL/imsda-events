import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  enqueuePublicRegistrationMessages: vi.fn(),
  enqueueWaitlistJoinedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: dependencies.processQueuedMessageIdsAfterCommit,
  enqueuePublicRegistrationMessages: dependencies.enqueuePublicRegistrationMessages,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({ enqueueWaitlistJoinedMessage: dependencies.enqueueWaitlistJoinedMessage }));

import { sealSecret } from "@/lib/secret-box";
import { clubAttendeePreparer, clubSubmissionAttribution } from "@/modules/club-registrations/repository";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { submitPublicRegistration, type ClubSubmissionContext } from "@/modules/forms/public-repository";

const field = (id: string, key: string, label: string, type: string, scope: "ATTENDEE" | "REGISTRATION", required = false) => (
  { id, key, label, helpText: "", type, scope, required, options: [] }
);

function definition(extraAttendeeFields: Record<string, unknown>[] = [], extraRegistrationFields: Record<string, unknown>[] = []) {
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
        ...extraRegistrationFields,
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

/** A directory-sourced club/church field pair (#482), matching the Honors
 * Weekend and Camporee templates. */
function directoryFields(): Record<string, unknown>[] {
  return [
    { id: "d_club", key: "club_name", label: "Pathfinder club", helpText: "", type: "SELECT", scope: "REGISTRATION", required: true, options: [], optionSource: "CLUBS_DIRECTORY" },
    { id: "d_club_other", key: "club_name_other", label: "Club — not listed", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [], conditional: { fieldKey: "club_name", operator: "EQUALS", value: "Not listed" } },
    { id: "d_church", key: "church_name", label: "Church", helpText: "", type: "SELECT", scope: "REGISTRATION", required: false, options: [], optionSource: "CHURCHES_DIRECTORY" },
  ];
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

function fixture({ billingMode = "DEFERRED_ORGANIZATION_INVOICE", audience = "CLUB", form = definition(), registrationClosesOn = "2026-11-30", waitlistEnabled = false } = {}) {
  const members = [
    { id: "m1", personId: "person-m1", attendeeType: "YOUTH", role: "Pathfinder", gender: "FEMALE", sealedBirthDate: sealSecret("2014-12-06", "club-roster:birth-date"), person: { firstName: "Alex", lastName: "Sample" } },
    { id: "m2", personId: "person-m2", attendeeType: "STAFF", role: "Counselor", gender: null, sealedBirthDate: sealSecret("1988-03-02", "club-roster:birth-date"), person: { firstName: "Jordan", lastName: "Example" } },
  ];
  const tx = {
    organization: {
      findUnique: vi.fn().mockResolvedValue({ name: "Test Pathfinders", parentOrganization: { name: "Test SDA Church", isActive: true } }),
      findMany: vi.fn(async ({ where }: { where: { type?: string } }) => (
        where.type === "CLUB" ? [{ name: "Test Pathfinders" }] : [{ name: "Test SDA Church" }]
      )),
    },
    registrationForm: { findFirst: vi.fn().mockResolvedValue({
      id: "form-1", slug: "clubs", eventId: "event-1",
      event: {
        id: "event-1", name: "Honors Weekend", slug: "honors-weekend",
        startsAt: new Date("2026-12-05T15:00:00.000Z"), endsAt: new Date("2026-12-06T20:00:00.000Z"),
        timezone: "America/Chicago", location: "Camp", capacity: null, isPublished: true,
        registrationOpensOn: "2026-10-01", registrationClosesOn, waitlistEnabled, billingMode, audience, attendeeTypes: [],
      },
      versions: [{ id: "version-1", versionNumber: 1, definition: form, publishedAt: new Date("2026-09-01T00:00:00Z") }],
    }) },
    clubRosterMember: { findMany: vi.fn(async ({ where }: { where: { organizationId: string } }) => (where.organizationId === "club-1" ? members : [])) },
    clubEventRegistration: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "cer-1" }) },
    eventLocation: { count: vi.fn().mockResolvedValue(0) },
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
    registrationWaitlistEntry: { aggregate: vi.fn(), create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null), count: vi.fn().mockResolvedValue(0) },
    locationWaitlistChange: { create: vi.fn().mockResolvedValue({ id: "change-1" }) },
    messageOutbox: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
  };
  dependencies.getPrisma.mockReturnValue({
    // Directory reads during submit must go through the transaction (#482).
    organization: {
      findUnique: vi.fn(() => { throw new Error("read the organization through the transaction"); }),
      findMany: vi.fn(() => { throw new Error("read the directory through the transaction"); }),
    },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  });
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
  dependencies.enqueueWaitlistJoinedMessage.mockResolvedValue({ messageIds: ["w"], pendingMessageIds: ["w"], deliveryMode: "LOCAL_CAPTURE", skippedReason: null });
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

  it("attributes a staff \"act as\" director's submission to the staff user and the act-as, never an attendee account (#442)", async () => {
    const tx = fixture();
    const acting: ClubSubmissionContext = {
      organizationId: "club-1",
      ...clubSubmissionAttribution({ userId: "admin-1", actAsId: "act-1" }),
      prepareAttendees: clubAttendeePreparer("club-1"),
    };
    await submit(baseInput, acting);
    expect(tx.clubEventRegistration.create).toHaveBeenCalledWith({ data: { eventId: "event-1", organizationId: "club-1", registrationId: "registration-1", submittedByAccountId: null, submittedByUserId: "admin-1" } });
    const audit = tx.auditLog.create.mock.calls.map(([call]) => call.data).find((data) => data.action === "CLUB_REGISTRATION_SUBMITTED");
    expect(audit).toMatchObject({ actorUserId: "admin-1", metadata: { clubOrganizationId: "club-1", submittedByStaffUserId: "admin-1", actAsId: "act-1" } });
    expect(audit.metadata).not.toHaveProperty("submittedByAttendeeAccountId");

    expect(clubSubmissionAttribution({ accountId: "director-1" })).toEqual({ submittedByAccountId: "director-1" });
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

  it("only runs for CLUB-audience events, even when billed to the church (#481)", async () => {
    const tx = fixture({ audience: "GENERAL" });
    await expect(submit()).rejects.toMatchObject({ code: "CLUB_REGISTRATION_UNAVAILABLE" });
    expect(tx.clubRosterMember.findMany).not.toHaveBeenCalled();
    expect(tx.registration.create).not.toHaveBeenCalled();
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

  it("locks the club directory field to the club's own Organization record, ignoring whatever the client sent (#482)", async () => {
    const tx = fixture({ form: definition([], directoryFields()) });
    await submit({
      ...baseInput,
      responses: {
        ...baseInput.responses,
        club_name: "A Made-Up Club",
        club_name_other: "Sneaky free text",
        church_name: "Test SDA Church",
      },
    });

    const submission = tx.publicRegistrationSubmission.create.mock.calls[0]![0].data;
    expect(submission.responses).toMatchObject({
      club_name: "Test Pathfinders",
      church_name: "Test SDA Church",
    });
    // The "Not listed" free-text companion no longer applies once locked to a
    // real directory match, so it is cleared rather than kept.
    expect(submission.responses.club_name_other).toBeFalsy();
    // Validated against the directory read inside the transaction.
    expect(tx.organization.findMany).toHaveBeenCalled();
  });

  it("keeps the church the director chose, even when it differs from the sponsoring church (#482)", async () => {
    const tx = fixture({ form: definition([], directoryFields()) });
    tx.organization.findMany.mockImplementation(async ({ where }: { where: { type?: string } }) => (
      where.type === "CLUB" ? [{ name: "Test Pathfinders" }] : [{ name: "Test SDA Church" }, { name: "Sample Chapel" }]
    ));
    await submit({ ...baseInput, responses: { ...baseInput.responses, church_name: "Sample Chapel" } });
    const submission = tx.publicRegistrationSubmission.create.mock.calls[0]![0].data;
    expect(submission.responses).toMatchObject({ club_name: "Test Pathfinders", church_name: "Sample Chapel" });
  });

  it("accepts a \"Not listed\" church with its typed name, never blocking the registration (#482)", async () => {
    const tx = fixture({ form: definition([], [
      ...directoryFields(),
      { id: "d_church_other", key: "church_name_other", label: "Church — not listed", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [], conditional: { fieldKey: "church_name", operator: "EQUALS", value: "Not listed" } },
    ]) });
    await submit({ ...baseInput, responses: { ...baseInput.responses, church_name: "Not listed", church_name_other: "Test Fellowship" } });
    const submission = tx.publicRegistrationSubmission.create.mock.calls[0]![0].data;
    expect(submission.responses).toMatchObject({ club_name: "Test Pathfinders", church_name: "Not listed", church_name_other: "Test Fellowship" });
  });

  it("refuses a church that is neither in the live directory nor \"Not listed\" (#482)", async () => {
    const tx = fixture({ form: definition([], directoryFields()) });
    await expect(submit({ ...baseInput, responses: { ...baseInput.responses, church_name: "A Made-Up Church" } }))
      .rejects.toMatchObject({ code: "INVALID_SUBMISSION" });
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("accepts a \"Not listed\" club with its typed name through the ordinary public submit (#482)", async () => {
    const tx = fixture({ form: definition([], directoryFields()), audience: "GENERAL", billingMode: "ATTENDEE_PAY" });
    tx.person.create.mockImplementation(async ({ data }: { data: { firstName: string; lastName: string } }) => ({ id: `person-${data.firstName}`, ...data }));
    tx.person.findUnique.mockResolvedValue(null);
    await submitPublicRegistration("honors-weekend", "clubs", publicRegistrationInputSchema.parse({
      ...baseInput,
      responses: { ...baseInput.responses, club_name: "Not listed", club_name_other: "Test Trailblazers" },
      attendees: [{ clientId: "attendee-1", responses: { first_name: "Alex", last_name: "Sample", attendee_age: "12" } }],
    }), now);
    const submission = tx.publicRegistrationSubmission.create.mock.calls[0]![0].data;
    expect(submission.responses).toMatchObject({ club_name: "Not listed", club_name_other: "Test Trailblazers" });
  });
});

describe("club registration submit at an event location (#413)", () => {
  type LocationRow = {
    id: string; eventId: string; name: string; address: string | null; firstDay: string | null; lastDay: string | null;
    capacity: number | null; registrationClosesOn: string | null; isActive: boolean;
  };
  const row = (overrides: Partial<LocationRow> = {}): LocationRow => ({
    id: "loc-1", eventId: "event-1", name: "Camp Heritage", address: "1 Synthetic Rd", firstDay: null, lastDay: null,
    capacity: null, registrationClosesOn: null, isActive: true, ...overrides,
  });

  /** The club fixture with the location lock and seat count wired the way Postgres answers them. */
  function located(options: { rows?: LocationRow[]; seatsAtLocation?: number; activeLocations?: number; fixtureOptions?: Parameters<typeof fixture>[0] } = {}) {
    const tx = fixture(options.fixtureOptions);
    const rows = options.rows ?? [row()];
    const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => rows.filter((candidate) => candidate.id === values[0]));
    const executeRaw = vi.fn().mockResolvedValue(0);
    tx.eventLocation.count.mockResolvedValue(options.activeLocations ?? rows.filter((candidate) => candidate.isActive).length);
    tx.registrationAttendee.count.mockImplementation(async ({ where }: { where: { registration?: { locationId?: string } } }) => (
      where.registration?.locationId ? options.seatsAtLocation ?? 0 : 0
    ));
    Object.assign(tx, { $queryRaw: queryRaw, $executeRawUnsafe: executeRaw });
    return { tx, queryRaw, executeRaw };
  }
  const at = (locationId: string | null, when = now) => submit(baseInput, { ...club(), locationId }, when);

  it("requires a pick when the event has active locations, and creates nothing without one", async () => {
    const { tx, queryRaw } = located({ activeLocations: 2 });
    await expect(at(null)).rejects.toMatchObject({ code: "LOCATION_REQUIRED" });
    expect(tx.registration.create).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("needs no pick, no lock, and records no location on an event without locations", async () => {
    const { tx, queryRaw, executeRaw } = located({ rows: [], activeLocations: 0 });
    await at(null);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(tx.registration.create.mock.calls[0]![0].data.locationId).toBeNull();
    expect(dependencies.enqueuePublicRegistrationMessages.mock.calls[0]![1].location).toBeNull();
  });

  it("locks the location row (5s wait only), records it on the registration, and names it in the confirmation", async () => {
    const { tx, queryRaw, executeRaw } = located({ rows: [row({ capacity: 10 })], seatsAtLocation: 3 });
    await at("loc-1");
    expect(executeRaw.mock.calls.map(([sql]) => sql)).toEqual(["SET LOCAL lock_timeout = '5s'", "SET LOCAL lock_timeout = 0"]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(String(queryRaw.mock.calls[0]![0].join(" "))).toContain("FOR UPDATE");
    expect(tx.registration.create.mock.calls[0]![0].data.locationId).toBe("loc-1");
    expect(tx.auditLog.create.mock.calls.map(([call]) => call.data).find((data) => data.action === "CLUB_REGISTRATION_SUBMITTED")?.metadata)
      .toMatchObject({ clubOrganizationId: "club-1", locationId: "loc-1" });
    // The event's own dates fill in what the location leaves unset.
    expect(dependencies.enqueuePublicRegistrationMessages.mock.calls[0]![1].location)
      .toEqual({ name: "Camp Heritage", address: "1 Synthetic Rd", firstDay: "2026-12-05", lastDay: "2026-12-06" });
  });

  it("refuses more people than the location has room for, counting people like the event capacity", async () => {
    const { tx } = located({ rows: [row({ capacity: 3 })], seatsAtLocation: 2 });
    // Two people are going and one seat is left.
    await expect(at("loc-1")).rejects.toMatchObject({ code: "LOCATION_FULL", message: "Only 1 spot remains at Camp Heritage." });
    expect(tx.registration.create).not.toHaveBeenCalled();
    located({ rows: [row({ capacity: 4 })], seatsAtLocation: 2 });
    await expect(at("loc-1")).resolves.toMatchObject({ registrationStatus: "SUBMITTED" });
  });

  describe("when the location is full and the event has a waitlist (#599)", () => {
    /** The club link exists by the time the change is recorded, which reads it back. */
    const waitlistedAt = (options: Parameters<typeof located>[0] = {}) => {
      const built = located({ rows: [row({ capacity: 3 })], seatsAtLocation: 2, ...options, fixtureOptions: { waitlistEnabled: true, ...options.fixtureOptions } });
      built.tx.registrationWaitlistEntry.aggregate.mockResolvedValue({ _max: { position: 6 } });
      // The club is second in line at its own location, though event-wide position 7 follows six others.
      built.tx.registrationWaitlistEntry.findUnique.mockResolvedValue({ position: 7, status: "WAITING" });
      built.tx.registrationWaitlistEntry.count.mockResolvedValue(2);
      built.tx.registration.findUnique.mockResolvedValue({
        eventId: "event-1", confirmationCode: "REG-CLUB", event: { endsAt: new Date("2026-12-06T20:00:00Z") },
        locationId: "loc-1", location: { name: "Camp Heritage" }, _count: { attendees: 2 }, clubRegistration: { organization: { name: "Test Pathfinders" } },
      });
      return built;
    };

    it("waitlists the registration at that location instead of refusing it, and takes no seats", async () => {
      const { tx } = waitlistedAt();
      // Two people are going and one seat is left: the location can't take them, so they wait for it.
      const confirmation = await at("loc-1");
      expect(confirmation).toMatchObject({ registrationStatus: "WAITLISTED", capacityDecision: "WAITLIST", paymentEligible: false });
      expect(tx.registration.create.mock.calls[0]![0].data).toMatchObject({ status: "WAITLISTED", locationId: "loc-1" });
      expect(tx.registrationWaitlistEntry.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventId: "event-1", registrationId: "registration-1", position: 7, attendeeCount: 2 }) });
      expect(tx.registrationCapacityReservation.createMany).not.toHaveBeenCalled();
    });

    it("says the club's place in line at its location, not the event-wide position", async () => {
      const { tx } = waitlistedAt();
      const confirmation = await at("loc-1");
      expect(confirmation.waitlistPosition).toBe(2);
      expect(tx.registrationWaitlistEntry.count).toHaveBeenCalledWith({ where: { status: "WAITING", position: { lte: 7 }, registration: { locationId: "loc-1" } } });
      expect(dependencies.enqueueWaitlistJoinedMessage).toHaveBeenCalledWith(tx, expect.objectContaining({ registrationId: "registration-1", recipientEmail: "director@example.test", waitlistPosition: 2 }));
      expect(dependencies.enqueuePublicRegistrationMessages).not.toHaveBeenCalled();
    });

    it("records the join for the coordinator and staff digest, with the club, the people and the place", async () => {
      const { tx } = waitlistedAt();
      await at("loc-1");
      expect(tx.locationWaitlistChange.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          kind: "JOINED", eventId: "event-1", locationId: "loc-1", registrationId: "registration-1",
          clubName: "Test Pathfinders", locationName: "Camp Heritage", attendeeCount: 2, place: 2,
        }),
      }));
    });

    it("still locks the location under the same admission path, and refuses a closed location before waitlisting", async () => {
      const { queryRaw } = waitlistedAt();
      await at("loc-1");
      expect(queryRaw).toHaveBeenCalledTimes(1);
      waitlistedAt({ rows: [row({ capacity: 3, registrationClosesOn: "2026-10-10" })] });
      await expect(at("loc-1")).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    });

    it("does not waitlist a club that fits: it registers and takes its seats", async () => {
      const { tx } = located({ rows: [row({ capacity: 4 })], seatsAtLocation: 2, fixtureOptions: { waitlistEnabled: true } });
      await expect(at("loc-1")).resolves.toMatchObject({ registrationStatus: "SUBMITTED" });
      expect(tx.registrationWaitlistEntry.create).not.toHaveBeenCalled();
      expect(tx.locationWaitlistChange.create).not.toHaveBeenCalled();
    });

    it("keeps refusing with LOCATION_FULL when the event has no waitlist", async () => {
      const { tx } = located({ rows: [row({ capacity: 3 })], seatsAtLocation: 2 });
      await expect(at("loc-1")).rejects.toMatchObject({ code: "LOCATION_FULL" });
      expect(tx.registration.create).not.toHaveBeenCalled();
      expect(tx.registrationWaitlistEntry.create).not.toHaveBeenCalled();
      expect(tx.locationWaitlistChange.create).not.toHaveBeenCalled();
    });

    it("can still be refused for a reason other than being full, waitlist or not", async () => {
      located({ rows: [row({ isActive: false })], activeLocations: 1, fixtureOptions: { waitlistEnabled: true } });
      await expect(at("loc-1")).rejects.toMatchObject({ code: "LOCATION_INVALID" });
    });
  });

  it("refuses an unknown, another event's, or inactive location", async () => {
    located({ rows: [row()] });
    await expect(at("elsewhere")).rejects.toMatchObject({ code: "LOCATION_INVALID" });
    const inactive = located({ rows: [row({ isActive: false })], activeLocations: 1 });
    await expect(at("loc-1")).rejects.toMatchObject({ code: "LOCATION_INVALID" });
    expect(inactive.tx.registration.create).not.toHaveBeenCalled();
  });

  it("closes only the location past its own closing date", async () => {
    located({ rows: [row({ id: "early", registrationClosesOn: "2026-10-10" }), row({ id: "open" })] });
    await expect(at("early")).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    await expect(at("open")).resolves.toMatchObject({ registrationStatus: "SUBMITTED" });
    // Before its closing date the same location takes the registration.
    located({ rows: [row({ id: "early", registrationClosesOn: "2026-10-10" })] });
    await expect(at("early", new Date("2026-10-05T15:00:00Z"))).resolves.toMatchObject({ registrationStatus: "SUBMITTED" });
  });

  it("closes a location after its own last day, and lets one run later than the event", async () => {
    // The event closed registration on Oct 10; this location closes Dec 15 and ends Dec 20.
    const laterRow = row({ firstDay: "2026-12-19", lastDay: "2026-12-20", registrationClosesOn: "2026-12-15" });
    located({ rows: [laterRow], fixtureOptions: { registrationClosesOn: "2026-10-10" } });
    await expect(at("loc-1", new Date("2026-12-10T15:00:00Z"))).resolves.toMatchObject({ registrationStatus: "SUBMITTED" });
    located({ rows: [{ ...laterRow, registrationClosesOn: null }], fixtureOptions: { registrationClosesOn: "2026-10-10" } });
    await expect(at("loc-1", new Date("2026-12-21T15:00:00Z"))).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
    // The event's own dates still close a location that has none of its own.
    located({ rows: [row()], fixtureOptions: { registrationClosesOn: "2026-10-10" } });
    await expect(at("loc-1")).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
  });

  it("says the location is closed, not the whole event, and names it", async () => {
    located({ rows: [row({ registrationClosesOn: "2026-10-10" })] });
    await expect(at("loc-1")).rejects.toMatchObject({ code: "REGISTRATION_CLOSED", message: "Registration for Camp Heritage is closed. Registration closed after 2026-10-10 in the event timezone." });
    located({ rows: [row({ lastDay: "2026-10-01" })] });
    await expect(at("loc-1")).rejects.toMatchObject({ code: "REGISTRATION_CLOSED", message: "Registration for Camp Heritage has closed." });
    located({ rows: [row()], fixtureOptions: { registrationClosesOn: "2026-11-30" } });
    await expect(at("loc-1", new Date("2026-09-01T15:00:00Z"))).rejects.toMatchObject({ code: "REGISTRATION_NOT_OPEN", message: expect.stringContaining("Registration for Camp Heritage is not open yet.") });
  });

  it("reports a closed location before a full one", async () => {
    located({ rows: [row({ capacity: 1, registrationClosesOn: "2026-10-10" })], seatsAtLocation: 1 });
    await expect(at("loc-1")).rejects.toMatchObject({ code: "REGISTRATION_CLOSED" });
  });

  it("gives up on a held location lock as a retryable busy, once, and writes nothing", async () => {
    const { tx, queryRaw } = located();
    queryRaw.mockRejectedValue(Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }));
    await expect(at("loc-1")).rejects.toMatchObject({ name: "EventLocationError", code: "LOCATION_BUSY" });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.registration.create).not.toHaveBeenCalled();
  });

  it("takes no location lock for a club that is already registered", async () => {
    const { tx, queryRaw } = located();
    tx.clubEventRegistration.findUnique.mockResolvedValue({ id: "cer-existing" });
    await expect(at("loc-1")).rejects.toMatchObject({ code: "CLUB_ALREADY_REGISTERED" });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("gives the submit transaction room for the lock wait", async () => {
    located();
    await at("loc-1");
    const prisma = dependencies.getPrisma() as { $transaction: ReturnType<typeof vi.fn> };
    expect(prisma.$transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel: "Serializable", timeout: 20_000 });
  });
});
