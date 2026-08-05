import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  hashPassword: vi.fn(),
  verifyPassword: vi.fn(),
  spendPasswordCheck: vi.fn(),
  createAttendeeSession: vi.fn(),
  revokeAllAttendeeSessions: vi.fn(),
  sealSecret: vi.fn(),
  openSecret: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/access/passwords", () => ({
  hashPassword: dependencies.hashPassword,
  verifyPassword: dependencies.verifyPassword,
  spendPasswordCheck: dependencies.spendPasswordCheck,
}));
vi.mock("@/lib/secret-box", () => ({
  sealSecret: dependencies.sealSecret,
  openSecret: dependencies.openSecret,
}));
vi.mock("@/modules/attendee-accounts/session-store", async () => {
  const actual = await vi.importActual<typeof import("@/modules/attendee-accounts/session-store")>(
    "@/modules/attendee-accounts/session-store",
  );
  return {
    ...actual,
    createAttendeeSession: dependencies.createAttendeeSession,
    revokeAllAttendeeSessions: dependencies.revokeAllAttendeeSessions,
  };
});

import {
  authenticateAttendee,
  attachVerificationCode,
  beginAttendeeSignUp,
  beginAttendeePasswordReset,
  completeAttendeePasswordReset,
  normalizeAttendeeEmail,
  reuseVerificationCode,
  verifyAttendeeEmail,
} from "@/modules/attendee-accounts/account-service";
import {
  createOneTimeCode,
  hashOneTimeCode,
  normalizeSubmittedCode,
  oneTimeCodeMatches,
  ONE_TIME_CODE_MAX_ATTEMPTS,
} from "@/modules/attendee-accounts/codes";
import {
  ATTENDEE_PENDING_COOKIE_NAME,
  ATTENDEE_SESSION_COOKIE_NAME,
} from "@/modules/attendee-accounts/session-store";
import { SESSION_COOKIE_NAME } from "@/modules/access/session-store";
import { listRegistrationsForVerifiedEmail } from "@/modules/attendee-accounts/registrations-repository";

type PrismaStub = {
  attendeeAccount: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  attendeeCredential: { update: ReturnType<typeof vi.fn> };
  attendeeAccountToken: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  attendeeSession: { updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

let prisma: PrismaStub;

function stubPrisma(): PrismaStub {
  const stub: PrismaStub = {
    attendeeAccount: {
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "acct_new" }),
      update: vi.fn().mockResolvedValue({ id: "acct_existing" }),
    },
    attendeeCredential: { update: vi.fn().mockResolvedValue({}) },
    attendeeAccountToken: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: "tok_1" }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    attendeeSession: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // Accepts both forms the service uses: an array of promises, and an
    // interactive callback.
    $transaction: vi.fn(async (argument: unknown) => (
      typeof argument === "function"
        ? await (argument as (tx: PrismaStub) => unknown)(stub)
        : await Promise.all(argument as Promise<unknown>[])
    )),
  };
  return stub;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma = stubPrisma();
  dependencies.getPrisma.mockReturnValue(prisma);
  dependencies.hashPassword.mockResolvedValue("scrypt$hash");
  dependencies.sealSecret.mockImplementation((value: string) => `sealed:${value}`);
  dependencies.openSecret.mockImplementation((value: string) => value.replace(/^sealed:/, ""));
  dependencies.createAttendeeSession.mockResolvedValue({
    token: "session-token",
    expiresAt: new Date("2026-08-11T00:00:00Z"),
  });
});

