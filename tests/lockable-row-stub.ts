import { vi } from "vitest";

/**
 * An in-memory stand-in for one row that carries a lockout counter
 * (`AuthCredential`, `AttendeeCredential`, `UserMfaEnrollment`,
 * `AttendeeMfaEnrollment`). It applies Prisma's semantics for the two
 * operations the lockout code uses, atomically per call, so tests can race two
 * wrong attempts against it the way two requests would race against Postgres:
 *
 * - `update` with `failedAttempts: { increment: n }` adds to the counter and
 *   returns the new row; any other `update` merges its data.
 * - `updateMany` with a `failedAttempts: { gte }` / `lockedUntil` guard only
 *   matches while the counter is at the threshold and no live lock stands,
 *   exactly like the lock claim; any other `updateMany` merges and matches.
 *
 * Not a test file (no `.test.ts`), so Vitest does not collect it.
 */
export type LockableRow = { failedAttempts: number; lockedUntil: Date | null };

type Where = {
  failedAttempts?: { gte: number };
  OR?: Array<{ lockedUntil: null | { lte: Date } }>;
};

export function lockableRowStub(initial: Partial<LockableRow> = {}) {
  const row: LockableRow = {
    failedAttempts: initial.failedAttempts ?? 0,
    lockedUntil: initial.lockedUntil ?? null,
  };

  const update = vi.fn(async (query: { data: Record<string, unknown> }) => {
    const { failedAttempts, ...rest } = query.data;
    if (failedAttempts && typeof failedAttempts === "object" && "increment" in failedAttempts) {
      row.failedAttempts += (failedAttempts as { increment: number }).increment;
    } else if (typeof failedAttempts === "number") {
      row.failedAttempts = failedAttempts;
    }
    if ("lockedUntil" in rest) row.lockedUntil = rest.lockedUntil as Date | null;
    return { ...row };
  });

  const updateMany = vi.fn(async (query: { where: Where; data: Record<string, unknown> }) => {
    const guard = query.where.failedAttempts;
    if (guard) {
      const expiredBefore = query.where.OR
        ?.map((clause) => clause.lockedUntil)
        .find((value): value is { lte: Date } => value !== null)?.lte;
      const unlocked = row.lockedUntil === null
        || (expiredBefore !== undefined && row.lockedUntil <= expiredBefore);
      if (row.failedAttempts < guard.gte || !unlocked) return { count: 0 };
    }
    if (typeof query.data.failedAttempts === "number") row.failedAttempts = query.data.failedAttempts;
    if ("lockedUntil" in query.data) row.lockedUntil = query.data.lockedUntil as Date | null;
    return { count: 1 };
  });

  return { row, update, updateMany };
}
