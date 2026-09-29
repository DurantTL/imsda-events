import "server-only";

import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";

/**
 * The email that carries a club form's private link (#610). Like account
 * email, its body holds a sentinel and never a token: the token is minted
 * when the message is actually delivered and only its SHA-256 is stored, so a
 * database read, an outbox row, an audit row or a log line never yields a
 * usable link. A definitive delivery failure retires the link again.
 */

export const CLUB_FORM_LINK_SENTINEL = "{{club_form_link}}";
export const CLUB_FORM_LINK_TEMPLATE_KEY = "CLUB_FORM_LINK";

export function clubFormLinkPath(token: string) {
  return `/club-forms/${encodeURIComponent(token)}`;
}

export function clubFormLinkEmailContent(input: { clubName: string; formName: string; days: number; expiresOn: string }) {
  return {
    subject: `A form to fill in for ${input.clubName}`,
    bodyText: [
      "Hello,",
      "",
      `${input.clubName} has asked you to fill in this form: ${input.formName}.`,
      "",
      "Open your private link:",
      "",
      CLUB_FORM_LINK_SENTINEL,
      "",
      `The link works once and expires in ${input.days} day${input.days === 1 ? "" : "s"} (on ${input.expiresOn}). After you submit the form it stops working.`,
      "",
      "Please don't forward this email: anyone who has the link can fill in the form. If you weren't expecting it, you can ignore it. Nothing happens unless you fill the form in.",
      "",
      "IMSDA Events",
    ].join("\n"),
  };
}

/**
 * Delivery-time preparation, called by the outbox worker for a message whose
 * template key is CLUB_FORM_LINK. Mints the token, stores only its hash on the
 * link (replacing any hash from an earlier attempt, so an undelivered link can
 * never be used), and swaps the sentinel for the URL.
 */
export async function prepareClubFormLinkBodyForDelivery(input: {
  messageId: string;
  bodyText: string;
  now: Date;
}) {
  if (!input.bodyText.includes(CLUB_FORM_LINK_SENTINEL)) return { bodyText: input.bodyText };
  const prisma = getPrisma();
  const link = await prisma.clubFormLink.findUnique({
    where: { messageId: input.messageId },
    select: { id: true, status: true, expiresAt: true },
  });
  if (!link || link.status !== "OPEN" || link.expiresAt <= input.now) {
    throw new Error("A club form link can't be delivered: it was withdrawn, used or has expired.");
  }
  const token = createOpaqueToken();
  const guarded = await prisma.clubFormLink.updateMany({
    where: { id: link.id, status: "OPEN", expiresAt: { gt: input.now } },
    data: { tokenHash: hashOpaqueToken(token) },
  });
  if (guarded.count === 0) throw new Error("A club form link can't be delivered: it was withdrawn, used or has expired.");
  const url = new URL(clubFormLinkPath(token), getServerEnv().APP_BASE_URL).toString();
  return {
    bodyText: input.bodyText.replaceAll(CLUB_FORM_LINK_SENTINEL, url),
    revokeOnDefinitiveFailure: async () => {
      await prisma.clubFormLink.updateMany({
        where: { id: link.id, status: "OPEN" },
        data: { status: "REVOKED", revokedAt: input.now, tokenHash: null },
      });
    },
  };
}