describe("verified attendee registration views", () => {
  it("locks assigned seminars while leaving unassigned attendees editable", async () => {
    dependencies.getPrisma.mockReturnValue({
      $queryRaw: vi.fn().mockResolvedValue([{ id: "registration-1" }]),
      registration: {
        findMany: vi.fn().mockResolvedValue([{
          id: "registration-1",
          confirmationCode: "REG-142",
          status: "SUBMITTED",
          submittedAt: new Date("2026-08-01T12:00:00.000Z"),
          updatedAt: new Date("2026-08-01T13:00:00.000Z"),
          totalAmount: { toString: () => "0" },
          contactSnapshot: { email: "holder@example.test" },
          accountHolderPerson: {
            firstName: "Registration",
            lastName: "Holder",
            normalizedEmail: "holder@example.test",
            phone: null,
          },
          event: {
            name: "Synthetic Retreat",
            slug: "synthetic-retreat",
            startsAt: new Date("2026-10-09T21:00:00.000Z"),
            endsAt: new Date("2026-10-11T17:00:00.000Z"),
            timezone: "America/Chicago",
            location: "Test Camp",
            attendeeEditPolicy: "TIERED",
            seminarPreferenceClosesOn: null,
            seminarPreferenceSelfServiceLocked: false,
            programAssignmentRuns: [{
              fieldKeySnapshot: "session_preferences",
              assignments: [{
                attendeeIdSnapshot: "attendee-1",
                outcome: "ASSIGNED",
                optionValue: "Prayer",
              }, {
                attendeeIdSnapshot: "attendee-2",
                outcome: "UNASSIGNED",
                optionValue: null,
              }],
            }],
          },
          attendees: [{
            id: "attendee-1",
            formResponses: { session_preferences: ["Prayer", "Service"] },
            profileSnapshot: { firstName: "Assigned", lastName: "Guest" },
            person: { firstName: "Assigned", lastName: "Person" },
          }, {
            id: "attendee-2",
            formResponses: { session_preferences: ["Service", "Prayer"] },
            profileSnapshot: { firstName: "Unassigned", lastName: "Guest" },
            person: { firstName: "Unassigned", lastName: "Person" },
          }],
          publicFormSubmission: {
            formVersion: {
              definition: {
                title: "Synthetic registration",
                description: "",
                confirmationMessage: "Received.",
                sections: [{
                  id: "seminars",
                  title: "Seminars",
                  description: "",
                  fields: [{
                    id: "session_preferences",
                    key: "session_preferences",
                    label: "Seminar preferences",
                    helpText: "",
                    type: "RANKED_CHOICE",
                    scope: "ATTENDEE",
                    required: true,
                    options: ["Prayer", "Service"],
                    minSelections: 1,
                    maxSelections: 2,
                    availabilityMode: "RANKED_INTEREST",
                    choiceLimits: {},
                  }],
                }],
              },
            },
          },
          payments: [],
          waitlistEntry: null,
        }]),
      },
    });

    const [registration] = await listRegistrationsForVerifiedEmail("holder@example.test");

    expect(registration?.answerEditing).toMatchObject({
      enabled: true,
      attendees: [{
        attendeeId: "attendee-1",
        lockedFieldKeys: ["session_preferences"],
      }, {
        attendeeId: "attendee-2",
        lockedFieldKeys: [],
      }],
    });
  });
});

describe("the two populations never share a session", () => {
  it("uses a different cookie from staff", () => {
    // The whole separation rests on this. If the names ever matched, a staff
    // token would be handed to the attendee lookup and an attendee token to the
    // staff lookup — and the tables being distinct would be the only thing left
    // standing between a registrant and a roster.
    expect(ATTENDEE_SESSION_COOKIE_NAME).not.toBe(SESSION_COOKIE_NAME);
    expect(ATTENDEE_PENDING_COOKIE_NAME).not.toBe(SESSION_COOKIE_NAME);
    expect(ATTENDEE_PENDING_COOKIE_NAME).not.toBe(ATTENDEE_SESSION_COOKIE_NAME);
  });
});

