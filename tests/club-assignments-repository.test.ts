import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/registrations/amendments-repository", () => ({ currentRegistrationAnswers: vi.fn() }));

import { Prisma } from "@prisma/client";
import { upsertClubAssignment } from "@/modules/club-registrations/assignments-repository";

const fields = {
  campsiteLocation: "Field C, site 12",
  campsiteNotes: "",
  dutyLabel: "Flag raising",
  dutyDay: "Friday",
  dutyTime: "morning",
  activityLabel: "Campfire singing",
  notes: "",
};

function database(existing: (typeof fields & { id: string; version: number }) | null) {
  const tx = {
    clubEventRegistration: {
      findUnique: vi.fn().mockResolvedValue({ id: "cer-1", registration: { status: "CONFIRMED" } }),
    },
    clubEventAssignment: {
      findUnique: vi.fn().mockResolvedValue(existing),
      upsert: vi.fn(async () => ({ ...(existing ?? { id: "assignment-1", version: 0 }), ...fields, version: (existing?.version ?? 0) + 1 })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown, options?: unknown) => {
      void options;
      return callback(tx);
    }),
  };
  return { tx, prisma };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertClubAssignment", () => {
  it("keeps the version and writes no audit or row update when nothing changed", async () => {
    const existing = { id: "assignment-1", version: 3, ...fields };
    const { tx, prisma } = database(existing);
    mocks.getPrisma.mockReturnValue(prisma);

    const saved = await upsertClubAssignment("event-1", "org-a", fields, "staff-1");
    expect(saved?.version).toBe(3);
    expect(tx.clubEventAssignment.upsert).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("bumps the version and writes exactly one audit entry, inside a serializable transaction", async () => {
    const existing = { id: "assignment-1", version: 3, ...fields };
    const { tx, prisma } = database(existing);
    mocks.getPrisma.mockReturnValue(prisma);

    const saved = await upsertClubAssignment(
      "event-1",
      "org-a",
      { ...fields, activityLabel: "Oregon Trail" },
      "staff-1",
    );
    expect(tx.clubEventAssignment.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ activityLabel: "Oregon Trail", version: { increment: 1 } }),
    }));
    expect(saved?.version).toBe(4);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_ASSIGNMENT_UPDATED", metadata: { organizationId: "org-a", version: 4 } }),
      tx,
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it("retries a serialization conflict and then succeeds", async () => {
    const { prisma } = database(null);
    const conflict = new Prisma.PrismaClientKnownRequestError("conflict", { code: "P2034", clientVersion: "test" });
    const original = prisma.$transaction.getMockImplementation()!;
    prisma.$transaction
      .mockImplementationOnce(async () => { throw conflict; })
      .mockImplementation(original);
    mocks.getPrisma.mockReturnValue(prisma);

    await expect(upsertClubAssignment("event-1", "org-a", fields, "staff-1")).resolves.toMatchObject({ version: 1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
