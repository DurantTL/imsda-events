import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn(),
  mfaDeleteMany: vi.fn(),
  accountFindUnique: vi.fn(),
  accountFindFirst: vi.fn(),
  accountUpdate: vi.fn(),
  attendeeMfaDeleteMany: vi.fn(),
  passkeyUpdateMany: vi.fn(),
  revokeAllUserSessions: vi.fn(),
  revokeAllAttendeeSessions: vi.fn(),
  sendAccountRecoveryEmail: vi.fn(),
  writeAuditLog: vi.fn(),
  requireSystemAdministrator: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

const client = {
  user: { findUnique: mocks.userFindUnique, findFirst: mocks.userFindFirst, update: mocks.userUpdate },
  userMfaEnrollment: { deleteMany: mocks.mfaDeleteMany },
  attendeeAccount: { findUnique: mocks.accountFindUnique, findFirst: mocks.accountFindFirst, update: mocks.accountUpdate },
  attendeeMfaEnrollment: { deleteMany: mocks.attendeeMfaDeleteMany },
  attendeePasskey: { updateMany: mocks.passkeyUpdateMany },
  $transaction: async (work: unknown[]) => Promise.all(work),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/access/session-store", () => ({ revokeAllUserSessions: mocks.revokeAllUserSessions }));
vi.mock("@/modules/attendee-accounts/session-store", () => ({ revokeAllAttendeeSessions: mocks.revokeAllAttendeeSessions }));
vi.mock("@/modules/communications/account-email-dispatch", () => ({ sendAccountRecoveryEmail: mocks.sendAccountRecoveryEmail }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/organizations/access", () => ({ requireSystemAdministrator: mocks.requireSystemAdministrator }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));

import { POST as ACCOUNT_ACTION } from "@/app/api/admin/accounts/[accountId]/route";
import { AccessDeniedError } from "@/modules/access/authorization";
import {
  changeAttendeeEmail,
  changeStaffEmail,
  resetAttendeeTwoStep,
  resetStaffTwoStep,
  sendStaffPasswordReset,
} from "@/modules/system-admin/user-admin";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.userFindUnique.mockResolvedValue({ id: "user-2", email: "staff@example.test" });
  mocks.userFindFirst.mockResolvedValue(null);
  mocks.accountFindUnique.mockResolvedValue({ id: "account-1" });
  mocks.accountFindFirst.mockResolvedValue(null);
  mocks.sendAccountRecoveryEmail.mockResolvedValue({ configured: true, queued: true });
  mocks.requireSystemAdministrator.mockResolvedValue({ id: "admin-1" });
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
});

describe("system administrator account tools (#386)", () => {
  it("resets a team member's two-step sign-in, signs them out, and audits it", async () => {
    await resetStaffTwoStep("user-2", "admin-1");
    expect(mocks.mfaDeleteMany).toHaveBeenCalledWith({ where: { userId: "user-2" } });
    expect(mocks.revokeAllUserSessions).toHaveBeenCalledWith("user-2");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "STAFF_MFA_RESET", actorUserId: "admin-1", entityId: "user-2" }));
  });

  it("won't reset an administrator's own two-step sign-in", async () => {
    await expect(resetStaffTwoStep("admin-1", "admin-1")).rejects.toMatchObject({ code: "NOT_ON_YOURSELF" });
    expect(mocks.mfaDeleteMany).not.toHaveBeenCalled();
  });

  it("changes a staff email only when it's free", async () => {
    mocks.userFindFirst.mockResolvedValueOnce({ id: "someone-else" });
    await expect(changeStaffEmail("user-2", "taken@example.test", "admin-1")).rejects.toMatchObject({ code: "EMAIL_IN_USE" });
    await changeStaffEmail("user-2", "new@example.test", "admin-1");
    expect(mocks.userUpdate).toHaveBeenCalledWith({ where: { id: "user-2" }, data: { email: "new@example.test" } });
    expect(mocks.revokeAllUserSessions).toHaveBeenCalledWith("user-2");
  });

  it("sends a staff password reset through the account email", async () => {
    await expect(sendStaffPasswordReset("user-2", "admin-1")).resolves.toEqual({ queued: true });
    expect(mocks.sendAccountRecoveryEmail).toHaveBeenCalledWith("staff@example.test");
    mocks.sendAccountRecoveryEmail.mockResolvedValueOnce({ configured: false, queued: false });
    await expect(sendStaffPasswordReset("user-2", "admin-1")).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
  });

  it("resets an attendee's authenticator and passkeys and signs them out", async () => {
    await resetAttendeeTwoStep("account-1", "admin-1", new Date("2026-09-23T12:00:00Z"));
    expect(mocks.attendeeMfaDeleteMany).toHaveBeenCalledWith({ where: { accountId: "account-1" } });
    expect(mocks.passkeyUpdateMany).toHaveBeenCalledWith({ where: { accountId: "account-1", revokedAt: null }, data: { revokedAt: new Date("2026-09-23T12:00:00Z") } });
    expect(mocks.revokeAllAttendeeSessions).toHaveBeenCalled();
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "ATTENDEE_MFA_RESET" }));
  });

  it("changes an attendee email only when it's free", async () => {
    mocks.accountFindFirst.mockResolvedValueOnce({ id: "account-9" });
    await expect(changeAttendeeEmail("account-1", "taken@example.test", "admin-1")).rejects.toMatchObject({ code: "EMAIL_IN_USE" });
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
  });

  it("is for system administrators only", async () => {
    mocks.requireSystemAdministrator.mockRejectedValueOnce(new AccessDeniedError("No.", 403, "PERMISSION_DENIED"));
    const response = await ACCOUNT_ACTION(new Request("https://events.imsda.test/api/admin/accounts/account-1", {
      method: "POST", headers: { origin: "https://events.imsda.test", "content-type": "application/json" }, body: JSON.stringify({ action: "reset-two-step" }),
    }), { params: Promise.resolve({ accountId: "account-1" }) });
    expect(response.status).toBe(403);
    expect(mocks.attendeeMfaDeleteMany).not.toHaveBeenCalled();
  });
});
