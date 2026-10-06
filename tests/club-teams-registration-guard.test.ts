import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getTeamSettings: vi.fn(), writeAuditLog: vi.fn(), syncTeamMemberPermissions: vi.fn() }));
vi.mock("@/modules/club-teams/permission-repository", () => ({ syncTeamMemberPermissions: mocks.syncTeamMemberPermissions }));
vi.mock("@/modules/club-rosters/birth-dates", () => ({ openBirthDate: (value: string) => value.replace("sealed:", "") }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/club-teams/settings-repository", () => ({ getTeamSettings: mocks.getTeamSettings }));

import { enforceTeamRegistrationRules, peopleOnOtherTeams } from "@/modules/club-teams/registration-guard";

const settings = { allowMultipleTeams: true, minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1, maxMemberAge: 19, ageAsOf: "2026-01-01", booksLine: "", levelInfo: [] };
const attendee = (id: string, name: string, extra: { age?: number; temporary?: boolean; teamRole?: string; responses?: Record<string, unknown> } = {}) => {
  const [firstName, lastName] = name.split(" ");
  return {
    id, personId: `person-${id}`,
    profileSnapshot: { firstName, lastName, ...(extra.age !== undefined ? { ageOnEventDate: extra.age } : {}), ...(extra.temporary ? { temporary: true } : {}), ...(extra.teamRole ? { teamRole: extra.teamRole } : {}) },
    formResponses: { attendee_type: "Pathfinder", ...(extra.responses ?? {}) },
  };
};

function transaction(options: { team?: unknown; attendees: unknown[]; others?: Array<{ personId: string; name: string; temporary?: boolean }>; roster?: unknown[] }) {
  const tx = {
    clubEventRegistration: {
      findUnique: vi.fn().mockResolvedValue("team" in options ? options.team : {
        eventId: "event-1", id: "cer-1", organizationId: "club-1", registration: { event: { startsAt: new Date("2027-01-16T18:00:00Z"), timezone: "America/Chicago" } },
      }),
    },
    registrationAttendee: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        if (args.where.registrationId) return options.attendees;
        return (options.others ?? []).map((other) => ({
          personId: other.personId,
          profileSnapshot: { firstName: other.name.split(" ")[0], lastName: other.name.split(" ")[1], ...(other.temporary ? { temporary: true } : {}) },
        }));
      }),
      update: vi.fn(),
    },
    clubRosterMember: { findMany: vi.fn().mockResolvedValue(options.roster ?? []) },
  };
  return tx as never as Parameters<typeof enforceTeamRegistrationRules>[0] & typeof tx;
}

const rosterOf = (...ids: string[]) => ids.map((id) => ({ personId: `person-${id}`, attendeeType: "YOUTH", classLevel: null, sealedBirthDate: null }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTeamSettings.mockResolvedValue(settings);
  mocks.syncTeamMemberPermissions.mockResolvedValue({ declined: [], queuedMessageIds: [] });
});

