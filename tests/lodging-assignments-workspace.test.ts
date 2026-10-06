import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayPanel, ExceptionsPanel, PlanPanel, WaitlistPanel } from "@/components/lodging-assignments-panels";
import { LodgingAssignmentsWorkspace } from "@/components/lodging-assignments-workspace";
import { PublicLodgingAssignment } from "@/components/public-lodging-assignment";
import type { AssignmentWorkspaceView, PersonCard, UnitCard } from "@/modules/lodging/assignment-view";
import type { RegistrantLodgingView } from "@/modules/lodging/preferences-service";

/**
 * The staff assignment workspace and the attendee display (#200), rendered on the server with synthetic data: the
 * accessible alternatives to drag and drop are present, status is words as well as colour, restricted flags appear only
 * when the view carries them, and the attendee view never holds a contact detail. The behaviour behind each button is
 * checked by the real-database script and the route tests.
 */
const nights = ["2027-06-15", "2027-06-16", "2027-06-17"];

const unit = (id: string, name: string, extra: Partial<UnitCard> = {}): UnitCard => ({
  eventUnitId: id, key: `k-${id}`, name, kind: "ROOM", isArea: false, floor: 1, groundLevel: true, bathroom: "SHARED", specialUse: false, category: "DORM_ROOM",
  beds: "2 twin", status: "AVAILABLE", capacity: 2, nightStatuses: nights.map(() => "AVAILABLE" as const), nightCapacities: [2, 2, 2], nightOccupied: [0, 0, 0],
  holdReasons: [], unavailableReason: null, extraBedding: false, occupants: [], ...extra,
});

const person = (key: string, name: string, extra: Partial<PersonCard> = {}): PersonCard => ({
  occupantKey: key, occupantId: key, kind: "ATTENDEE", name, registrationId: `reg-${key}`, registrationCode: `CODE-${key}`, registrationStatus: "CONFIRMED", active: true, colorIndex: 1, people: 1,
  category: "DORM_ROOM", roomCount: 1, bringsExtraBedding: false, asksForLodging: true, wantedFirstNight: nights[0]!, wantedLastNight: nights[2]!, wantedNights: 3, placements: [], uncoveredNights: 3, waitlistStatus: null, householdKeys: [], ...extra,
});

const view = (extra: Partial<AssignmentWorkspaceView> = {}): AssignmentWorkspaceView => ({
  eventId: "ev1", propertyName: "Sunnydale Academy", nights,
  settings: { showAssignmentsToAttendees: false, showRoommateFirstNames: false, attendeeInstructions: null },
  canSeeSensitive: false, palette: 12,
  buildings: [{ key: "boys", name: "Boys Dorm", floors: [{ floor: 1, label: "1st floor", units: [
    unit("u101", "101", { occupants: [{ assignmentId: "a1", occupantKey: "p1", occupantId: "p1", kind: "ATTENDEE", name: "Pat Example", registrationCode: "CODE-p1", firstNight: nights[0]!, lastNight: nights[2]!, people: 1, colorIndex: 1, inactive: false }], status: "PARTIAL", nightOccupied: [1, 1, 1] }),
    unit("u102", "102", { status: "HELD", holdReasons: ["Speaker"], nightStatuses: nights.map(() => "HELD" as const), nightCapacities: [0, 0, 0] }),
    unit("u314", "314", { specialUse: true, capacity: 8, floor: 3, groundLevel: false }),
  ] }] }],
  buckets: [{ id: "b1", kind: "HOTEL", label: "Hotel", people: 0, occupants: [] }],
  people: [person("p1", "Pat Example", { placements: [{ assignmentId: "a1", unitId: "u101", bucketId: null, label: "101", firstNight: nights[0]!, lastNight: nights[2]!, people: 1 }], uncoveredNights: 0 }), person("p2", "Sam Sample")],
  exceptions: [], waitlist: [], notices: [], counts: { placed: 1, unplaced: 1, waitingOnList: 0, exceptions: 0 }, ...extra,
});

