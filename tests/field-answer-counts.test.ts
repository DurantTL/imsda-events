import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { countFieldAnswers } from "@/modules/forms/repository";

/**
 * `countFieldAnswers` (#471): the registration builder's "review before
 * removing" dialog needs the real count of attendees on this event's real
 * registrations who already have a non-empty answer for a field key, so
 * what's shown is never invented.
 */
describe("countFieldAnswers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty map without querying when no keys are given", async () => {
    const queryRaw = vi.fn();
    dependencies.getPrisma.mockReturnValue({ $queryRaw: queryRaw });

    expect(await countFieldAnswers("event-1", [])).toEqual({});
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("counts each distinct field key separately, with real per-key numbers", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ count: BigInt(42) }])
      .mockResolvedValueOnce([{ count: BigInt(0) }]);
    dependencies.getPrisma.mockReturnValue({ $queryRaw: queryRaw });

    const counts = await countFieldAnswers("event-1", ["shirt_size", "shirt_size", "dietary_notes"]);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(counts).toEqual({ shirt_size: 42, dietary_notes: 0 });
  });
});
