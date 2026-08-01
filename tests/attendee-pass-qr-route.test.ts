import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAuthorizedAttendeePass: vi.fn(),
  checkPublicManageRateLimit: vi.fn(),
  qrToString: vi.fn(),
  qrToBuffer: vi.fn(),
}));

vi.mock("@/modules/checkin/attendee-pass-repository", () => ({
  createAuthorizedAttendeePass: mocks.createAuthorizedAttendeePass,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkPublicManageRateLimit: mocks.checkPublicManageRateLimit,
}));
vi.mock("qrcode", () => ({
  default: { toString: mocks.qrToString, toBuffer: mocks.qrToBuffer },
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
  mocks.qrToBuffer.mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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

  /**
   * The PNG exists to be embedded in a confirmation email, which loads it from
   * a mail client — another origin by definition. The SVG the app renders keeps
   * `same-origin`; this one response has to opt out, or browser-based clients
   * refuse the image before it ever renders.
   */
  it("returns an embeddable PNG that a mail client can load cross-origin", async () => {
    const response = await GET(
      new Request(
        `https://events.imsda.test/api/public/manage/${token}/attendee-passes/attendee_456/qr?format=png`,
      ),
      context,
    );

    expect(response.status).toBe(200);
    expect(mocks.qrToBuffer).toHaveBeenCalledWith(
      "imsda-pass.v1.payload.signature",
      expect.objectContaining({ type: "png", errorCorrectionLevel: "M" }),
    );
    expect(mocks.qrToString).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");

    // Opting out of CORP must not loosen anything else: the URL still carries a
    // bearer token, so it stays uncacheable, unindexed, and referrer-free.
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toContain("noindex");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps the in-app SVG same-origin", async () => {
    const response = await GET(
      new Request(
        `https://events.imsda.test/api/public/manage/${token}/attendee-passes/attendee_456/qr`,
      ),
      context,
    );

    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
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