describe("sign-up refuses to say whether an address is known", () => {
  it("creates an unverified account for an address with none", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue(null);

    const result = await beginAttendeeSignUp({
      email: "  New.Person@Example.COM ",
      displayName: "New Person",
      password: "a-long-enough-passphrase",
    });

    expect(result.outcome).toBe("created");
    expect(prisma.attendeeAccount.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "new.person@example.com",
          status: "PENDING_VERIFICATION",
        }),
      }),
    );
  });

  it("replaces the password on an account that never verified", async () => {
    // Nothing is claimed until an address is verified, so there is nothing here
    // for an overwrite to take — and refusing would strand anyone who lost the
    // first code.
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_existing",
      status: "PENDING_VERIFICATION",
    });

    const result = await beginAttendeeSignUp({
      email: "half@example.com",
      displayName: "Half Way",
      password: "a-long-enough-passphrase",
    });

    expect(result.outcome).toBe("resumed");
    expect(prisma.attendeeAccount.update).toHaveBeenCalled();
    expect(prisma.attendeeAccount.create).not.toHaveBeenCalled();
  });

  it("changes nothing for an address that already has an active account", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_active",
      status: "ACTIVE",
    });

    const result = await beginAttendeeSignUp({
      email: "taken@example.com",
      displayName: "Impostor",
      password: "a-long-enough-passphrase",
    });

    // The caller cannot tell this apart from a fresh sign-up: same shape, and a
    // pending token of its own.
    expect(result.outcome).toBe("existing");
    expect(result.pendingToken).toEqual(expect.any(String));
    expect(prisma.attendeeAccount.create).not.toHaveBeenCalled();
    expect(prisma.attendeeAccount.update).not.toHaveBeenCalled();
  });

  it("hashes the password even when the account already exists", async () => {
    // Skipping the expensive step for a known address would turn sign-up into a
    // timing oracle for the fact it refuses to state.
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_active",
      status: "ACTIVE",
    });

    await beginAttendeeSignUp({
      email: "taken@example.com",
      displayName: "Impostor",
      password: "a-long-enough-passphrase",
    });

    expect(dependencies.hashPassword).toHaveBeenCalledOnce();
  });

  it("issues a verification token in every case", async () => {
    for (const existing of [
      null,
      { id: "acct_existing", status: "PENDING_VERIFICATION" },
      { id: "acct_active", status: "ACTIVE" },
    ]) {
      vi.clearAllMocks();
      prisma = stubPrisma();
      dependencies.getPrisma.mockReturnValue(prisma);
      dependencies.hashPassword.mockResolvedValue("scrypt$hash");
      prisma.attendeeAccount.findUnique.mockResolvedValue(existing);

      await beginAttendeeSignUp({
        email: "someone@example.com",
        displayName: "Someone",
        password: "a-long-enough-passphrase",
      });

      expect(prisma.attendeeAccountToken.create).toHaveBeenCalledOnce();
      // Created without a code: the code is minted when the email is actually
      // sent, so a database read never yields a usable credential.
      expect(prisma.attendeeAccountToken.create.mock.calls[0][0].data.codeHash)
        .toBeUndefined();
    }
  });

  it("normalises an address the way the rest of the platform does", () => {
    expect(normalizeAttendeeEmail("  Mixed.Case@Example.COM  ")).toBe("mixed.case@example.com");
  });
});

