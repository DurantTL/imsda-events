import { describe, expect, it } from "vitest";
import {
  buildClassRosters,
  buildClubSchedule,
  buildSiteRoster,
  classRostersCsv,
  clubScheduleCsv,
  rosterGroupOf,
  siteRosterCsv,
  type RosterAttendee,
  type RosterEnrollment,
  type RosterOffering,
  type RosterSession,
} from "@/modules/honors/roster-domain";

const sessions: RosterSession[] = [
  { id: "s2", name: "Sunday morning", sortOrder: 2 },
  { id: "s1", name: "Sabbath afternoon", sortOrder: 1 },
];
const offering = (overrides: Partial<RosterOffering>): RosterOffering => ({
  id: "o", honorName: "Knots", honorCode: "AR-011", span: "SINGLE_SESSION", sessionId: "s1",
  capacity: 10, teacherName: "", location: "", isActive: true, ...overrides,
});
const offerings = [
  offering({ id: "knots", honorName: "Knots", sessionId: "s1", location: "Chapel", teacherName: "Ann Teacher" }),
  offering({ id: "birds", honorName: "Birds", sessionId: "s2" }),
  offering({ id: "camp", honorName: "Camping Skills I", span: "ALL_SESSIONS", sessionId: null }),
];
const person = (overrides: Partial<RosterAttendee>): RosterAttendee => ({
  id: "a", firstName: "Sam", lastName: "Sample", clubId: "c1", clubName: "Test Pathfinders",
  ageOnEventDate: 12, attendeeType: "YOUTH", checkedIn: false, dietary: null, ...overrides,
});
const attendees = [
  person({ id: "y1", firstName: "Alex", lastName: "Zed" }),
  person({ id: "y2", firstName: "Bea", lastName: "Able", clubId: "c2", clubName: "Other Club", dietary: "Peanut allergy", checkedIn: true }),
  person({ id: "st", firstName: "Jordan", lastName: "Counselor", attendeeType: "STAFF", ageOnEventDate: 38 }),
  person({ id: "ad", firstName: "Pat", lastName: "Parent", attendeeType: "ADULT", ageOnEventDate: 41 }),
  person({ id: "un", firstName: "Kid", lastName: "Small", attendeeType: "UNDERAGE", ageOnEventDate: null }),
];
const enrollments: RosterEnrollment[] = [
  { offeringId: "knots", attendeeId: "y1", consumesSeat: true },
  { offeringId: "knots", attendeeId: "y2", consumesSeat: true },
  { offeringId: "knots", attendeeId: "st", consumesSeat: false },
  { offeringId: "birds", attendeeId: "y1", consumesSeat: true },
  { offeringId: "camp", attendeeId: "ad", consumesSeat: false },
];

describe("roster groups", () => {
  it("uses H5's youth rule: anyone not staff or adult is youth", () => {
    expect(rosterGroupOf("YOUTH")).toBe("YOUTH");
    expect(rosterGroupOf("UNDERAGE")).toBe("YOUTH");
    expect(rosterGroupOf(null)).toBe("YOUTH");
    expect(rosterGroupOf("STAFF")).toBe("STAFF");
    expect(rosterGroupOf("ADULT")).toBe("ADULT");
  });
});

describe("class rosters", () => {
  it("orders all-sessions classes first, then by session order, and counts only seat-holding rows", () => {
    const rosters = buildClassRosters(sessions, offerings, enrollments, attendees);
    expect(rosters.map((roster) => roster.offering.id)).toEqual(["camp", "knots", "birds"]);
    const knots = rosters[1];
    expect(knots.session).toBe("Sabbath afternoon");
    expect(knots.people.map((p) => p.lastName)).toEqual(["Able", "Counselor", "Zed"]);
    expect(knots.youthSeats).toBe(2);
    expect(rosters[0].session).toBe("All sessions");
  });

  it("keeps an empty class so its sheet can still print", () => {
    const rosters = buildClassRosters(sessions, [offering({ id: "empty" })], [], attendees);
    expect(rosters[0]).toMatchObject({ youthSeats: 0, people: [] });
    expect(classRostersCsv(rosters).split("\r\n")).toHaveLength(3);
  });
});

describe("site roster", () => {
  it("totals youth, staff, and adults, overall and by club", () => {
    const site = buildSiteRoster(attendees);
    expect(site.totals).toEqual({ YOUTH: 3, STAFF: 1, ADULT: 1, total: 5 });
    expect(site.clubs).toEqual([
      { clubName: "Other Club", YOUTH: 1, STAFF: 0, ADULT: 0 },
      { clubName: "Test Pathfinders", YOUTH: 2, STAFF: 1, ADULT: 1 },
    ]);
    expect(site.people[0].clubName).toBe("Other Club");
  });

  it("adds dietary notes to the CSV only when asked", () => {
    const site = buildSiteRoster(attendees);
    expect(siteRosterCsv(site, false)).not.toContain("Peanut");
    expect(siteRosterCsv(site, false)).not.toContain("Dietary");
    const withDiet = siteRosterCsv(site, true);
    expect(withDiet).toContain('"Dietary notes"');
    expect(withDiet).toContain('"Peanut allergy"');
    expect(withDiet).toContain('"Other Club","Able","Bea","12","Youth","Yes","Peanut allergy"');
  });
});

describe("club schedule", () => {
  it("shows one class per session, with an all-sessions class in every column", () => {
    const schedule = buildClubSchedule("c1", sessions, offerings, enrollments, attendees);
    expect(schedule.sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(schedule.people.map((row) => row.person.lastName)).toEqual(["Counselor", "Parent", "Small", "Zed"]);
    const zed = schedule.people.find((row) => row.person.id === "y1")!;
    expect(zed.bySession.s1?.honorName).toBe("Knots");
    expect(zed.bySession.s2?.honorName).toBe("Birds");
    const parent = schedule.people.find((row) => row.person.id === "ad")!;
    expect(parent.bySession.s1?.honorName).toBe("Camping Skills I");
    expect(parent.bySession.s2?.honorName).toBe("Camping Skills I");
    expect(schedule.people.some((row) => row.person.clubId !== "c1")).toBe(false);
    expect(clubScheduleCsv(schedule)).toContain('"Knots — Chapel · Ann Teacher"');
  });
});

describe("CSV safety", () => {
  it("neutralizes spreadsheet formulas in names and never includes birth dates", () => {
    const risky = [person({ id: "x", firstName: "=HYPERLINK(\"http://evil\")", lastName: "+SUM(1)", clubName: "@club" })];
    const csv = siteRosterCsv(buildSiteRoster(risky), false)
      + classRostersCsv(buildClassRosters(sessions, offerings, [{ offeringId: "knots", attendeeId: "x", consumesSeat: true }], risky));
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain(`"'+SUM(1)"`);
    expect(csv).toContain(`"'@club"`);
    expect(csv).not.toMatch(/birth/i);
  });
});
