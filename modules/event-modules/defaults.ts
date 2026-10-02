import "server-only";

import type { Prisma } from "@prisma/client";
import { defaultModuleKeys } from "@/modules/event-modules/catalog";

type Tx = Pick<Prisma.TransactionClient, "eventModule">;

/**
 * Writes the starting modules for a new event (#741), from its audience. Called
 * inside each event-creating transaction (create, template, clone without a
 * source row set) so a new event has stored rows from its first moment.
 */
export async function writeDefaultModules(tx: Tx, eventId: string, audience: "GENERAL" | "CLUB") {
  await tx.eventModule.createMany({
    data: defaultModuleKeys(audience).map((moduleKey) => ({ eventId, moduleKey })),
    skipDuplicates: true,
  });
}

/** Copies the source event's module rows to a clone, inside the clone transaction. Data is never copied by this. */
export async function copyEventModules(tx: Tx, sourceEventId: string, targetEventId: string) {
  const rows = await tx.eventModule.findMany({ where: { eventId: sourceEventId }, select: { moduleKey: true } });
  if (rows.length === 0) return 0;
  const created = await tx.eventModule.createMany({
    data: rows.map((row) => ({ eventId: targetEventId, moduleKey: row.moduleKey })),
    skipDuplicates: true,
  });
  return created.count;
}
