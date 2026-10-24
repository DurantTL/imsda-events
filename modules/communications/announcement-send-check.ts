import "server-only";

import type { Prisma } from "@prisma/client";
import type { getPrisma } from "@/lib/prisma";
import { MessagingError } from "@/modules/communications/messaging-error";
import {
  announcementSendCheckInput,
  describeSendCheckErrors,
  runSendCheck,
} from "@/modules/communications/send-check";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/modules/communications/templates";

type Client = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/**
 * The errors-only send check (#836) for the announcement paths that have no review dialog of their own: a scheduled
 * announcement email and "Email selected". It checks the email as it will go out (the published event announcement
 * template around the typed title and text) and refuses with `INVALID_TEMPLATE` and the findings. Warnings and
 * suggestions never stop these; the announcement broadcast review is where a warning is acknowledged.
 */
export async function assertAnnouncementTextSendable(
  client: Client,
  eventId: string,
  announcement: { title: string; body: string },
) {
  const template = await client.eventMessageTemplate.findUnique({
    where: { eventId_key: { eventId, key: "EVENT_ANNOUNCEMENT" } },
    select: {
      versions: {
        where: { status: "PUBLISHED" },
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: { subjectTemplate: true, bodyTemplate: true, preheaderTemplate: true },
      },
    },
  });
  const version = template?.versions[0];
  const fallback = DEFAULT_MESSAGE_TEMPLATES.EVENT_ANNOUNCEMENT;
  const check = runSendCheck(announcementSendCheckInput({
    templateSubject: version?.subjectTemplate ?? fallback.subject,
    templateBody: version?.bodyTemplate ?? fallback.body,
    templatePreheader: version?.preheaderTemplate ?? null,
    announcement,
  }));
  if (check.hasErrors) {
    throw new MessagingError("INVALID_TEMPLATE", `Fix this before sending: ${describeSendCheckErrors(check)}`, {
      findings: check.errors.map((finding) => ({ id: finding.id, code: finding.code, field: finding.field, message: finding.message })),
    });
  }
}