describe("enforceTeamRegistrationRules (#809)", () => {
  it("leaves a registration that has no club registration row alone", async () => {
    const tx = transaction({ team: null, attendees: [] });
    await enforceTeamRegistrationRules(tx, "reg-1");
    expect(mocks.getTeamSettings).not.toHaveBeenCalled();
  });

  it("leaves an event without team rules alone", async () => {
    mocks.getTeamSettings.mockResolvedValue(null);
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 })] });
    await enforceTeamRegistrationRules(tx, "reg-1");
    expect(tx.registrationAttendee.findMany).not.toHaveBeenCalled();
  });

  it("checks a one-team-per-club event with team rules too, but not the one-team-per-person rule", async () => {
    mocks.getTeamSettings.mockResolvedValue({ ...settings, allowMultipleTeams: false });
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 })], others: [{ personId: "person-a", name: "Alex One" }], roster: rosterOf("a") });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ code: "TEAM_RULES", message: expect.stringContaining("at least 2 team members") });
    const okTx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Blake Two", { age: 15 })], others: [{ personId: "person-a", name: "Alex One" }], roster: rosterOf("a", "b") });
    await enforceTeamRegistrationRules(okTx, "reg-1");
  });

  it("reads the settings inside the transaction it was given, and passes a team that keeps the rules", async () => {
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Blake Two", { age: 15 })], roster: rosterOf("a", "b") });
    await enforceTeamRegistrationRules(tx, "reg-1");
    expect(mocks.getTeamSettings).toHaveBeenCalledWith("event-1", tx);
  });

  it("refuses a staff change down to one team member, with the same message the director sees", async () => {
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 })] });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ code: "TEAM_RULES", message: expect.stringContaining("A team needs at least 2 team members; this one has 1.") });
  });

  it("refuses nine team members and three alternates", async () => {
    const nine = Array.from({ length: 9 }, (_, index) => attendee(`m${index}`, `Member N${index}`, { age: 14, responses: { alternate: index < 3 } }));
    const error = (await enforceTeamRegistrationRules(transaction({ attendees: nine }), "reg-1").then(() => null, (caught: unknown) => caught)) as { problems: string[] };
    expect(error.problems.join(" ")).toContain("at most 7 team members");
    expect(error.problems.join(" ")).toContain("Only 1 team member can be the alternate");
  });

  it("hands the people to the permission flags with their age and role, and passes on the messages it queued", async () => {
    mocks.syncTeamMemberPermissions.mockResolvedValue({ declined: [], queuedMessageIds: ["msg-1"] });
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Blake Two", { age: 18, responses: { attendee_type: "TLT" } })], roster: rosterOf("a", "b") });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).resolves.toEqual({ queuedMessageIds: ["msg-1"] });
    expect(mocks.syncTeamMemberPermissions).toHaveBeenCalledWith(tx, expect.objectContaining({
      clubEventRegistrationId: "cer-1", registrationId: "reg-1",
      people: [expect.objectContaining({ attendeeId: "a", age: 14, role: "MEMBER" }), expect.objectContaining({ attendeeId: "b", age: 18, role: "MEMBER" })],
    }));
  });

  it("refuses the save while a declined person is still a team member", async () => {
    mocks.syncTeamMemberPermissions.mockResolvedValue({ declined: ["Blake Two"], queuedMessageIds: [] });
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Blake Two", { age: 18 })], roster: rosterOf("a", "b") });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ code: "TEAM_RULES", message: expect.stringContaining("declined permission for Blake Two") });
  });

  it("works out the role of a person staff added from the age answered on the form, and saves it", async () => {
    const tx = transaction({ attendees: [
      { ...attendee("a", "Alex One"), formResponses: { attendee_type: "Pathfinder", attendee_age: "14" } },
      { ...attendee("b", "Blake Two"), formResponses: { attendee_type: "Pathfinder", attendee_age: "15" } },
      { ...attendee("c", "Coach Three"), formResponses: { attendee_type: "Coach", attendee_age: "40" } },
    ] });
    await enforceTeamRegistrationRules(tx, "reg-1");
    const saved = tx.registrationAttendee.update.mock.calls.map(([call]) => (call as { data: { profileSnapshot: { teamRole: string; ageOnEventDate: number } } }).data.profileSnapshot);
    expect(saved.map((snapshot) => snapshot.teamRole)).toEqual(["MEMBER", "MEMBER", "COACH"]);
    expect(saved.map((snapshot) => snapshot.ageOnEventDate)).toEqual([14, 15, 40]);
  });

  it("prefers the age from a birth date on the roster, as of the age date, over the form's age answer", async () => {
    // Born 2005-12-31: 20 on 2026-01-01, whatever the form says.
    const tx = transaction({
      attendees: [
        { ...attendee("a", "Alex One"), formResponses: { attendee_type: "Pathfinder", attendee_age: "15" } },
        { ...attendee("b", "Blake Two"), formResponses: { attendee_type: "Pathfinder", attendee_age: "15" } },
      ],
      roster: [{ personId: "person-a", attendeeType: "YOUTH", classLevel: null, sealedBirthDate: "sealed:2005-12-31" }, ...rosterOf("b")],
    });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ message: expect.stringContaining("this one has 1") });
  });

  it("refuses a person who is on another team of the club, a coach too", async () => {
    const tx = transaction({
      attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Blake Two", { age: 15 }), attendee("c", "Coach Three", { age: 40, responses: { attendee_type: "Coach" } })],
      others: [{ personId: "person-c", name: "Coach Three" }],
      roster: [...rosterOf("a", "b"), { personId: "person-c", attendeeType: "STAFF", classLevel: null, sealedBirthDate: null }],
    });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ code: "TEAM_RULES", message: expect.stringContaining("Coach Three is already on another team from your club") });
  });

  it("refuses an extra person whose name matches someone on another team, with the name-only message", async () => {
    const tx = transaction({
      attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Pat Visitor", { age: 15, temporary: true })],
      others: [{ personId: "person-z", name: "pat visitor", temporary: true }],
      roster: rosterOf("a"),
    });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({
      code: "TEAM_RULES",
      message: expect.stringContaining("Someone named Pat Visitor is already on another team from your club. If this is a different person, contact the event team."),
    });
  });

  it("also catches a roster person whose name matches an extra person on another team", async () => {
    const tx = transaction({
      attendees: [attendee("a", "Pat Visitor", { age: 14 }), attendee("b", "Blake Two", { age: 15 })],
      others: [{ personId: "person-z", name: "Pat Visitor", temporary: true }],
      roster: rosterOf("a", "b"),
    });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ message: expect.stringContaining("Someone named Pat Visitor") });
    // A roster person is not compared with another roster person of the same name (those are told apart by their person record).
    const sameNameRoster = transaction({ attendees: [attendee("a", "Pat Visitor", { age: 14 }), attendee("b", "Blake Two", { age: 15 })], others: [{ personId: "person-z", name: "Pat Visitor" }], roster: rosterOf("a", "b") });
    await enforceTeamRegistrationRules(sameNameRoster, "reg-1");
  });

  it("lets staff confirm a name-only match as a different person, and audits it, but never a person-record match", async () => {
    const attendees = [attendee("a", "Alex One", { age: 14 }), attendee("b", "Pat Visitor", { age: 15, temporary: true })];
    const nameOnly = transaction({ attendees, others: [{ personId: "person-z", name: "Pat Visitor", temporary: true }], roster: rosterOf("a") });
    await enforceTeamRegistrationRules(nameOnly, "reg-1", { actorUserId: "staff-1", differentPersonAttendeeIds: new Set(["b"]) });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_TEAM_DIFFERENT_PERSON_CONFIRMED", actorUserId: "staff-1", entityId: "reg-1" }), nameOnly);
    const sameRecord = transaction({ attendees, others: [{ personId: "person-b", name: "Someone Else" }], roster: rosterOf("a") });
    await expect(enforceTeamRegistrationRules(sameRecord, "reg-1", { actorUserId: "staff-1", differentPersonAttendeeIds: new Set(["b"]) })).rejects.toMatchObject({ message: expect.stringContaining("Pat Visitor is already on another team") });
    // Without a staff actor the confirmation is ignored.
    const noActor = transaction({ attendees, others: [{ personId: "person-z", name: "Pat Visitor", temporary: true }], roster: rosterOf("a") });
    await expect(enforceTeamRegistrationRules(noActor, "reg-1", { differentPersonAttendeeIds: new Set(["b"]) })).rejects.toMatchObject({ code: "TEAM_RULES" });
  });
});

describe("peopleOnOtherTeams (#809)", () => {
  it("asks for the club's other active registrations only, leaving out the one being changed", async () => {
    const tx = transaction({ attendees: [], others: [{ personId: "p-1", name: "Alex One" }] });
    const { conflicts } = await peopleOnOtherTeams(tx, { eventId: "event-1", organizationId: "club-1", people: [{ personId: "p-1", name: "Alex One", onRoster: true }, { personId: "p-2", name: "Blake Two", onRoster: true }], excludeRegistrationId: "reg-1" });
    expect(conflicts).toEqual([{ name: "Alex One", kind: "PERSON" }]);
    expect(tx.registrationAttendee.findMany.mock.calls[0]![0].where.registration).toEqual({
      status: { in: ["SUBMITTED", "CONFIRMED", "WAITLISTED"] },
      clubRegistration: { is: { organizationId: "club-1", registrationId: { not: "reg-1" } } },
    });
  });
});
