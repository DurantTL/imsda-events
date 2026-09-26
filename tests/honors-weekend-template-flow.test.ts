import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Honors Weekend template, end to end (#436, acceptance criterion 2): a club
 * registers on a church-billed event using the shipped template, roster-owned
 * answers are locked and the role is prefilled, and class choices afterwards
 * use a seat for youth but not for staff. Synthetic data only.
 */

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
import { lockedAttendeeFieldKeys, rosterOwnedResponses, rosterRolePrefill, type RosterPerson } from "@/modules/club-registrations/domain";
import { clubAttendeePreparer } from "@/modules/club-registrations/repository";
import { getFormTemplate, registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { submitPublicRegistration } from "@/modules/forms/public-repository";
import { setClassSelections } from "@/modules/honors/enrollment-repository";

const definition = registrationFormDefinitionSchema.parse(getFormTemplate("honors_weekend")!.definition);

type Member = {
  id: string;
  personId: string;
  attendeeType: "YOUTH" | "STAFF" | "ADULT" | "UNDERAGE";
  role: string;
  gender: "FEMALE" | "MALE" | null;
  birthDate: string;
  firstName: string;
  lastName: string;
};

// Fictitious club roster: a Pathfinder, a TLT, a youth with no role, a staff
// member, and an underage child.
const roster: Member[] = [
  { id: "m1", personId: "person-m1", attendeeType: "YOUTH", role: "Pathfinder", gender: "FEMALE", birthDate: "2014-12-06", firstName: "Alex", lastName: "Sample" },
  { id: "m2", personId: "person-m2", attendeeType: "YOUTH", role: "TLT", gender: "MALE", birthDate: "2010-05-01", firstName: "Casey", lastName: "Demo" },
  { id: "m3", personId: "person-m3", attendeeType: "YOUTH", role: "", gender: null, birthDate: "2013-01-01", firstName: "Riley", lastName: "Placeholder" },
  { id: "m4", personId: "person-m4", attendeeType: "STAFF", role: "Counselor", gender: null, birthDate: "1988-03-02", firstName: "Jordan", lastName: "Example" },
  { id: "m5", personId: "person-m5", attendeeType: "UNDERAGE", role: "", gender: null, birthDate: "2020-06-01", firstName: "Sky", lastName: "Fixture" },
];
const ages: Record<string, number> = { m1: 11, m2: 16, m3: 13, m4: 38, m5: 6 };

const rosterPerson = (member: Member): RosterPerson => ({
  firstName: member.firstName,
  lastName: member.lastName,
  ageOnEventDate: ages[member.id]!,
  gender: member.gender,
  role: member.role,
  attendeeType: member.attendeeType,
});

type Enrollment = { id: string; offeringId: string; registrationAttendeeId: string; organizationId: string; consumesSeat: boolean };

function fixture() {
  const event = {
    id: "event-1", name: "Honors Weekend — Fictional Site", slug: "honors-weekend",
    startsAt: new Date("2026-12-05T15:00:00.000Z"), endsAt: new Date("2026-12-06T20:00:00.000Z"),
    timezone: "America/Chicago", location: "Fictional Camp", capacity: null, isPublished: true,
    registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30", waitlistEnabled: false,
    billingMode: "DEFERRED_ORGANIZATION_INVOICE", attendeeTypes: [],
  };
  const members = roster.map((member) => ({
    id: member.id, personId: member.personId, attendeeType: member.attendeeType, role: member.role, gender: member.gender,
    sealedBirthDate: sealSecret(member.birthDate, "club-roster:birth-date"),
    person: { firstName: member.firstName, lastName: member.lastName },
  }));
  const createdAttendees: Array<{ id: string; profileSnapshot: Record<string, unknown> }> = [];
  const enrollments: Enrollment[] = [];
  const seatRows = (where: { organizationId?: string }) => {
    const counts = new Map<string, number>();
    for (const row of enrollments) {
      if (!row.consumesSeat || (where.organizationId && row.organizationId !== where.organizationId)) continue;
      counts.set(row.offeringId, (counts.get(row.offeringId) ?? 0) + 1);
    }
    return [...counts].map(([offeringId, count]) => ({ offeringId, _count: { _all: count } }));
  };

  const db = {
    registrationForm: { findFirst: vi.fn().mockResolvedValue({
      id: "form-1", slug: "clubs", eventId: "event-1", event,
      versions: [{ id: "version-1", versionNumber: 1, definition, publishedAt: new Date("2026-09-01T00:00:00Z") }],
    }) },
    clubRosterMember: {
      findMany: vi.fn(async ({ where }: { where: { organizationId?: string; id?: { in: string[] } } }) => {
        if (where.id) return members.filter((member) => where.id!.in.includes(member.id)).map(({ id, attendeeType }) => ({ id, attendeeType }));
        return where.organizationId === "club-1" ? members : [];
      }),
    },
    clubEventRegistration: {
      // Nothing is registered until the submit below creates it.
      findUnique: vi.fn(async ({ select }: { select?: { registration?: unknown } }) => (
        select?.registration && createdAttendees.length > 0
          ? { event, registration: { id: "registration-1", status: "SUBMITTED", attendees: createdAttendees } }
          : null
      )),
      create: vi.fn().mockResolvedValue({ id: "cer-1" }),
    },
    clubRegistrationDraft: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    publicRegistrationSubmission: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: "submission-1" }) },
    registrationCapacityReservation: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() },
    registrationAttendee: {
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn(async ({ data }: { data: { personId: string; attendeeType: string; formResponses: Record<string, unknown>; profileSnapshot: Record<string, unknown> } }) => {
        const row = { id: `attendee-${data.personId}`, profileSnapshot: data.profileSnapshot };
        createdAttendees.push(row);
        return { id: row.id };
      }),
    },
    person: {
      upsert: vi.fn().mockResolvedValue({ id: "person-director", firstName: "Jamie", lastName: "Director", normalizedEmail: "director@example.test" }),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    registration: {
      create: vi.fn().mockResolvedValue({ id: "registration-1" }),
      findUnique: vi.fn().mockResolvedValue({ eventId: "event-1", confirmationCode: "REG-HW-DEMO", event: { endsAt: event.endsAt } }),
    },
    registrationAccessToken: { create: vi.fn().mockResolvedValue({ id: "access-1" }) },
    registrationWaitlistEntry: { aggregate: vi.fn(), create: vi.fn() },
    messageOutbox: { findMany: vi.fn().mockResolvedValue([]) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    honorOffering: { findMany: vi.fn().mockResolvedValue([{
      // One seat: the youth takes it, and staff still join without one.
      id: "knots", span: "SINGLE_SESSION", sessionId: "sabbath", capacity: 1, minimumAge: null, perClubLimit: null,
      teacherName: "Fictional Teacher", location: "Pavilion", isActive: true,
      honor: { name: "Knot Tying", code: "HW-DEMO-1" }, session: { name: "Sabbath afternoon", sortOrder: 1 },
    }]) },
    honorSession: { findMany: vi.fn().mockResolvedValue([{ id: "sabbath", name: "Sabbath afternoon" }]) },
    honorEnrollment: {
      findMany: vi.fn(async () => enrollments.map(({ id, registrationAttendeeId, offeringId }) => ({ id, registrationAttendeeId, offeringId }))),
      deleteMany: vi.fn(),
      createMany: vi.fn(async ({ data }: { data: Array<Omit<Enrollment, "id">> }) => {
        for (const row of data) enrollments.push({ ...row, id: `enrollment-${enrollments.length + 1}` });
        return { count: data.length };
      }),
      groupBy: vi.fn(async ({ where }: { where: { organizationId?: string } }) => seatRows(where)),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (operation: (client: unknown) => unknown) => operation(db)),
  };
  dependencies.getPrisma.mockReturnValue(db);
  return { db, enrollments };
}

