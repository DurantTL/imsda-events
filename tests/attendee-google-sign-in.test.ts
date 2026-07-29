import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  createAttendeeSession: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/logger", () => ({
  logInfo: dependencies.logInfo,
  logError: vi.fn(),
}));
vi.mock("@/modules/attendee-accounts/session-store", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/session-store")>(
    "@/modules/attendee-accounts/session-store",
  );
  return { ...actual, createAttendeeSession: dependencies.createAttendeeSession };
});

import { signInWithGoogle } from "@/modules/attendee-accounts/federated-sign-in";
import {
  mutableRedirect,
  OAUTH_HANDOFF_LIFETIME_SECONDS,
  parseOAuthHandoff,
  stateMatches,
} from "@/modules/attendee-accounts/oauth-handoff";
import { applyRateLimitHeaders } from "@/modules/rate-limit/domain";

const identity = {
  subject: "google-subject-1",
  email: "Person@Example.COM",
  emailVerified: true,
  name: "A Person",
};

type Stub = ReturnType<typeof stubPrisma>;
let prisma: Stub;

function stubPrisma() {
  const stub = {
    attendeeIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    attendeeAccount: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "acct_new" }),
      update: vi.fn().mockResolvedValue({}),
    },
    attendeeCredential: { delete: vi.fn().mockResolvedValue({}) },
    attendeeAccountToken: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    attendeeSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $transaction: vi.fn(async (argument: unknown) => (
      typeof argument === "function"
        ? await (argument as (tx: unknown) => unknown)(stub)
        : await Promise.all(argument as Promise<unknown>[])
    )),
  };
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma = stubPrisma();
  dependencies.getPrisma.mockReturnValue(prisma);
  dependencies.createAttendeeSession.mockResolvedValue({
    token: "session-token",
    expiresAt: new Date("2026-08-12T00:00:00Z"),
  });
});

describe("what a Google assertion is allowed to claim", () => {
  it("refuses an address Google has not verified", async () => {
    // Google hands over an address an account merely typed in. Treating that as
    // proof would give away the registrations sitting at it.
    const result = await signInWithGoogle({ ...identity, emailVerified: false }, null);
    expect(result).toEqual({ outcome: "refused", reason: "unverified-email" });
    expect(prisma.attendeeAccount.create).not.toHaveBeenCalled();
    expect(dependencies.createAttendeeSession).not.toHaveBeenCalled();
  });

  it("creates a verified account with no password when the address is new", async () => {
    const result = await signInWithGoogle(identity, null);

    expect(result.outcome).toBe("signed-in");
    const data = prisma.attendeeAccount.create.mock.calls[0][0].data;
    expect(data.email).toBe("person@example.com");
    expect(data.status).toBe("ACTIVE");
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    // No credential is created. There is no password to phish or reuse.
    expect(data.credential).toBeUndefined();
  });

  it("signs in through an identity it has seen before", async () => {
    prisma.attendeeIdentity.findUnique.mockResolvedValue({
      id: "idn_1",
      accountId: "acct_1",
      account: { disabledAt: null },
    });

    const result = await signInWithGoogle(identity, null);

    expect(result).toMatchObject({ outcome: "signed-in", linkage: "existing-identity" });
    // The address is never re-matched on the way in: the subject is the key.
    expect(prisma.attendeeAccount.findUnique).not.toHaveBeenCalled();
  });

  it("refuses a disabled account, by identity or by address", async () => {
    prisma.attendeeIdentity.findUnique.mockResolvedValue({
      id: "idn_1",
      accountId: "acct_1",
      account: { disabledAt: new Date("2026-07-01T00:00:00Z") },
    });
    expect(await signInWithGoogle(identity, null))
      .toEqual({ outcome: "refused", reason: "account-disabled" });

    prisma.attendeeIdentity.findUnique.mockResolvedValue(null);
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "ACTIVE",
      disabledAt: new Date("2026-07-01T00:00:00Z"),
      credential: null,
      identities: [],
    });
    expect(await signInWithGoogle(identity, null))
      .toEqual({ outcome: "refused", reason: "account-disabled" });
  });
});

