import "server-only";

import type { Prisma } from "@prisma/client";
import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";
import { healthRecordsEnabled } from "@/modules/health-records/flag";

/**
 * The email that carries a Health Record private link (#611), built the way
 * the club form link email is (#610): the body holds a sentinel and never a
 * token, the token is minted at delivery and only its SHA-256 is stored, and
 * a definitive delivery failure retires the link. The body names the club and
 * the expiry, and nothing about the child or their health.
 */

export const HEALTH_RECORD_LINK_SENTINEL = "{{health_record_link}}";
export const HEALTH_RECORD_LINK_TEMPLATE_KEY = "HEALTH_RECORD_LINK";

export function healthRecordLinkPath(token: string) {
  return `/health-records/${encodeURIComponent(token)}`;
}

export function healthRecordLinkEmailContent(input: { clubName: string; days: number; expiresOn: string }) {
  return {
    subject: `A health record form from ${input.clubName}`,
    bodyText: [
      "Hello,",
      "",
      `${input.clubName} has asked you to fill in a Pathfinder Health Record.`,
      "",
      "Open your private link:",
      "",
      HEALTH_RECORD_LINK_SENTINEL,
      "",
      `The link works once and expires in ${input.days} day${input.days === 1 ? "" : "s"} (on ${input.expiresOn}). After you submit the form it stops working.`,
      "",
      "Please don't forward this email: anyone who has the link can fill in the form. If you weren't expecting it, you can ignore it. Nothing happens unless you fill the form in.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

/** Withdraws the link a message carried when that message finally fails. A message with no link matches nothing. */
export async function retireHealthRecordLinkForMessage(
  client: Pick<Prisma.TransactionClient, "healthRecordLink">,
  messageId: string,
  now: Date,
) {
  const retired = await client.healthRecordLink.updateMany({
    where: { messageId, status: "OPEN" },
    data: { status: "REVOKED", revokedAt: now, tokenHash: null },
  });
  return retired.count;
}

/** Delivery-time preparation: mints the token, stores only its hash, and swaps the sentinel for the URL. */
export async function prepareHealthRecordLinkBodyForDelivery(input: { messageId: string; bodyText: string; now: Date }) {
  if (!input.bodyText.includes(HEALTH_RECORD_LINK_SENTINEL)) return { bodyText: input.bodyText };
  const prisma = getPrisma();
  // Switched off after the link was queued: retire it and fail the message. No token is minted.
  if (!healthRecordsEnabled()) {
    await prisma.healthRecordLink.updateMany({
      where: { messageId: input.messageId, status: "OPEN" },
      data: { status: "REVOKED", revokedAt: input.now, tokenHash: null },
    });
    throw new Error("A health record link can't be delivered: health records are switched off.");
  }
  const link = await prisma.healthRecordLink.findUnique({
    where: { messageId: input.messageId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!link || link.status !== "OPEN" || link.expiresAt <= input.now) {
    throw new Error("A health record link can't be delivered: it was withdrawn, used or has expired.");
  }
  const token = createOpaqueToken();
  const guarded = await prisma.healthRecordLink.updateMany({
    where: { id: link.id, status: "OPEN", expiresAt: { gt: input.now } },
    data: { tokenHash: hashOpaqueToken(token) },
  });
  if (guarded.count === 0) throw new Error("A health record link can't be delivered: it was withdrawn, used or has expired.");
  const url = new URL(healthRecordLinkPath(token), getServerEnv().APP_BASE_URL).toString();
  return {
    bodyText: input.bodyText.replaceAll(HEALTH_RECORD_LINK_SENTINEL, url),
    revokeOnDefinitiveFailure: async () => {
      await prisma.healthRecordLink.updateMany({
        where: { id: link.id, status: "OPEN" },
        data: { status: "REVOKED", revokedAt: input.now, tokenHash: null },
      });
    },
  };
}