const now = new Date("2026-10-15T15:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: "a-secret-encryption-key-of-adequate-length" });
  dependencies.processQueuedMessageIdsAfterCommit.mockResolvedValue({ capturedIds: [], sentIds: [], failedIds: [], rescheduledIds: [], skippedIds: [] });
  dependencies.enqueuePublicRegistrationMessages.mockResolvedValue({ messageIds: ["m"], pendingMessageIds: ["m"], registrantMessageIds: ["m"], deliveryMode: "LOCAL_CAPTURE" });
});

describe("Honors Weekend template, from club registration to class seats (#436)", () => {
  it("locks roster-owned answers and prefills each person's roster role", () => {
    expect(lockedAttendeeFieldKeys(definition)).toEqual(["first_name", "last_name", "attendee_age"]);
    expect(roster.map((member) => rosterRolePrefill(definition, rosterPerson(member)))).toEqual([
      { attendee_type: "Pathfinder" },
      { attendee_type: "TLT" },
      { attendee_type: "Pathfinder" },
      { attendee_type: "Staff" },
      { attendee_type: "Child" },
    ]);
  });

  it("registers the club on a church-billed event, then gives youth a class seat and staff and underage none", async () => {
    const { db, enrollments } = fixture();

    // The director's answers: the prefilled role, plus a name that isn't the
    // roster's, which the server must ignore.
    const attendees = roster.map((member) => ({
      clientId: `member:${member.id}`,
      responses: { ...rosterRolePrefill(definition, rosterPerson(member)), first_name: "Somebody", attendee_age: "99" },
    }));
    await submitPublicRegistration("honors-weekend", "clubs", publicRegistrationInputSchema.parse({
      versionId: "version-1",
      idempotencyKey: "6b1d7c52-0f7e-4d5c-9a3e-1c2b3d4e5f60",
      responses: { club_name: "Ankeny Son-Seekers", director_name: "Jamie Director", email: "director@example.test", phone: "555-0100" },
      attendees,
      website: "",
    }), now, { organizationId: "club-1", submittedByAccountId: "director-1", prepareAttendees: clubAttendeePreparer("club-1") });

    const created = db.registrationAttendee.create.mock.calls.map(([call]) => call.data);
    expect(created.map((data) => data.personId)).toEqual(roster.map((member) => member.personId));
    roster.forEach((member, index) => {
      expect(created[index]!.formResponses).toMatchObject({
        ...rosterOwnedResponses(definition, rosterPerson(member)),
        ...rosterRolePrefill(definition, rosterPerson(member)),
      });
    });
    // "Child" maps to the same attendee type as Spring Camporee.
    expect(created.map((data) => data.attendeeType)).toEqual(["ATTENDEE", "ATTENDEE", "ATTENDEE", "ATTENDEE", "CHILD"]);
    expect(db.registration.create.mock.calls[0]![0].data).toMatchObject({ totalAmount: 0 });
    expect(db.clubEventRegistration.create).toHaveBeenCalledWith({ data: { eventId: "event-1", organizationId: "club-1", registrationId: "registration-1", submittedByAccountId: "director-1", submittedByUserId: null } });
    expect(JSON.stringify(db.registrationAttendee.create.mock.calls)).not.toMatch(/Somebody|2014-12-06|1988-03-02/);

    // Class choices after the roster is saved: one-seat class, one youth, one
    // staff member, and one underage child (no seat either, #462).
    const workspace = await setClassSelections("club-1", "event-1", { accountId: "director-1" }, {
      "attendee-person-m1": ["knots"],
      "attendee-person-m4": ["knots"],
      "attendee-person-m5": ["knots"],
    }, now);

    expect(enrollments.map(({ registrationAttendeeId, consumesSeat }) => ({ registrationAttendeeId, consumesSeat }))).toEqual([
      { registrationAttendeeId: "attendee-person-m1", consumesSeat: true },
      { registrationAttendeeId: "attendee-person-m4", consumesSeat: false },
      { registrationAttendeeId: "attendee-person-m5", consumesSeat: false },
    ]);
    expect(workspace.offerings.find((offering) => offering.id === "knots")).toMatchObject({ capacity: 1, seatsTaken: 1 });
    expect(Object.fromEntries(workspace.attendees.map((attendee) => [attendee.id, attendee.consumesSeat]))).toMatchObject({
      "attendee-person-m1": true,
      "attendee-person-m4": false,
      "attendee-person-m5": false,
    });
    expect(workspace.selections).toEqual({ "attendee-person-m1": ["knots"], "attendee-person-m4": ["knots"], "attendee-person-m5": ["knots"] });
  });
});
