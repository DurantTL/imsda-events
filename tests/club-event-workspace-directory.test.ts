import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  getPublicRegistrationExperience: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/forms/public-repository", () => ({
  getPublicRegistrationExperience: dependencies.getPublicRegistrationExperience,
  submitPublicRegistration: vi.fn(),
  PublicRegistrationError: class PublicRegistrationError extends Error {},
}));

import { attendeeProfilePrefill } from "@/modules/attendee-accounts/profile-service";
import { getClubEventWorkspace } from "@/modules/club-registrations/repository";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

// Synthetic fixture only.
const definition = registrationFormDefinitionSchema.parse({
  title: "Synthetic club registration",
  description: "",
  confirmationMessage: "Done",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add" },
  sections: [
    { id: "s_club", title: "Club", description: "", fields: [
      { id: "f_club", key: "club_name", label: "Pathfinder club", helpText: "", type: "SELECT", scope: "REGISTRATION", required: true, options: [], optionSource: "CLUBS_DIRECTORY" },
      { id: "f_club_other", key: "club_name_other", label: "Club — not listed", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [], conditional: { fieldKey: "club_name", operator: "EQUALS", value: "Not listed" } },
      { id: "f_director", key: "director_name", label: "Club director", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "f_church", key: "church_name", label: "Church", helpText: "", type: "SELECT", scope: "REGISTRATION", required: false, options: [], optionSource: "CHURCHES_DIRECTORY" },
    ] },
    { id: "s_roster", title: "Roster", description: "", fields: [
      { id: "a_first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
      { id: "a_last", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
    ] },
  ],
});

function mockPrisma(parentOrganization: { name: string; isActive: boolean } | null, draftResponses: Record<string, unknown> | null = null) {
  const prisma = {
    event: { findFirst: vi.fn().mockResolvedValue({
      id: "event-1", name: "Synthetic Camporee", slug: "synthetic-camporee",
      startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T20:00:00Z"),
      timezone: "America/Chicago", isPublished: true, registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30",
      waitlistEnabled: false, capacity: null,
    }) },
    registrationForm: { findFirst: vi.fn().mockResolvedValue({ slug: "clubs", versions: [{ definition }] }) },
    eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
    eventTeamSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    clubRosterMember: { findMany: vi.fn().mockResolvedValue([]) },
    clubEventRegistration: { findUnique: vi.fn().mockResolvedValue(null) },
    clubRegistrationDraft: { findUnique: vi.fn().mockResolvedValue(draftResponses ? {
      selectedMemberIds: [], guests: [], responses: draftResponses, attendeeResponses: {}, updatedAt: new Date("2026-10-10T12:00:00Z"),
    } : null) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: "Test Pathfinders", parentOrganization }) },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  dependencies.getPublicRegistrationExperience.mockResolvedValue({ form: { definition } });
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

describe("club event workspace directory prefill (#482)", () => {
  const now = new Date("2026-10-15T15:00:00Z");

  it("locks only the club, and prefills the club and its sponsoring church", async () => {
    mockPrisma({ name: "Test SDA Church", isActive: true });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.directory).toEqual({
      lockedFieldKeys: ["club_name"],
      prefillResponses: { club_name: "Test Pathfinders", church_name: "Test SDA Church" },
    });
  });

  it("leaves the church blank when the club has no sponsoring church", async () => {
    mockPrisma(null);
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.directory.prefillResponses).toEqual({ club_name: "Test Pathfinders" });
  });

  it("leaves the church blank when the sponsoring church is inactive", async () => {
    mockPrisma({ name: "Closed Test Church", isActive: false });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.directory.prefillResponses).toEqual({ club_name: "Test Pathfinders" });
    expect(workspace.directory.lockedFieldKeys).toEqual(["club_name"]);
  });

  it("lays the locked club over a saved draft holding a stale club name, keeping the draft's own church", async () => {
    mockPrisma({ name: "Test SDA Church", isActive: true }, { club_name: "Old Test Club", church_name: "Sample Chapel", director_name: "Avery Director" });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.draft?.responses).toEqual({ club_name: "Test Pathfinders", church_name: "Sample Chapel", director_name: "Avery Director" });
  });

  it("fills the club and the sponsoring church into a saved draft with no club or church", async () => {
    mockPrisma({ name: "Test SDA Church", isActive: true }, { director_name: "Avery Director" });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.draft?.responses).toEqual({ club_name: "Test Pathfinders", church_name: "Test SDA Church", director_name: "Avery Director" });
  });

  it("replaces a draft's \"Not listed\" club with the real club and drops the typed name", async () => {
    mockPrisma(null, { club_name: "Not listed", club_name_other: "Test Pathfinderz" });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.draft?.responses).toEqual({ club_name: "Test Pathfinders" });
  });

  it("prefills the director's name from their profile", () => {
    expect(attendeeProfilePrefill({
      firstName: "Avery", lastName: "Director", phone: "555-0100", shirtSize: "", dietaryNeeds: "", accessibilityNeeds: "",
      mailingLine1: "", mailingLine2: "", mailingCity: "", mailingRegion: "", mailingPostalCode: "", mailingCountry: "",
      emergencyContactName: "", emergencyContactRelationship: "", emergencyContactPhone: "",
    }, "director@example.test")).toMatchObject({ director_name: "Avery Director", email: "director@example.test", phone: "555-0100" });
  });
});

