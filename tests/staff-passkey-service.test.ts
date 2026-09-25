import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  settings: { passkeyRpId: "events.imsda.test" as string | null },
  accountStatus: "ACTIVE" as string,
  credential: null as Row | null,
  enrollment: null as Row | null,
  recoveryCodes: [] as Row[],
  passkeys: [] as Row[],
  attendeePasskeys: [] as Row[],
  challenges: [] as Row[],
  sessions: [] as Row[],
  audit: [] as Row[],
}));
const webauthn = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));
const logger = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@simplewebauthn/server", () => webauthn);
vi.mock("@/lib/logger", () => logger);
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
// The stored "sealed" secret is the secret itself here; the real box is tested on its own.
vi.mock("@/lib/secret-box", () => ({ sealSecret: (value: string) => value, openSecret: (value: string) => value }));
vi.mock("@/modules/access/passwords", () => ({
  hashPassword: async (password: string) => `hash:${password}`,
  verifyPassword: async (password: string, hash: string) => hash === `hash:${password}`,
  spendPasswordCheck: async () => undefined,
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn(async (entry: Row) => { state.audit.push(entry); }) }));
vi.mock("@/lib/prisma", () => {
  const matchesCounter = (row: Row, where: Row) => {
    const counter = where.counter as { lt?: bigint } | undefined;
    return !counter?.lt || (row.counter as bigint) < counter.lt;
  };
  const active = (where: Row) => state.passkeys.filter((passkey) =>
    (where.userId === undefined || passkey.userId === where.userId)
    && (where.credentialId === undefined || passkey.credentialId === where.credentialId)
    && (typeof where.id !== "string" || passkey.id === where.id)
    && (!("revokedAt" in where) || passkey.revokedAt === null)
    && matchesCounter(passkey, where));
  const notId = (where: Row) => (where.id as Row | undefined)?.not as string | undefined;
  const applyIncrement = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      const increment = (value as { increment?: number } | null)?.increment;
      row[key] = typeof increment === "number" ? (row[key] as number) + increment : value;
    }
    return row;
  };
  const client = {
    platformSettings: { findUnique: async () => state.settings },
    user: {
      findUnique: async ({ where }: { where: Row }) => ({
        id: where.id, email: `${String(where.id)}@imsda.test`, globalRole: null, accountStatus: state.accountStatus, credential: state.credential,
      }),
    },
    authCredential: {
      findUnique: async () => state.credential,
      update: async ({ data }: { data: Row }) => Object.assign(state.credential!, data),
    },
    userSession: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = state.sessions.filter((row) => row.userId === where.userId && row.revokedAt === null);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    userMfaEnrollment: {
      findUnique: async () => state.enrollment,
      deleteMany: async () => {
        const count = state.enrollment ? 1 : 0;
        state.enrollment = null;
        return { count };
      },
      update: async ({ data }: { data: Row }) => applyIncrement(state.enrollment!, data),
      updateMany: async ({ where, data }: { where: { OR?: Array<{ lastUsedStep: null | { lt: bigint } }> }; data: Row }) => {
        const row = state.enrollment;
        const stepOk = !where.OR || where.OR.some((condition) => (condition.lastUsedStep === null
          ? row?.lastUsedStep === null
          : row?.lastUsedStep !== null && (row?.lastUsedStep as bigint) < condition.lastUsedStep.lt));
        if (!row || !stepOk) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    mfaRecoveryCode: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = state.recoveryCodes.filter((row) => row.codeHash === where.codeHash && row.usedAt === null);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
      count: async () => state.recoveryCodes.filter((row) => row.usedAt === null).length,
    },
    userPasskey: {
      count: async ({ where }: { where: Row }) => {
        const excluded = notId(where);
        return active(where).filter((row) => !excluded || row.id !== excluded).length;
      },
      findMany: async ({ where }: { where: Row }) => active(where),
      findFirst: async ({ where }: { where: Row }) => {
        const row = active(where)[0];
        if (!row) return null;
        return {
          ...row,
          user: { id: row.userId, globalRole: null, accountStatus: state.accountStatus, credential: state.credential },
        };
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `pk-${state.passkeys.length + 1}`, revokedAt: null, createdAt: new Date(), lastUsedAt: null, ...data };
        state.passkeys.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(state.passkeys.find((row) => row.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = active(where);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    userPasskeyChallenge: {
      deleteMany: async ({ where }: { where: Row & { expiresAt?: { lt: Date } } }) => {
        state.challenges = state.challenges.filter((row) => !(
          (where.sessionId === undefined || row.sessionId === where.sessionId)
          && (where.purpose === undefined || row.purpose === where.purpose)
          && (where.expiresAt === undefined || (row.expiresAt as Date) < where.expiresAt.lt)
        ));
      },
      create: async ({ data }: { data: Row }) => {
        const row = { id: `ch-${state.challenges.length + 1}`, usedAt: null, createdAt: new Date(), sessionId: "sessionId" in data ? data.sessionId : null, ...data };
        state.challenges.push(row);
        return row;
      },
      findFirst: async ({ where }: { where: Row & { expiresAt?: { gt: Date } } }) => state.challenges.find((row) =>
        (where.id === undefined || row.id === where.id)
        && (where.sessionId === undefined ? true : row.sessionId === where.sessionId)
        && row.purpose === where.purpose && row.usedAt === null
        && (!where.expiresAt || (row.expiresAt as Date) > where.expiresAt.gt)) ?? null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = state.challenges.filter((row) => row.id === where.id && row.usedAt === null);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    $transaction: async (work: unknown) => (typeof work === "function"
      ? (work as (tx: unknown) => Promise<unknown>)(client)
      : Promise.all(work as Promise<unknown>[])),
  };
  return { getPrisma: () => client };
});
vi.mock("@/modules/access/session-store", async () => {
  const actual = await vi.importActual<typeof import("@/modules/access/session-store")>("@/modules/access/session-store");
  return { ...actual, createDatabaseSession: vi.fn(async (userId: string) => ({ token: `token-${userId}`, expiresAt: new Date("2026-10-07T00:00:00Z") })) };
});
vi.mock("@/modules/communications/account-email-dispatch", () => ({ sendAccountRecoveryEmail: vi.fn() }));

import {
  beginPasskeyRegistration,
  beginPasskeySignIn,
  beginPasskeyVerification,
  changeVerificationMethods,
  finishPasskeyRegistration,
  finishPasskeySignIn,
  removePasskey,
  renamePasskey,
  type ChangeProof,
} from "@/modules/access/passkeys";
import { resetStaffTwoStep } from "@/modules/system-admin/user-admin";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { totpCode, totpStep } from "@/modules/access/totp";

const account = { id: "user-1", email: "director@imsda.test", displayName: "Test Director" };
const origin = "https://events.imsda.test";
const now = new Date("2026-10-01T12:00:00Z");
const PASSWORD = "synthetic correct horse";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const RECOVERY_CODE = "12345-67890";
const registration = { id: "cred-1", rawId: "cred-1", type: "public-key", response: {} } as never;
const assertion = (id = "cred-1", userHandle?: string) => ({
  id,
  rawId: id,
  type: "public-key",
  response: userHandle ? { userHandle } : {},
}) as never;
const passwordProof: ChangeProof = { password: PASSWORD };

async function addPasskey(proof: ChangeProof = passwordProof) {
  await beginPasskeyRegistration(account, "session-1", origin, proof, now);
  return finishPasskeyRegistration(account, "session-1", origin, { response: registration, name: "Laptop" }, now);
}

/** Puts a passkey straight into the table, for tests that start from one already registered. */
function seedPasskey(id = "pk-seeded", credentialId = "cred-seeded") {
  state.passkeys.push({
    id, userId: "user-1", credentialId, publicKey: Buffer.from([9]), counter: BigInt(0), transports: ["internal"],
    backedUp: false, name: "Phone", revokedAt: null, createdAt: now, lastUsedAt: null,
  });
}

function enrolAuthenticator() {
  state.enrollment = {
    id: "enrol-1", status: "ACTIVE", sealedSecret: SECRET, lastUsedStep: null, lockedUntil: null, failedAttempts: 0,
  };
  state.recoveryCodes = [{ id: "rc-1", enrollmentId: "enrol-1", codeHash: hashOpaqueToken(RECOVERY_CODE), usedAt: null }];
}

async function existingPasskeyProof(credentialId = "cred-seeded"): Promise<ChangeProof> {
  await beginPasskeyVerification(account, "session-1", origin, now);
  return { passkey: assertion(credentialId) };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { passkeyRpId: "events.imsda.test" };
  state.accountStatus = "ACTIVE";
  state.credential = { id: "auth-1", passwordHash: `hash:${PASSWORD}`, failedAttempts: 0, lockedUntil: null, disabledAt: null };
  state.enrollment = null;
  state.recoveryCodes = [];
  state.passkeys = [];
  state.attendeePasskeys = [];
  state.challenges = [];
  state.sessions = [];
  state.audit = [];
  webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: "reg-challenge" });
  webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "auth-challenge" });
  webauthn.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
    },
  });
  webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });
});

