import "server-only";

import type { Prisma } from "@prisma/client";
import { isSecretEncryptionConfigured } from "@/lib/secret-box";
import { ClubFormError } from "@/modules/club-forms/errors";
import { lockClubFormTemplateForReseal } from "@/modules/club-forms/template-lock";
import { openSensitiveAnswers, sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";

/**
 * Re-sealing (#610). A template's `sensitiveFieldKeys` decide which answers
 * are sealed at write time, so a template version that makes a field newly
 * sensitive would leave every existing submission holding that answer in the
 * plain `answers` column. `syncClubFormTemplates` therefore refuses to apply
 * such a change on its own and runs this, in the same transaction as the
 * template update, moving the answer into the sealed value of every existing
 * submission. Nothing else calls it.
 */
export async function resealClubFormSubmissions(
  tx: Prisma.TransactionClient,
  templateId: string,
  newlySensitiveKeys: readonly string[],
) {
  if (newlySensitiveKeys.length === 0) return 0;
  // Waits for in-flight saves (which hold FOR SHARE) and holds off new ones until this transaction commits.
  await lockClubFormTemplateForReseal(tx, templateId);
  const moving = new Set(newlySensitiveKeys);
  let resealed = 0;
  let cursor: string | undefined;
  for (;;) {
    const batch = await tx.clubFormSubmission.findMany({
      where: { templateId },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      select: { id: true, answers: true, sealedSensitiveAnswers: true },
    });
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1].id;
    for (const row of batch) {
      const plain = { ...(row.answers as Record<string, unknown>) };
      const toMove = Object.keys(plain).filter((key) => moving.has(key));
      if (toMove.length === 0) continue;
      if (!isSecretEncryptionConfigured()) {
        throw new ClubFormError("ENCRYPTION_NOT_CONFIGURED", "Encryption isn't set up, so existing forms can't be re-sealed.");
      }
      const sealed = row.sealedSensitiveAnswers ? openSensitiveAnswers(row.id, row.sealedSensitiveAnswers) : {};
      for (const key of toMove) {
        sealed[key] = plain[key];
        delete plain[key];
      }
      await tx.clubFormSubmission.update({
        where: { id: row.id },
        data: {
          answers: plain as Prisma.InputJsonValue,
          sealedSensitiveAnswers: sealSensitiveAnswers(row.id, sealed),
          hasSensitiveAnswers: true,
        },
      });
      resealed += 1;
    }
  }
  return resealed;
}
