import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { openSecret, sealSecret } from "@/lib/secret-box";
import {
  ATTENDEE_PENDING_REQUEST_LIFETIME_HOURS,
  EMAIL_VERIFICATION_LIFETIME_MINUTES,
  ONE_TIME_CODE_MAX_ATTEMPTS,
  hashOneTimeCode,
  oneTimeCodeMatches,
} from "@/modules/attendee-accounts/codes";

const SECRET_PURPOSE = "attendee-step-up-code";

function requestExpiry(now: Date) {
  return new Date(
    now.getTime() + ATTENDEE_PENDING_REQUEST_LIFETIME_HOURS * 60 * 60 * 1_000,
  );
}

function codeExpiry(now: Date) {
  return new Date(now.getTime() + EMAIL_VERIFICATION_LIFETIME_MINUTES * 60 * 1_000);
}

export async function beginAttendeeEditStepUp(
  accountId: string,
  sessionId: string,
  now = new Date(),
) {
  return getPrisma().$transaction(async (tx) => {
    await tx.attendeeStepUpCode.updateMany({
      where: {
        accountId,
        sessionId,
        purpose: "REGISTRATION_EDIT",
        consumedAt: null,
      },
      data: { consumedAt: now },
    });
    return tx.attendeeStepUpCode.create({
      data: {
        accountId,
        sessionId,
        purpose: "REGISTRATION_EDIT",
        expiresAt: requestExpiry(now),
      },
      select: { id: true, expiresAt: true },
    });
  });
}

export async function bindAttendeeStepUpMessage(
  stepUpCodeId: string,
  messageId: string,
  now = new Date(),
) {
  const bound = await getPrisma().attendeeStepUpCode.updateMany({
    where: {
      id: stepUpCodeId,
      deliveryMessageId: null,
      consumedAt: null,
      expiresAt: { gt: now },
    },
    data: { deliveryMessageId: messageId },
  });
  return bound.count === 1;
}

export async function attachAttendeeStepUpCode(input: {
  accountId: string;
  messageId: string;
  code: string;
  now: Date;
}) {
  const attached = await getPrisma().attendeeStepUpCode.updateMany({
    where: {
      accountId: input.accountId,
      deliveryMessageId: input.messageId,
      codeHash: null,
      consumedAt: null,
      expiresAt: { gt: input.now },
    },
    data: {
      codeHash: hashOneTimeCode(input.code),
      sealedCode: sealSecret(input.code, SECRET_PURPOSE),
      codeExpiresAt: codeExpiry(input.now),
    },
  });
  return attached.count === 1;
}

export async function reuseAttendeeStepUpCode(input: {
  accountId: string;
  messageId: string;
  now: Date;
}) {
  const record = await getPrisma().attendeeStepUpCode.findFirst({
    where: {
      accountId: input.accountId,
      deliveryMessageId: input.messageId,
      consumedAt: null,
      expiresAt: { gt: input.now },
      codeExpiresAt: { gt: input.now },
      sealedCode: { not: null },
    },
    select: { sealedCode: true },
  });
  return record?.sealedCode ? openSecret(record.sealedCode, SECRET_PURPOSE) : null;
}

export async function revokeAttendeeStepUpCode(codeHash: string, now = new Date()) {
  await getPrisma().attendeeStepUpCode.updateMany({
    where: { codeHash, consumedAt: null },
    data: { consumedAt: now },
  });
}

export async function consumeAttendeeEditStepUp(input: {
  accountId: string;
  sessionId: string;
  code: string;
  now?: Date;
  client?: Prisma.TransactionClient;
}) {
  const now = input.now ?? new Date();
  const consume = async (tx: Prisma.TransactionClient) => {
    const record = await tx.attendeeStepUpCode.findFirst({
      where: {
        accountId: input.accountId,
        sessionId: input.sessionId,
        purpose: "REGISTRATION_EDIT",
        consumedAt: null,
        expiresAt: { gt: now },
        codeExpiresAt: { gt: now },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, codeHash: true, attempts: true },
    });
    if (!record || record.attempts >= ONE_TIME_CODE_MAX_ATTEMPTS) return false;
    if (!oneTimeCodeMatches(input.code, record.codeHash)) {
      const attempts = record.attempts + 1;
      await tx.attendeeStepUpCode.update({
        where: { id: record.id },
        data: {
          attempts,
          consumedAt: attempts >= ONE_TIME_CODE_MAX_ATTEMPTS ? now : null,
        },
      });
      return false;
    }
    const consumed = await tx.attendeeStepUpCode.updateMany({
      where: { id: record.id, consumedAt: null, attempts: record.attempts },
      data: { consumedAt: now },
    });
    return consumed.count === 1;
  };
  return input.client
    ? consume(input.client)
    : getPrisma().$transaction(consume);
}