describe("spending a verification code", () => {
  const code = "123456";

  function liveToken(overrides: Record<string, unknown> = {}) {
    return {
      id: "tok_1",
      accountId: "acct_1",
      codeHash: hashOneTimeCode(code),
      purpose: "EMAIL_VERIFICATION",
      expiresAt: new Date("2999-01-01T00:00:00Z"),
      codeExpiresAt: new Date("2999-01-01T00:00:00Z"),
      usedAt: null,
      attempts: 0,
      ...overrides,
    };
  }

  it("verifies the account and signs it in when both halves are right", async () => {
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(liveToken());

    const result = await verifyAttendeeEmail({
      pendingToken: "pending",
      code,
      userAgent: null,
    });

    expect(result.outcome).toBe("verified");
    expect(prisma.attendeeAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "ACTIVE" }),
      }),
    );
    expect(dependencies.createAttendeeSession).toHaveBeenCalledOnce();
  });

  it("rejects the right code presented without the token that asked for it", async () => {
    // The unknown token is what a forwarded code looks like: the recipient has
    // the secret from the inbox but not the browser handle. This is the case a
    // link could not refuse, and the reason verification is a code.
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(null);

    const result = await verifyAttendeeEmail({
      pendingToken: "someone-elses-browser",
      code,
      userAgent: null,
    });

    expect(result.outcome).toBe("rejected");
    expect(dependencies.createAttendeeSession).not.toHaveBeenCalled();
  });

  it("rejects a wrong code and still spends an attempt", async () => {
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(liveToken());

    const result = await verifyAttendeeEmail({
      pendingToken: "pending",
      code: "000000",
      userAgent: null,
    });

    expect(result.outcome).toBe("rejected");
    expect(prisma.attendeeAccountToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { attempts: 1 } }),
    );
  });

  it("counts the attempt before checking, so concurrent guesses cannot share a slot", async () => {
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(liveToken({ attempts: 2 }));
    // The guarded update loses the race: another request already advanced the
    // counter from 2.
    prisma.attendeeAccountToken.updateMany.mockResolvedValue({ count: 0 });

    const result = await verifyAttendeeEmail({
      pendingToken: "pending",
      code,
      userAgent: null,
    });

    // Correct code, but the attempt could not be claimed — refused rather than
    // let through on a lost race.
    expect(result.outcome).toBe("rejected");
  });

  it("refuses a token that has run out of attempts", async () => {
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(
      liveToken({ attempts: ONE_TIME_CODE_MAX_ATTEMPTS }),
    );

    expect((await verifyAttendeeEmail({
      pendingToken: "pending",
      code,
      userAgent: null,
    })).outcome).toBe("rejected");
  });

  it("refuses an expired, spent, or wrong-purpose token", async () => {
    const refused = [
      liveToken({ expiresAt: new Date("2000-01-01T00:00:00Z") }),
      liveToken({ codeExpiresAt: new Date("2000-01-01T00:00:00Z") }),
      liveToken({ usedAt: new Date("2026-07-28T00:00:00Z") }),
      liveToken({ purpose: "PASSWORD_RESET" }),
      // A verification whose email never got as far as minting a code.
      liveToken({ codeHash: null }),
    ];

    for (const record of refused) {
      prisma.attendeeAccountToken.findUnique.mockResolvedValue(record);
      expect((await verifyAttendeeEmail({
        pendingToken: "pending",
        code,
        userAgent: null,
      })).outcome).toBe("rejected");
    }
    expect(dependencies.createAttendeeSession).not.toHaveBeenCalled();
  });
});

describe("preparing a retry-stable verification code", () => {
  it("binds the first code to its message and starts twenty minutes at preparation", async () => {
    const now = new Date("2026-07-29T12:00:00Z");

    await expect(attachVerificationCode({
      accountId: "acct_1",
      messageId: "message-1",
      code: "123456",
      now,
    })).resolves.toBe(true);

    expect(prisma.attendeeAccountToken.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        accountId: "acct_1",
        codeHash: null,
        deliveryMessageId: null,
      }),
      data: expect.objectContaining({
        codeHash: hashOneTimeCode("123456"),
        deliveryMessageId: "message-1",
        sealedCode: "sealed:123456",
        codeExpiresAt: new Date("2026-07-29T12:20:00Z"),
      }),
    });
  });

  it("opens the code already attached to the same message on retry", async () => {
    prisma.attendeeAccountToken.findFirst.mockResolvedValue({
      sealedCode: "sealed:123456",
    });

    await expect(reuseVerificationCode({
      accountId: "acct_1",
      messageId: "message-1",
      now: new Date("2026-07-29T12:01:00Z"),
    })).resolves.toBe("123456");
  });
});