const render = (props: Partial<Parameters<typeof LodgingAssignmentsWorkspace>[0]> = {}) => renderToStaticMarkup(createElement(LodgingAssignmentsWorkspace, { eventName: "Camp Meeting", initialView: view(), canConfigure: true, canExport: true, ...props }));

describe("the staff assignment workspace", () => {
  it("offers a keyboard and touch alternative to dragging: select a person, then assign here", () => {
    const html = render();
    expect(html).toContain("Select a person, then press");
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[\s\S]*Sam Sample/);
    expect(html).toContain("Assign the next unplaced person");
    expect(html).toContain("Fill this room");
    // Every action that drag and drop offers also has a labelled control.
    expect(html).toContain("Change Pat Example&#x27;s place");
  });

  it("shows room status in words, holds and special-use warnings, and household colour with a code beside it", () => {
    const html = render();
    expect(html).toContain("Partly filled");
    expect(html).toContain("Held");
    expect(html).toContain("Held: Speaker");
    expect(html).toContain("Special-use room: you will be asked to confirm.");
    expect(html).toContain("CODE-p1");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Lodging sections"');
  });

  it("has building and floor choices, a hall layout and alternate housing", () => {
    const html = render();
    expect(html).toContain("Hall layout");
    expect(html).toContain("Room list");
    expect(html).toContain("Boys Dorm");
    expect(html).toContain("1st floor");
    expect(html).toContain("Housing arranged elsewhere");
    expect(html).toContain("Add an expected guest");
    expect(html).toContain("Search by name or confirmation code");
  });

  it("shows accessibility flags only when the server sent them", () => {
    const blind = render();
    expect(blind).not.toMatch(/needs ground floor/i);
    const sensitive = render({ initialView: view({ canSeeSensitive: true, people: [person("p2", "Sam Sample", { groundFloorNeeded: true })] }) });
    expect(sensitive).toMatch(/needs ground floor/i);
  });

  it("shows the room count and the extra-bedding flag on the person, and a party above a room's beds as a warning", () => {
    const html = render({
      initialView: view({
        buildings: [{ key: "boys", name: "Boys Dorm", floors: [{ floor: 1, label: "1st floor", units: [unit("u101", "101", { status: "FULL", extraBedding: true, nightOccupied: [5, 5, 5] })] }] }],
        people: [person("p2", "Sam Sample", { people: 1, roomCount: 2, bringsExtraBedding: true }), person("p3", "Alex Sample", { roomCount: 1 })],
      }),
    });
    expect(html).toContain("2 rooms");
    expect(html).toContain("bringing extra bedding");
    expect(html).toContain("1 room");
    // A room holding one party above its beds reads as full with extra bedding, never as an over-capacity conflict.
    expect(html).toContain("(extra bedding)");
    expect(html).not.toContain("Over capacity");
  });

  it("lists the rooms a waitlist entry wants", () => {
    const html = renderToStaticMarkup(createElement(WaitlistPanel, {
      view: view({ waitlist: [{ id: "w1", registrationId: "reg-p2", registrationCode: "CODE-p2", holder: "Sam Sample", category: "DORM_ROOM", firstNight: null, lastNight: null, partySize: 6, roomCount: 3, status: "JOINED", offerNumber: 0, offeredAt: null, offerExpiresAt: null, offerMessageStatus: null, lapsed: false, joinedAt: "2027-05-01T00:00:00.000Z", createdVia: "STAFF" }] }),
      base: "/api/events/ev1/lodging", run: async () => true, busy: false, canConfigure: true,
    }));
    expect(html).toContain("<th scope=\"col\">Rooms</th>");
    expect(html).toContain("<td>3</td>");
  });

  it("holds no contact detail", () => {
    expect(render().toLowerCase()).not.toMatch(/@|phone|email address/);
  });
});

