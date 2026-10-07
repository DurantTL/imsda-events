import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), writeAuditLog: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import {
  getClassSelectionWorkspace,
  getClassSelectionWorkspaceIfRegistered,
  getRegistrationHonorsCatalog,
  saveRegistrationHonorPicks,
} from "@/modules/honors/enrollment-repository";
import { seatsNote, toPublicSeatView, unavailableReason } from "@/modules/honors/class-picker-view";
import {
  firstPickProblem,
  honorsNoteKey,
  offeringsAtLocation,
  pickingAttendees,
  picksByAttendeeId,
  prunePicks,
} from "@/modules/honors/registration-picks";

const now = new Date("2026-10-15T15:00:00.000Z");
const event = {
  id: "event-1", isPublished: true, endsAt: new Date("2026-12-06T20:00:00.000Z"), timezone: "America/Chicago",
  registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30", waitlistEnabled: false,
};

function offering(id: string, honorName: string, sessionId: string | null, locationId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id, span: sessionId ? "SINGLE_SESSION" : "ALL_SESSIONS", sessionId,
    locationId: sessionId ? null : locationId, site: !sessionId && locationId ? { name: `Site ${locationId}` } : null,
    capacity: 10, minimumAge: null, perClubLimit: null,
    teacherName: "", location: "", isActive: true, honors: [{ honor: { id: `honor-${id}`, name: honorName, code: id.toUpperCase(), isActive: true } }],
    session: sessionId ? { name: `Session ${sessionId}`, sortOrder: 0, locationId, location: locationId ? { name: `Site ${locationId}` } : null } : null,
    ...extra,
  };
}

const offerings = [
  offering("knots-hr", "Knots at Heritage", "s-hr", "loc-hr"),
  offering("birds-dm", "Birds at Des Moines", "s-dm", "loc-dm"),
  offering("camp-shared", "Camping (no site)", "s-shared", null),
  offering("all-hr", "All-sessions at Heritage", null, "loc-hr"),
  offering("retired", "Retired class", "s-hr", "loc-hr", { isActive: false }),
  offering("adults-only", "Advanced first aid", "s-shared", null, { minimumAge: 16 }),
];
const sessions = [
  { id: "s-hr", name: "Sabbath Morning", locationId: "loc-hr", sortOrder: 0, createdAt: now },
  { id: "s-dm", name: "Sabbath Morning", locationId: "loc-dm", sortOrder: 0, createdAt: now },
  { id: "s-shared", name: "Sunday", locationId: null, sortOrder: 1, createdAt: now },
];

function database(options: { taken?: Array<[string, number]>; clubTaken?: Array<[string, number]>; offerings?: unknown[]; status?: string } = {}) {
  const created: Array<{ offeringId: string; registrationAttendeeId: string }> = [];
  const groups = (rows: Array<[string, number]> = []) => rows.map(([offeringId, count]) => ({ offeringId, _count: { _all: count } }));
  const db = {
    clubEventRegistration: {
      findUnique: vi.fn().mockResolvedValue({
        event,
        registration: {
          id: "registration-1", status: options.status ?? "SUBMITTED",
          locationId: "loc-hr", location: { id: "loc-hr", name: "Camp Heritage 1" },
          attendees: [
            { id: "attendee-1", position: 0, profileSnapshot: { firstName: "Alex", lastName: "Youth", ageOnEventDate: 12, clubRosterMemberId: "member-1" } },
            { id: "attendee-2", position: 1, profileSnapshot: { firstName: "Pat", lastName: "Visitor", ageOnEventDate: 40, temporary: true, clubGuestId: "guest-1", temporaryAttendeeType: "ADULT" } },
          ],
        },
      }),
    },
    clubRosterMember: { findMany: vi.fn().mockResolvedValue([{ id: "member-1", attendeeType: "YOUTH" }]) },
    eventLocation: { count: vi.fn().mockResolvedValue(2) },
    honorOffering: { findMany: vi.fn().mockResolvedValue(options.offerings ?? offerings) },
    honorSession: { findMany: vi.fn().mockResolvedValue(sessions) },
    honorEnrollment: {
      groupBy: vi.fn()
        .mockResolvedValueOnce(groups(options.taken))
        .mockResolvedValueOnce(groups(options.clubTaken))
        .mockResolvedValue(groups(options.taken)),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(async ({ data }: { data: Array<{ offeringId: string; registrationAttendeeId: string }> }) => { created.push(...data); return { count: data.length }; }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (work: (client: unknown) => unknown) => work(db)),
  };
  mocks.getPrisma.mockReturnValue(db);
  return { db, created };
}

const actor = { accountId: "director-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
});

