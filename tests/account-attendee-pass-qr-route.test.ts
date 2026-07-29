import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentAttendee: vi.fn(),
  createAccountAttendeePass: vi.fn(),
  qrToString: vi.fn(),
}));

vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: mocks.getCurrentAttendee,
}));
vi.mock("@/modules/checkin/attendee-pass-repository", () => ({
  createAccountAttendeePass: mocks.createAccountAttendeePass,
}));
vi.mock("qrcode", () => ({
  default: { toString: mocks.qrToString },
}));

import { GET } from "@/app/api/attendee/registrations/[registrationId]/attendee-passes/[attendeeId]/qr/route";

const context = {
  params: Promise.resolve({
    registrationId: "registration-1",
    attendeeId: "attendee-1",
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentAttendee.mockResolvedValue({
    account: {
      id: "account-1",
      verifiedEmail: "guest@example.test",
      displayName: "Guest",
    },
    via: "attendee",
  });
  mocks.createAccountAttendeePass.mockResolvedValue({
    token: "imsda-pass.v1.payload.signature",
    expiresAt: new Date("2026-10-13T17:00:00.000Z"),
  });
  mocks.qrToString.mockResolvedValue("<svg>account pass</svg>");
});

describe("account attendee pass QR route", () => {
  it("scopes the pass to the verified account and returns a private SVG", async () => {
    const response = await GET(new Request(
      "https://events.imsda.test/api/attendee/registrations/registration-1/attendee-passes/attendee-1/qr",
    ), context);

    expect(mocks.createAccountAttendeePass).toHaveBeenCalledWith(
      "guest@example.test",
      "registration-1",
      "attendee-1",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  it("does not attempt to render without an attendee account", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({
      account: null,
      via: null,
    });

    const response = await GET(new Request(
      "https://events.imsda.test/api/attendee/registrations/registration-1/attendee-passes/attendee-1/qr",
    ), context);

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.createAccountAttendeePass).not.toHaveBeenCalled();
    expect(mocks.qrToString).not.toHaveBeenCalled();
  });

  it("uses one unavailable response when registration ownership or attendee scope fails", async () => {
    mocks.createAccountAttendeePass.mockResolvedValue(null);

    const response = await GET(new Request(
      "https://events.imsda.test/api/attendee/registrations/registration-1/attendee-passes/attendee-other/qr",
    ), {
      params: Promise.resolve({
        registrationId: "registration-1",
        attendeeId: "attendee-other",
      }),
    });

    expect(response.status).toBe(404);
    expect(mocks.qrToString).not.toHaveBeenCalled();
  });
});
