import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  listDirectedClubs: vi.fn(),
  findEnrollment: vi.fn(),
  findSession: vi.fn(),
  countPasskeys: vi.fn(),
  findSettings: vi.fn(),
  createDirectorClubPass: vi.fn(),
  toString: vi.fn(),
}));

vi.mock("server-only", () => ({}));
// The attendee second step is covered in tests/club-second-step.test.ts; here it has been passed.
vi.mock("@/modules/attendee-accounts/sign-in-gate", () => ({ accountNeedsSecondStep: async () => "OK" }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    attendeeMfaEnrollment: { findUnique: mocks.findEnrollment },
    attendeeSession: { findUnique: mocks.findSession },
    attendeePasskey: { count: mocks.countPasskeys },
    platformSettings: { findUnique: mocks.findSettings },
  }),
}));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({ getCurrentAttendee: mocks.getCurrentAttendee }));
vi.mock("@/modules/organizations/staff-act-as", () => ({ currentStaffActingContext: async () => null }));
vi.mock("@/modules/organizations/director-access", () => ({ listDirectedClubs: mocks.listDirectedClubs }));
vi.mock("@/modules/checkin/club-pass-repository", () => ({
  createDirectorClubPass: mocks.createDirectorClubPass,
}));
vi.mock("qrcode", () => ({ default: { toString: mocks.toString } }));

import { GET } from "@/app/api/attendee/clubs/[organizationId]/events/[eventId]/club-pass/qr/route";

const club = { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null };
const account = { id: "director-1", verifiedEmail: "director@example.test", displayName: "Test Director" };

function context(organizationId = "club-1", eventId = "event_123") {
  return { params: Promise.resolve({ organizationId, eventId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({ account, via: "attendee", sessionId: "session-1" });
  mocks.listDirectedClubs.mockResolvedValue([club]);
  mocks.findEnrollment.mockResolvedValue({ status: "ACTIVE" });
  mocks.findSession.mockResolvedValue({ secondFactorVerifiedAt: new Date() });
  mocks.countPasskeys.mockResolvedValue(0);
  mocks.findSettings.mockResolvedValue({ passkeyRpId: null });
  mocks.createDirectorClubPass.mockResolvedValue({
    token: "imsda-club-pass.v1.payload.signature",
    expiresAt: new Date("2026-10-13T17:00:00.000Z"),
  });
  mocks.toString.mockResolvedValue("<svg>club pass</svg>");
});

describe("director's club check-in QR route (#412)", () => {
  it("renders a no-store SVG for the director's own club", async () => {
    const response = await GET(new Request("https://events.imsda.test/x"), context());

    expect(mocks.createDirectorClubPass).toHaveBeenCalledWith("club-1", "event_123");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("<svg>club pass</svg>");
  });

  it("refuses another club's director with 404, never rendering that club's QR", async () => {
    const response = await GET(new Request("https://events.imsda.test/x"), context("club-2"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createDirectorClubPass).not.toHaveBeenCalled();
    expect(mocks.toString).not.toHaveBeenCalled();
  });

  it("refuses a signed-out visitor", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: null, via: null, sessionId: null });
    const response = await GET(new Request("https://events.imsda.test/x"), context());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createDirectorClubPass).not.toHaveBeenCalled();
  });

  it("answers with 404 when the club has no active registration for this event", async () => {
    mocks.createDirectorClubPass.mockResolvedValue(null);
    const response = await GET(new Request("https://events.imsda.test/x"), context());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "CLUB_PASS_UNAVAILABLE" });
    expect(mocks.toString).not.toHaveBeenCalled();
  });
});
