import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #456 review (B1): the wrong password that locks an account must answer
 * exactly like any other wrong password — same status, same body, same
 * headers — and must not do any email work before the response. Anything
 * else is an account-existence timing oracle on an unauthenticated route.
 * The lockout email is handed to Next.js `after()`, which is mocked here so
 * the test can see that it was scheduled and never run inline.
 */

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getPrisma: vi.fn(),
  verifyPassword: vi.fn(),
  spendPasswordCheck: vi.fn(),
  hashPassword: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
  checkLoginClientRateLimit: vi.fn(),
  checkLoginAccountRateLimit: vi.fn(),
  checkAttendeeSignInRateLimit: vi.fn(),
  processAccountEmailQueue: vi.fn(),
  getPlatformSettings: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(),
  after: mocks.after,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/access/passwords", () => ({
  hashPassword: mocks.hashPassword,
  verifyPassword: mocks.verifyPassword,
  spendPasswordCheck: mocks.spendPasswordCheck,
}));
vi.mock("@/modules/access/request-security", () => ({
  rejectCrossOriginRequest: mocks.rejectCrossOriginRequest,
}));
vi.mock("@/modules/rate-limit/service", () => ({
  checkLoginClientRateLimit: mocks.checkLoginClientRateLimit,
  checkLoginAccountRateLimit: mocks.checkLoginAccountRateLimit,
  checkAttendeeSignInRateLimit: mocks.checkAttendeeSignInRateLimit,
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  processAccountEmailQueue: mocks.processAccountEmailQueue,
}));
vi.mock("@/modules/system-admin/platform-settings", () => ({
  getPlatformSettings: mocks.getPlatformSettings,
}));

import { POST as STAFF_LOGIN } from "@/app/api/auth/login/route";
import { POST as ATTENDEE_SIGN_IN } from "@/app/api/attendee/sign-in/route";
import { lockableRowStub, type LockableRow } from "./lockable-row-stub";

function allowed() {
  return {
    allowed: true,
    decisions: [{
      policy: "sign-in",
      allowed: true,
      limit: 10,
      remaining: 9,
      count: 1,
      windowSeconds: 900,
      resetAfterSeconds: 900,
    }],
  };
}

function request(path: string) {
  return new Request(`https://events.imsda.test${path}`, {
    method: "POST",
    headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
    body: JSON.stringify({ email: "person@example.org", password: "not-the-password" }),
  });
}

/** Everything a caller can observe, minus the per-request correlation id. */
async function observable(response: Response) {
  const headers = Object.fromEntries(
    [...response.headers.entries()].filter(([name]) => name !== "x-correlation-id"),
  );
  return { status: response.status, headers, body: await response.json() };
}

function credentialRow(row: LockableRow) {
  return {
    id: "cred-1",
    passwordHash: "hash",
    failedAttempts: row.failedAttempts,
    lockedUntil: row.lockedUntil,
    disabledAt: null,
  };
}

function staffDatabase(initial: Partial<LockableRow>) {
  const credential = lockableRowStub(initial);
  const messageOutbox = { findFirst: vi.fn(), upsert: vi.fn() };
  mocks.getPrisma.mockReturnValue({
    user: {
      findUnique: vi.fn(async () => ({
        id: "user-1",
        accountStatus: "ACTIVE",
        globalRole: null,
        memberships: [],
        mfaEnrollment: null,
        passkeys: [],
        credential: credentialRow({ ...credential.row }),
      })),
    },
    authCredential: { update: credential.update, updateMany: credential.updateMany },
    messageOutbox,
  });
  return { credential, messageOutbox };
}

function attendeeDatabase(initial: Partial<LockableRow>) {
  const credential = lockableRowStub(initial);
  const messageOutbox = { findFirst: vi.fn(), upsert: vi.fn() };
  mocks.getPrisma.mockReturnValue({
    attendeeAccount: {
      findUnique: vi.fn(async () => ({
        id: "acct-1",
        status: "ACTIVE",
        disabledAt: null,
        credential: credentialRow({ ...credential.row }),
      })),
    },
    attendeeCredential: { update: credential.update, updateMany: credential.updateMany },
    messageOutbox,
  });
  return { credential, messageOutbox };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.checkLoginClientRateLimit.mockResolvedValue(allowed());
  mocks.checkLoginAccountRateLimit.mockResolvedValue(allowed());
  mocks.checkAttendeeSignInRateLimit.mockResolvedValue(allowed());
  mocks.verifyPassword.mockResolvedValue(false);
  mocks.spendPasswordCheck.mockResolvedValue(undefined);
});

describe.each([
  { name: "staff /api/auth/login", path: "/api/auth/login", handler: STAFF_LOGIN, database: staffDatabase },
  { name: "attendee /api/attendee/sign-in", path: "/api/attendee/sign-in", handler: ATTENDEE_SIGN_IN, database: attendeeDatabase },
])("$name on the locking attempt", ({ path, handler, database }) => {
  it("answers exactly like any other wrong password", async () => {
    database({ failedAttempts: 2 });
    const ordinary = await observable(await handler(request(path)));
    expect(mocks.after).not.toHaveBeenCalled();

    const { credential } = database({ failedAttempts: 4 });
    const locking = await observable(await handler(request(path)));

    expect(credential.row.lockedUntil).toBeInstanceOf(Date);
    expect(locking).toEqual(ordinary);
  });

  it("schedules the email through after() and does none of it before responding", async () => {
    const { messageOutbox } = database({ failedAttempts: 4 });

    await handler(request(path));

    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.after.mock.calls[0][0]).toBeTypeOf("function");
    // The scheduled task has not run, so nothing was queued, looked up, or sent.
    expect(messageOutbox.findFirst).not.toHaveBeenCalled();
    expect(messageOutbox.upsert).not.toHaveBeenCalled();
    expect(mocks.getPlatformSettings).not.toHaveBeenCalled();
    expect(mocks.processAccountEmailQueue).not.toHaveBeenCalled();
  });
});