describe("club event workspace locations (#413)", () => {
  const now = new Date("2026-10-15T15:00:00Z");
  const location = (overrides: Record<string, unknown> = {}) => ({
    id: "loc-1", name: "Camp Heritage", address: "1 Synthetic Rd", firstDay: null, lastDay: null, capacity: null,
    registrationClosesOn: null, isActive: true, sortOrder: 0, ...overrides,
  });

  function withLocations(locations: ReturnType<typeof location>[], seats: Record<string, number> = {}, registered: { location: ReturnType<typeof location> } | null = null) {
    const prisma = mockPrisma(null);
    prisma.eventLocation.findMany.mockResolvedValue(locations);
    Object.assign(prisma, {
      registration: {
        findMany: vi.fn().mockResolvedValue(Object.entries(seats).map(([locationId, count]) => ({ locationId, _count: { attendees: count } }))),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });
    if (registered) {
      prisma.clubEventRegistration.findUnique.mockResolvedValue({
        createdAt: new Date("2026-10-10T12:00:00Z"), registrationId: "registration-1",
        registration: {
          confirmationCode: "REG-CLUB", status: "SUBMITTED", updatedAt: new Date("2026-10-10T12:00:00Z"), totalAmount: 0,
          location: registered.location, attendees: [], messages: [],
        },
      });
    }
    return prisma;
  }

  it.each([
    ["SENT", "SENT", false],
    ["PENDING", "PENDING", true],
    ["FAILED", "FAILED", true],
  ])("reports the real confirmation email state for a %s message (#642)", async (outbox, expected, hasSupport) => {
    const prisma = withLocations([], {}, { location: location({ id: "own" }) });
    prisma.event.findFirst.mockResolvedValue({
      ...(await prisma.event.findFirst()), supportContact: "events@example.test",
    });
    prisma.clubEventRegistration.findUnique.mockResolvedValue({
      createdAt: new Date("2026-10-10T12:00:00Z"), registrationId: "registration-1",
      registration: {
        confirmationCode: "REG-CLUB", status: "SUBMITTED", updatedAt: new Date("2026-10-10T12:00:00Z"),
        location: null, attendees: [], messages: [{ status: outbox }],
      },
    });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    const select = prisma.clubEventRegistration.findUnique.mock.calls[0]![0].select;
    const keys = select.registration.select.messages.where.templateKey.in;
    expect(keys).toEqual(expect.arrayContaining(["REGISTRATION_CONFIRMATION_ORGANIZATION_BILLED", "WAITLIST_PROMOTED"]));
    expect(workspace.registration?.confirmationEmail.status).toBe(expected);
    expect(workspace.registration?.confirmationEmail.supportEmail).toBe(hasSupport ? "events@example.test" : null);
  });

  it("has no locations for an event without them, and reads no seat counts", async () => {
    const prisma = mockPrisma(null);
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.locations).toEqual([]);
    expect(workspace.event.phase).toBe("OPEN");
    expect(prisma.eventLocation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { eventId: "event-1", isActive: true } }));
  });

  it("lists active locations with the event's dates filled in, seats left, and Full for a location with none", async () => {
    withLocations([
      location({ id: "loc-1", capacity: 3 }),
      location({ id: "loc-2", name: "Des Moines", capacity: 10, firstDay: "2026-12-12", lastDay: "2026-12-13" }),
      location({ id: "loc-3", name: "Kansas City" }),
    ], { "loc-1": 3, "loc-2": 4 });
    const { locations } = await getClubEventWorkspace("club-1", "event-1", now);
    expect(locations.map((entry) => [entry.name, entry.firstDay, entry.lastDay, entry.remaining, entry.full, entry.open])).toEqual([
      ["Camp Heritage", "2026-12-05", "2026-12-06", 0, true, true],
      ["Des Moines", "2026-12-12", "2026-12-13", 6, false, true],
      ["Kansas City", "2026-12-05", "2026-12-06", null, false, true],
    ]);
  });

  it("shows a location past its own closing date as closed while another is open, and the event open while any location is", async () => {
    withLocations([location({ id: "early", name: "Early", registrationClosesOn: "2026-10-10" }), location({ id: "open", name: "Open" })]);
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.locations.map((entry) => [entry.name, entry.phase, entry.open])).toEqual([["Early", "CLOSED", false], ["Open", "OPEN", true]]);
    expect(workspace.event.phase).toBe("OPEN");
    withLocations([location({ id: "early", name: "Early", registrationClosesOn: "2026-10-10" })]);
    expect((await getClubEventWorkspace("club-1", "event-1", now)).event.phase).toBe("CLOSED");
  });

  it("follows a registered club's own location for the phase, edit window, and dates, and never counts its own seats against it", async () => {
    const early = location({ id: "early", name: "Early", capacity: 5, registrationClosesOn: "2026-10-10" });
    const prisma = withLocations([location({ id: "open", name: "Open" })], { early: 2 }, { location: early });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.registration?.location).toMatchObject({ id: "early", name: "Early", phase: "CLOSED", registrationClosesOn: "2026-10-10", remaining: 3 });
    expect(workspace.event.edit).toMatchObject({ open: false });
    expect(workspace.event.registrationClosesOn).toBe("2026-10-10");
    // Seats are counted with this club's own registration left out.
    const seatQuery = (prisma as unknown as { registration: { findMany: ReturnType<typeof vi.fn> } }).registration.findMany.mock.calls[0]![0];
    expect(seatQuery.where).toMatchObject({ eventId: "event-1", id: { not: "registration-1" } });
  });

  it("shows a location's own closing date only when it differs from the event's", async () => {
    withLocations([
      location({ id: "same", name: "Same", registrationClosesOn: "2026-11-30" }),
      location({ id: "own", name: "Own", registrationClosesOn: "2026-11-15" }),
      location({ id: "none", name: "None" }),
    ]);
    const { locations } = await getClubEventWorkspace("club-1", "event-1", now);
    expect(locations.map((entry) => [entry.name, entry.registrationClosesOn, entry.ownClosingDate])).toEqual([
      ["Same", "2026-11-30", null], ["Own", "2026-11-15", "2026-11-15"], ["None", "2026-11-30", null],
    ]);
  });

  it("keeps a registered club's deactivated location on its page", async () => {
    const retired = location({ id: "retired", name: "Retired", isActive: false });
    withLocations([], {}, { location: retired });
    const workspace = await getClubEventWorkspace("club-1", "event-1", now);
    expect(workspace.locations).toEqual([]);
    expect(workspace.registration?.location).toMatchObject({ id: "retired", isActive: false });
  });
});
