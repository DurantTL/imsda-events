import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A club director sees only their own club's assignment (#410). The roster
 * access state is the one thing stubbed; the loader and repository are real,
 * so these prove which rows it would read.
 */
const mocks = vi.hoisted(() => ({
  getRosterAccessState: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessState: mocks.getRosterAccessState }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ clubEventAssignment: { findUnique: mocks.findUnique } }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/registrations/amendments-repository", () => ({ currentRegistrationAnswers: vi.fn() }));

import { loadDirectorClubAssignment } from "@/modules/club-registrations/director-assignment";

const clubA = { organizationId: "org-a", name: "Pathfinder Pioneers", role: "DIRECTOR" };
const setRow = {
  campsiteLocation: "Field C, site 12",
  campsiteNotes: "",
  dutyLabel: "Flag raising",
  dutyDay: "Friday",
  dutyTime: "morning",
  activityLabel: "Campfire singing",
  notes: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(setRow);
});

describe("loadDirectorClubAssignment", () => {
  it("returns null without querying when a director of club A requests club B", async () => {
    // getRosterAccessState resolves NOT_FOUND for a club the account doesn't direct.
    mocks.getRosterAccessState.mockResolvedValue({ state: "NOT_FOUND" });
    await expect(loadDirectorClubAssignment("org-b", "event-1")).resolves.toBeNull();
    expect(mocks.getRosterAccessState).toHaveBeenCalledWith("org-b");
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    { state: "MFA_UNLOCK", club: clubA, methods: { code: true, passkey: false } },
    { state: "NO_ROSTER", club: clubA, capabilities: { roster: false } },
    { state: "SIGN_IN" },
    { state: "OWN_SESSION_REQUIRED", club: clubA },
    { state: "MFA_SETUP", club: clubA },
  ])("returns null without querying for $state", async (access) => {
    mocks.getRosterAccessState.mockResolvedValue(access);
    await expect(loadDirectorClubAssignment("org-a", "event-1")).resolves.toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("reads exactly this event and this club when the roster is OPEN", async () => {
    mocks.getRosterAccessState.mockResolvedValue({
      state: "OPEN",
      club: clubA,
      capabilities: { roster: true },
      accountId: "account-1",
      sessionId: "session-1",
    });
    await expect(loadDirectorClubAssignment("org-a", "event-1")).resolves.toMatchObject({
      status: "SET",
      fields: { campsiteLocation: "Field C, site 12" },
    });
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { eventId_organizationId: { eventId: "event-1", organizationId: "org-a" } },
    });
  });

  it("returns null when staff haven't set anything yet", async () => {
    mocks.getRosterAccessState.mockResolvedValue({
      state: "OPEN",
      club: clubA,
      capabilities: { roster: true },
      accountId: "account-1",
      sessionId: "session-1",
    });
    mocks.findUnique.mockResolvedValue({ ...setRow, campsiteLocation: "", dutyLabel: "", activityLabel: "" });
    await expect(loadDirectorClubAssignment("org-a", "event-1")).resolves.toBeNull();
  });
});
