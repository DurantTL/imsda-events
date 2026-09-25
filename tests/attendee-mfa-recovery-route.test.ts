import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minting recovery codes needs more than a password (#456 review): a session
 * that signed in with a password alone could otherwise mint fresh codes and
 * use one to open club rosters. The route must refuse unless the session
 * passed a second step recently or the request carries a current code.
 */

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getCurrentAttendee: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  openSecret: vi.fn(),
  scheduleLockoutEmails: vi.fn(),
  checkAttendeeRosterUnlockRateLimit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/secret-box", () => ({ openSecret: mocks.openSecret, sealSecret: vi.fn() }));
vi.mock("@/modules/attendee-accounts/current-attendee", () => ({
  getCurrentAttendee: mocks.getCurrentAttendee,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkAttendeeRosterUnlockRateLimit: mocks.checkAttendeeRosterUnlockRateLimit,
}));
vi.mock("@/modules/communications/lockout-email", () => ({
  scheduleLockoutEmails: mocks.scheduleLockoutEmails,
}));

import { POST } from "@/app/api/attendee/mfa/route";
import { totpCode } from "@/modules/access/totp";

const SECRET = "JBSWY3DPEHPK3PXP";

function rateLimit(allowed: boolean) {
  return {
    allowed,
    decisions: [{
      policy: "attendee.roster-unlock.account",
      allowed,
      limit: 5,
      remaining: allowed ? 4 : 0,
      count: allowed ? 1 : 6,
      windowSeconds: 900,
      resetAfterSeconds: 600,
    }],
  };
}

function request(body: Record<string, unknown>) {
  return new Request("https://events.imsda.test/api/attendee/mfa", {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

let prisma: {
  attendeeMfaEnrollment: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  attendeeMfaRecoveryCode: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  attendeeSession: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma = {
    attendeeMfaEnrollment: {
      findUnique: vi.fn().mockResolvedValue({
        id: "mfa-1",
        status: "ACTIVE",
        sealedSecret: "sealed",
        lastUsedStep: null,
        lockedUntil: null,
      }),
      update: vi.fn().mockResolvedValue({ failedAttempts: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    attendeeMfaRecoveryCode: {
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      createMany: vi.fn().mockResolvedValue({ count: 10 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    attendeeSession: { findUnique: vi.fn().mockResolvedValue({ accountId: "acct-1", secondFactorVerifiedAt: null }) },
    $transaction: vi.fn(async (values: Promise<unknown>[]) => Promise.all(values)),
  };
  mocks.getPrisma.mockReturnValue(prisma);
  mocks.openSecret.mockReturnValue(SECRET);
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkAttendeeRosterUnlockRateLimit.mockResolvedValue(rateLimit(true));
  mocks.getCurrentAttendee.mockResolvedValue({
    account: { id: "acct-1" },
    via: "attendee",
    sessionId: "sess-1",
  });
});

describe("POST /api/attendee/mfa regenerate-recovery-codes", () => {
  it("refuses a password-only session with 403 and mints nothing", async () => {
    const response = await POST(request({ action: "regenerate-recovery-codes" }));

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("RECENT_VERIFICATION_REQUIRED");
    expect(prisma.attendeeMfaRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it("refuses a staff member viewing a linked attendee account", async () => {
    mocks.getCurrentAttendee.mockResolvedValue({ account: { id: "acct-1" }, via: "staff", sessionId: null });

    const response = await POST(request({ action: "regenerate-recovery-codes", code: totpCode(SECRET, new Date()) }));

    expect(response.status).toBe(403);
    expect(prisma.attendeeMfaRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it("refuses a wrong code", async () => {
    const response = await POST(request({ action: "regenerate-recovery-codes", code: "000000" }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("MFA_CODE_INVALID");
    expect(prisma.attendeeMfaRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it("answers 429 while the second factor is locked", async () => {
    prisma.attendeeMfaEnrollment.findUnique.mockResolvedValue({
      id: "mfa-1",
      status: "ACTIVE",
      sealedSecret: "sealed",
      lastUsedStep: null,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    const response = await POST(request({ action: "regenerate-recovery-codes", code: "000000" }));

    expect(response.status).toBe(429);
    expect((await response.json()).error).toBe("MFA_LOCKED");
  });

  it("issues codes for a session that recently passed its second step", async () => {
    prisma.attendeeSession.findUnique.mockResolvedValue({
      accountId: "acct-1",
      secondFactorVerifiedAt: new Date(Date.now() - 60_000),
    });

    const response = await POST(request({ action: "regenerate-recovery-codes" }));

    expect(response.status).toBe(200);
    expect((await response.json()).recoveryCodes).toHaveLength(10);
  });

  it("issues codes when the request carries a current authenticator code", async () => {
    const response = await POST(request({ action: "regenerate-recovery-codes", code: totpCode(SECRET, new Date()) }));

    expect(response.status).toBe(200);
    expect((await response.json()).recoveryCodes).toHaveLength(10);
  });

  it("rate-limits a presented code, with the roster-unlock budget, before verifying it", async () => {
    mocks.checkAttendeeRosterUnlockRateLimit.mockResolvedValue(rateLimit(false));

    const response = await POST(request({ action: "regenerate-recovery-codes", code: "000000" }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: "RATE_LIMITED",
      message: "Too many attempts. Wait a few minutes and try again.",
    });
    expect(mocks.checkAttendeeRosterUnlockRateLimit).toHaveBeenCalledWith(expect.any(Request), "acct-1");
    // Nothing was reserved or verified.
    expect(prisma.attendeeMfaEnrollment.updateMany).not.toHaveBeenCalled();
    expect(prisma.attendeeMfaRecoveryCode.updateMany).not.toHaveBeenCalled();
    expect(prisma.attendeeMfaRecoveryCode.createMany).not.toHaveBeenCalled();
  });

  it("does not spend the budget when no code is presented", async () => {
    prisma.attendeeSession.findUnique.mockResolvedValue({
      accountId: "acct-1",
      secondFactorVerifiedAt: new Date(Date.now() - 60_000),
    });

    await POST(request({ action: "regenerate-recovery-codes" }));

    expect(mocks.checkAttendeeRosterUnlockRateLimit).not.toHaveBeenCalled();
  });
});