describe("staff passkey registration", () => {
  it("stores only the public key, verified against this site's origin and domain, and audits it", async () => {
    const passkeys = await addPasskey();
    expect(passkeys).toEqual([expect.objectContaining({ name: "Laptop", backedUp: false })]);
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "reg-challenge",
      expectedOrigin: origin,
      expectedRPID: "events.imsda.test",
      requireUserVerification: true,
    }));
    expect(state.audit).toEqual([expect.objectContaining({ action: "USER_PASSKEY_ADDED", actorUserId: "user-1" })]);
    // Credential ids, public keys and challenges never appear in audit metadata.
    expect(JSON.stringify(state.audit)).not.toContain("cred-1");
  });

  it("stays off when no domain is set (wrong RP ID) or the page is on another origin", async () => {
    state.settings = { passkeyRpId: null };
    await expect(beginPasskeyRegistration(account, "session-1", origin, passwordProof, now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
    state.settings = { passkeyRpId: "events.imsda.test" };
    await expect(beginPasskeyRegistration(account, "session-1", "https://evil.test", passwordProof, now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
  });

  it("won't answer the same registration prompt twice (challenge replay)", async () => {
    await addPasskey();
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, now))
      .rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects an expired challenge", async () => {
    await beginPasskeyRegistration(account, "session-1", origin, passwordProof, now);
    const later = new Date(now.getTime() + 6 * 60_000);
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, later))
      .rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects a response the library doesn't verify, logging a fixed reason code only", async () => {
    webauthn.verifyRegistrationResponse.mockRejectedValueOnce(new Error("Unexpected origin cred-1"));
    await beginPasskeyRegistration(account, "session-1", origin, passwordProof, now);
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, now))
      .rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(state.passkeys).toHaveLength(0);
    expect(logger.logWarn).toHaveBeenCalledWith(expect.any(String), { reason: "REGISTRATION_REJECTED" });
    expect(JSON.stringify(logger.logWarn.mock.calls)).not.toContain("cred-1");
  });
});

