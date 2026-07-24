import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  isSessionIdle,
  listUserSessions,
  revokeOtherUserSessions,
  SESSION_IDLE_TIMEOUT_SECONDS,
  SESSION_LIFETIME_SECONDS,
  shouldTouchSession,
  touchDatabaseSession,
} from "@/modules/access/session-store";
import { hashOpaqueToken } from "@/modules/access/tokens";

const now = new Date("2026-07-24T18:00:00.000Z");

function ago(seconds: number) {
  return new Date(now.getTime() - seconds * 1000);
}

function prismaFixture(rows: Array<Record<string, unknown>> = []) {
  const prisma = {
    userSession: {
      findMany: vi.fn().mockResolvedValue(rows),
      updateMany: vi.fn().mockResolvedValue({ count: rows.length }),
    },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return prisma;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("idle expiry alongside the absolute expiry", () => {
  it("keeps the absolute ceiling at eight hours", () => {
    expect(SESSION_LIFETIME_SECONDS).toBe(8 * 60 * 60);
  });

  it("expires a session left idle past the timeout", () => {
    expect(isSessionIdle(ago(SESSION_IDLE_TIMEOUT_SECONDS + 1), now)).toBe(true);
    expect(isSessionIdle(ago(SESSION_IDLE_TIMEOUT_SECONDS - 1), now)).toBe(false);
  });

  it("does not treat a session used moments ago as idle", () => {
    expect(isSessionIdle(now, now)).toBe(false);
  });
});

describe("throttled touching", () => {
  it("skips the write until the interval has passed", () => {
    expect(shouldTouchSession(ago(5), now)).toBe(false);
    expect(shouldTouchSession(ago(120), now)).toBe(true);
  });

  it("guards the update on the observed value so concurrent requests do not race", async () => {
    const prisma = prismaFixture();
    const observed = ago(120);

    await touchDatabaseSession("hash-1", observed, now);

    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { tokenHash: "hash-1", revokedAt: null, lastSeenAt: observed },
      data: { lastSeenAt: now },
    });
  });
});

describe("signing out other devices", () => {
  it("keeps the caller's own session", async () => {
    const prisma = prismaFixture();

    await revokeOtherUserSessions("user-1", "raw-token");

    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        revokedAt: null,
        tokenHash: { not: hashOpaqueToken("raw-token") },
      },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("revokes everything when there is no current token to keep", async () => {
    const prisma = prismaFixture();

    await revokeOtherUserSessions("user-1", undefined);

    expect(prisma.userSession.updateMany).toHaveBeenCalledWith({
      where: { userId: "user-1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe("listing signed-in devices", () => {
  it("marks the caller's own session and hides idle ones", async () => {
    prismaFixture([
      {
        id: "session-current",
        tokenHash: hashOpaqueToken("raw-token"),
        createdAt: ago(3600),
        lastSeenAt: ago(30),
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
      {
        id: "session-other",
        tokenHash: "another-hash",
        createdAt: ago(7200),
        lastSeenAt: ago(600),
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
      {
        id: "session-idle",
        tokenHash: "idle-hash",
        createdAt: ago(20000),
        lastSeenAt: ago(SESSION_IDLE_TIMEOUT_SECONDS + 60),
        expiresAt: new Date(now.getTime() + 3_600_000),
      },
    ]);

    const sessions = await listUserSessions("user-1", "raw-token", now);

    expect(sessions.map((session) => session.id)).toEqual(["session-current", "session-other"]);
    expect(sessions[0].isCurrent).toBe(true);
    expect(sessions[1].isCurrent).toBe(false);
  });

  it("never returns a token hash to the client", async () => {
    prismaFixture([{
      id: "session-current",
      tokenHash: hashOpaqueToken("raw-token"),
      createdAt: ago(60),
      lastSeenAt: ago(10),
      expiresAt: new Date(now.getTime() + 3_600_000),
    }]);

    const [session] = await listUserSessions("user-1", "raw-token", now);

    expect(Object.keys(session)).toEqual([
      "id",
      "isCurrent",
      "startedAt",
      "lastSeenAt",
      "expiresAt",
    ]);
  });
});
