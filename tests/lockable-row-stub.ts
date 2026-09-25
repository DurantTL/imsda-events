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
 * - `updateMany` honours the guards the lockout code uses — a
 *   `failedAttempts: { gte }` or `{ lt }` bound and an `OR` of `lockedUntil`
 *   clauses ("no live lock") — and applies `increment` or plain values. Other
 *   `OR` clauses (for example `lastUsedStep`) are ignored and match.
 *
 * Not a test file (no `.test.ts`), so Vitest does not collect it.
 */
export type LockableRow = { failedAttempts: number; lockedUntil: Date | null };

type Where = {
  failedAttempts?: { gte?: number; lt?: number };
  OR?: Array<{ lockedUntil?: null | { lte: Date } }>;
};

function apply(row: LockableRow, data: Record<string, unknown>) {
  const { failedAttempts } = data;
  if (failedAttempts && typeof failedAttempts === "object" && "increment" in failedAttempts) {
    row.failedAttempts += (failedAttempts as { increment: number }).increment;
  } else if (typeof failedAttempts === "number") {
    row.failedAttempts = failedAttempts;
  }
  if ("lockedUntil" in data) row.lockedUntil = data.lockedUntil as Date | null;
}

function matches(row: LockableRow, where: Where) {
  const bound = where.failedAttempts;
  if (bound?.gte !== undefined && row.failedAttempts < bound.gte) return false;
  if (bound?.lt !== undefined && row.failedAttempts >= bound.lt) return false;
  const lockClauses = (where.OR ?? []).filter((clause) => "lockedUntil" in clause);
  if (lockClauses.length === 0) return true;
  return lockClauses.some((clause) => (clause.lockedUntil === null
    ? row.lockedUntil === null
    : row.lockedUntil !== null && row.lockedUntil <= clause.lockedUntil!.lte));
}

export function lockableRowStub(initial: Partial<LockableRow> = {}) {
  const row: LockableRow = {
    failedAttempts: initial.failedAttempts ?? 0,
    lockedUntil: initial.lockedUntil ?? null,
  };

  const update = vi.fn(async (query: { data: Record<string, unknown> }) => {
    apply(row, query.data);
    return { ...row };
  });

  const updateMany = vi.fn(async (query: { where: Where; data: Record<string, unknown> }) => {
    if (!matches(row, query.where)) return { count: 0 };
    apply(row, query.data);
    return { count: 1 };
  });

  return { row, update, updateMany };
}
