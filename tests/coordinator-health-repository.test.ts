import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  eventFindUnique: vi.fn(),
  eventFindMany: vi.fn(),
  registrationFindMany: vi.fn(),
  rosterFindMany: vi.fn(),
  submissionFindMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    event: { findUnique: mocks.eventFindUnique, findMany: mocks.eventFindMany },
    clubEventRegistration: { findMany: mocks.registrationFindMany },
    clubRosterMember: { findMany: mocks.rosterFindMany },
    clubFormSubmission: { findMany: mocks.submissionFindMany },
  }),
}));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-health-view-tests", APP_BASE_URL: "https://events.imsda.test" }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import type { HealthViewer } from "@/modules/coordinator-health/domain";
import { HealthViewError, listHealthEvents, loadEventHealth } from "@/modules/coordinator-health/repository";

const now = new Date("2026-10-20T15:00:00Z");
const event = { id: "e1", name: "Synthetic Camporee", startsAt: new Date("2026-10-09T15:00:00Z"), endsAt: new Date("2026-10-11T22:00:00Z"), timezone: "America/Chicago" };

const admin: HealthViewer = { kind: "SYSTEM_ADMIN", userId: "root" };
const coordinator: HealthViewer = { kind: "AREA_COORDINATOR", accountId: "acct-ac" };
const roleHolder: HealthViewer = { kind: "HEALTH_ROLE", userId: "u-role", eventIds: ["e1"] };
const ownLeader: HealthViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-dir" } };

// Synthetic values only.
const PHYSICIAN = "Dr. Synthetic Physician";
const CLINIC = "Synthetic Clinic";
const SLIP_PHONE = "555-0142";
const PASSENGER_CONTACT = "Parent Test 555-0177";
const DIETARY = "Synthetic tree-nut allergy";

function attendee(id: string, personId: string, first: string, last: string, responses: Record<string, unknown> = {}) {
  return { id, personId, formResponses: responses, person: { firstName: first, lastName: last } };
}

