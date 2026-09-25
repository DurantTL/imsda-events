import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Lockout email (#456): the account holder is told what kind of attempt
 * locked the account and for how long, with a link to the right reset page —
 * never the attempted password or code, and no IP address. The configured
 * office address gets a short alert too. Emails are capped per account — one
 * to the person per hour, one office alert per 24 hours — and all of it runs
 * after the sign-in response, through Next.js `after()`.
 */

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  getResendEmailAvailability: vi.fn(),
  getPlatformSettings: vi.fn(),
  processAccountEmailQueue: vi.fn(),
  after: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: dependencies.after,
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

import {
  dispatchLockoutEmails,
  scheduleLockoutEmails,
} from "@/modules/communications/lockout-email";

const now = new Date("2026-09-25T20:15:00.000Z");
const lockedUntil = new Date(now.getTime() + 15 * 60 * 1000);

type OutboxRow = Record<string, unknown>;

function outboxFixture(options: { findEmail?: string; findDisplayName?: string } = {}) {
  const created: OutboxRow[] = [];
  // Rows as the database would hold them: unique on idempotencyKey, stamped
  // with the `now` of the dispatch that created them.
  const stored = new Map<string, { id: string; createdAt: Date }>();
  let clock = now;
  const messageOutbox = {
    findFirst: vi.fn(async (query: {
      where: { idempotencyKey: { startsWith: string }; createdAt: { gt: Date } };
    }) => {
      for (const [key, row] of stored) {
        if (key.startsWith(query.where.idempotencyKey.startsWith) && row.createdAt > query.where.createdAt.gt) {
          return { id: row.id };
        }
      }
      return null;
    }),
    upsert: vi.fn(async (query: { where: { idempotencyKey: string }; create: OutboxRow }) => {
      const existing = stored.get(query.where.idempotencyKey);
      if (existing) return { id: existing.id };
      created.push(query.create);
      const row = { id: `msg-${created.length}`, createdAt: clock };
      stored.set(query.where.idempotencyKey, row);
      return { id: row.id };
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
  return {
    messageOutbox,
    user,
    attendeeAccount,
    created,
    /** Moves the fixture's idea of "now" for rows created afterwards. */
    setClock(value: Date) {
      clock = value;
    },
  };
}

const minutes = (count: number) => count * 60 * 1000;

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

describe("the per-account cap", () => {
  function lockAt(at: Date, kind: "PASSWORD" | "CODE" = "PASSWORD") {
    return {
      audience: "STAFF" as const,
      kind,
      accountUserId: "user-1",
      lockedUntil: new Date(at.getTime() + minutes(15)),
      now: at,
    };
  }

  beforeEach(() => {
    dependencies.getPlatformSettings.mockResolvedValue({
      defaultTimezone: "America/Chicago",
      securityAlertEmail: "security@imsda.org",
    });
  });

  it("sends the person no second email for a second lockout within the hour", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails(lockAt(now));
    const later = new Date(now.getTime() + minutes(20));
    fixture.setClock(later);
    // A different kind of lockout on the same account shares the allowance.
    await dispatchLockoutEmails(lockAt(later, "CODE"));

    const toPerson = fixture.created.filter((row) => row.recipientKind === "ACCOUNT");
    expect(toPerson).toHaveLength(1);
  });

  it("does not let a clock-hour boundary open a second email inside the hour", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);
    const beforeTheHour = new Date("2026-09-25T20:55:00.000Z");
    const afterTheHour = new Date("2026-09-25T21:10:00.000Z");

    fixture.setClock(beforeTheHour);
    await dispatchLockoutEmails(lockAt(beforeTheHour));
    fixture.setClock(afterTheHour);
    await dispatchLockoutEmails(lockAt(afterTheHour));

    expect(fixture.created.filter((row) => row.recipientKind === "ACCOUNT")).toHaveLength(1);
  });

  it("emails the person again once the hour has passed", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails(lockAt(now));
    const later = new Date(now.getTime() + minutes(61));
    fixture.setClock(later);
    await dispatchLockoutEmails(lockAt(later));

    expect(fixture.created.filter((row) => row.recipientKind === "ACCOUNT")).toHaveLength(2);
  });

  it("sends the office at most one alert per account per 24 hours", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    // A lockout every 15 minutes, all day: the most wrong attempts can do.
    for (let step = 0; step < 96; step += 1) {
      const at = new Date(now.getTime() + minutes(15 * step));
      fixture.setClock(at);
      await dispatchLockoutEmails(lockAt(at));
    }

    expect(fixture.created.filter((row) => row.recipientKind === "INTERNAL")).toHaveLength(1);
    // And the person hears at most once an hour, not 96 times.
    expect(fixture.created.filter((row) => row.recipientKind === "ACCOUNT")).toHaveLength(24);

    const nextDay = new Date(now.getTime() + minutes(24 * 60 + 1));
    fixture.setClock(nextDay);
    await dispatchLockoutEmails(lockAt(nextDay));
    expect(fixture.created.filter((row) => row.recipientKind === "INTERNAL")).toHaveLength(2);
  });

  it("keeps separate allowances for separate accounts", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    await dispatchLockoutEmails(lockAt(now));
    await dispatchLockoutEmails({ ...lockAt(now), accountUserId: "user-2" });

    expect(fixture.created.filter((row) => row.recipientKind === "ACCOUNT")).toHaveLength(2);
  });

  it("collapses two racing dispatches in the same window onto one row", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    // Both look before either writes, so the look-back cannot stop the second.
    fixture.messageOutbox.findFirst.mockResolvedValue(null);
    dependencies.getPrisma.mockReturnValue(fixture);

    await Promise.all([dispatchLockoutEmails(lockAt(now)), dispatchLockoutEmails(lockAt(now))]);

    const keys = fixture.messageOutbox.upsert.mock.calls.map((call) => call[0].where.idempotencyKey);
    expect(new Set(keys).size).toBe(2); // one person key, one office key
    expect(fixture.created).toHaveLength(2);
  });
});