describe("the other panels", () => {
  const base = "/api/events/ev1/lodging";
  const run = async () => true;

  it("lists conflicts and closeout items with their kind, and offers to release rooms of inactive registrations", () => {
    const html = renderToStaticMarkup(createElement(ExceptionsPanel, {
      view: view({ exceptions: [
        { kind: "UNIT_OUT_OF_SERVICE", key: "closed:u1", title: "101 is out of service", detail: "Move them.", assignmentIds: ["a1"], label: "Room closed or held after assignment", section: "CONFLICT" },
        { kind: "INACTIVE_REGISTRATION", key: "inactive:r1", title: "Registration X still holds a room", detail: "Release it.", assignmentIds: ["a2"], label: "Assigned, but the registration is no longer active", section: "CLOSEOUT" },
      ] }),
      base, run, busy: false,
    }));
    expect(html).toContain("Room closed or held after assignment");
    expect(html).toContain("Closeout exceptions (1)");
    expect(html).toContain("Release rooms of inactive registrations");
  });

  it("previews offers before anything is sent and says nothing offers on its own", () => {
    const html = renderToStaticMarkup(createElement(WaitlistPanel, {
      view: view({ waitlist: [{ id: "w1", registrationId: "reg-p2", registrationCode: "CODE-p2", holder: "Sam Sample", category: "DORM_ROOM", firstNight: null, lastNight: null, partySize: 2, roomCount: 2, status: "JOINED", offerNumber: 0, offeredAt: null, offerExpiresAt: null, offerMessageStatus: null, lapsed: false, joinedAt: "2027-05-01T00:00:00.000Z", createdVia: "STAFF" }] }),
      base, run, busy: false, canConfigure: true,
    }));
    expect(html).toContain("one email per entry, only when you confirm here");
    expect(html).toContain("Nothing offers or promotes on its own");
    expect(html).toContain("Preview offers for 0 entries");
    expect(html).toContain("Waiting");
    const noConfigure = renderToStaticMarkup(createElement(WaitlistPanel, { view: view(), base, run, busy: false, canConfigure: false }));
    expect(noConfigure).toContain("Event administrators send offers");
    expect(noConfigure).not.toContain("Preview offers");
  });

  it("shows the offer email's status and warns when an open offer never reached the guest", () => {
    const entry = { id: "w1", registrationId: "reg-p2", registrationCode: "CODE-p2", holder: "Sam Sample", category: "DORM_ROOM" as const, firstNight: null, lastNight: null, partySize: 1, roomCount: 1, status: "OFFERED" as const, offerNumber: 1, offeredAt: "2027-05-20T12:00:00.000Z", offerExpiresAt: "2027-05-22T12:00:00.000Z", offerMessageStatus: "SUPPRESSED", lapsed: false, joinedAt: "2027-05-01T00:00:00.000Z", createdVia: "STAFF" };
    const html = renderToStaticMarkup(createElement(WaitlistPanel, { view: view({ waitlist: [entry] }), base, run, busy: false, canConfigure: true }));
    expect(html).toContain("Offer email: suppressed");
    expect(html).toContain("did not reach the guest");
    const captured = renderToStaticMarkup(createElement(WaitlistPanel, { view: view({ waitlist: [{ ...entry, offerMessageStatus: "CAPTURED" }] }), base, run, busy: false, canConfigure: true }));
    expect(captured).toContain("Offer email: captured");
    expect(captured).not.toContain("did not reach the guest");
  });

  it("previews a proposal or import and applies nothing until confirmed, and says what the proposal ignores without access", () => {
    const blind = renderToStaticMarkup(createElement(PlanPanel, { view: view(), base, run, busy: false, canExport: true }));
    expect(blind).toContain("change nothing until you confirm");
    expect(blind).toContain("does not consider them");
    expect(blind).toContain("report=assignments");
    const sensitive = renderToStaticMarkup(createElement(PlanPanel, { view: view({ canSeeSensitive: true }), base, run, busy: false, canExport: false }));
    expect(sensitive).toContain("puts ground-floor needs on the ground floor");
    expect(sensitive).toContain("Exports need the reports permission");
  });

  it("explains the attendee display and keeps its switches off by default", () => {
    const html = renderToStaticMarkup(createElement(DisplayPanel, { view: view(), base, run, busy: false, canConfigure: true }));
    expect(html).toContain("Show room assignments to attendees");
    expect(html).toContain("Show roommates by first name");
    expect(html).toContain("Contact details are never shown");
    expect(html).not.toContain("checked");
    const readOnly = renderToStaticMarkup(createElement(DisplayPanel, { view: view(), base, run, busy: false, canConfigure: false }));
    expect(readOnly).toContain("Event administrators change this");
  });
});

