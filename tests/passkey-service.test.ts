import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  settings: { passkeyRpId: "events.imsda.test" as string | null },
  enrollment: null as Row | null,
  session: { secondFactorVerifiedAt: null as Date | null },
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
    (where.accountId === undefined || passkey.accountId === where.accountId)
    && (where.credentialId === undefined || passkey.credentialId === where.credentialId)
    && (where.id === undefined || passkey.id === where.id)
    && (!("revokedAt" in where) || passkey.revokedAt === null));
  const client = {
    platformSettings: { findUnique: async () => state.settings },
    attendeeMfaEnrollment: { findUnique: async () => state.enrollment },
    attendeeSession: { findUnique: async () => state.session },
    attendeePasskey: {
      count: async ({ where }: { where: Row }) => active(where).length,
      findMany: async ({ where }: { where: Row }) => active(where),
      findFirst: async ({ where }: { where: Row }) => active(where)[0] ?? null,
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
    attendeePasskeyChallenge: {
      deleteMany: async ({ where }: { where: Row }) => {
        state.challenges = state.challenges.filter((row) => !(row.sessionId === where.sessionId && row.purpose === where.purpose));
      },
      create: async ({ data }: { data: Row }) => { state.challenges.push({ id: `ch-${state.challenges.length + 1}`, usedAt: null, createdAt: new Date(), ...data }); },
      findFirst: async ({ where }: { where: Row & { expiresAt: { gt: Date } } }) => state.challenges.find((row) =>
        row.sessionId === where.sessionId && row.purpose === where.purpose && row.usedAt === null
        && (row.expiresAt as Date) > where.expiresAt.gt) ?? null,
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

import {
  PasskeyError,
  beginPasskeyRegistration,
  beginPasskeyVerification,
  finishPasskeyRegistration,
  finishPasskeyVerification,
  removePasskey,
} from "@/modules/attendee-accounts/passkeys";

const account = { id: "account-1", verifiedEmail: "director@example.test", displayName: "Test Director" };
const origin = "https://events.imsda.test";
const now = new Date("2026-10-01T12:00:00Z");
const registration = { id: "cred-1", rawId: "cred-1", type: "public-key", response: {} } as never;
const assertion = (id = "cred-1") => ({ id, rawId: id, type: "public-key", response: {} }) as never;

async function addPasskey() {
  await beginPasskeyRegistration(account, "session-1", origin, now);
  return finishPasskeyRegistration(account, "session-1", origin, { response: registration, name: "Phone" }, now);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.settings = { passkeyRpId: "events.imsda.test" };
  state.enrollment = null;
  state.session = { secondFactorVerifiedAt: null };
  state.passkeys = [];
  state.challenges = [];
  state.audit = [];
  webauthn.generateRegistrationOptions.mockResolvedValue({ challenge: "reg-challenge" });
  webauthn.generateAuthenticationOptions.mockResolvedValue({ challenge: "auth-challenge" });
  webauthn.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: "cred-1", publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
    },
  });
  webauthn.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 5 } });
});

describe("adding passkeys", () => {
  it("stores only the public key, verified against this site's origin and domain", async () => {
    const passkeys = await addPasskey();
    expect(passkeys).toEqual([expect.objectContaining({ name: "Phone", backedUp: true })]);
    expect(webauthn.verifyRegistrationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "reg-challenge",
      expectedOrigin: origin,
      expectedRPID: "events.imsda.test",
      requireUserVerification: true,
    }));
    expect(state.audit).toEqual([expect.objectContaining({ action: "ATTENDEE_PASSKEY_ADDED" })]);
    expect(JSON.stringify(state.audit)).not.toContain("cred-1");
  });

  it("won't answer the same prompt twice", async () => {
    await addPasskey();
    state.session = { secondFactorVerifiedAt: now };
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, now))
      .rejects.toMatchObject({ code: "CHALLENGE_EXPIRED" });
  });

  it("stays off when no domain is set or the page is on another origin", async () => {
    state.settings = { passkeyRpId: null };
    await expect(beginPasskeyRegistration(account, "session-1", origin, now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
    state.settings = { passkeyRpId: "events.imsda.test" };
    await expect(beginPasskeyRegistration(account, "session-1", "https://elsewhere.test", now)).rejects.toMatchObject({ code: "PASSKEYS_NOT_AVAILABLE" });
  });

  it("needs a recent second step once the account already has one", async () => {
    state.enrollment = { status: "ACTIVE" };
    await expect(beginPasskeyRegistration(account, "session-1", origin, now)).rejects.toBeInstanceOf(PasskeyError);
    state.session = { secondFactorVerifiedAt: new Date(now.getTime() - 60_000) };
    await expect(beginPasskeyRegistration(account, "session-1", origin, now)).resolves.toMatchObject({ challenge: "reg-challenge" });
  });

  it("rejects a response the library doesn't verify", async () => {
    webauthn.verifyRegistrationResponse.mockRejectedValueOnce(new Error("Unexpected origin"));
    await beginPasskeyRegistration(account, "session-1", origin, now);
    await expect(finishPasskeyRegistration(account, "session-1", origin, { response: registration }, now))
      .rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(state.passkeys).toHaveLength(0);
  });
});

describe("using and removing passkeys", () => {
  it("verifies this account's passkey and advances its counter", async () => {
    await addPasskey();
    await beginPasskeyVerification(account, "session-1", origin, now);
    await finishPasskeyVerification(account, "session-1", origin, assertion(), now);
    expect(webauthn.verifyAuthenticationResponse).toHaveBeenCalledWith(expect.objectContaining({
      expectedChallenge: "auth-challenge",
      requireUserVerification: true,
      credential: expect.objectContaining({ id: "cred-1", counter: 0 }),
    }));
    expect(state.passkeys[0]).toMatchObject({ counter: BigInt(5), lastUsedAt: now });
  });

  it("refuses another account's passkey", async () => {
    await addPasskey();
    await beginPasskeyVerification(account, "session-1", origin, now);
    const other = { ...account, id: "account-2" };
    state.challenges.push({ id: "ch-x", sessionId: "session-2", purpose: "VERIFY", challenge: "c", usedAt: null, createdAt: now, expiresAt: new Date(now.getTime() + 60_000) });
    await expect(finishPasskeyVerification(other, "session-2", origin, assertion(), now)).rejects.toMatchObject({ code: "PASSKEY_NOT_VERIFIED" });
    expect(webauthn.verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("asks for a passkey before offering the prompt", async () => {
    await expect(beginPasskeyVerification(account, "session-1", origin, now)).rejects.toMatchObject({ code: "NO_PASSKEYS" });
  });

  it("removes a passkey only after a recent second step, and it never verifies again", async () => {
    await addPasskey();
    await expect(removePasskey(account, "session-1", "pk-1", now)).rejects.toMatchObject({ code: "RECENT_VERIFICATION_REQUIRED" });
    state.session = { secondFactorVerifiedAt: now };
    // With no authenticator app, the only passkey is the only second step and stays.
    await expect(removePasskey(account, "session-1", "pk-1", now)).rejects.toMatchObject({ code: "LAST_SECOND_STEP" });
    state.enrollment = { status: "ACTIVE" };
    await expect(removePasskey(account, "session-1", "pk-1", now)).resolves.toEqual([]);
    await expect(removePasskey(account, "session-1", "pk-1", now)).rejects.toMatchObject({ code: "PASSKEY_NOT_FOUND" });
    await expect(beginPasskeyVerification(account, "session-1", origin, now)).rejects.toMatchObject({ code: "NO_PASSKEYS" });
  });
});