describe("linking to an account that already exists", () => {
  it("links to a verified password account and leaves the password alone", async () => {
    // Both paths proved control of the same inbox, so both may reach it. The
    // password stays: taking it away would strand anyone whose Google access
    // later lapses.
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "ACTIVE",
      disabledAt: null,
      credential: { id: "cred_1" },
      identities: [],
    });

    const result = await signInWithGoogle(identity, null);

    expect(result).toMatchObject({
      outcome: "signed-in",
      linkage: "linked-to-password-account",
    });
    expect(prisma.attendeeCredential.delete).not.toHaveBeenCalled();
    expect(prisma.attendeeSession.updateMany).not.toHaveBeenCalled();
  });

  it("destroys the password when it claims a sign-up that never verified", async () => {
    // The pre-hijacking case, and the reason this branch exists. Someone
    // started a password sign-up on this address without ever proving they
    // could read it. Activating the account as-is would leave their password
    // live on a now-verified account — they could sign in and read the
    // registrations of the person who just arrived from Google.
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "PENDING_VERIFICATION",
      disabledAt: null,
      credential: { id: "cred_1" },
      identities: [],
    });

    const result = await signInWithGoogle(identity, null);

    expect(result).toMatchObject({ outcome: "signed-in", linkage: "claimed-pending" });
    expect(prisma.attendeeCredential.delete).toHaveBeenCalledWith({ where: { id: "cred_1" } });
    // And nothing that password already produced survives either.
    expect(prisma.attendeeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: "acct_1", revokedAt: null } }),
    );
    expect(prisma.attendeeAccountToken.updateMany).toHaveBeenCalled();
    expect(prisma.attendeeAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "ACTIVE" }) }),
    );
  });

  it("says so in the log, because that path destroys a credential", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "PENDING_VERIFICATION",
      disabledAt: null,
      credential: { id: "cred_1" },
      identities: [],
    });
    await signInWithGoogle(identity, null);
    // In volume this is an attack in progress, and nothing else would show it.
    expect(dependencies.logInfo).toHaveBeenCalledOnce();
  });

  it("refuses to rebind an address already linked to a different Google account", async () => {
    // Rebinding on an address match is exactly what keying on the subject
    // exists to prevent, so this goes to a person rather than through.
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "ACTIVE",
      disabledAt: null,
      credential: null,
      identities: [{ id: "idn_other" }],
    });

    expect(await signInWithGoogle(identity, null))
      .toEqual({ outcome: "refused", reason: "identity-conflict" });
    expect(prisma.attendeeIdentity.create).not.toHaveBeenCalled();
  });
});

describe("the handoff between here and Google", () => {
  it("reads back what the start route wrote", () => {
    const handoff = { state: "s", nonce: "n", codeVerifier: "v" };
    expect(parseOAuthHandoff(JSON.stringify(handoff))).toEqual(handoff);
  });

  it("treats a missing or malformed cookie as absent", () => {
    for (const raw of [undefined, "", "{", "null", "[]", JSON.stringify({ state: "s" })]) {
      expect(parseOAuthHandoff(raw)).toBeNull();
    }
  });

  it("refuses a callback whose state does not match", () => {
    // Without this an attacker completes their own sign-in in someone else's
    // browser, and that person is quietly signed in as them.
    expect(stateMatches("expected", "expected")).toBe(true);
    expect(stateMatches("other", "expected")).toBe(false);
    expect(stateMatches(null, "expected")).toBe(false);
    expect(stateMatches("", "expected")).toBe(false);
    // Length differences must not short-circuit into a match either.
    expect(stateMatches("expected-longer", "expected")).toBe(false);
  });

  it("expires the handoff well inside a session", () => {
    expect(OAUTH_HANDOFF_LIFETIME_SECONDS).toBeLessThanOrEqual(15 * 60);
    expect(OAUTH_HANDOFF_LIFETIME_SECONDS).toBeGreaterThanOrEqual(5 * 60);
  });

  it("builds a redirect the rate limiter can still write headers onto", () => {
    // `Response.redirect()` returns immutable headers, so attaching
    // `RateLimit-*` to one throws — and because both OAuth routes build a
    // redirect inside their catch block too, that throw turned every handled
    // failure into a 500. Every redirect in this flow goes through
    // `mutableRedirect` for that reason.
    const outcome = {
      allowed: true,
      decisions: [{
        policy: "attendee.oauth.start.client",
        allowed: true,
        limit: 30,
        remaining: 29,
        count: 1,
        windowSeconds: 900,
        resetAfterSeconds: 900,
      }],
    };
    const response = applyRateLimitHeaders(mutableRedirect("https://example.test/x"), outcome);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("https://example.test/x");
    expect(response.headers.get("RateLimit-Limit")).toBe("30");

    // The behaviour this exists to guard against.
    expect(() => Response.redirect("https://example.test/x", 303).headers.set("a", "b"))
      .toThrow(TypeError);
  });
});
