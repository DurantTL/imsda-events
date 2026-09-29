import "server-only";

import type { Prisma } from "@prisma/client";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { formBusyError, isLockTimeoutError } from "@/modules/club-forms/errors";

/**
 * Row locks on a club form template (#610). The template's sensitive-field
 * keys decide what a writer seals, and a version change re-seals existing
 * submissions. To keep a save from landing plaintext for a field that a
 * concurrent re-seal has just made sensitive:
 *
 * - a writer takes FOR SHARE on the template row inside its own transaction
 *   and re-reads the keys after the lock (many writers can share it);
 * - the re-seal takes FOR UPDATE, so it waits for in-flight writers to
 *   commit, and later writers wait for it and then see the new keys.
 *
 * A writer never waits long: Prisma's transaction timeout does not cancel a
 * query that is blocked on a lock, so a pile of waiting saves could hold the
 * whole connection pool. `lock_timeout` makes the wait itself give up, and the
 * writer answers "being updated, try again" (FORM_BUSY) with nothing written.
 */
export type TemplateForWrite = { id: string; key: string; version: number };

export async function lockClubFormTemplateForWrite(tx: Prisma.TransactionClient, template: TemplateForWrite) {
  let locked;
  try {
    await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
    await tx.$queryRaw`SELECT "id" FROM "ClubFormTemplate" WHERE "id" = ${template.id} FOR SHARE`;
    locked = await readLockedKeys(tx, template.id);
  } catch (error) {
    if (isLockTimeoutError(error)) throw formBusyError();
    throw error;
  }
  // The definition the writer validated against must be the one it seals by.
  if (locked.version !== template.version) throw formBusyError();
  // A deploy that bumped a seed version has not been synced (and re-sealed) yet: nothing is written until it is.
  const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === template.key);
  if (seed && locked.version < seed.version) throw formBusyError();
  return {
    version: locked.version,
    sensitiveFieldKeys: union(locked.sensitiveFieldKeys, seed?.sensitiveFieldKeys),
    birthDateFieldKeys: union(locked.birthDateFieldKeys, seed?.birthDateFieldKeys),
  };
}

export async function lockClubFormTemplateForReseal(tx: Prisma.TransactionClient, templateId: string) {
  await tx.$queryRaw`SELECT "id" FROM "ClubFormTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
  return readLockedKeys(tx, templateId);
}

function union(stored: readonly string[], seed: readonly string[] = []) {
  return [...new Set([...stored, ...seed])];
}

async function readLockedKeys(tx: Prisma.TransactionClient, templateId: string) {
  const row = await tx.clubFormTemplate.findUnique({
    where: { id: templateId },
    select: { version: true, sensitiveFieldKeys: true, birthDateFieldKeys: true },
  });
  if (!row) throw new Error("Club form template disappeared during a write.");
  return row;
}
