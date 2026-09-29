import { Prisma } from "@prisma/client";

/** PostgreSQL `lock_not_available`: a `lock_timeout` or `NOWAIT` lock gave up. */
const lockNotAvailable = "55P03";

/**
 * Whether `error` is a row-lock wait that gave up under `SET LOCAL
 * lock_timeout` (SQLSTATE 55P03). Prisma reports a raw query that fails this
 * way as P2010 with `meta.code: "55P03"` (checked against PostgreSQL 16); an
 * interactive transaction may instead surface it as P2034, a non-raw query as
 * a `PrismaClientUnknownRequestError` naming it only in the message, or a
 * plain error carrying the SQLSTATE, so each shape is accepted. Nothing was written when
 * this is true, so the caller can report "busy, try again".
 */
export function isLockTimeoutError(error: unknown): boolean {
  // A lock wait inside a non-raw query surfaces with no code or meta; the
  // SQLSTATE appears only in its message.
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return error.message.includes(lockNotAvailable);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as { code?: unknown } | undefined;
    if (meta?.code === lockNotAvailable) return true;
    return (error.code === "P2010" || error.code === "P2034") && error.message.includes(lockNotAvailable);
  }
  if (error && typeof error === "object" && "code" in error) return (error as { code: unknown }).code === lockNotAvailable;
  return false;
}

/** PostgreSQL `serialization_failure` and `deadlock_detected`: the transaction lost a conflict, wrote nothing, and can simply be retried. */
const serializationFailure = "40001";
const deadlockDetected = "40P01";

function carriesSqlState(error: Error, state: string) {
  // Prisma words a raw query failure "Code: `40001`"; other paths may say "SQLSTATE 40001".
  return new RegExp(`(?:SQLSTATE\\s*|code:\\s*[\`"]?)${state}\\b`, "i").test(error.message);
}

function hasSqlState(error: unknown, state: string): boolean {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return carriesSqlState(error, state);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as { code?: unknown } | undefined;
    if (meta?.code === state) return true;
    return error.code === "P2010" && carriesSqlState(error, state);
  }
  if (error && typeof error === "object" && "code" in error) return (error as { code: unknown }).code === state;
  return false;
}

/**
 * Whether `error` is a deadlock (SQLSTATE 40P01). Two transactions took the
 * same rows in opposite orders (a location's row lock, #413) and PostgreSQL
 * ended one of them. Prisma reports a raw query that fails this way as P2010
 * with `meta.code: "40P01"`.
 */
export function isDeadlockError(error: unknown): boolean {
  return hasSqlState(error, deadlockDetected);
}

/**
 * Whether `error` is a conflict a retry resolves: a serialization failure
 * (SQLSTATE 40001) or a deadlock (40P01). Prisma reports the ones from its own
 * queries as P2034, but a raw query reports them as P2010 with the SQLSTATE in
 * `meta.code`. Nothing was written, so a retry sees the winner's changes.
 */
export function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") return true;
  return hasSqlState(error, serializationFailure) || hasSqlState(error, deadlockDetected);
}

/**
 * A short, jittered pause before retrying a transaction that lost a conflict.
 * Two transactions that deadlocked and retry at once would collide again; the
 * jitter pulls them apart.
 */
export function pauseBeforeRetry(attempt: number): Promise<void> {
  const milliseconds = 20 * (attempt + 1) + Math.floor(Math.random() * 60);
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
