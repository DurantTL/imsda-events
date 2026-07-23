import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  paymentAttemptFindMany: vi.fn(),
  registrationFindMany: vi.fn(),
  messageOutboxFindMany: vi.fn(),
  importRunFindMany: vi.fn(),
  eventFindUnique: vi.fn(),
  attendeeCount: vi.fn(),
  formFindMany: vi.fn(),
  capacityGroupBy: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    paymentAttempt: { findMany: mocks.paymentAttemptFindMany },
    registration: { findMany: mocks.registrationFindMany },
    messageOutbox: { findMany: mocks.messageOutboxFindMany },
    importRun: { findMany: mocks.importRunFindMany },
    event: { findUnique: mocks.eventFindUnique },
    registrationAttendee: { count: mocks.attendeeCount },
    registrationForm: { findMany: mocks.formFindMany },
    registrationCapacityReservation: { groupBy: mocks.capacityGroupBy },
  }),
}));

import { getOperationalHealth } from "@/modules/operations/repository";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paymentAttemptFindMany.mockResolvedValue([]);
  mocks.registrationFindMany.mockResolvedValue([]);
  mocks.messageOutboxFindMany.mockResolvedValue([]);
  mocks.importRunFindMany.mockResolvedValue([]);
  mocks.eventFindUnique.mockResolvedValue({ capacity: null });
  mocks.attendeeCount.mockResolvedValue(0);
  mocks.formFindMany.mockResolvedValue([]);
  mocks.capacityGroupBy.mockResolvedValue([]);
});

describe("operational health repository", () => {
  it("queries only the event-scoped category granted to the caller", async () => {
    await getOperationalHealth("event-one", {
      finance: false,
      communications: true,
      imports: false,
      capacity: false,
    }, new Date("2026-09-01T18:00:00.000Z"));

    expect(mocks.messageOutboxFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventId: "event-one" }),
        select: expect.objectContaining({
          _count: {
            select: {
              retries: {
                where: {
                  status: {
                    in: ["FAILED", "PENDING", "PROCESSING", "SENT"],
                  },
                },
              },
            },
          },
        }),
      }),
    );
    expect(mocks.paymentAttemptFindMany).not.toHaveBeenCalled();
    expect(mocks.registrationFindMany).not.toHaveBeenCalled();
    expect(mocks.importRunFindMany).not.toHaveBeenCalled();
    expect(mocks.eventFindUnique).not.toHaveBeenCalled();
    expect(mocks.capacityGroupBy).not.toHaveBeenCalled();
  });

  it("scopes every capacity read to the selected event", async () => {
    await getOperationalHealth("event-two", {
      finance: false,
      communications: false,
      imports: false,
      capacity: true,
    }, new Date("2026-09-01T18:00:00.000Z"));

    expect(mocks.eventFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "event-two" } }),
    );
    expect(mocks.attendeeCount).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventId: "event-two" }),
      }),
    );
    expect(mocks.formFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventId: "event-two" }),
      }),
    );
    expect(mocks.capacityGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventId: "event-two" }),
      }),
    );
  });
});