describe("re-authentication before adding or removing a staff passkey (#429)", () => {
  type Change = "add" | "remove";
  const attempt = (change: Change, proof: ChangeProof | undefined) => (change === "add"
    ? beginPasskeyRegistration(account, "session-1", origin, proof, now)
    : removePasskey(account, "session-1", origin, "pk-seeded", proof, now));
  const refused = { code: "RECENT_VERIFICATION_REQUIRED" };

  describe.each<Change>(["add", "remove"])("%s", (change) => {
    beforeEach(() => {
      if (change === "remove") seedPasskey();
    });

    it("is refused with no proof", async () => {
      await expect(attempt(change, undefined)).rejects.toMatchObject(refused);
      await expect(attempt(change, {})).rejects.toMatchObject(refused);
      expect(state.challenges.filter((row) => row.purpose === "REGISTER")).toHaveLength(0);
      expect(state.passkeys.filter((row) => row.revokedAt === null)).toHaveLength(change === "remove" ? 1 : 0);
    });

    it("is refused with a wrong code, which counts toward the authenticator lockout", async () => {
      enrolAuthenticator();
      await expect(attempt(change, { code: "000000" })).rejects.toMatchObject(refused);
      await expect(attempt(change, { code: "99999-99999" })).rejects.toMatchObject(refused);
      expect(state.enrollment).toMatchObject({ failedAttempts: 2 });
    });

    it("is refused with a wrong password, which counts toward the sign-in lockout", async () => {
      for (let tries = 0; tries < 5; tries += 1) {
        await expect(attempt(change, { password: "not the password" })).rejects.toMatchObject(refused);
      }
      expect(state.credential).toMatchObject({ failedAttempts: 5, lockedUntil: expect.any(Date) });
      // Once locked, even the right password is refused.
      await expect(attempt(change, passwordProof)).rejects.toMatchObject(refused);
    });

    it.each([
      ["authenticator code", () => totpCode(SECRET, now)],
      ["recovery code", () => RECOVERY_CODE],
    ])("is refused with a reused %s", async (_label, codeOf) => {
      enrolAuthenticator();
      const code = codeOf();
      await expect(attempt(change, { code })).resolves.toBeDefined();
      if (change === "remove") seedPasskey("pk-seeded", "cred-seeded-again");
      await expect(attempt(change, { code })).rejects.toMatchObject(refused);
    });

    it("is refused with a password when the account has an authenticator", async () => {
      enrolAuthenticator();
      await expect(attempt(change, passwordProof)).rejects.toMatchObject(refused);
      // A proof the account can't give is refused without touching the password counter.
      expect(state.credential).toMatchObject({ failedAttempts: 0 });
    });

    it("is refused with an existing-passkey answer that doesn't verify, or with no prompt open", async () => {
      seedPasskey("pk-other", "cred-other");
      await expect(attempt(change, { passkey: assertion("cred-other") })).rejects.toMatchObject(refused);
      const proof = await existingPasskeyProof("cred-other");
      webauthn.verifyAuthenticationResponse.mockRejectedValueOnce(new Error("Signature mismatch"));
      await expect(attempt(change, proof)).rejects.toMatchObject(refused);
      // The prompt was spent by the failed answer.
      await expect(attempt(change, proof)).rejects.toMatchObject(refused);
    });

    it("accepts the current password when the account has no authenticator", async () => {
      await expect(attempt(change, passwordProof)).resolves.toBeDefined();
      expect(state.credential).toMatchObject({ failedAttempts: 0 });
    });

    it("accepts an authenticator code", async () => {
      enrolAuthenticator();
      await expect(attempt(change, { code: totpCode(SECRET, now) })).resolves.toBeDefined();
      expect(state.enrollment).toMatchObject({ lastUsedStep: BigInt(totpStep(now)) });
    });

    it("accepts an unused recovery code, spends it, and audits its use", async () => {
      enrolAuthenticator();
      await expect(attempt(change, { code: RECOVERY_CODE })).resolves.toBeDefined();
      expect(state.recoveryCodes[0]).toMatchObject({ usedAt: now });
      expect(state.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "MFA_RECOVERY_CODE_USED" })]));
      expect(JSON.stringify(state.audit)).not.toContain(RECOVERY_CODE);
    });

    it("accepts an answer from an existing passkey to this session's prompt", async () => {
      seedPasskey("pk-other", "cred-other");
      const proof = await existingPasskeyProof("cred-other");
      await expect(attempt(change, proof)).resolves.toBeDefined();
      expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
        expectedChallenge: "auth-challenge",
        requireUserVerification: true,
        credential: expect.objectContaining({ id: "cred-other" }),
      }));
    });
  });

  it("offers the proofs the account can give", async () => {
    expect(await changeVerificationMethods("user-1")).toEqual({ code: false, passkey: false, password: true });
    seedPasskey();
    expect(await changeVerificationMethods("user-1")).toEqual({ code: false, passkey: true, password: true });
    enrolAuthenticator();
    expect(await changeVerificationMethods("user-1")).toEqual({ code: true, passkey: true, password: false });
  });

  it("won't answer an existing-passkey prompt with another account's passkey", async () => {
    state.passkeys.push({ id: "pk-x", userId: "user-2", credentialId: "cred-x", publicKey: Buffer.from([1]), counter: BigInt(0), transports: [], revokedAt: null });
    seedPasskey();
    await beginPasskeyVerification(account, "session-1", origin, now);
    await expect(beginPasskeyRegistration(account, "session-1", origin, { passkey: assertion("cred-x") }, now)).rejects.toMatchObject(refused);
  });

  it("has nothing to prompt for when the account has no passkey", async () => {
    await expect(beginPasskeyVerification(account, "session-1", origin, now)).rejects.toMatchObject({ code: "NO_PASSKEYS" });
  });
});

