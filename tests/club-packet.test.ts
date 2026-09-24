import { describe, expect, it } from "vitest";
import { buildClubEventRecord, type BuildClubEventRecordInput } from "@/modules/reporting/club-event-reports";
import { buildClubPacket, withClubPacketAssignment } from "@/modules/reporting/club-packet";

function clubInput(): BuildClubEventRecordInput {
  return {
    organizationId: "org-1",
    organizationName: "Trailblazers",
    sponsoringChurch: "Ankeny SDA",
    registrationId: "reg-1",
    confirmationCode: "CAMP-001",
    status: "CONFIRMED",
    submittedAt: "2026-01-05T00:00:00.000Z",
    registrationResponses: {
      director_name: "Pat Rivera",
      email: "pat@example.org",
      phone: "555-0100",
      tents: "3 large",
      trailers: "1",
      kitchen_canopy: "20x20",
      total_sqft: "900",
      camp_next_to: "Eagles",
      duty_areas: ["Flag raising / lowering"],
      flag_slots: ["Friday morning"],
      bathroom_days: [],
      special_activities: ["Lead mixer Thursday night at vespers"],
      partner_club: "Eagles",
      event_ribbons: "Yes",
      sabbath_skit: "Noah's Ark",
      sponsoring_meals: "Yes",
      meal_sponsorship_count: "10",
      meal_times: ["Friday lunch"],
      baptism_names: "Jamie Lee",
      bible_names: "Sam Ortiz",
    },
    attendees: [
      { id: "att-1", firstName: "Jamie", lastName: "Lee", responses: { attendee_type: "Pathfinder", attendee_age: 12, gender: "Female", dietary_needs: "peanuts" } },
      { id: "att-2", firstName: "Robin", lastName: "Diaz", responses: { attendee_type: "Staff", attendee_age: 34, medical_personnel: true } },
    ],
    amountOwedCents: 4500,
    pricingSnapshot: {},
    lateRateLabel: null,
  };
}

function eventInfo() {
  return {
    name: "Spring Camporee 2026",
    conferenceName: "IMSDA Events",
    startsOn: "2026-05-01T00:00:00.000Z",
    endsOn: "2026-05-03T00:00:00.000Z",
    timezone: "America/Chicago",
    earlyBirdDeadline: "2026-04-11",
    lateRateApplied: false,
  };
}

describe("buildClubPacket", () => {
  it("builds headcounts, roster, camping, and billing from the club record, with no assignment until one is attached", () => {
    const club = buildClubEventRecord(clubInput());
    const packet = buildClubPacket(club, eventInfo());
    expect(packet.headcounts).toEqual({ pathfinder: 1, tlt: 0, staff: 1, child: 0, total: 2 });
    expect(packet.attendees).toHaveLength(2);
    expect(packet.camping.tents).toBe("3 large");
    expect(packet.amountOwedCents).toBe(4500);
    expect(packet.isBilled).toBe(true);
    expect(packet.assignment).toBeNull();
  });

  it("carries no birth date anywhere in the built packet", () => {
    const club = buildClubEventRecord(clubInput());
    const packet = buildClubPacket(club, eventInfo());
    expect(JSON.stringify(packet)).not.toMatch(/birth|dob/i);
  });

  it("never carries the dietary free text itself, only the flag", () => {
    const club = buildClubEventRecord(clubInput());
    const packet = buildClubPacket(club, eventInfo());
    expect(JSON.stringify(packet)).not.toContain("peanuts");
    expect(packet.attendees.find((a) => a.id === "att-1")?.hasDietaryNeed).toBe(true);
  });

  it("attaches a staff assignment onto an already-built packet", () => {
    const club = buildClubEventRecord(clubInput());
    const packet = withClubPacketAssignment(
      buildClubPacket(club, eventInfo()),
      { campsiteLocation: "Field C", campsiteNotes: "", dutyLabel: "Flags", dutyDay: "Friday", dutyTime: "AM", activityLabel: "Skit", notes: "" },
    );
    expect(packet.assignment?.campsiteLocation).toBe("Field C");
  });
});
