import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { recordAnnouncementOptOut } from "@/modules/communications/email-preferences-repository";

const input = { email: "Avery@Example.test", eventId: "event-1", scope: "EVENT" as const, source: "ONE_CLICK" as const };

beforeEach(() => vi.clearAllMocks());

describe("recording an announcement opt-out (#838)", () => {
  it("is idempotent when a concurrent request wins the unique index (P2002), instead of failing", async () => {
    const existing = { id: "optout-1" };
    const findUnique = vi.fn().mockResolvedValue(existing);
    mocks.getPrisma.mockReturnValue({
      emailAnnouncementOptOut: { findUnique },
      // The loser's transaction: its own read saw nothing, then the insert hit the unique index.
      $transaction: vi.fn(async () => { throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }); }),
    });
    await expect(recordAnnouncementOptOut(input)).resolves.toEqual({ recorded: false, id: "optout-1" });
    expect(findUnique).toHaveBeenCalledWith({
      where: { normalizedEmail_scopeKey: { normalizedEmail: "avery@example.test", scopeKey: "event-1" } },
      select: { id: true },
    });
  });

  it("still surfaces a P2002 that no existing row explains, and any other error", async () => {
    mocks.getPrisma.mockReturnValue({
      emailAnnouncementOptOut: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async () => { throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" }); }),
    });
    await expect(recordAnnouncementOptOut(input)).rejects.toThrow(/Unique constraint/);
    mocks.getPrisma.mockReturnValue({ $transaction: vi.fn(async () => { throw new Error("database down"); }) });
    await expect(recordAnnouncementOptOut(input)).rejects.toThrow(/database down/);
  });

  it("records once and audits once in the normal case", async () => {
    const tx = {
      emailAnnouncementOptOut: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "optout-2" }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    mocks.getPrisma.mockReturnValue({ $transaction: vi.fn(async (run: (client: typeof tx) => unknown) => run(tx)) });
    await expect(recordAnnouncementOptOut(input)).resolves.toEqual({ recorded: true, id: "optout-2" });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain("example.test");
  });
});
