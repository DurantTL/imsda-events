import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  settings: { passkeyRpId: "events.imsda.test" as string | null },
  credential: { disabledAt: null as Date | null } as Row | null,
  passkeys: [] as Row[],
  challenges: [] as Row[],
  audit: [] as Row[],
}));
const webauthn = vi.hoisted(() => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@simplewebauthn/server", () => webauthn);
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn(async (entry: Row) => { state.audit.push(entry); }) }));
vi.mock("@/lib/prisma", () => {
  const active = (where: Row) => state.passkeys.filter((passkey) =>
    (where.userId === undefined || passkey.userId === where.userId)
    && (where.credentialId === undefined || passkey.credentialId === where.credentialId)
    && (typeof where.id !== "string" || passkey.id === where.id)
    && (!("revokedAt" in where) || passkey.revokedAt === null));
  const notId = (where: Row) => (where.id as Row | undefined)?.not as string | undefined;
  const client = {
    platformSettings: { findUnique: async () => state.settings },
    authCredential: { findUnique: async () => state.credential },
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
          user: { id: row.userId, globalRole: null, accountStatus: "ACTIVE", credential: state.credential },
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
      deleteMany: async ({ where }: { where: Row }) => {
        state.challenges = state.challenges.filter((row) => !(
          (where.sessionId === undefined || row.sessionId === where.sessionId)
          && (where.purpose === undefined || row.purpose === where.purpose)
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
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(client),
  };
  return { getPrisma: () => client };
});
vi.mock("@/modules/access/session-store", async () => {
  const actual = await vi.importActual<typeof import("@/modules/access/session-store")>("@/modules/access/session-store");
  return { ...actual, createDatabaseSession: vi.fn(async (userId: string) => ({ token: `token-${userId}`, expiresAt: new Date("2026-10-07T00:00:00Z") })) };
});

import {
  beginPasskeyRegistration,
  beginPasskeySignIn,
  finishPasskeyRegistration,
  finishPasskeySignIn,
  removePasskey,
  renamePasskey,
} from "@/modules/access/passkeys";

const account = { id: "user-1", email: "director@imsda.test", displayName: "Test Director" };
const origin = "https://events.imsda.test";
const now = new Date("2026-10-01T12:00:00Z");
const registration = { id: "cred-1", rawId: "cred-1", type: "public-key", response: {} } as never;
const assertion = (id = "cred-1", userHandle?: string) => ({
  id,
  rawId: id,
  type: "public-key",
  response: userHandle ? { userHandle } : {},
}) as never;

async function addPasskey() {
  await beginPasskeyRegistration(account, "session-1", origin, now);
  return finishPasskeyRegistration(account, "session-1", origin, { response: registration, name: "Laptop" }, now);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { passkeyRpId: "events.imsda.test" };
  state.credential = { disabledAt: null };
  state.passkeys = [];
  state.challenges = [];
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
    await expect(beginPasskeyRegistration(account, "session-1", origin, now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
    state.settings = { passkeyRpId: "events.imsda.test" };
    await expect(beginPasskeyRegistration(account, "session-1", "https://evil.test", now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
  });

  it("won't answer the same registration prompt twice (challenge replay)", async () => {
    await addPasskey();
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, now))
      .rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects an expired challenge", async () => {
    await beginPasskeyRegistration(account, "session-1", origin, now);
    const later = new Date(now.getTime() + 6 * 60_000);
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, later))
      .rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("rejects a response the library doesn't verify", async () => {
    webauthn.verifyRegistrationResponse.mockRejectedValueOnce(new Error("Unexpected origin"));
    await beginPasskeyRegistration(account, "session-1", origin, now);
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, now))
      .rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(state.passkeys).toHaveLength(0);
  });
});

describe("renaming and removing staff passkeys", () => {
  it("renames a passkey and audits it", async () => {
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

  it("removes a passkey when a usable password remains, and audits it", async () => {
    await addPasskey();
    await addPasskey();
    const remaining = await removePasskey(account, "pk-1", now);
    expect(remaining).toEqual([expect.objectContaining({ id: "pk-2" })]);
    expect(state.audit).toEqual(expect.arrayContaining([expect.objectContaining({ action: "USER_PASSKEY_REMOVED", entityId: "pk-1" })]));
  });

  it("refuses another account's passkey id", async () => {
    await addPasskey();
    const other = { ...account, id: "user-2" };
    await expect(removePasskey(other, "pk-1", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_FOUND" });
  });

  it("won't remove the last sign-in method when the account has no usable password", async () => {
    state.credential = null;
    await addPasskey();
    await expect(removePasskey(account, "pk-1", now)).rejects.toMatchObject({ code: "LAST_SIGN_IN_METHOD" });

    state.credential = { disabledAt: now };
    await expect(removePasskey(account, "pk-1", now)).rejects.toMatchObject({ code: "LAST_SIGN_IN_METHOD" });
  });

  it("removes the only passkey when the password is still usable", async () => {
    await addPasskey();
    await expect(removePasskey(account, "pk-1", now)).resolves.toEqual([]);
    await expect(removePasskey(account, "pk-1", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_FOUND" });
  });
});

describe("staff passkey sign-in", () => {
  async function signIn(userHandle?: string, credentialId = "cred-1") {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    return finishPasskeySignIn(challengeId, origin, assertion(credentialId, userHandle), "test-agent", now);
  }

  it("completes sign-in on a UV passkey alone and advances the counter", async () => {
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

  it("refuses the wrong origin and the wrong RP ID", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    await expect(finishPasskeySignIn(challengeId, "https://not-imsda.test", assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });

    state.settings = { passkeyRpId: null };
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
  });

  it("falls back to rejecting a counter that goes backwards", async () => {
    await addPasskey();
    state.passkeys[0].counter = BigInt(9);
    const { challengeId } = await beginPasskeySignIn(origin, now);
    webauthn.verifyAuthenticationResponse.mockRejectedValueOnce(new Error("Response counter value 5 was lower than expected 9"));
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(state.passkeys[0]).toMatchObject({ counter: BigInt(9) });
  });

  it("refuses an unknown credential", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    await expect(finishPasskeySignIn(challengeId, origin, assertion("unknown-cred"), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
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
    state.credential = { disabledAt: now };
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("refuses a locked account", async () => {
    await addPasskey();
    const { challengeId } = await beginPasskeySignIn(origin, now);
    state.credential = { disabledAt: null, lockedUntil: new Date(now.getTime() + 60_000) };
    await expect(finishPasskeySignIn(challengeId, origin, assertion(), "test-agent", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });
});
