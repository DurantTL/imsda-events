import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the profile route against the real second-step gate; only the
// grant, session and enrollment lookups are faked.
const mocks = vi.hoisted(() => ({
  rejectCrossOriginRequest: vi.fn(),
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  areaGrant: vi.fn(),
  session: vi.fn(),
  enrollment: vi.fn(),
  passkeyCount: vi.fn(),
  getAttendeeProfile: vi.fn(),
  updateAttendeeProfile: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    areaCoordinatorGrant: { findUnique: mocks.areaGrant },
    attendeeSession: { findUnique: mocks.session },
    attendeeMfaEnrollment: { findUnique: mocks.enrollment },
    attendeePasskey: { count: mocks.passkeyCount },
  }),
}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/attendee-accounts/return-redirect", () => ({ twoStepRedirectPath: vi.fn() }));
vi.mock("@/modules/attendee-accounts/passkeys", () => ({ passkeysConfigured: async () => false }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/attendee-accounts/profile-service", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/profile-service")>(
    "@/modules/attendee-accounts/profile-service",
  );
  return {
    attendeeProfileSchema: actual.attendeeProfileSchema,
    getAttendeeProfile: mocks.getAttendeeProfile,
    updateAttendeeProfile: mocks.updateAttendeeProfile,
  };
});

import { GET, PATCH } from "@/app/api/attendee/profile/route";

const profile = {
  firstName: "Avery",
  lastName: "Person",
  phone: "555-0100",
  shirtSize: "M",
  dietaryNeeds: "",
  accessibilityNeeds: "",
};
const patchRequest = () =>
  new Request("https://events.imsda.test/api/attendee/profile", {
    method: "PATCH",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(profile),
  });
const callGet = () => (GET as unknown as (r: Request) => Promise<Response>)(new Request("https://events.imsda.test/api/attendee/profile"));
const callPatch = () => (PATCH as unknown as (r: Request) => Promise<Response>)(patchRequest());

const club = [{ organizationId: "org-1", name: "Synthetic Club", role: "DIRECTOR", sponsoringChurch: null }];
const activeGrant = { revokedAt: null, expiresAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1" }, via: "attendee", sessionId: "sess-1" });
  mocks.listDirectedClubs.mockResolvedValue([]);
  mocks.areaGrant.mockResolvedValue(null);
  mocks.session.mockResolvedValue({ secondFactorVerifiedAt: null });
  mocks.enrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.passkeyCount.mockResolvedValue(0);
  mocks.getAttendeeProfile.mockResolvedValue(profile);
  mocks.updateAttendeeProfile.mockResolvedValue(profile);
});

describe("profile route with the real second-step gate", () => {
  it.each([
    ["Area Coordinator", () => mocks.areaGrant.mockResolvedValue(activeGrant)],
    ["club director", () => mocks.listDirectedClubs.mockResolvedValue(club)],
  ])("refuses a %s whose session has no second step", async (_name, arrange) => {
    arrange();
    const got = await callGet();
    expect(got.status).toBe(403);
    expect(await got.json()).toMatchObject({ code: "SECOND_STEP_REQUIRED" });
    expect((await callPatch()).status).toBe(403);
    expect(mocks.getAttendeeProfile).not.toHaveBeenCalled();
    expect(mocks.updateAttendeeProfile).not.toHaveBeenCalled();
  });

  it("allows an Area Coordinator once the session has passed its second step", async () => {
    mocks.areaGrant.mockResolvedValue(activeGrant);
    mocks.session.mockResolvedValue({ secondFactorVerifiedAt: new Date("2026-10-02T12:00:00Z") });
    expect((await callGet()).status).toBe(200);
    expect((await callPatch()).status).toBe(200);
    expect(mocks.updateAttendeeProfile).toHaveBeenCalledTimes(1);
  });

  it("allows an ordinary attendee with no role", async () => {
    expect((await callGet()).status).toBe(200);
    expect((await callPatch()).status).toBe(200);
    expect(mocks.updateAttendeeProfile).toHaveBeenCalledTimes(1);
  });
});