describe("the honors step of a club registration (#618)", () => {
  it("offers only active classes, with live seats, before anything is registered", async () => {
    database({ taken: [["knots-hr", 10]], clubTaken: [["knots-hr", 2]] });
    const catalog = await getRegistrationHonorsCatalog("club-1", "event-1");
    expect(catalog.offerings.map((row) => row.id)).not.toContain("retired");
    const knots = catalog.offerings.find((row) => row.id === "knots-hr")!;
    expect(knots).toMatchObject({ seatsTaken: 10, clubSeatsTaken: 2, capacity: 10, siteId: "loc-hr" });
    // The screen greys out a full class using the shared guidance.
    const youth = { attendeeType: "YOUTH", consumesSeat: true, ageOnEventDate: 12 };
    expect(unavailableReason(knots, false, youth)).toBe("full");
    expect(seatsNote(knots, false, { ...youth, consumesSeat: false })).toBe("no seat needed");
  });

  it("shows only the registered location's classes, plus classes with no site (#589)", async () => {
    database();
    const { offerings: all } = await getRegistrationHonorsCatalog("club-1", "event-1");
    expect(offeringsAtLocation(all, "loc-hr").map((row) => row.id)).toEqual(["knots-hr", "camp-shared", "all-hr", "adults-only"]);
    expect(offeringsAtLocation(all, "loc-dm").map((row) => row.id)).toEqual(["birds-dm", "camp-shared", "adults-only"]);
    // Before a location is picked only classes with no site show.
    expect(offeringsAtLocation(all, null).map((row) => row.id)).toEqual(["camp-shared", "adults-only"]);
  });

  it("sends only the known site's classes, plus those with no site, and everything when the site isn't known", async () => {
    database();
    const everything = await getRegistrationHonorsCatalog("club-1", "event-1");
    expect(everything.offerings.map((row) => row.id)).toContain("birds-dm");
    const heritage = await getRegistrationHonorsCatalog("club-1", "event-1", "loc-hr");
    expect(heritage.offerings.map((row) => row.id)).toEqual(["knots-hr", "camp-shared", "all-hr", "adults-only"]);
    expect(heritage.sessions.map((session) => session.id)).toEqual(["s-hr", "s-shared"]);
    // An event with no sites: only classes with no site.
    const none = await getRegistrationHonorsCatalog("club-1", "event-1", null);
    expect(none.offerings.map((row) => row.id)).toEqual(["camp-shared", "adults-only"]);
  });

  it("gives the registered page no class picker, instead of crashing, for a waitlisted registration", async () => {
    database({ status: "WAITLISTED" });
    await expect(getClassSelectionWorkspace("club-1", "event-1", now)).rejects.toMatchObject({ code: "NOT_REGISTERED" });
    await expect(getClassSelectionWorkspaceIfRegistered("club-1", "event-1", now)).resolves.toBeNull();
    database({ status: "SUBMITTED" });
    await expect(getClassSelectionWorkspaceIfRegistered("club-1", "event-1", now)).resolves.toMatchObject({ locationRequired: false });
  });

  it("has no honors step for an event with no honors", async () => {
    database({ offerings: [] });
    const catalog = await getRegistrationHonorsCatalog("club-1", "event-1");
    expect(catalog.offerings).toEqual([]);
    expect(offeringsAtLocation(catalog.offerings, "loc-hr")).toEqual([]);
  });

  it("builds the people to pick for from who's going, roster and extra people alike", () => {
    const people = pickingAttendees({
      roster: [
        { memberId: "member-1", firstName: "Alex", lastName: "Youth", ageOnEventDate: 12, attendeeType: "YOUTH" },
        { memberId: "member-2", firstName: "Sam", lastName: "Staff", ageOnEventDate: 30, attendeeType: "STAFF" },
        { memberId: "member-3", firstName: "Not", lastName: "Going", ageOnEventDate: 11, attendeeType: "YOUTH" },
      ],
      selectedMemberIds: ["member-1", "member-2"],
      guests: [{ id: "guest-1", firstName: "Pat", lastName: "Visitor", age: 40 }],
    });
    expect(people.map((person) => [person.clientId, person.consumesSeat])).toEqual([
      ["member:member-1", true], ["member:member-2", false], ["guest:guest-1", false],
    ]);
  });

  it("uses the shared enrollment rules to catch conflicts and minimum ages before saving", async () => {
    database();
    const { offerings: all } = await getRegistrationHonorsCatalog("club-1", "event-1");
    const here = offeringsAtLocation(all, "loc-hr");
    const [alex] = pickingAttendees({
      roster: [{ memberId: "member-1", firstName: "Alex", lastName: "Youth", ageOnEventDate: 12, attendeeType: "YOUTH" }],
      selectedMemberIds: ["member-1"], guests: [],
    });
    expect(firstPickProblem({ "member:member-1": ["knots-hr", "camp-shared"] }, [alex!], here)).toBeNull();
    expect(firstPickProblem({ "member:member-1": ["all-hr", "camp-shared"] }, [alex!], here)).toContain("has to be the only class");
    expect(firstPickProblem({ "member:member-1": ["adults-only"] }, [alex!], here)).toContain("ages 16 and up");
  });

  it("checks the minimum age against an age typed in for a roster person with no birth date (#639)", async () => {
    database();
    const { offerings: all } = await getRegistrationHonorsCatalog("club-1", "event-1");
    const here = offeringsAtLocation(all, "loc-hr");
    const roster = [{ memberId: "member-1", firstName: "Alex", lastName: "Youth", ageOnEventDate: null, attendeeType: "YOUTH" as const }];
    const picks = { "member:member-1": ["adults-only"] };
    const [young] = pickingAttendees({ roster, selectedMemberIds: ["member-1"], guests: [], rosterAges: { "member-1": 12 } });
    expect(young!.ageOnEventDate).toBe(12);
    expect(firstPickProblem(picks, [young!], here)).toContain("ages 16 and up");
    const [old] = pickingAttendees({ roster, selectedMemberIds: ["member-1"], guests: [], rosterAges: { "member-1": 17 } });
    expect(firstPickProblem(picks, [old!], here)).toBeNull();
    // A birth date on the roster wins over a typed-in age.
    const [dated] = pickingAttendees({ roster: [{ ...roster[0]!, ageOnEventDate: 12 }], selectedMemberIds: ["member-1"], guests: [], rosterAges: { "member-1": 17 } });
    expect(dated!.ageOnEventDate).toBe(12);
  });

  it("keeps one club's unsaved-honors note apart from another club's, and from another event's", () => {
    const keys = new Set([honorsNoteKey("club-a", "event-1"), honorsNoteKey("club-b", "event-1"), honorsNoteKey("club-a", "event-2")]);
    expect(keys.size).toBe(3);
  });

  it("drops picks for people who are no longer going and classes not offered at the site", () => {
    const picks = { "member:member-1": ["knots-hr", "birds-dm"], "member:gone": ["knots-hr"] };
    expect(prunePicks(picks, [{ clientId: "member:member-1" }], [{ id: "knots-hr" }])).toEqual({ "member:member-1": ["knots-hr"] });
  });
});

