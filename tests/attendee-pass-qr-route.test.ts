import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAuthorizedAttendeePass: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
  qrToString: vi.fn(),
}));

vi.mock("@/modules/checkin/attendee-pass-repository", () => ({
  createAuthorizedAttendeePass: mocks.createAuthorizedAttendeePass,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicManageRateLimit: mocks.checkPublicManageRateLimit,
}));
vi.mock("qrcode", () => ({
  default: { toString: mocks.qrToString },
}));

import { GET } from "@/app/api/public/manage/[token]/attendee-passes/[attendeeId]/qr/route";

const token = "a".repeat(43);
const context = {
  params: Promise.resolve({
    token,
    attendeeId: "attendee_456",
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkPublicManageRateLimit.mockResolvedValue({
    allowed: true,
    decisions: [{
      policy: "public.manage.read.client-token",
      allowed: true,
      limit: 60,
      remaining: 59,
      count: 1,
      windowSeconds: 900,
      resetAfterSeconds: 200,
    }],
  });
  mocks.createAuthorizedAttendeePass.mockResolvedValue({
    token: "imsda-pass.v1.payload.signature",
    expiresAt: new Date("2026-10-13T17:00:00.000Z"),
  });
  mocks.qrToString.mockResolvedValue("<svg><path d=\"M0 0\" /></svg>");
});

describe("private attendee QR route", () => {
  it("authorizes the manage token and returns an uncacheable SVG", async () => {
    const response = await GET(
      new Request(
        `https://events.imsda.test/api/public/manage/${token}/attendee-passes/attendee_456/qr`,
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.createAuthorizedAttendeePass).toHaveBeenCalledWith(
      token,
      "attendee_456",
    );
    expect(mocks.qrToString).toHaveBeenCalledWith(
      "imsda-pass.v1.payload.signature",
      expect.objectContaining({
        type: "svg",
        errorCorrectionLevel: "M",
      }),
    );
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  });

  it("uses one private unavailable response when access or attendee scope fails", async () => {
    mocks.createAuthorizedAttendeePass.mockResolvedValue(null);

    const response = await GET(
      new Request(
        `https://events.imsda.test/api/public/manage/${token}/attendee-passes/attendee_other/qr`,
      ),
      {
        params: Promise.resolve({
          token,
          attendeeId: "attendee_other",
        }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      error: "ATTENDEE_PASS_UNAVAILABLE",
      message: "This attendee pass is invalid or no longer available.",
    });
  });

  it("rate limits private QR rendering before access resolution", async () => {
    mocks.checkPublicManageRateLimit.mockResolvedValue({
      allowed: false,
      decisions: [{
        policy: "public.manage.read.client-token",
        allowed: false,
        limit: 60,
        remaining: 0,
        count: 61,
        windowSeconds: 900,
        resetAfterSeconds: 200,
      }],
    });

    const response = await GET(
      new Request(
        `https://events.imsda.test/api/public/manage/${token}/attendee-passes/attendee_456/qr`,
      ),
      context,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("200");
    expect(mocks.createAuthorizedAttendeePass).not.toHaveBeenCalled();
  });
});

