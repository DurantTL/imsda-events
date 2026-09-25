import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lockout email (#456): the account holder is told what kind of attempt
 * locked the account and for how long, with a link to the right reset page —
 * never the attempted password or code, and no IP address. The configured
 * office address gets a short alert too, and at most one of each per lockout.
 */

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  getResendEmailAvailability: vi.fn(),
  getPlatformSettings: vi.fn(),
  processAccountEmailQueue: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: dependencies.getResendEmailAvailability,
}));
vi.mock("@/modules/system-admin/platform-settings", () => ({
  getPlatformSettings: dependencies.getPlatformSettings,
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  processAccountEmailQueue: dependencies.processAccountEmailQueue,
}));

import { dispatchLockoutEmails } from "@/modules/communications/lockout-email";

const now = new Date("2026-09-25T20:15:00.000Z");
const lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

type OutboxRow = Record<string, unknown>;

function outboxFixture(options: { findEmail?: string; findDisplayName?: string } = {}) {
  const created: OutboxRow[] = [];
  const messageOutbox = {
    upsert: vi.fn(async (query: { where: { idempotencyKey: string }; create: OutboxRow }) => {
      created.push(query.create);
      return { id: `msg-${created.length}` };
    }),
  };
  const user = {
    findUnique: vi.fn().mockResolvedValue(
      options.findEmail === undefined
        ? null
        : { email: options.findEmail, displayName: options.findDisplayName ?? "" },
    ),
  };
  const attendeeAccount = {
    findUnique: vi.fn().mockResolvedValue(
      options.findEmail === undefined
        ? null
        : { email: options.findEmail, displayName: options.findDisplayName ?? "" },
    ),
  };
  return { messageOutbox, user, attendeeAccount, created };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({
    APP_BASE_URL: "https://events.imsda.org",
    ACCOUNT_EMAIL_SENDER_NAME: "IMSDA Events",
    ACCOUNT_EMAIL_SENDER_ADDRESS: "no-reply@imsda.org",
    ACCOUNT_EMAIL_REPLY_TO: null,
  });
  dependencies.getResendEmailAvailability.mockReturnValue({
    deliveryConfigured: true,
    webhookConfigured: true,
  });
  dependencies.processAccountEmailQueue.mockResolvedValue({
    sentIds: [], rescheduledIds: [], failedIds: [],
  });
  dependencies.getPlatformSettings.mockResolvedValue({
    defaultTimezone: "America/Chicago",
    securityAlertEmail: null,
  });
});

describe("staff lockout email", () => {
  it("emails the account holder, names the kind of attempt, and links the staff reset page", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex Staff" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "STAFF",
      kind: "PASSWORD",
      accountUserId: "user-1",
      lockedUntil,
      now,
    });

    expect(fixture.created).toHaveLength(1);
    const [row] = fixture.created;
    expect(row.recipientEmail).toBe("staff@imsda.org");
    expect(row.templateKey).toBe("ACCOUNT_LOCKOUT");
    expect(row.accountUserId).toBe("user-1");
    expect(row.bodyTextSnapshot).toContain("wrong password");
    expect(row.bodyTextSnapshot).toContain("https://events.imsda.org/forgot-password");
    expect(row.bodyTextSnapshot).toContain("15 minutes");
    expect(row.bodyTextSnapshot).toContain("Alex Staff");
  });

  it("names the code, not the password, for a code lockout", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "STAFF",
      kind: "CODE",
      accountUserId: "user-1",
      lockedUntil,
      now,
    });

    expect(fixture.created[0].bodyTextSnapshot).toContain("wrong two-step code");
    expect(fixture.created[0].bodyTextSnapshot).not.toContain("wrong password");
  });

  it("never includes the attempted password or code, or an IP address", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "STAFF",
      kind: "CODE",
      accountUserId: "user-1",
      lockedUntil,
      now,
    });

    const body = fixture.created[0].bodyTextSnapshot as string;
    // No 6-digit authenticator code, no 5-5 recovery code, no IP-shaped token.
    expect(body).not.toMatch(/\b\d{6}\b/);
    expect(body).not.toMatch(/\b\d{5}-\d{5}\b/);
    expect(body).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(body.toLowerCase()).not.toContain("ip address");
  });
});

describe("attendee lockout email", () => {
  it("links the attendee reset page instead of the staff one", async () => {
    const fixture = outboxFixture({ findEmail: "attendee@example.org", findDisplayName: "Casey" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "ATTENDEE",
      kind: "PASSWORD",
      accountAttendeeId: "acct-1",
      lockedUntil,
      now,
    });

    const [row] = fixture.created;
    expect(row.templateKey).toBe("ATTENDEE_LOCKOUT");
    expect(row.accountAttendeeId).toBe("acct-1");
    expect(row.bodyTextSnapshot).toContain("https://events.imsda.org/account/forgot-password");
  });
});