describe("what an attendee sees", () => {
  const lodging = { enabled: true, canEdit: true, fullBehavior: "WAITLIST", offered: [{ category: "TENT", label: "Tent", full: true, rate: null, unitCapacity: null }], people: [{ personId: "x", name: "Pat" }], request: null } as unknown as RegistrantLodgingView;
  const stay = (extra: object = {}) => ({ name: "Pat Example", kind: "ROOM" as const, building: "Girls Dorm", room: "224", firstNight: "2027-06-15", lastNight: "2027-06-17", roommates: [], otherGuests: 0, ...extra });

  it("shows nothing when nothing is published and no waitlist applies", () => {
    expect(renderToStaticMarkup(createElement(PublicLodgingAssignment, { token: "t", initialAssignments: { published: false, instructions: null, stays: [] }, initialWaitlist: { enabled: false, entry: null }, lodging: null }))).toBe("");
  });

  it("shows the approved building, room, nights and instructions, and first names only", () => {
    const html = renderToStaticMarkup(createElement(PublicLodgingAssignment, {
      token: "t", lodging: null, initialWaitlist: { enabled: false, entry: null },
      initialAssignments: { published: true, instructions: "Check in at the office.", stays: [stay({ roommates: ["Maria"], otherGuests: 2 })] },
    }));
    expect(html).toContain("Girls Dorm, 224");
    expect(html).toContain("Check in at the office.");
    expect(html).toContain("Maria and 2 others");
    expect(html).not.toMatch(/@|555-|phone|email/i);
  });

  it("says a room is not assigned yet, and offers an alternate-housing stay without a room", () => {
    const none = renderToStaticMarkup(createElement(PublicLodgingAssignment, { token: "t", lodging: null, initialWaitlist: { enabled: false, entry: null }, initialAssignments: { published: true, instructions: null, stays: [] } }));
    expect(none).toContain("not been assigned yet");
    const elsewhere = renderToStaticMarkup(createElement(PublicLodgingAssignment, { token: "t", lodging: null, initialWaitlist: { enabled: false, entry: null }, initialAssignments: { published: true, instructions: null, stays: [stay({ kind: "ELSEWHERE", building: null, room: "Hotel" })] } }));
    expect(elsewhere).toContain("Hotel (arranged outside the property)");
  });

  it("shows a live offer with accept and decline, an expired one without, and joining only when a type is full", () => {
    const entry = { id: "e1", status: "OFFERED" as const, category: "TENT" as const, firstNight: null, lastNight: null, partySize: 2, roomCount: 1, offerExpiresAt: "2027-05-21T12:00:00.000Z", lapsed: false };
    const offered = renderToStaticMarkup(createElement(PublicLodgingAssignment, { token: "t", lodging: null, initialAssignments: { published: false, instructions: null, stays: [] }, initialWaitlist: { enabled: true, entry } }));
    expect(offered).toContain("Accept the place");
    expect(offered).toContain("Decline");
    expect(offered).toContain("does not charge anything by itself");
    const expired = renderToStaticMarkup(createElement(PublicLodgingAssignment, { token: "t", lodging: null, initialAssignments: { published: false, instructions: null, stays: [] }, initialWaitlist: { enabled: true, entry: { ...entry, lapsed: true } } }));
    expect(expired).toContain("The offer has expired");
    expect(expired).not.toContain("Accept the place");
    const join = renderToStaticMarkup(createElement(PublicLodgingAssignment, { token: "t", lodging, initialAssignments: { published: false, instructions: null, stays: [] }, initialWaitlist: { enabled: true, entry: null } }));
    expect(join).toContain("Join the waitlist");
    expect(join).toContain("Nothing is charged by joining");
  });
});