function seed() {
  mocks.eventFindUnique.mockResolvedValue(event);
  mocks.registrationFindMany.mockResolvedValue([
    {
      organization: { id: "club-a", name: "Synthetic Club A" },
      registration: {
        attendees: [
          attendee("att-1", "p1", "Avery", "Test", { dietary_needs: DIETARY, medical_or_accessibility_need: "Yes", shirt_size: "Youth M" }),
          attendee("att-2", "p2", "Blake", "Test", { dietary_needs: "", medical_or_accessibility_need: "No" }),
          attendee("att-3", "p3", "Casey", "Test"),
        ],
      },
    },
  ]);
  mocks.rosterFindMany.mockResolvedValue([
    { id: "r1", organizationId: "club-a", personId: "p1" },
    { id: "r2", organizationId: "club-a", personId: "p2" },
  ]);
  mocks.submissionFindMany.mockResolvedValue([
    {
      id: "sub-slip",
      organizationId: "club-a",
      rosterMemberId: "r1",
      answers: { child_name: "Avery Test", activity: "Synthetic hike" },
      sealedSensitiveAnswers: sealSensitiveAnswers("sub-slip", {
        physician_name: PHYSICIAN, physician_phone: "555-0111", clinic_name: CLINIC, clinic_phone: "555-0112", emergency_contact_phone: SLIP_PHONE,
      }),
      submittedAt: new Date("2026-10-02T15:00:00Z"),
      template: { key: "off_premises_permission_slip", name: "Off-Premises Permission Slip" },
    },
    {
      id: "sub-slip-other",
      organizationId: "club-a",
      rosterMemberId: "r-unrelated",
      answers: {},
      sealedSensitiveAnswers: sealSensitiveAnswers("sub-slip-other", { emergency_contact_phone: "555-0000" }),
      submittedAt: new Date("2026-10-02T15:00:00Z"),
      template: { key: "off_premises_permission_slip", name: "Off-Premises Permission Slip" },
    },
    {
      id: "sub-list",
      organizationId: "club-a",
      rosterMemberId: null,
      answers: { passenger_1_name: "Blake Test", passenger_2_name: "Someone Else" },
      sealedSensitiveAnswers: sealSensitiveAnswers("sub-list", { passenger_1_emergency_contact: PASSENGER_CONTACT, passenger_2_emergency_contact: "Other Person 555-0001" }),
      submittedAt: new Date("2026-10-03T15:00:00Z"),
      template: { key: "transportation_passenger_list", name: "Transportation Passenger List" },
    },
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
});

describe("loadEventHealth (#658)", () => {
  it("shows only the approved fields, each tied to its source form and date", async () => {
    const sheet = await loadEventHealth(admin, "e1", {}, now);
    const [club] = sheet.clubs;
    const [avery, blake, casey] = club.attendees;
    expect(avery).toMatchObject({ name: "Avery Test", dietary: DIETARY, medicalFlag: "Yes" });
    expect(avery.emergencyContacts).toEqual([
      { value: SLIP_PHONE, formName: "Off-Premises Permission Slip", submittedOn: "2026-10-02", matchedBy: "ROSTER_MEMBER", kind: "PHONE_ONLY", forThisEvent: false },
    ]);
    expect(blake).toMatchObject({ dietary: null, medicalFlag: "No" });
    expect(blake.emergencyContacts).toEqual([
      { value: PASSENGER_CONTACT, formName: "Transportation Passenger List", submittedOn: "2026-10-03", matchedBy: "NAME", kind: "NAME_AND_PHONE", forThisEvent: false },
    ]);
    expect(casey).toMatchObject({ dietary: null, medicalFlag: null, emergencyContacts: [] });
  });

  it("never returns physician, clinic, other registration answers, or another person's contact", async () => {
    const text = JSON.stringify(await loadEventHealth(admin, "e1", {}, now));
    for (const secret of [PHYSICIAN, CLINIC, "555-0111", "555-0112", "555-0000", "Other Person", "Youth M", "Synthetic hike"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("writes the audit row first, with who, event and counts but no health text", async () => {
    await loadEventHealth(coordinator, "e1", {}, now);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = mocks.writeAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      eventId: "e1",
      action: "COORDINATOR_HEALTH_VIEWED",
      entityType: "Event",
      entityId: "e1",
      metadata: { viewerKind: "AREA_COORDINATOR", actorAttendeeAccountId: "acct-ac", purpose: "VIEW", clubCount: 1, attendeeCount: 3, organizationId: null },
    });
    const logged = JSON.stringify(entry);
    for (const text of [DIETARY, SLIP_PHONE, PASSENGER_CONTACT, "Avery", "Blake", "Casey"]) expect(logged).not.toContain(text);
    // The audit happened before the submissions (and their sealed answers) were read.
    expect(mocks.writeAuditLog.mock.invocationCallOrder[0]).toBeLessThan(mocks.submissionFindMany.mock.invocationCallOrder[0]);
  });

  it("audits a printed sheet as an export", async () => {
    await loadEventHealth(admin, "e1", { purpose: "EXPORT" }, now);
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "COORDINATOR_HEALTH_EXPORTED", metadata: { purpose: "EXPORT", viewerKind: "SYSTEM_ADMIN" }, actorUserId: "root" });
  });

  it("returns nothing and reads no sealed answer when the audit write fails", async () => {
    mocks.writeAuditLog.mockRejectedValueOnce(new Error("audit down"));
    await expect(loadEventHealth(admin, "e1", {}, now)).rejects.toThrow("audit down");
    expect(mocks.submissionFindMany).not.toHaveBeenCalled();
  });

  it("closes for everyone, system administrators included, 30 days after the event ends, audits the refusal and reads nothing", async () => {
    const late = new Date("2026-11-12T15:00:00Z");
    for (const viewer of [admin, coordinator, roleHolder, ownLeader]) {
      await expect(loadEventHealth(viewer, "e1", {}, late)).rejects.toMatchObject({ code: "WINDOW_CLOSED" });
    }
    expect(mocks.registrationFindMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(4);
    for (const [entry] of mocks.writeAuditLog.mock.calls) {
      expect(entry).toMatchObject({ action: "COORDINATOR_HEALTH_DENIED", eventId: "e1", metadata: { reason: "WINDOW_CLOSED" } });
    }
  });

  it("is still open on the last day of the window", async () => {
    await expect(loadEventHealth(admin, "e1", {}, new Date("2026-11-10T20:00:00Z"))).resolves.toMatchObject({ clubs: expect.any(Array) });
  });

  it("refuses a role holder for an event they were not granted, before reading anything", async () => {
    await expect(loadEventHealth({ ...roleHolder, eventIds: ["e2"] }, "e1", {}, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.registrationFindMany).not.toHaveBeenCalled();
    expect(mocks.submissionFindMany).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "COORDINATOR_HEALTH_DENIED", metadata: { reason: "FORBIDDEN", viewerKind: "HEALTH_ROLE" } });
  });

  it("limits a club leader to their own club and answers 'not found' for another", async () => {
    await loadEventHealth(ownLeader, "e1", {}, now);
    expect(mocks.registrationFindMany.mock.calls[0][0].where).toMatchObject({ eventId: "e1", organizationId: "club-a" });
    await expect(loadEventHealth(ownLeader, "e1", { organizationId: "club-b" }, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(2);
    expect(mocks.writeAuditLog.mock.calls[1][0]).toMatchObject({ action: "COORDINATOR_HEALTH_DENIED", metadata: { reason: "NOT_FOUND" } });
  });

  it("narrows to one club when asked, for viewers who see every club", async () => {
    await loadEventHealth(coordinator, "e1", { organizationId: "club-a" }, now);
    expect(mocks.registrationFindMany.mock.calls[0][0].where).toMatchObject({ organizationId: "club-a" });
    expect(mocks.writeAuditLog.mock.calls[0][0].metadata).toMatchObject({ organizationId: "club-a" });
  });

  it("answers 'not found' for an unknown event", async () => {
    mocks.eventFindUnique.mockResolvedValue(null);
    await expect(loadEventHealth(admin, "nope", {}, now)).rejects.toBeInstanceOf(HealthViewError);
    expect(mocks.writeAuditLog.mock.calls[0][0]).not.toHaveProperty("eventId");
  });

  it("reads only submitted slips and passenger lists for the club year of the event", async () => {
    await loadEventHealth(admin, "e1", {}, now);
    const where = mocks.submissionFindMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "SUBMITTED" });
    expect(where.clubYear.in).toEqual(["2026-27"]);
    expect(where.template.key.in.sort()).toEqual(["off_premises_permission_slip", "transportation_passenger_list"]);
  });
});

describe("emergency contact matching (#658)", () => {
  function listWith(names: Array<[string, string]>, listAnswers: Record<string, unknown>, sealed: Record<string, unknown>) {
    mocks.registrationFindMany.mockResolvedValue([
      {
        organization: { id: "club-a", name: "Synthetic Club A" },
        registration: { attendees: names.map(([first, last], index) => attendee(`att-${index}`, `p${index}`, first, last)) },
      },
    ]);
    mocks.rosterFindMany.mockResolvedValue([]);
    mocks.submissionFindMany.mockResolvedValue([
      {
        id: "sub-list", organizationId: "club-a", rosterMemberId: null, answers: listAnswers,
        sealedSensitiveAnswers: sealSensitiveAnswers("sub-list", sealed), submittedAt: new Date("2026-10-03T15:00:00Z"),
        template: { key: "transportation_passenger_list", name: "Transportation Passenger List" },
      },
    ]);
  }

  it("does not attach a passenger-list contact when two attendees share the name, and says so", async () => {
    listWith([["Avery", "Test"], ["Avery", "Test"], ["Blake", "Test"]], { passenger_1_name: "Avery Test" }, { passenger_1_emergency_contact: PASSENGER_CONTACT });
    const [first, second, third] = (await loadEventHealth(admin, "e1", {}, now)).clubs[0].attendees;
    for (const row of [first, second]) {
      expect(row.emergencyContacts).toEqual([]);
      expect(row.emergencyStatus).toBe("AMBIGUOUS_NAME");
    }
    expect(third.emergencyStatus).toBe("NO_CONTACT_MATCHED");
    expect(JSON.stringify(await loadEventHealth(admin, "e1", {}, now))).not.toContain(PASSENGER_CONTACT);
  });

  it("says 'no contact matched' when the club has passenger lists but nothing matched, and 'none on file' when it has none", async () => {
    listWith([["Casey", "Test"]], { passenger_1_name: "Someone Else" }, { passenger_1_emergency_contact: "Other 555-0001" });
    expect((await loadEventHealth(admin, "e1", {}, now)).clubs[0].attendees[0].emergencyStatus).toBe("NO_CONTACT_MATCHED");
    mocks.submissionFindMany.mockResolvedValue([]);
    expect((await loadEventHealth(admin, "e1", {}, now)).clubs[0].attendees[0].emergencyStatus).toBe("NONE_ON_FILE");
  });

  it("finds a slip through any of a person's roster rows, and lists slips for this event first", async () => {
    mocks.registrationFindMany.mockResolvedValue([
      { organization: { id: "club-a", name: "Synthetic Club A" }, registration: { attendees: [attendee("att-1", "p1", "Avery", "Test")] } },
    ]);
    // Two club years (the event spans September): two roster rows for the same person.
    mocks.rosterFindMany.mockResolvedValue([
      { id: "r-old", organizationId: "club-a", personId: "p1" },
      { id: "r-new", organizationId: "club-a", personId: "p1" },
    ]);
    const slip = (id: string, rosterMemberId: string, phone: string, activity: string) => ({
      id, organizationId: "club-a", rosterMemberId, answers: { activity_date: activity },
      sealedSensitiveAnswers: sealSensitiveAnswers(id, { emergency_contact_phone: phone }), submittedAt: new Date("2026-09-20T15:00:00Z"),
      template: { key: "off_premises_permission_slip", name: "Off-Premises Permission Slip" },
    });
    mocks.submissionFindMany.mockResolvedValue([
      slip("s-other-day", "r-old", "555-0201", "2026-08-01"),
      slip("s-this-event", "r-new", "555-0202", "2026-10-10"),
    ]);
    const contacts = (await loadEventHealth(admin, "e1", {}, now)).clubs[0].attendees[0].emergencyContacts;
    expect(contacts.map((contact) => [contact.value, contact.forThisEvent])).toEqual([["555-0202", true], ["555-0201", false]]);
  });
});

describe("listHealthEvents (#658)", () => {
  it("lists events whose window is open, scoped to the viewer, with names and dates only", async () => {
    mocks.eventFindMany.mockResolvedValue([
      event,
      { ...event, id: "e0", name: "Old Synthetic Event", endsAt: new Date("2026-08-01T22:00:00Z") },
      { ...event, id: "e2", name: "Other Synthetic Event" },
    ]);
    const forAdmin = await listHealthEvents(admin, now);
    expect(forAdmin.map((row) => row.id)).toEqual(["e1", "e2"]);
    expect(forAdmin[0]).toMatchObject({ availableThrough: "2026-11-10" });
    expect((await listHealthEvents({ ...roleHolder, eventIds: ["e2"] }, now)).map((row) => row.id)).toEqual(["e2"]);
    await listHealthEvents(ownLeader, now);
    expect(mocks.eventFindMany.mock.calls.at(-1)?.[0].where.clubRegistrations).toEqual({ some: { organizationId: "club-a" } });
  });
});
