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

/** PostgreSQL `serialization_failure`: a SERIALIZABLE transaction lost a conflict and can simply be retried. */
const serializationFailure = "40001";

/**
 * Whether `error` is a serialization failure (SQLSTATE 40001). Prisma reports
 * the ones from its own queries as P2034, but a raw query, such as the row
 * lock a location takes (#413), reports it as P2010 with `meta.code: "40001"`.
 * Nothing was written, so a retry sees the winner's changes.
 */
export function isSerializationFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) return error.message.includes(serializationFailure);
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2034") return true;
    const meta = error.meta as { code?: unknown } | undefined;
    if (meta?.code === serializationFailure) return true;
    return error.code === "P2010" && error.message.includes(serializationFailure);
  }
  if (error && typeof error === "object" && "code" in error) return (error as { code: unknown }).code === serializationFailure;
  return false;
}