describe("saving the honors picked while registering (#618)", () => {
  it("maps the form's client ids to the saved attendees and saves through the enrollment domain", async () => {
    const { created } = database();
    const result = await saveRegistrationHonorPicks(
      "club-1", "event-1", actor,
      { "member:member-1": ["knots-hr"], "guest:guest-1": ["camp-shared"] },
      now,
    );
    expect(result).toEqual({ saved: 2 });
    expect(created).toEqual([
      expect.objectContaining({ offeringId: "knots-hr", registrationAttendeeId: "attendee-1" }),
      expect.objectContaining({ offeringId: "camp-shared", registrationAttendeeId: "attendee-2" }),
    ]);
  });

  it("does nothing, and touches nothing, when no honors were picked", async () => {
    const { db } = database();
    await expect(saveRegistrationHonorPicks("club-1", "event-1", actor, { "member:member-1": [] }, now)).resolves.toEqual({ saved: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("still refuses another site's class, a full class, and a person who isn't on the registration", async () => {
    const other = database();
    await expect(saveRegistrationHonorPicks("club-1", "event-1", actor, { "member:member-1": ["birds-dm"] }, now))
      .rejects.toMatchObject({ code: "SELECTION_INVALID", message: expect.stringContaining("isn't offered at your location, Camp Heritage 1") });
    expect(other.created).toEqual([]);

    // Seat counts are read again after the pick is added; over capacity refuses the save.
    const full = database({ taken: [["knots-hr", 11]] });
    full.db.honorEnrollment.groupBy.mockReset();
    full.db.honorEnrollment.groupBy.mockResolvedValue([{ offeringId: "knots-hr", _count: { _all: 11 } }]);
    await expect(saveRegistrationHonorPicks("club-1", "event-1", actor, { "member:member-1": ["knots-hr"] }, now))
      .rejects.toMatchObject({ code: "CLASS_FULL" });

    database();
    await expect(saveRegistrationHonorPicks("club-1", "event-1", actor, { "member:stranger": ["knots-hr"] }, now))
      .rejects.toMatchObject({ code: "ATTENDEE_NOT_FOUND" });
  });

  it("maps picks by roster member or extra person and reports strangers", () => {
    expect(picksByAttendeeId(
      { "member:m1": ["a"], "guest:g1": ["b"], "member:zzz": ["c"], "member:m2": [] },
      [{ id: "att-1", clubRosterMemberId: "m1" }, { id: "att-2", clubGuestId: "g1" }, { id: "att-3", clubRosterMemberId: "m2" }],
    )).toEqual({ mapped: { "att-1": ["a"], "att-2": ["b"] }, unknown: ["member:zzz"] });
  });
});

describe("public group class view (#650)", () => {
  const full = { capacity: 10, seatsTaken: 4, clubSeatsTaken: 2, perClubLimit: 3, minimumAge: null, isActive: true };
  const youth = { attendeeType: "YOUTH", consumesSeat: true, ageOnEventDate: 12 };

  it("keeps only an availability status: no capacity, seats taken, seat count or per-club count", () => {
    const view = toPublicSeatView(full);
    expect(Object.keys(view).sort()).toEqual(["availability", "isActive", "minimumAge", "perClubLimit"]);
    expect(view.availability).toBe("AVAILABLE");
    expect(toPublicSeatView({ ...full, seatsTaken: 5 }).availability).toBe("FEW_LEFT");
    expect(toPublicSeatView({ ...full, seatsTaken: 9 }).availability).toBe("FEW_LEFT");
    expect(toPublicSeatView({ ...full, seatsTaken: 4, capacity: 10 }).availability).toBe("AVAILABLE");
    expect(toPublicSeatView({ ...full, seatsTaken: 10 }).availability).toBe("FULL");
    expect(toPublicSeatView({ ...full, seatsTaken: 12 }).availability).toBe("FULL");
  });

  it("words and gates the picker from the status alone", () => {
    expect(seatsNote(toPublicSeatView({ ...full, seatsTaken: 6 }), false, youth, "group")).toBe("Few seats left, 3 left for your group");
    expect(seatsNote(toPublicSeatView(full), false, youth, "group")).toBe("Seats available, 3 left for your group");
    expect(unavailableReason(toPublicSeatView({ ...full, seatsTaken: 10 }), false, youth)).toBe("full");
    expect(unavailableReason(toPublicSeatView({ ...full, seatsTaken: 6 }), false, youth)).toBeNull();
  });
});
