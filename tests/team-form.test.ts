import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn(), currentRegistrationAnswers: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/registrations/amendments-repository", () => ({ currentRegistrationAnswers: mocks.currentRegistrationAnswers }));

import { TeamFormSheet } from "@/components/team-form-sheet";
import { buildTeamForm, type TeamFormFilled, type TeamFormInput } from "@/modules/club-teams/team-form";
import { loadBlankTeamForm, loadFilledTeamForm } from "@/modules/club-teams/team-form-repository";

/** The printable team form (#809): the 4-1 wording with the event's own dates. Synthetic names only. */

const settings = {
  minTeamMembers: 2, maxTeamMembers: 7, maxAlternates: 1, maxMemberAge: 19, ageAsOf: "2026-01-01",
  booksLine: "The Book of Mark, 1-2 Peter, 1-3 John & Commentary",
  levelInfo: [
    { level: "CONFERENCE" as const, date: "2027-02-20", place: "TBA" },
    { level: "UNION" as const, date: "2027-03-27", place: "Lincoln, NE" },
  ],
};
const base: TeamFormInput = {
  areaDate: "2027-01-16",
  areaPlaces: [{ name: "Missouri", address: null }, { name: "Iowa", address: null }],
  registrationClosesOn: "2026-12-18",
  settings,
  filled: null,
};
const filled: TeamFormFilled = {
  teamName: "Bible Bees", clubName: "Test Pathfinders", church: "Test SDA Church", confirmationCode: "PBE-1", areaLocation: "Iowa",
  coordinator: { name: "Pat Coordinator", address: "1 Example Road", city: "Testville", state: "IA", zip: "50000", phone: "515-555-0100", email: "pat@example.test" },
  partnerClub: "Sample Explorers", members: ["Alex Sample", "Casey Example"], alternate: "Morgan Reported", coaches: ["Jordan Example"],
  confirmed: true, confirmedOn: "2026-11-02", releaseAnswer: "Yes" as const,
};

describe("the team form's wording", () => {
  it("states the three level dates and the due date from the event, with the Area date of January 16", () => {
    const model = buildTeamForm(base);
    expect(model.dueNote).toBe("Due December 18");
    expect(model.datesParagraph).toBe(
      "The IA/MO Conference Area Bible Experiences will be held January 16, 2027. There will be two locations, Missouri and Iowa. Locations will be provided at a later date. "
      + "The Conference Bible Experience will be February 20, 2027. The Mid-America Union Bible Experience will be March 27, 2027 in Lincoln, NE. "
      + "The deadline for this registration form is December 18. Do not use the NAD dates on their website. The IA-MO Conference dates are different from the other Conferences in this Union.",
    );
    expect(model.datesParagraph).not.toContain("January 17");
  });

  it("carries the books line, the team rules from the settings, and the director's confirmation", () => {
    const model = buildTeamForm(base);
    expect(model.booksLine).toBe("The Book of Mark, 1-2 Peter, 1-3 John & Commentary");
    expect(model.teamParagraph).toContain("not older than 19 as of January 1, 2026");
    expect(model.teamParagraph).toContain("a minimum of two members, and the maximum number is seven, which includes the alternate member.");
    expect(model.confirmationText).toBe("Every team member is an inducted Pathfinder/TLT in good standing, has not graduated from high school and is not older than 19 as of January 1, 2026.");
    expect(model.releaseText).toContain("photographed and/or videotaped");
    expect(model.formNumber).toBe("4-1");
  });

  it("says nothing it cannot back: no due note without a closing date, no size sentence without limits, a later date for an unknown level", () => {
    const model = buildTeamForm({ ...base, registrationClosesOn: null, settings: { ...settings, minTeamMembers: null, maxTeamMembers: null, maxMemberAge: null, levelInfo: [] } });
    expect(model.dueNote).toBe("");
    expect(model.teamParagraph).not.toContain("minimum of");
    expect(model.teamParagraph).not.toContain("not older than");
    expect(model.datesParagraph).toContain("The Conference Bible Experience will be announced later.");
    expect(model.datesParagraph).not.toContain("The deadline");
  });

  it("leaves out the 'provided at a later date' line once every location has an address", () => {
    const model = buildTeamForm({ ...base, areaPlaces: [{ name: "Missouri", address: "1 Test Road" }, { name: "Iowa", address: "2 Test Road" }] });
    expect(model.datesParagraph).not.toContain("provided at a later date");
  });

  it("numbers six member lines, and one more when a team of seven names no alternate", () => {
    expect(buildTeamForm(base).memberSlots).toHaveLength(6);
    const seven = buildTeamForm({ ...base, filled: { ...filled, members: Array.from({ length: 7 }, (_, index) => `Member ${index + 1}`), alternate: "" } });
    expect(seven.memberSlots).toHaveLength(7);
    expect(seven.memberSlots[6]).toEqual({ number: 7, name: "Member 7" });
  });
});

