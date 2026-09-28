import { Prisma } from "@prisma/client";

/** PostgreSQL `lock_not_available`: a `lock_timeout` or `NOWAIT` lock gave up. */
const lockNotAvailable = "55P03";

/**
 * Whether `error` is a row-lock wait that gave up under `SET LOCAL
 * lock_timeout` (SQLSTATE 55P03). Prisma reports a raw query that fails this
 * way as P2010 with `meta.code: "55P03"` (checked against PostgreSQL 16); an
 * interactive transaction may instead surface it as P2034, or as a plain error
 * carrying the SQLSTATE, so each shape is accepted. Nothing was written when
 * this is true, so the caller can report "busy, try again".
 */
export function isLockTimeoutError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = error.meta as { code?: unknown } | undefined;
    if (meta?.code === lockNotAvailable) return true;
    return (error.code === "P2010" || error.code === "P2034") && error.message.includes(lockNotAvailable);
  }
  if (error && typeof error === "object" && "code" in error) return (error as { code: unknown }).code === lockNotAvailable;
  return false;
}
