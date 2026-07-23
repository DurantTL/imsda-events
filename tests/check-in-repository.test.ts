import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import {
  CheckInOperationError,
  checkInAttendee,
} from "@/modules/checkin/repository";

const idempotencyKey = "d67776d0-f79d-4e8f-bec2-ee61abb7337c";

function checkInRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "checkin_1",
    eventId: "event_123",
    registrationAttendeeId: "attendee_123",
    idempotencyKey,
    checkedInAt: new Date("2026-07-23T14:00:00.000Z"),
    undoneAt: null,
    undoReason: null,
    createdAt: new Date("2026-07-23T14:00:00.000Z"),
    ...overrides,
  };
}

function fixture() {
  const created = checkInRecord();
  const tx = {
    checkIn: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(created),
    },
    registrationAttendee: {
      findFirst: vi.fn().mockResolvedValue({
        id: "attendee_123",
        registration: { status: "CONFIRMED" },
        checkIns: [],
      }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_1" }),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (
      operation: (client: typeof tx) => unknown,
    ) => operation(tx)),
  };
  return { prisma, tx, created };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("check-in repository", () => {
  it("records the client UUID and one audit inside a serializable transaction", async () => {
    const { prisma, tx, created } = fixture();
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await checkInAttendee(
      "event_123",
      "attendee_123",
      "staff_1",
      idempotencyKey,
    );

    expect(result).toEqual({
      checkIn: created,
      disposition: "CREATED",
      checkedIn: true,
    });
    expect(tx.checkIn.create).toHaveBeenCalledWith({
      data: {
        eventId: "event_123",
        registrationAttendeeId: "attendee_123",
        idempotencyKey,
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  });

  it("returns the exact existing operation for a same-key retry without another audit", async () => {
    const { prisma, tx } = fixture();
    const replay = checkInRecord();
    tx.checkIn.findUnique.mockResolvedValue(replay);
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await checkInAttendee(
      "event_123",
      "attendee_123",
      "staff_1",
      idempotencyKey,
    );

    expect(result).toEqual({
      checkIn: replay,
      disposition: "IDEMPOTENT_REPLAY",
      checkedIn: true,
    });
    expect(tx.registrationAttendee.findFirst).not.toHaveBeenCalled();
    expect(tx.checkIn.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not let the same event-scoped retry key target another attendee", async () => {
    const { prisma, tx } = fixture();
    tx.checkIn.findUnique.mockResolvedValue(checkInRecord());
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(checkInAttendee(
      "event_123",
      "attendee_other",
      "staff_1",
      idempotencyKey,
    )).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    });
    expect(tx.checkIn.create).not.toHaveBeenCalled();
  });

  it("returns an existing active check-in created by another staff action", async () => {
    const { prisma, tx } = fixture();
    const active = checkInRecord({
      id: "checkin_other",
      idempotencyKey: "9ea10d48-aa3f-41fc-a621-003c823940cf",
    });
    tx.registrationAttendee.findFirst.mockResolvedValue({
      id: "attendee_123",
      registration: { status: "SUBMITTED" },
      checkIns: [active],
    });
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await checkInAttendee(
      "event_123",
      "attendee_123",
      "staff_1",
      idempotencyKey,
    );

    expect(result).toEqual({
      checkIn: active,
      disposition: "ALREADY_CHECKED_IN",
      checkedIn: true,
    });
    expect(tx.checkIn.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    [null, "ATTENDEE_NOT_FOUND"],
    [{
      id: "attendee_123",
      registration: { status: "CANCELLED" },
      checkIns: [],
    }, "REGISTRATION_NOT_ELIGIBLE"],
  ])("rejects missing and ineligible attendee state", async (
    attendee,
    code,
  ) => {
    const { prisma, tx } = fixture();
    tx.registrationAttendee.findFirst.mockResolvedValue(attendee);
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(checkInAttendee(
      "event_123",
      "attendee_123",
      "staff_1",
      idempotencyKey,
    )).rejects.toMatchObject({ code });
    expect(tx.checkIn.create).not.toHaveBeenCalled();
  });

  it("retries a unique-index race and returns the winning active check-in", async () => {
    const { prisma, tx } = fixture();
    const winner = checkInRecord({
      id: "checkin_winner",
      idempotencyKey: "9ea10d48-aa3f-41fc-a621-003c823940cf",
    });
    tx.registrationAttendee.findFirst
      .mockResolvedValueOnce({
        id: "attendee_123",
        registration: { status: "CONFIRMED" },
        checkIns: [],
      })
      .mockResolvedValueOnce({
        id: "attendee_123",
        registration: { status: "CONFIRMED" },
        checkIns: [winner],
      });
    tx.checkIn.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        { code: "P2002", clientVersion: "6.19.3" },
      ),
    );
    dependencies.getPrisma.mockReturnValue(prisma);

    await expect(checkInAttendee(
      "event_123",
      "attendee_123",
      "staff_1",
      idempotencyKey,
    )).resolves.toEqual({
      checkIn: winner,
      disposition: "ALREADY_CHECKED_IN",
      checkedIn: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("reports a replayed operation that was explicitly undone without recreating it", async () => {
    const { prisma, tx } = fixture();
    tx.checkIn.findUnique.mockResolvedValue(checkInRecord({
      undoneAt: new Date("2026-07-23T14:10:00.000Z"),
    }));
    dependencies.getPrisma.mockReturnValue(prisma);

    const result = await checkInAttendee(
      "event_123",
      "attendee_123",
      "staff_1",
      idempotencyKey,
    );

    expect(result).toMatchObject({
      disposition: "IDEMPOTENT_REPLAY",
      checkedIn: false,
    });
    expect(tx.checkIn.create).not.toHaveBeenCalled();
  });

  it("uses typed operation errors for conflict handling", () => {
    expect(
      new CheckInOperationError("CHECK_IN_OPERATION_CONFLICT"),
    ).toMatchObject({
      code: "CHECK_IN_OPERATION_CONFLICT",
    });
  });
});

