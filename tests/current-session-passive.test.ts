import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  cookieValue: "session-token",
}));

vi.mock("server-only", () => ({}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: dependencies.cookieValue }) }),
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { getCurrentSession, getCurrentSessionPassive } from "@/modules/access/current-session";
import { SESSION_IDLE_TIMEOUT_SECONDS, SESSION_TOUCH_INTERVAL_SECONDS } from "@/modules/access/session-store";

function row(lastSeenSecondsAgo: number) {
  return {
    id: "session_1",
    expiresAt: new Date(Date.now() + 3_600_000),
    revokedAt: null,
    lastSeenAt: new Date(Date.now() - lastSeenSecondsAgo * 1000),
    user: {
      id: "staff_1",
      email: "desk@example.test",
      displayName: "Desk",
      globalRole: null,
      accountStatus: "ACTIVE",
      credential: { disabledAt: null },
    },
  };
}

function prismaWith(lastSeenSecondsAgo: number) {
  const prisma = {
    userSession: {
      findUnique: vi.fn().mockResolvedValue(row(lastSeenSecondsAgo)),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return prisma;
}

beforeEach(() => vi.clearAllMocks());

describe("reading the session for background polling (#825)", () => {
  it("a normal read advances the idle clock once the touch interval has passed", async () => {
    const prisma = prismaWith(SESSION_TOUCH_INTERVAL_SECONDS + 5);
    expect((await getCurrentSession()).user?.id).toBe("staff_1");
    expect(prisma.userSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a passive read gives the same answer but never writes lastSeenAt", async () => {
    const prisma = prismaWith(SESSION_TOUCH_INTERVAL_SECONDS + 5);
    expect((await getCurrentSessionPassive()).user?.id).toBe("staff_1");
    expect(prisma.userSession.updateMany).not.toHaveBeenCalled();
  });

  it("a passive read of an idle session is signed out, so an unattended tablet's poll gets refused", async () => {
    const prisma = prismaWith(SESSION_IDLE_TIMEOUT_SECONDS + 60);
    expect((await getCurrentSessionPassive()).user).toBeNull();
    expect(prisma.userSession.updateMany).not.toHaveBeenCalled();
  });
});