describe("scheduling: nothing email-related runs before the response", () => {
  const input = {
    audience: "STAFF" as const,
    kind: "PASSWORD" as const,
    accountUserId: "user-1",
    lockedUntil,
    now,
  };

  it("hands the work to Next.js after() by default and does none of it inline", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);

    const returned = scheduleLockoutEmails(input);

    expect(returned).toBeUndefined(); // synchronous: nothing to await
    expect(dependencies.after).toHaveBeenCalledTimes(1);
    expect(fixture.messageOutbox.findFirst).not.toHaveBeenCalled();
    expect(fixture.messageOutbox.upsert).not.toHaveBeenCalled();
    expect(fixture.user.findUnique).not.toHaveBeenCalled();
    expect(dependencies.getPlatformSettings).not.toHaveBeenCalled();
    expect(dependencies.processAccountEmailQueue).not.toHaveBeenCalled();

    // Both the enqueue and the delivery happen inside the scheduled task.
    const [task] = dependencies.after.mock.calls[0] as [() => Promise<void>];
    await task();
    expect(fixture.messageOutbox.upsert).toHaveBeenCalledTimes(1);
    expect(dependencies.processAccountEmailQueue).toHaveBeenCalledWith({ messageIds: ["msg-1"] });
  });

  it("never throws into the sign-in path when there is no request scope to schedule into", () => {
    dependencies.after.mockImplementationOnce(() => {
      throw new Error("after() was called outside a request scope");
    });
    expect(() => scheduleLockoutEmails(input)).not.toThrow();
  });

  it("accepts an injected scheduler", async () => {
    const fixture = outboxFixture({ findEmail: "staff@imsda.org", findDisplayName: "Alex" });
    dependencies.getPrisma.mockReturnValue(fixture);
    const tasks: Array<() => Promise<void>> = [];

    scheduleLockoutEmails(input, (task) => tasks.push(task));

    expect(dependencies.after).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);
    expect(fixture.messageOutbox.upsert).not.toHaveBeenCalled();
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