describe("the office alert", () => {
  it("is not sent when no security alert address is configured", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "STAFF",
      kind: "PASSWORD",
      accountUserId: "user-1",
      lockedUntil,
      now,
    });

    expect(fixture.created).toHaveLength(1);
    expect(fixture.created.every((row) => row.recipientKind === "ACCOUNT")).toBe(true);
  });

  it("is sent, in addition to the account holder, once one is configured", async () => {
    dependencies.getPlatformSettings.mockResolvedValue({
      defaultTimezone: "America/Chicago",
      securityAlertEmail: "security@imsda.org",
    });
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex Staff" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "STAFF",
      kind: "CODE",
      accountUserId: "user-1",
      lockedUntil,
      now,
    });

    expect(fixture.created).toHaveLength(2);
    const office = fixture.created.find((row) => row.recipientKind === "INTERNAL");
    expect(office?.recipientEmail).toBe("security@imsda.org");
    expect(office?.bodyTextSnapshot).toContain("staff@imsda.org");
    expect(office?.bodyTextSnapshot).toContain("wrong two-step code");
    // The alert names the account without belonging to it.
    expect(office?.accountUserId).toBeUndefined();
    expect(office?.accountAttendeeId).toBeUndefined();
  });

  it("never includes a code or password either", async () => {
    dependencies.getPlatformSettings.mockResolvedValue({
      defaultTimezone: "America/Chicago",
      securityAlertEmail: "security@imsda.org",
    });
    const fixture = outboxFixture({ findEmail: "attendee@example.org", findDisplayName: "Casey" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "ATTENDEE",
      kind: "CODE",
      accountAttendeeId: "acct-1",
      lockedUntil,
      now,
    });

    const office = fixture.created.find((row) => row.recipientKind === "INTERNAL");
    expect(office?.bodyTextSnapshot as string).not.toMatch(/\b\d{6}\b/);
  });
});

describe("idempotency: at most one email per account per lockout", () => {
  it("reuses the same idempotency key for the same lockout instant", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "STAFF", kind: "PASSWORD", accountUserId: "user-1", lockedUntil, now,
    });
    await dispatchLockoutEmails({
      audience: "STAFF", kind: "PASSWORD", accountUserId: "user-1", lockedUntil, now,
    });

    const keys = fixture.messageOutbox.upsert.mock.calls.map(
      (call) => call[0].where.idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it("uses a different key for a later, separate lockout", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);
    const laterLock = new Date(lockedUntil.getTime() + 60 * 60 * 1000);

    await dispatchLockoutEmails({
      audience: "STAFF", kind: "PASSWORD", accountUserId: "user-1", lockedUntil, now,
    });
    await dispatchLockoutEmails({
      audience: "STAFF", kind: "PASSWORD", accountUserId: "user-1", lockedUntil: laterLock, now,
    });

    const keys = fixture.messageOutbox.upsert.mock.calls.map(
      (call) => call[0].where.idempotencyKey,
    );
    expect(keys[0]).not.toBe(keys[1]);
  });
});

describe("resilience", () => {
  it("sends nothing and never throws when account email is not configured", async () => {
    dependencies.getServerEnv.mockReturnValue({ APP_BASE_URL: "https://events.imsda.org" });
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await expect(dispatchLockoutEmails({
      audience: "STAFF", kind: "PASSWORD", accountUserId: "user-1", lockedUntil, now,
    })).resolves.toBeUndefined();
    expect(fixture.messageOutbox.upsert).not.toHaveBeenCalled();
    expect(fixture.user.findUnique).not.toHaveBeenCalled();
  });

  it("never throws past the caller when the database rejects the write", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    fixture.messageOutbox.upsert.mockRejectedValue(new Error("synthetic failure"));
    dependencies.getPrisma.mockReturnValue(fixture);

    await expect(dispatchLockoutEmails({
      audience: "STAFF", kind: "PASSWORD", accountUserId: "user-1", lockedUntil, now,
    })).resolves.toBeUndefined();
  });

  it("does nothing when the account no longer exists", async () => {
    const fixture = outboxFixture();
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails({
      audience: "STAFF", kind: "PASSWORD", accountUserId: "user-1", lockedUntil, now,
    });

    expect(fixture.messageOutbox.upsert).not.toHaveBeenCalled();
  });
});