describe("renaming and removing staff passkeys", () => {
  it("renames a passkey without a fresh proof and audits it", async () => {
    await addPasskey();
    const renamed = await renamePasskey(account, "pk-1", "  Work laptop  ", now);
    expect(renamed).toEqual([expect.objectContaining({ name: "Work laptop" })]);
    expect(state.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "USER_PASSKEY_RENAMED", entityId: "pk-1" })]));
  });

  it("won't rename another account's passkey", async () => {
    await addPasskey();
    const other = { ...account, id: "user-2" };
    await expect(renamePasskey(other, "pk-1", "Mine now", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_FOUND" });
  });

  it("removes a passkey and audits it", async () => {
    await addPasskey();
    await addPasskey();
    const remaining = await removePasskey(account, "session-1", origin, "pk-1", passwordProof, now);
    expect(remaining).toEqual([expect.objectContaining({ id: "pk-2" })]);
    expect(state.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "USER_PASSKEY_REMOVED", entityId: "pk-1" })]));
  });

  it("refuses another account's passkey id", async () => {
    await addPasskey();
    const other = { ...account, id: "user-2" };
    await expect(removePasskey(other, "session-1", origin, "pk-1", passwordProof, now)).rejects.toMatchObject({ code: "PASSKEY_NOT_FOUND" });
  });

  it("removes the only passkey; the password stays the fallback", async () => {
    await addPasskey();
    await expect(removePasskey(account, "session-1", origin, "pk-1", passwordProof, now)).resolves.toEqual([]);
    await expect(removePasskey(account, "session-1", origin, "pk-1", passwordProof, now)).rejects.toMatchObject({ code: "PASSKEY_NOT_FOUND" });
  });
});

