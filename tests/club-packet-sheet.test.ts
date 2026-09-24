import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ClubPacketSheet } from "@/components/club-packet-sheet";
import type { ClubPacket } from "@/modules/reporting/club-packet";

function packet(overrides: Partial<ClubPacket> = {}): ClubPacket {
  return {
    event: {
      name: "Spring Camporee 2026",
      conferenceName: "IMSDA Events",
      startsOn: "2026-05-01T00:00:00.000Z",
      endsOn: "2026-05-03T00:00:00.000Z",
      timezone: "America/Chicago",
      earlyBirdDeadline: "2026-04-11",
      lateRateApplied: false,
    },
    club: {
      organizationId: "org-1",
      organizationName: "Trailblazers",
      sponsoringChurch: "Ankeny SDA",
      directorName: "Pat Rivera",
      email: "pat@example.org",
      phone: "555-0100",
      submittedAt: "2026-01-05T00:00:00.000Z",
      confirmationCode: "CAMP-001",
    },
    headcounts: { pathfinder: 1, tlt: 0, staff: 1, child: 0, total: 2 },
    firstTimeCampers: 1,
    attendees: [
      { id: "att-1", lastName: "Lee", firstName: "Jamie", roleAbbreviation: "PF", ageOnEventDate: 12, gender: "Female", medicalPersonnel: false, masterGuideInvestiture: false, firstTimeCamper: true, hasDietaryNeed: true },
      { id: "att-2", lastName: "Diaz", firstName: "Robin", roleAbbreviation: "Stf", ageOnEventDate: 34, gender: "Male", medicalPersonnel: true, masterGuideInvestiture: false, firstTimeCamper: false, hasDietaryNeed: false },
    ],
    camping: { tents: "3 large", trailers: "1", kitchenCanopy: "20x20", totalSqft: "900", campNextTo: "Eagles" },
    assignment: { campsiteLocation: "Field C", campsiteNotes: "", dutyLabel: "Flags", dutyDay: "Friday", dutyTime: "AM", activityLabel: "Skit", notes: "" },
    dutyPreferences: { dutyAreas: ["Flag raising / lowering"], flagSlots: ["Friday morning"], bathroomDays: [] },
    otherDetails: { specialActivities: ["Lead mixer Thursday night at vespers"], sponsoringMeals: true, mealSponsorshipCount: "10", mealTimes: ["Friday lunch"], partnerClub: "Eagles", eventRibbons: "Yes", sabbathSkit: "Noah's Ark" },
    milestones: { baptismNames: "Jamie Lee", bibleNames: "Sam Ortiz" },
    amountOwedCents: 4500,
    isBilled: true,
    ...overrides,
  };
}

describe("ClubPacketSheet", () => {
  it("renders both sides, one letter page each, with side markers and no birth date anywhere", () => {
    const markup = renderToStaticMarkup(createElement(ClubPacketSheet, { packet: packet(), qrSrc: "/api/x/qr" }));
    expect(markup).toContain("club-packet-front");
    expect(markup).toContain("club-packet-back");
    expect(markup).toContain("1 of 2");
    expect(markup).toContain("2 of 2");
    expect(markup).not.toMatch(/birth|dob/i);
  });

  it("shows the front roster with role, age, and marker flags, but never free-text dietary detail", () => {
    const markup = renderToStaticMarkup(createElement(ClubPacketSheet, { packet: packet(), qrSrc: "/api/x/qr" }));
    expect(markup).toContain("Lee, Jamie");
    expect(markup).toContain("Diaz, Robin");
    expect(markup).toContain("[M]");
    expect(markup).not.toContain("peanuts");
  });

  it("marks first-time campers with a star and counts them in the summary", () => {
    const markup = renderToStaticMarkup(createElement(ClubPacketSheet, { packet: packet(), qrSrc: "/api/x/qr" }));
    expect(markup).toContain("Lee, Jamie ★");
    expect(markup).not.toContain("Diaz, Robin ★");
    expect(markup).toContain("First-time campers");
  });

  it("shows the back's camping requirements, assignment, and estimated amount billed to the church", () => {
    const markup = renderToStaticMarkup(createElement(ClubPacketSheet, { packet: packet(), qrSrc: "/api/x/qr" }));
    expect(markup).toContain("3 large");
    expect(markup).toContain("Field C");
    expect(markup).toContain("$45.00");
  });

  it("renders the club's own QR pass image from the given source", () => {
    const markup = renderToStaticMarkup(createElement(ClubPacketSheet, { packet: packet(), qrSrc: "/api/events/e1/clubs/org-1/club-pass/qr" }));
    expect(markup).toContain("/api/events/e1/clubs/org-1/club-pass/qr");
  });

  it("shows an unassigned note on the back when staff haven't set an assignment yet", () => {
    const markup = renderToStaticMarkup(createElement(ClubPacketSheet, { packet: packet({ assignment: null }), qrSrc: "/api/x/qr" }));
    expect(markup).toContain("Not yet assigned by staff.");
  });
});
