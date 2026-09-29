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
import { groupSessionsBySite } from "@/modules/honors/session-order";

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
  it("lists anyone not staff or adult with the youth, underage included", () => {
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

describe("rosters at sites (#589)", () => {
  const locations = [{ id: "dm", name: "Des Moines", sortOrder: 0 }, { id: "hr", name: "Camp Heritage 1", sortOrder: 1 }];
  const siteSessions: RosterSession[] = [
    { id: "hr-sab", name: "Sabbath Morning", sortOrder: 0, locationId: "hr" },
    { id: "dm-sab", name: "Sabbath Morning", sortOrder: 0, locationId: "dm" },
    { id: "shared", name: "Sunday", sortOrder: 5, locationId: null },
  ];
  const siteOfferings = [
    offering({ id: "hr-knots", honorName: "Knots", sessionId: "hr-sab", siteName: "Camp Heritage 1" }),
    offering({ id: "dm-birds", honorName: "Birds", sessionId: "dm-sab", siteName: "Des Moines" }),
    offering({ id: "shared-fire", honorName: "Fire", sessionId: "shared", siteName: null }),
  ];
  const siteAttendees = [
    person({ id: "dm1", firstName: "Dee", lastName: "Em", clubId: "cd", clubName: "Iowa Club", locationId: "dm", locationName: "Des Moines" }),
    person({ id: "hr1", firstName: "Hal", lastName: "Are", clubId: "ch", clubName: "Heritage Club", locationId: "hr", locationName: "Camp Heritage 1" }),
  ];
  const siteEnrollments: RosterEnrollment[] = [
    { offeringId: "dm-birds", attendeeId: "dm1", consumesSeat: true },
    { offeringId: "hr-knots", attendeeId: "hr1", consumesSeat: true },
  ];

  it("orders class rosters by site, then session, and names the site on each", () => {
    const rosters = buildClassRosters(siteSessions, siteOfferings, siteEnrollments, siteAttendees, locations);
    expect(rosters.map((roster) => [roster.siteName, roster.offering.id])).toEqual([
      ["Des Moines", "dm-birds"], ["Camp Heritage 1", "hr-knots"], [null, "shared-fire"],
    ]);
  });

  it("names the site in every CSV when the event has sites, and only then", () => {
    const rosters = buildClassRosters(siteSessions, siteOfferings, siteEnrollments, siteAttendees, locations);
    const withSite = classRostersCsv(rosters, true).split("\r\n");
    expect(withSite[0]).toContain('"Site","Session"');
    expect(withSite[1]).toMatch(/^"Des Moines","Sabbath Morning"/);
    expect(withSite.filter(Boolean).at(-1)).toContain('"All sites"');
    expect(classRostersCsv(rosters)).not.toContain('"Site"');

    expect(siteRosterCsv(buildSiteRoster(siteAttendees), false, true)).toContain('"Des Moines","Iowa Club"');
    expect(siteRosterCsv(buildSiteRoster(siteAttendees), false)).not.toContain("Des Moines");
  });

  it("shows a club only its own site's sessions and names the site on its schedule", () => {
    const schedule = buildClubSchedule("cd", siteSessions, siteOfferings, siteEnrollments, siteAttendees, locations);
    expect(schedule.siteName).toBe("Des Moines");
    expect(schedule.sessions.map((session) => session.id)).toEqual(["dm-sab", "shared"]);
    expect(clubScheduleCsv(schedule, true).split("\r\n")[1]).toMatch(/^"Des Moines","Em","Dee"/);
    expect(clubScheduleCsv(schedule)).not.toContain("Des Moines");
  });

  it("orders sessions per site, so each site's order applies within it", () => {
    const groups = groupSessionsBySite(
      [{ id: "b", sortOrder: 0, locationId: "hr" }, { id: "a", sortOrder: 3, locationId: "dm" }, { id: "c", sortOrder: 1, locationId: "dm" }, { id: "x", sortOrder: 0, locationId: null }],
      locations,
    );
    expect(groups.map((group) => [group.location?.id ?? null, group.sessions.map((session) => session.id)])).toEqual([
      ["dm", ["c", "a"]], ["hr", ["b"]], [null, ["x"]],
    ]);
  });

  it("is a single group with no site for an event without locations", () => {
    const groups = groupSessionsBySite([{ id: "b", sortOrder: 1 }, { id: "a", sortOrder: 0 }], []);
    expect(groups).toEqual([{ location: null, sessions: [{ id: "a", sortOrder: 0 }, { id: "b", sortOrder: 1 }] }]);
  });
});
