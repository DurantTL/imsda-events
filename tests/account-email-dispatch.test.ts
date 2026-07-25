import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  isAccountEmailConfigured: vi.fn(),
  enqueueAccountEmail: vi.fn(),
  processAccountEmailQueue: vi.fn(),
  logError: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/logger", () => ({
  logError: dependencies.logError,
  logInfo: dependencies.logInfo,
}));
vi.mock("@/modules/communications/account-email", () => ({
  isAccountEmailConfigured: dependencies.isAccountEmailConfigured,
  enqueueAccountEmail: dependencies.enqueueAccountEmail,
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  processAccountEmailQueue: dependencies.processAccountEmailQueue,
}));

import {
  sendAccountRecoveryEmail,
  sendStaffInvitationEmail,
} from "@/modules/communications/account-email-dispatch";

function userFixture(user: Record<string, unknown> | null) {
  const findUnique = vi.fn().mockResolvedValue(user);
  dependencies.getPrisma.mockReturnValue({ user: { findUnique } });
  return findUnique;
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.isAccountEmailConfigured.mockReturnValue(true);
  dependencies.enqueueAccountEmail.mockResolvedValue({
    messageId: "message-1",
    purpose: "PASSWORD_RESET",
  });
  dependencies.processAccountEmailQueue.mockResolvedValue({
    recoveredIds: [],
    sentIds: ["message-1"],
    failedIds: [],
    rescheduledIds: [],
  });
});

describe("account recovery email", () => {
  it("sends a reset link to an active account", async () => {
    userFixture({
      id: "user-1",
      displayName: "Alex Staff",
      accountStatus: "ACTIVE",
      credential: { disabledAt: null },
    });

    expect(await sendAccountRecoveryEmail("Alex@IMSDA.org")).toEqual({
      configured: true,
      queued: true,
    });
    expect(dependencies.enqueueAccountEmail).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user-1",
      email: "alex@imsda.org",
      purpose: "PASSWORD_RESET",
    }));
    expect(dependencies.processAccountEmailQueue).toHaveBeenCalledWith({
      messageIds: ["message-1"],
      limit: 1,
    });
  });

  it("sends an activation link to an account that was never activated", async () => {
    userFixture({
      id: "user-1",
      displayName: "Alex Staff",
      accountStatus: "PENDING_ACTIVATION",
      credential: { disabledAt: null },
    });

    await sendAccountRecoveryEmail("alex@imsda.org");

    expect(dependencies.enqueueAccountEmail).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "ACCOUNT_ACTIVATION",
    }));
  });

  it("queues nothing for an unknown or disabled account, and says so the same way", async () => {
    userFixture(null);
    expect(await sendAccountRecoveryEmail("nobody@imsda.org")).toEqual({
      configured: true,
      queued: false,
    });

    userFixture({
      id: "user-1",
      displayName: "Alex Staff",
      accountStatus: "ACTIVE",
      credential: { disabledAt: new Date() },
    });
    expect(await sendAccountRecoveryEmail("disabled@imsda.org")).toEqual({
      configured: true,
      queued: false,
    });

    expect(dependencies.enqueueAccountEmail).not.toHaveBeenCalled();
  });

  it("reports an unconfigured deployment without touching the database", async () => {
    dependencies.isAccountEmailConfigured.mockReturnValue(false);
    const findUnique = userFixture({ id: "user-1" });

    expect(await sendAccountRecoveryEmail("alex@imsda.org")).toEqual({
      configured: false,
      queued: false,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("still counts as queued when the first delivery attempt throws", async () => {
    userFixture({
      id: "user-1",
      displayName: "Alex Staff",
      accountStatus: "ACTIVE",
      credential: { disabledAt: null },
    });
    dependencies.processAccountEmailQueue.mockRejectedValue(new Error("Resend is down."));

    // The row is in the outbox with its backoff; the sweep will try again.
    expect(await sendAccountRecoveryEmail("alex@imsda.org")).toEqual({
      configured: true,
      queued: true,
    });
    expect(dependencies.logError).toHaveBeenCalledOnce();
  });
});

describe("staff invitation email", () => {
  it("emails the activation link for a newly invited colleague", async () => {
    expect(await sendStaffInvitationEmail({
      userId: "user-2",
      email: "new@imsda.org",
      displayName: "New Colleague",
    })).toEqual({ configured: true, queued: true });

    expect(dependencies.enqueueAccountEmail).toHaveBeenCalledWith({
      userId: "user-2",
      email: "new@imsda.org",
      displayName: "New Colleague",
      purpose: "ACCOUNT_ACTIVATION",
    });
  });

  it("reports nothing sent when the deployment cannot send", async () => {
    dependencies.isAccountEmailConfigured.mockReturnValue(false);

    expect(await sendStaffInvitationEmail({
      userId: "user-2",
      email: "new@imsda.org",
      displayName: "New Colleague",
    })).toEqual({ configured: false, queued: false });
    expect(dependencies.enqueueAccountEmail).not.toHaveBeenCalled();
  });
});