describe("password sign-in", () => {
  it("refuses an account that has not verified its address", async () => {
    // Signing this account in would produce a session that can reach nothing,
    // and saying why would confirm the address is known.
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "PENDING_VERIFICATION",
      credential: {
        id: "cred_1",
        passwordHash: "scrypt$hash",
        failedAttempts: 0,
        lockedUntil: null,
        disabledAt: null,
      },
    });

    expect(await authenticateAttendee("someone@example.com", "password", null)).toBeNull();
    expect(dependencies.verifyPassword).not.toHaveBeenCalled();
    // The dummy work that keeps an unknown address indistinguishable from a
    // known one.
    expect(dependencies.spendPasswordCheck).toHaveBeenCalledOnce();
  });

  it("refuses a disabled credential without checking the password", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "ACTIVE",
      credential: {
        id: "cred_1",
        passwordHash: "scrypt$hash",
        failedAttempts: 0,
        lockedUntil: null,
        disabledAt: new Date("2026-07-01T00:00:00Z"),
      },
    });

    expect(await authenticateAttendee("someone@example.com", "password", null)).toBeNull();
    expect(dependencies.verifyPassword).not.toHaveBeenCalled();
  });

  it("locks the credential after repeated failures", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "ACTIVE",
      credential: {
        id: "cred_1",
        passwordHash: "scrypt$hash",
        failedAttempts: 4,
        lockedUntil: null,
        disabledAt: null,
      },
    });
    dependencies.verifyPassword.mockResolvedValue(false);

    expect(await authenticateAttendee("someone@example.com", "wrong", null)).toBeNull();
    const update = prisma.attendeeCredential.update.mock.calls[0][0];
    expect(update.data.failedAttempts).toBe(5);
    expect(update.data.lockedUntil).toBeInstanceOf(Date);
  });

  it("issues a session for a verified account and a correct password", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue({
      id: "acct_1",
      status: "ACTIVE",
      credential: {
        id: "cred_1",
        passwordHash: "scrypt$hash",
        failedAttempts: 2,
        lockedUntil: null,
        disabledAt: null,
      },
    });
    dependencies.verifyPassword.mockResolvedValue(true);

    const result = await authenticateAttendee("someone@example.com", "right", null);

    expect(result?.accountId).toBe("acct_1");
    expect(prisma.attendeeCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failedAttempts: 0, lockedUntil: null } }),
    );
  });
});

describe("asking for a password reset", () => {
  function account(overrides: Record<string, unknown> = {}) {
    return {
      id: "acct_1",
      status: "ACTIVE",
      displayName: "A Person",
      disabledAt: null,
      credential: { id: "cred_1", disabledAt: null },
      identities: [],
      ...overrides,
    };
  }

  it("issues a code for a verified account that has a password", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue(account());

    const result = await beginAttendeePasswordReset({ email: "person@example.com" });

    expect(result.outcome).toBe("issued");
    const created = prisma.attendeeAccountToken.create.mock.calls[0][0].data;
    expect(created.purpose).toBe("PASSWORD_RESET");
    // No code yet: it is minted when the message actually leaves.
    expect(created.codeHash).toBeUndefined();
  });

  it("retires an outstanding reset before issuing another", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue(account());
    await beginAttendeePasswordReset({ email: "person@example.com" });
    expect(prisma.attendeeAccountToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ purpose: "PASSWORD_RESET", usedAt: null }),
      }),
    );
  });

  it("refuses to reset a sign-up that was never verified", async () => {
    // Replacing the password there would activate an account without anyone
    // ever proving they can read the address — the one thing verification is
    // for. It would also be a way around the whole verification flow.
    prisma.attendeeAccount.findUnique.mockResolvedValue(
      account({ status: "PENDING_VERIFICATION" }),
    );

    const result = await beginAttendeePasswordReset({ email: "person@example.com" });

    expect(result.outcome).toBe("no-account");
    expect(prisma.attendeeAccountToken.create).not.toHaveBeenCalled();
  });

  it("refuses a disabled account", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue(
      account({ disabledAt: new Date("2026-07-01T00:00:00Z") }),
    );
    expect((await beginAttendeePasswordReset({ email: "person@example.com" })).outcome)
      .toBe("no-account");
    expect(prisma.attendeeAccountToken.create).not.toHaveBeenCalled();
  });

  it("sends a Google-only account to Google instead of minting a password", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue(
      account({ credential: null, identities: [{ id: "idn_1" }] }),
    );

    const result = await beginAttendeePasswordReset({ email: "person@example.com" });

    expect(result.outcome).toBe("federated-only");
    expect(prisma.attendeeAccountToken.create).not.toHaveBeenCalled();
  });

  it("hands back a pending token and does the dummy work for an unknown address", async () => {
    prisma.attendeeAccount.findUnique.mockResolvedValue(null);

    const result = await beginAttendeePasswordReset({ email: "nobody@example.com" });

    // Same shape as a real one, so the response cannot be told apart...
    expect(result.outcome).toBe("no-account");
    expect(result.pendingToken).toEqual(expect.any(String));
    // ...and the same time spent, so the timing cannot either.
    expect(dependencies.spendPasswordCheck).toHaveBeenCalledOnce();
  });
});

