import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));

import { backfillAttendeeTypes } from "@/modules/attendee-types/repository";

beforeEach(() => vi.clearAllMocks());

describe("attendee type backfill", () => {
  it("is idempotent and leaves an unmappable legacy value untouched", async () => {
    const attendees = [
      { id: "attendee-1", attendeeType: " Adult ", attendeeTypeDefinitionId: null as string | null },
      { id: "attendee-2", attendeeType: "ADULT", attendeeTypeDefinitionId: null as string | null },
      { id: "attendee-3", attendeeType: "Visitor", attendeeTypeDefinitionId: null as string | null },
    ];
    const registrationAttendee = {
      groupBy: vi.fn(async () => {
        const counts = new Map<string, number>();
        attendees.filter((row) => row.attendeeTypeDefinitionId === null).forEach((row) => counts.set(row.attendeeType, (counts.get(row.attendeeType) ?? 0) + 1));
        return [...counts].map(([attendeeType, count]) => ({ attendeeType, _count: { _all: count } }));
      }),
      findMany: vi.fn(async () => attendees.filter((row) => row.attendeeTypeDefinitionId === null).map((row, index) => ({ id: row.id ?? `attendee-${index + 1}`, attendeeType: row.attendeeType }))),
      updateMany: vi.fn(async ({ where, data }: { where: { id: { in: string[] }; attendeeTypeDefinitionId: null }; data: { attendeeTypeDefinitionId: string } }) => {
        let count = 0;
        attendees.forEach((row, index) => { if (where.id.in.includes(row.id ?? `attendee-${index + 1}`) && row.attendeeTypeDefinitionId === where.attendeeTypeDefinitionId) { row.attendeeTypeDefinitionId = data.attendeeTypeDefinitionId; count += 1; } });
        return { count };
      }),
    };
    const prisma = {
      eventAttendeeType: { findMany: vi.fn().mockResolvedValue([{ id: "type-adult", code: "ADULT", label: "Adult" }]) },
      registrationAttendee,
      $transaction: vi.fn(async (callback: (tx: { registrationAttendee: typeof registrationAttendee }) => unknown) => callback({ registrationAttendee })),
    };
    mocks.getPrisma.mockReturnValue(prisma);

    const first = await backfillAttendeeTypes("event-synthetic", true);
    const repeated = await backfillAttendeeTypes("event-synthetic", true);

    expect(first.updatedCount).toBe(2);
    expect(first.rows.find((row) => row.value === "Visitor")?.status).toBe("UNMAPPABLE");
    expect(repeated.updatedCount).toBe(0);
    expect(attendees.find((row) => row.attendeeType === "Visitor")?.attendeeTypeDefinitionId).toBeNull();
  });
});
