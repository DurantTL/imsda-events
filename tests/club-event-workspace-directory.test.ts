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
    }, "director@example.test")).toMatchObject({ director_name: "Avery Director", email: "director@example.test", phone: "555-0100" });
  });
});
