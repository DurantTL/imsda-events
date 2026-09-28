import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { countFieldAnswers } from "@/modules/forms/repository";
import {
  batchFieldKeys,
  FIELD_ANSWER_COUNT_BATCH_SIZE,
  NEUTRAL_REMOVAL_ANSWER_NOTE,
  removalAnswerNote,
} from "@/modules/forms/field-answer-counts";

type SqlLike = { sql: string; values: unknown[] };

/**
 * `countFieldAnswers` (#471): the registration builder's "review before
 * removing" dialog needs the real number of this event's registrations that
 * already hold a submitted answer for a field key, so what's shown is never
 * invented. The suite never opens a database connection (see
 * vitest.config.ts), so this pins the query's shape and parameters.
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

  it("counts every distinct key in one query, filling in zero for keys with no rows", async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ key: "shirt_size", count: BigInt(42) }]);
    dependencies.getPrisma.mockReturnValue({ $queryRaw: queryRaw });

    const counts = await countFieldAnswers("event-1", ["shirt_size", "shirt_size", "dietary_notes"]);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(counts).toEqual({ shirt_size: 42, dietary_notes: 0 });
  });

  it("counts distinct registrations, excludes empty stored values, and passes keys only as parameters", async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    dependencies.getPrisma.mockReturnValue({ $queryRaw: queryRaw });
    const hostileKey = `x'); DROP TABLE "Registration"; --`;

    await countFieldAnswers("event-1", [" padded_key ", hostileKey]);

    const query = queryRaw.mock.calls[0]![0] as SqlLike;
    expect(query.sql).toContain('COUNT(DISTINCT a."registrationId")');
    for (const empty of ["'null'::jsonb", "'false'::jsonb", "'\"\"'::jsonb", "'[]'::jsonb", "'{}'::jsonb"]) {
      expect(query.sql).toContain(empty);
    }
    // Keys are parameters, untrimmed, never spliced into the SQL text.
    expect(query.sql).not.toContain("DROP TABLE");
    expect(query.sql).not.toContain("padded_key");
    expect(query.values).toContainEqual([" padded_key ", hostileKey]);
    expect(query.values).toContain("event-1");
  });
});

describe("batchFieldKeys", () => {
  it("splits unique keys into route-sized batches", () => {
    const keys = Array.from({ length: 45 }, (_, index) => `field_${index}`);
    const batches = batchFieldKeys([...keys, "field_0"]);
    expect(batches.map((batch) => batch.length)).toEqual([FIELD_ANSWER_COUNT_BATCH_SIZE, FIELD_ANSWER_COUNT_BATCH_SIZE, 5]);
    expect(batches.flat()).toEqual(keys);
  });
});

describe("removalAnswerNote", () => {
  it("uses neutral wording when the counts could not be loaded, never claiming there are none", () => {
    expect(removalAnswerNote("field", ["shirt_size"], null)).toBe(NEUTRAL_REMOVAL_ANSWER_NOTE);
    expect(removalAnswerNote("section", ["a", "b"], { a: 0 })).toBe(NEUTRAL_REMOVAL_ANSWER_NOTE);
    expect(NEUTRAL_REMOVAL_ANSWER_NOTE).toBe("Answers already submitted stay on those registrations.");
  });

  it("reports registrations for a field", () => {
    expect(removalAnswerNote("field", ["shirt_size"], { shirt_size: 1 })).toBe(
      "1 registration already has an answer for it. Those answers stay on those registrations.",
    );
    expect(removalAnswerNote("field", ["shirt_size"], { shirt_size: 7 })).toContain("7 registrations already have");
    expect(removalAnswerNote("field", ["shirt_size"], { shirt_size: 0 })).toBe("No registration has an answer for it yet.");
  });

  it("never sums a section's per-field counts, since one registration can answer several fields", () => {
    expect(removalAnswerNote("section", ["a", "b"], { a: 3, b: 5 })).toBe(
      "At least 5 registrations already have answers for these fields. Those answers stay on those registrations.",
    );
    expect(removalAnswerNote("section", ["a", "b"], { a: 0, b: 0 })).toBe("No registration has an answer for these fields yet.");
  });
});
