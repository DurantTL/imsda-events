import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockAccessDeniedError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: 401 | 403,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AccessDeniedError: MockAccessDeniedError,
    requirePermission: vi.fn(),
    getCurrentSession: vi.fn(),
    findActiveMembership: vi.fn(),
    createStaffAttendeePass: vi.fn(),
    toString: vi.fn(),
  };
});

vi.mock("@/modules/access/authorization", () => ({
  AccessDeniedError: mocks.AccessDeniedError,
  requirePermission: mocks.requirePermission,
}));
vi.mock("@/modules/access/current-session", () => ({
  getCurrentSession: mocks.getCurrentSession,
}));
vi.mock("@/modules/events/repository", () => ({
  findActiveMembership: mocks.findActiveMembership,
}));
vi.mock("@/modules/checkin/attendee-pass-repository", () => ({
  createStaffAttendeePass: mocks.createStaffAttendeePass,
}));
vi.mock("qrcode", () => ({
  default: { toString: mocks.toString },
}));

import { GET } from "@/app/api/events/[eventId]/attendee-passes/[attendeeId]/qr/route";

const context = {
  params: Promise.resolve({
    eventId: "event_123",
    attendeeId: "attendee_456",
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "staff_1" } });
  mocks.requirePermission.mockResolvedValue({ user: { id: "staff_1" } });
  mocks.createStaffAttendeePass.mockResolvedValue({
    token: "imsda-pass.v1.payload.signature",
    expiresAt: new Date("2026-10-13T17:00:00.000Z"),
  });
  mocks.toString.mockResolvedValue("<svg>private pass</svg>");
});

describe("staff attendee pass QR route", () => {
  it("requires event-scoped check-in access and returns a no-store SVG", async () => {
    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_123/attendee-passes/attendee_456/qr"),
      context,
    );

    expect(mocks.requirePermission).toHaveBeenCalledWith(
      { user: { id: "staff_1" } },
      "event_123",
      "MANAGE_CHECK_IN",
      mocks.findActiveMembership,
    );
    expect(mocks.createStaffAttendeePass).toHaveBeenCalledWith(
      "event_123",
      "attendee_456",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(await response.text()).toBe("<svg>private pass</svg>");
  });

  it("does not expose a pass that is unavailable or outside the event", async () => {
    mocks.createStaffAttendeePass.mockResolvedValue(null);

    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_123/attendee-passes/attendee_other/qr"),
      {
        params: Promise.resolve({
          eventId: "event_123",
          attendeeId: "attendee_other",
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      error: "ATTENDEE_PASS_UNAVAILABLE",
    });
  });

  it("returns a private authorization error without rendering a QR", async () => {
    mocks.requirePermission.mockRejectedValue(
      new mocks.AccessDeniedError("FORBIDDEN", 403, "Check-in access required."),
    );

    const response = await GET(
      new Request("https://events.imsda.test/api/events/event_123/attendee-passes/attendee_456/qr"),
      context,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createStaffAttendeePass).not.toHaveBeenCalled();
    expect(mocks.toString).not.toHaveBeenCalled();
  });
});
