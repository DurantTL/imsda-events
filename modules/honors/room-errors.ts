import { Prisma } from "@prisma/client";
import { isSerializationFailure } from "@/lib/prisma-errors";

export { isSerializationFailure };

/**
 * The database's own refusal of a class over its room's seats (#834): the trigger raises a check_violation
 * (SQLSTATE 23514). Prisma reports it as a P2010 raw error, a P2004, or a `PrismaClientUnknownRequestError` that
 * names the SQLSTATE or the trigger's text only in its message, so every shape is accepted.
 */
export function isRoomCapacityRefusal(error: unknown): boolean {
  const prismaError = error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError;
  if (!prismaError) return false;
  return error.message.includes("23514") || /room capacity|below a class placed in it/.test(error.message);
}

/** A unique-index refusal (P2002) on the one-active-class-per-room-and-session index. */
export function isRoomBookedIndex(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") return false;
  return /HonorOffering_roomId_sessionId_active_key/.test(`${error.message} ${JSON.stringify(error.meta ?? {})}`);
}