describe("staff passkey sign-in", () => {
  const SIGN_IN_REFUSED = "That passkey didn't sign you in. Try again, or sign in with your email and password.";

  async function signIn(userHandle?: string, credentialId = "cred-1") {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    return finishPasskeySignIn(challengeId, origin, assertion(credentialId, userHandle), "test-agent", now);
  }

  it("completes sign-in on a UV passkey alone and advances the counter conditionally", async () => {
    const result = await signIn(Buffer.from("user-1").toString("base64url"));
    expect(result).toMatchObject({ userId: "user-1" });
    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "auth-challenge",
      expectedOrigin: origin,
      expectedRPID: "events.imsda.test",
      requireUserVerification: true,
      credential: expect.objectContaining({ id: "cred-1", counter: 0 }),
    }));
    expect(state.passkeys[0]).toMatchObject({ counter: BigInt(5), lastUsedAt: now });
    expect(state.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "USER_PASSKEY_SIGN_IN", actorUserId: "user-1" })]));
  });

  it("leaves the counter alone for an authenticator that reports 0", async () => {
    webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0 } });
    await expect(signIn()).resolves.toMatchObject({ userId: "user-1" });
    expect(state.passkeys[0]).toMatchObject({ counter: BigInt(0), lastUsedAt: now });
  });

  it("refuses when a concurrent sign-in already stored that counter", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    // The library saw 0 and accepted 5, but another request stored 5 meanwhile.
    webauthn.verifyAuthenticationResponse.mockImplementationOnce(async () => {
      state.passkeys[0].counter = BigInt(5);
      return { verified: true, authenticationInfo: { newCounter: 5 } };
    });
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
  });

  it("won't answer the same sign-in prompt twice (challenge replay)", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    await finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now);
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects an expired sign-in challenge", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    const later = new Date(now.getTime() + 6 * 60_000);
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", later)).rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("clears only expired sign-in prompts when a new one is made", async () => {
    const first = await beginPasskeySignIn(origin, now);
    const soon = new Date(now.getTime() + 60_000);
    await beginPasskeySignIn(origin, soon);
    // The first prompt is still live one minute later, so it was kept.
    expect(state.challenges.map((row) => row.id)).toContain(first.challengeId);
    const later = new Date(now.getTime() + 6 * 60_000);
    await beginPasskeySignIn(origin, later);
    expect(state.challenges.map((row) => row.id)).not.toContain(first.challengeId);
  });

  it("refuses the wrong origin and the wrong RP ID", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    await expect(finishPasskeySignIn(challengeId, "https://not-imsda.test", assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });

    state.settings = { passkeyRpId: null };
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
  });

  it("falls back to rejecting a counter that goes backwards, logging a fixed reason code only", async () => {
    await addPasskey();
    state.passkeys[0].counter = BigInt(9);
    const { challengeId } = await beginPasskeySignIn(origin, now);
    webauthn.verifyAuthenticationResponse.mockRejectedValueOnce(new Error("Response counter value 5 was lower than expected 9"));
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(state.passkeys[0]).toMatchObject({ counter: BigInt(9) });
    expect(logger.logWarn).toHaveBeenCalledWith(expect.any(String), { reason: "ASSERTION_REJECTED" });
  });

  it("refuses an unknown credential", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    await expect(finishPasskeySignIn(challengeId, origin, assertion("unknown-cred"), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("gives an attendee's credential the same neutral refusal as an unknown one", async () => {
    // An attendee passkey lives in its own table; staff sign-in never looks there.
    state.attendeePasskeys.push({ id: "apk-1", accountId: "attendee-1", credentialId: "attendee-cred-1", revokedAt: null });
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    const refusal = finishPasskeySignIn(challengeId, origin, assertion("attendee-cred-1"), "test-agent", now);
    await expect(refusal).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED", message: SIGN_IN_REFUSED });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("refuses a passkey whose authenticator names a different account", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    await expect(finishPasskeySignIn(challengeId, origin, assertion("cred-1", Buffer.from("user-2").toString("base64url")), "test-agent", now))
      .rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("refuses a disabled account", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    state.credential = { ...state.credential, disabledAt: now };
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("refuses a locked account", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    state.credential = { ...state.credential, lockedUntil: new Date(now.getTime() + 60_000) };
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("refuses an account that is still PENDING_ACTIVATION", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    state.accountStatus = "PENDING_ACTIVATION";
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED", message: SIGN_IN_REFUSED });
  });

  it.each([
    ["disabled", () => { state.credential = { ...state.credential, disabledAt: now }; }],
    ["locked", () => { state.credential = { ...state.credential, lockedUntil: new Date(now.getTime() + 60_000) }; }],
    ["deactivated", () => { state.accountStatus = "DISABLED"; }],
    ["passkey revoked", () => { state.passkeys[0].revokedAt = now; }],
  ])("re-reads the account just before minting a session (%s mid-verification)", async (_label, change) => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    webauthn.verifyAuthenticationResponse.mockImplementationOnce(async () => {
      change();
      return { verified: true, authenticationInfo: { newCounter: 5 } };
    });
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED", message: SIGN_IN_REFUSED });
    expect(state.audit.map((entry) => entry.action)).not.toContain("USER_PASSKEY_SIGN_IN");
  });

  it("refuses passkey sign-in after a system administrator resets two-step sign-in", async () => {
    await addPasskey();
    enrolAuthenticator();
    await resetStaffTwoStep("user-1", "admin-1", now);
    expect(state.enrollment).toBeNull();
    expect(state.passkeys[0]).toMatchObject({ revokedAt: now });
    const { challengeId } = await beginPasskeySignIn(origin, now);
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED", message: SIGN_IN_REFUSED });
  });
});
