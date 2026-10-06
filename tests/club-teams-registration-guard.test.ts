import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getTeamSettings: vi.fn() }));
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

function transaction(options: { team?: unknown; attendees: unknown[]; otherPersonIds?: string[]; otherGuests?: string[]; roster?: unknown[] }) {
  const tx = {
    clubEventRegistration: {
      findUnique: vi.fn().mockResolvedValue("team" in options ? options.team : {
        eventId: "event-1", organizationId: "club-1", teamKey: "bible bees", registration: { event: { startsAt: new Date("2027-01-16T18:00:00Z"), timezone: "America/Chicago" } },
      }),
    },
    registrationAttendee: {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) => {
        if (args.where.registrationId) return options.attendees;
        if (!args.where.personId) return (options.otherGuests ?? []).map((name) => ({ profileSnapshot: { firstName: name.split(" ")[0], lastName: name.split(" ")[1], temporary: true } }));
        return (options.otherPersonIds ?? []).map((personId) => ({ personId }));
      }),
      update: vi.fn(),
    },
    clubRosterMember: { findMany: vi.fn().mockResolvedValue(options.roster ?? []) },
  };
  return tx as never as Parameters<typeof enforceTeamRegistrationRules>[0] & typeof tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTeamSettings.mockResolvedValue(settings);
});

describe("enforceTeamRegistrationRules (#809)", () => {
  it("leaves a registration that is not a team's alone", async () => {
    const tx = transaction({ team: { eventId: "event-1", organizationId: "club-1", teamKey: "", registration: { event: { startsAt: new Date(), timezone: "UTC" } } }, attendees: [] });
    await enforceTeamRegistrationRules(tx, "reg-1");
    expect(mocks.getTeamSettings).not.toHaveBeenCalled();
  });

  it("reads the settings inside the transaction it was given, and passes a team that keeps the rules", async () => {
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Blake Two", { age: 15 })] });
    await enforceTeamRegistrationRules(tx, "reg-1");
    expect(mocks.getTeamSettings).toHaveBeenCalledWith("event-1", tx);
  });

  it("refuses a staff change down to one team member, with the same message the director sees", async () => {
    const tx = transaction({ attendees: [attendee("a", "Alex One", { age: 14 })] });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ code: "TEAM_RULES", message: expect.stringContaining("A team needs at least 2 team members; this one has 1.") });
  });

  it("refuses two alternates and a team member older than the limit, naming them", async () => {
    const tx = transaction({ attendees: [
      attendee("a", "Alex One", { age: 14, responses: { alternate: true } }),
      attendee("b", "Blake Two", { age: 15, responses: { alternate: true } }),
      attendee("c", "Casey Three", { age: 19, responses: { attendee_type: "Pathfinder" } }),
      attendee("d", "Drew Four", { age: 20 }),
    ] });
    const error = (await enforceTeamRegistrationRules(tx, "reg-1").then(() => null, (caught: unknown) => caught)) as { problems: string[] };
    expect(error.problems.join(" ")).toContain("Only 1 team member can be the alternate");
    expect(error.problems.join(" ")).not.toContain("Drew Four is 20");
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

  it("refuses a person who is on another team of the club, a coach too", async () => {
    const tx = transaction({
      attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Blake Two", { age: 15 }), attendee("c", "Coach Three", { age: 40, responses: { attendee_type: "Coach" } })],
      otherPersonIds: ["person-c"],
      roster: ["a", "b", "c"].map((id) => ({ personId: `person-${id}`, attendeeType: id === "c" ? "STAFF" : "YOUTH", classLevel: null })),
    });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ code: "TEAM_RULES", message: expect.stringContaining("Coach Three is already on another team from your club") });
  });

  it("refuses an extra person already on another team of the club, matched by name", async () => {
    const tx = transaction({
      attendees: [attendee("a", "Alex One", { age: 14 }), attendee("b", "Pat Visitor", { age: 15, temporary: true })],
      otherGuests: ["pat visitor"],
      roster: [{ personId: "person-a", attendeeType: "YOUTH", classLevel: null }],
    });
    await expect(enforceTeamRegistrationRules(tx, "reg-1")).rejects.toMatchObject({ code: "TEAM_RULES" });
  });
});

describe("peopleOnOtherTeams (#809)", () => {
  it("asks for the club's other active registrations only, leaving out the one being changed", async () => {
    const tx = transaction({ attendees: [], otherPersonIds: ["p-1"] });
    const names = await peopleOnOtherTeams(tx, { eventId: "event-1", organizationId: "club-1", people: [{ personId: "p-1", name: "Alex One" }, { personId: "p-2", name: "Blake Two" }], guestNames: [], excludeRegistrationId: "reg-1" });
    expect(names).toEqual(["Alex One"]);
    expect(tx.registrationAttendee.findMany.mock.calls[0]![0].where.registration).toEqual({
      status: { in: ["SUBMITTED", "CONFIRMED", "WAITLISTED"] },
      clubRegistration: { is: { organizationId: "club-1", registrationId: { not: "reg-1" } } },
    });
  });
});