describe("spending a reset code", () => {
  const code = "654321";

  function liveToken(overrides: Record<string, unknown> = {}) {
    return {
      id: "tok_r",
      accountId: "acct_1",
      codeHash: hashOneTimeCode(code),
      purpose: "PASSWORD_RESET",
      expiresAt: new Date("2999-01-01T00:00:00Z"),
      codeExpiresAt: new Date("2999-01-01T00:00:00Z"),
      usedAt: null,
      attempts: 0,
      ...overrides,
    };
  }

  it("sets the new password and signs the person back in", async () => {
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(liveToken());

    const result = await completeAttendeePasswordReset({
      pendingToken: "pending",
      code,
      passwordHash: "scrypt$new",
      userAgent: null,
    });

    expect(result.outcome).toBe("reset");
    expect(prisma.attendeeCredential.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          passwordHash: "scrypt$new",
          failedAttempts: 0,
          lockedUntil: null,
        }),
      }),
    );
  });

  it("revokes every other session", async () => {
    // Someone resetting a password often believes another person has the old
    // one. Leaving those sessions alive would answer the wrong half of that.
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(liveToken());

    await completeAttendeePasswordReset({
      pendingToken: "pending",
      code,
      passwordHash: "scrypt$new",
      userAgent: null,
    });

    expect(prisma.attendeeSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { accountId: "acct_1", revokedAt: null } }),
    );
  });

  it("will not spend a verification token as a reset", async () => {
    // The two purposes can be outstanding together, and one must never stand
    // in for the other.
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(
      liveToken({ purpose: "EMAIL_VERIFICATION" }),
    );

    expect((await completeAttendeePasswordReset({
      pendingToken: "pending",
      code,
      passwordHash: "scrypt$new",
      userAgent: null,
    })).outcome).toBe("rejected");
    expect(prisma.attendeeCredential.update).not.toHaveBeenCalled();
  });

  it("rejects a wrong, expired, spent, or exhausted code without touching the password", async () => {
    const refused = [
      liveToken({ codeHash: hashOneTimeCode("000000") }),
      liveToken({ expiresAt: new Date("2000-01-01T00:00:00Z") }),
      liveToken({ codeExpiresAt: new Date("2000-01-01T00:00:00Z") }),
      liveToken({ usedAt: new Date("2026-07-29T00:00:00Z") }),
      liveToken({ attempts: ONE_TIME_CODE_MAX_ATTEMPTS }),
      liveToken({ codeHash: null }),
    ];

    for (const record of refused) {
      prisma.attendeeAccountToken.findUnique.mockResolvedValue(record);
      expect((await completeAttendeePasswordReset({
        pendingToken: "pending",
        code,
        passwordHash: "scrypt$new",
        userAgent: null,
      })).outcome).toBe("rejected");
    }
    expect(prisma.attendeeCredential.update).not.toHaveBeenCalled();
    expect(dependencies.createAttendeeSession).not.toHaveBeenCalled();
  });

  it("rejects the right code without the browser that asked for it", async () => {
    prisma.attendeeAccountToken.findUnique.mockResolvedValue(null);
    expect((await completeAttendeePasswordReset({
      pendingToken: "someone-elses-browser",
      code,
      passwordHash: "scrypt$new",
      userAgent: null,
    })).outcome).toBe("rejected");
  });
});

describe("one-time codes", () => {
  it("mints six digits, keeping the leading zeros", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(createOneTimeCode()).toMatch(/^\d{6}$/);
    }
  });

  it("accepts the grouped form a password manager hands over", () => {
    // "123 456" is what the email shows, so it is what gets copied. The same
    // rule the MFA routes apply, for the same reason.
    expect(normalizeSubmittedCode(" 123 456 ")).toBe("123456");
    expect(oneTimeCodeMatches("123 456", hashOneTimeCode("123456"))).toBe(true);
  });

  it("never matches against an unminted code", () => {
    expect(oneTimeCodeMatches("123456", null)).toBe(false);
  });
});
