import "server-only";

import type { Prisma } from "@prisma/client";

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
 */
export async function lockClubFormTemplateForWrite(tx: Prisma.TransactionClient, templateId: string) {
  await tx.$queryRaw`SELECT "id" FROM "ClubFormTemplate" WHERE "id" = ${templateId} FOR SHARE`;
  return readLockedKeys(tx, templateId);
}

export async function lockClubFormTemplateForReseal(tx: Prisma.TransactionClient, templateId: string) {
  await tx.$queryRaw`SELECT "id" FROM "ClubFormTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
  return readLockedKeys(tx, templateId);
}

async function readLockedKeys(tx: Prisma.TransactionClient, templateId: string) {
  const row = await tx.clubFormTemplate.findUnique({
    where: { id: templateId },
    select: { version: true, sensitiveFieldKeys: true, birthDateFieldKeys: true },
  });
  if (!row) throw new Error("Club form template disappeared during a write.");
  return row;
}
