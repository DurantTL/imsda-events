import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ getPrisma: () => ({ $transaction: database.transaction }) }));

import { EventDeletionError, deleteEvent } from "@/modules/events/deletion-repository";

function p2028(message: string) {
  return new Prisma.PrismaClientKnownRequestError(message, { code: "P2028", clientVersion: "test" });
}

async function failureOf(error: unknown) {
  database.transaction.mockRejectedValueOnce(error);
  return deleteEvent({ eventId: "evt_1", actor: { userId: "u1", globalRole: "SYSTEM_ADMIN" }, confirmName: "x" }).then(
    () => null,
    (caught: unknown) => caught,
  );
}

describe("event deletion failure mapping (#620)", () => {
  beforeEach(() => database.transaction.mockReset());

  it("reports a transaction that outlived its deadline as too slow, not busy", async () => {
    const error = await failureOf(p2028("Transaction API error: A commit cannot be executed on an expired transaction. The timeout for this transaction was 120000 ms."));
    expect(error).toBeInstanceOf(EventDeletionError);
    expect((error as EventDeletionError).code).toBe("EVENT_DELETE_TIMEOUT");
    expect((error as EventDeletionError).message).toBe("Deleting this event took too long and nothing was removed. Contact support.");
  });

  it("keeps busy for a transaction that could not start in time", async () => {
    const error = await failureOf(p2028("Unable to start a transaction in the given time."));
    expect((error as EventDeletionError).code).toBe("EVENT_BUSY");
  });

  it("keeps busy for a deadlock", async () => {
    const error = await failureOf(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
    expect((error as EventDeletionError).code).toBe("EVENT_BUSY");
  });

  it("lets other errors through unchanged", async () => {
    const boom = new Error("boom");
    expect(await failureOf(boom)).toBe(boom);
  });
});