describe("the printed sheet", () => {
  it("renders the blank form with empty lines, a signature line and the paper's wording", () => {
    const html = renderToStaticMarkup(createElement(TeamFormSheet, { model: buildTeamForm(base) }));
    for (const text of ["Iowa-Missouri Conference Pathfinder", "Bible Experience Participating Form", "Due December 18", "The Team", "The Team&#x27;s Coordinator", "Team Members", "Alternate Member:", "Club Director&#x27;s Signature:", "4-1"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("January 16, 2027");
    expect(html).not.toContain("Pat Coordinator");
  });

  it("renders the filled form with the coordinator, members, alternate, coaches and the recorded confirmation", () => {
    const html = renderToStaticMarkup(createElement(TeamFormSheet, { model: buildTeamForm({ ...base, filled }) }));
    for (const text of ["Pat Coordinator", "1 Example Road", "Testville", "pat@example.test", "Test Pathfinders", "Test SDA Church", "Bible Bees", "Alex Sample", "Casey Example", "Morgan Reported", "Jordan Example", "Sample Explorers", "Confirmed online on November 2, 2026"]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("Club Director&#x27;s Signature:");
  });

  it("shows the release answer the director gave, or says none was recorded", () => {
    const html = (releaseAnswer: "Yes" | "No" | "") => renderToStaticMarkup(createElement(TeamFormSheet, { model: buildTeamForm({ ...base, filled: { ...filled, releaseAnswer } }) }));
    expect(html("Yes")).toContain("Release understood and agreed:</strong> Yes");
    expect(html("No")).toContain("Release understood and agreed:</strong> No");
    expect(html("")).toContain("Not recorded");
    expect(renderToStaticMarkup(createElement(TeamFormSheet, { model: buildTeamForm({ ...base, filled: null }) }))).not.toContain("Release understood and agreed");
  });

  it("says plainly when the confirmation was not recorded", () => {
    const html = renderToStaticMarkup(createElement(TeamFormSheet, { model: buildTeamForm({ ...base, filled: { ...filled, confirmed: false, confirmedOn: null } }) }));
    expect(html).toContain("(not recorded)");
  });
});

describe("loading the form", () => {
  const event = { name: "Synthetic PBE", startsAt: new Date("2027-01-16T16:00:00Z"), timezone: "America/Chicago", registrationClosesOn: "2026-12-18", isPublished: true, audience: "CLUB" };
  const teamRow = {
    teamName: "Bible Bees", registrationId: "reg-1", createdAt: new Date("2026-11-03T02:30:00Z"),
    organization: { name: "Test Pathfinders", parentOrganization: { name: "Test SDA Church" } },
    registration: {
      confirmationCode: "PBE-1", status: "CONFIRMED", location: { name: "Iowa" },
      attendees: [
        { profileSnapshot: { firstName: "Alex", lastName: "Sample", teamRole: "MEMBER" }, formResponses: {} },
        { profileSnapshot: { firstName: "Morgan", lastName: "Reported", teamRole: "MEMBER" }, formResponses: { alternate: true } },
        { profileSnapshot: { firstName: "Jordan", lastName: "Example", teamRole: "COACH" }, formResponses: { dietary_needs: "PRIVATE" } },
      ],
    },
  };
  const prisma = (overrides: { settings?: unknown; team?: unknown; event?: unknown } = {}) => {
    const client = {
      event: { findUnique: vi.fn().mockResolvedValue("event" in overrides ? overrides.event : event) },
      eventTeamSettings: { findUnique: vi.fn().mockResolvedValue("settings" in overrides ? overrides.settings : { eventId: "e", allowMultipleTeams: true, ...settings }) },
      eventLocation: { findMany: vi.fn().mockResolvedValue([{ name: "Missouri", address: null }, { name: "Iowa", address: null }]) },
      clubEventRegistration: { findFirst: vi.fn().mockResolvedValue("team" in overrides ? overrides.team : teamRow) },
    };
    mocks.getPrisma.mockReturnValue(client);
    return client;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentRegistrationAnswers.mockResolvedValue({ responses: {
      coordinator_name: "Pat Coordinator", coordinator_address: "1 Example Road", coordinator_city: "Testville", coordinator_state: "IA", coordinator_zip: "50000",
      coordinator_phone: "515-555-0100", coordinator_email: "pat@example.test", partner_club: "", director_confirmation: true, photo_video_release: "Yes",
      medical_notes: "PRIVATE",
    } });
  });

  it("shows where the Area Coordinator's permission stands beside a team member of 18 or older", async () => {
    prisma({ team: { ...teamRow, registration: { ...teamRow.registration, attendees: [
      { profileSnapshot: { firstName: "Alex", lastName: "Sample", teamRole: "MEMBER" }, formResponses: {}, teamPermission: { status: "PENDING" } },
      { profileSnapshot: { firstName: "Morgan", lastName: "Reported", teamRole: "MEMBER" }, formResponses: { alternate: true }, teamPermission: { status: "GRANTED" } },
      { profileSnapshot: { firstName: "Blake", lastName: "Younger", teamRole: "MEMBER" }, formResponses: {}, teamPermission: null },
    ] } } });
    const page = await loadFilledTeamForm({ eventId: "event-1", organizationId: "club-1", teamKey: "bible bees" });
    expect(page?.model.filled?.members).toEqual(["Alex Sample (AC permission: pending)", "Blake Younger"]);
    expect(page?.model.filled?.alternate).toBe("Morgan Reported (AC permission: granted)");
  });

  it("fills members, the alternate and coaches from the attendees, and the coordinator from the registration answers", async () => {
    const client = prisma();
    const page = await loadFilledTeamForm({ eventId: "event-1", organizationId: "club-1", teamKey: "bible bees" });
    expect(page?.title).toBe("Bible Bees (Test Pathfinders)");
    expect(page?.model.filled).toMatchObject({ members: ["Alex Sample"], alternate: "Morgan Reported", coaches: ["Jordan Example"], areaLocation: "Iowa", confirmed: true, confirmedOn: "2026-11-02", releaseAnswer: "Yes" });
    expect(page?.model.filled?.coordinator.name).toBe("Pat Coordinator");
    // Looked up under the club and the team named, never by the team alone.
    expect(client.clubEventRegistration.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "event-1", organizationId: "club-1", teamKey: "bible bees" } }));
    // Nothing private reaches the form.
    expect(JSON.stringify(page)).not.toContain("PRIVATE");
  });

  it("uses the event's first day as the Area date, in the event's own time zone", async () => {
    prisma();
    const page = await loadFilledTeamForm({ eventId: "event-1", clubEventRegistrationId: "cer-1" });
    expect(page?.model.datesParagraph).toContain("held January 16, 2027");
  });

  it("finds nothing for a team the club never registered, a cancelled one, or an event without teams", async () => {
    prisma({ team: null });
    expect(await loadFilledTeamForm({ eventId: "event-1", organizationId: "club-1", teamKey: "not-a-team" })).toBeNull();
    prisma({ team: { ...teamRow, registration: { ...teamRow.registration, status: "CANCELLED" } } });
    expect(await loadFilledTeamForm({ eventId: "event-1", organizationId: "club-1", teamKey: "bible bees" })).toBeNull();
    prisma({ settings: null });
    expect(await loadFilledTeamForm({ eventId: "event-1", organizationId: "club-1", teamKey: "bible bees" })).toBeNull();
  });

  it("builds the blank form, and keeps it to a published club event for a director", async () => {
    prisma();
    expect((await loadBlankTeamForm("event-1"))?.model.filled).toBeNull();
    prisma({ event: { ...event, isPublished: false } });
    expect(await loadBlankTeamForm("event-1", { publishedClubOnly: true })).toBeNull();
    expect(await loadBlankTeamForm("event-1")).not.toBeNull();
    prisma({ event: { ...event, audience: "GENERAL" } });
    expect(await loadBlankTeamForm("event-1", { publishedClubOnly: true })).toBeNull();
  });
});
