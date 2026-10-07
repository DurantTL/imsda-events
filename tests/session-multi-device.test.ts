import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { createDatabaseSession } from "@/modules/access/session-store";

beforeEach(() => vi.clearAllMocks());

describe("one staff account on several devices (#825)", () => {
  it("signing a device in only adds a session; it never revokes, updates or deletes another", async () => {
    const userSession = {
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    };
    dependencies.getPrisma.mockReturnValue({ userSession });

    const sessions = await Promise.all(
      ["phone one", "phone two", "phone three", "tablet"].map((agent) => createDatabaseSession("staff_1", agent)),
    );

    expect(new Set(sessions.map((session) => session.token)).size).toBe(4);
    expect(userSession.create).toHaveBeenCalledTimes(4);
    expect(userSession.updateMany).not.toHaveBeenCalled();
    expect(userSession.update).not.toHaveBeenCalled();
    expect(userSession.delete).not.toHaveBeenCalled();
    expect(userSession.deleteMany).not.toHaveBeenCalled();
  });

  it("does not tie a session, or the request origin check, to the client address (cell handoffs, carrier NAT)", () => {
    for (const file of [
      "modules/access/session-store.ts",
      "modules/access/current-session.ts",
      "modules/access/request-security.ts",
      "modules/access/authorization.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/x-forwarded-for|x-real-ip|cf-connecting-ip|remoteAddress|clientIp|ipAddress/i);
    }
    // The user agent is recorded for the device list only; it is never compared when a session is read.
    expect(readFileSync("modules/access/current-session.ts", "utf8")).not.toMatch(/userAgent/i);
  });

  it("the live list stops polling and says why when the idle timeout has signed the device out", () => {
    const source = readFileSync("components/check-in-workspace.tsx", "utf8");
    expect(source).toMatch(/response\.status === 401/);
    expect(source).toContain("Signed out for inactivity");
    // One loop only: a poll in flight blocks a second one, and every timer is replaced, not stacked.
    expect(source).toMatch(/if \(cancelled \|\| inFlight\) return;/);
    expect(source).toMatch(/window\.clearTimeout\(timer\);\s*if \(!cancelled\) timer = /);
  });

  it("revokes other sessions only on explicit security events, never on sign-in", () => {
    const signInFiles = ["modules/access/auth-service.ts", "modules/access/mfa-service.ts", "modules/access/passkeys.ts", "app/api/auth/login/route.ts", "app/api/auth/mfa/challenge/route.ts"];
    for (const file of signInFiles) {
      const source = readFileSync(file, "utf8");
      // The one allowed revocation in auth-service is the password reset (resetPassword).
      const revocations = source.match(/userSession\.updateMany|revokeAllUserSessions|revokeOtherUserSessions/g) ?? [];
      expect(revocations.length, file).toBe(file.endsWith("auth-service.ts") ? 1 : 0);
    }
    expect(readFileSync("modules/access/auth-service.ts", "utf8")).toMatch(/resetPassword[\s\S]*userSession\.updateMany/);
  });
});
