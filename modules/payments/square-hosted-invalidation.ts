import "server-only";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { logError, logWarn } from "@/lib/logger";
import {
  getSquareConfiguration,
  type SquareRuntimeConfiguration,
} from "@/modules/payments/square-config";
import { SquareAdapterError } from "@/modules/payments/square-http";
import { deleteSquarePaymentLink } from "@/modules/payments/square-payment-link-adapter";
import {
  hostedPaymentStaleReason,
  registrationBalanceCents,
} from "@/modules/payments/square-domain";

/**
 * Withdrawing hosted "Pay on Square" links (#327).
 *
 * Two halves, deliberately apart. Marking a link withdrawn happens inside the transaction that made
 * it stale (another payment recorded, the choice or balance changed), so no later webhook can find
 * it still ACTIVE. Telling Square happens after commit and can fail: it is retried from the stored
 * `INVALIDATED` + no `providerDeletedAt` state by the next flush or sweep, so a Square outage never
 * blocks a payment from being recorded. A link Square failed to delete is still safe, because a
 * payment through it is judged against the live balance when its webhook arrives
 * (`hostedPaymentStaleReason`), not against the link's status.
 */

export type HostedInvalidationReason =
  | "ANOTHER_PAYMENT_RECORDED"
  | "EMBEDDED_ATTEMPT_STARTED"
  | "BALANCE_CHANGED"
  | "REGISTRATION_NOT_PAYABLE"
  | "SUPERSEDED_BY_NEW_LINK"
  | "SETTING_OFF"
  | "EXPIRED";

/**
 * Marks the registration's open hosted links withdrawn, and cancels their payment attempts, in the
 * caller's transaction. Returns how many were withdrawn. Nothing is sent to Square here.
 */
export async function invalidateHostedCheckoutsInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    registrationId: string;
    reason: HostedInvalidationReason;
    now: Date;
    exceptPaymentAttemptId?: string;
    /** Withdraw only this link, not every open link of the registration. */
    hostedCheckoutId?: string;
  },
) {
  const open = await tx.squareHostedCheckout.findMany({
    where: {
      registrationId: input.registrationId,
      status: { in: ["CREATING", "ACTIVE"] },
      // A link with a payment already in flight is left alone: cancelling its order mid-payment
      // would only strand the money. Its result is judged against the live balance instead.
      paymentAttempt: { is: { providerPaymentId: null } },
      ...(input.hostedCheckoutId ? { id: input.hostedCheckoutId } : {}),
      ...(input.exceptPaymentAttemptId
        ? { paymentAttemptId: { not: input.exceptPaymentAttemptId } }
        : {}),
    },
    select: {
      id: true,
      eventId: true,
      paymentAttemptId: true,
      registration: { select: { confirmationCode: true } },
    },
  });
  for (const checkout of open) {
    // Attempt first, then its link: the same order a payment webhook takes, so the two cannot
    // deadlock on each other.
    await tx.paymentAttempt.updateMany({
      where: {
        id: checkout.paymentAttemptId,
        status: { in: ["PROCESSING", "PENDING"] },
        providerPaymentId: null,
      },
      data: {
        status: "CANCELED",
        activeRegistrationKey: null,
        failureCode: "HOSTED_LINK_INVALIDATED",
        failureMessage: "The Pay on Square link was withdrawn.",
        completedAt: input.now,
      },
    });
    await tx.squareHostedCheckout.update({
      where: { id: checkout.id },
      data: {
        status: "INVALIDATED",
        invalidationReason: input.reason,
        invalidatedAt: input.now,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId: checkout.eventId,
        action: "SQUARE_HOSTED_LINK_INVALIDATED",
        entityType: "PaymentAttempt",
        entityId: checkout.paymentAttemptId,
        correlationId: randomUUID(),
        summary: `Withdrew the Pay on Square link for registration ${checkout.registration.confirmationCode}.`,
        metadata: { reason: input.reason, hostedCheckoutId: checkout.id },
      },
    });
  }
  return open.length;
}

/**
 * Deletes withdrawn links at Square once the response has gone out (`after`), so a request never
 * waits on Square. Outside a request (the sweep, a script, a test) there is no response to wait
 * behind, so it simply runs to completion. Either way it never throws.
 */
export async function flushHostedDeletionsAfterResponse(
  options: Parameters<typeof flushHostedProviderDeletions>[0] = {},
) {
  try {
    after(() => flushHostedProviderDeletions(options));
  } catch {
    await flushHostedProviderDeletions(options);
  }
}

export type HostedProviderDeletion = (
  configuration: SquareRuntimeConfiguration,
  paymentLinkId: string,
) => Promise<{ alreadyGone: boolean; cancelledOrderId: string | null }>;

/**
 * Tells Square to delete every withdrawn link it has not yet been told about (optionally for one
 * registration). Never throws: a failure is stored and retried by the next call.
 */
export async function flushHostedProviderDeletions(
  options: {
    registrationId?: string;
    configuration?: SquareRuntimeConfiguration;
    deleteLink?: HostedProviderDeletion;
    now?: Date;
  } = {},
) {
  try {
    const configuration = options.configuration ?? getSquareConfiguration();
    if (!configuration.paymentConfigured) return { deleted: 0, failed: 0 };
    const prisma = getPrisma();
    const pending = await prisma.squareHostedCheckout.findMany({
      where: {
        status: "INVALIDATED",
        providerDeletedAt: null,
        providerPaymentLinkId: { not: null },
        environment: configuration.environment,
        ...(options.registrationId
          ? { registrationId: options.registrationId }
          : {}),
      },
      select: { id: true, providerPaymentLinkId: true },
      take: 50,
    });
    let deleted = 0;
    let failed = 0;
    for (const checkout of pending) {
      try {
        await (options.deleteLink ?? deleteSquarePaymentLink)(
          configuration,
          checkout.providerPaymentLinkId!,
        );
        await prisma.squareHostedCheckout.update({
          where: { id: checkout.id },
          data: {
            providerDeletedAt: options.now ?? new Date(),
            providerDeleteError: null,
          },
        });
        deleted += 1;
      } catch (error) {
        failed += 1;
        logWarn("A withdrawn Pay on Square link could not be deleted at Square; the sweep will retry.", {
          hostedCheckoutId: checkout.id,
          code: error instanceof SquareAdapterError ? error.code : "UNKNOWN",
        });
        const message = error instanceof SquareAdapterError
          ? error.message
          : "The payment link could not be deleted.";
        await prisma.squareHostedCheckout.update({
          where: { id: checkout.id },
          data: { providerDeleteError: message.slice(0, 500) },
        }).catch(() => undefined);
      }
    }
    return { deleted, failed };
  } catch (error) {
    logError("Flushing withdrawn Square payment links failed.", error);
    return { deleted: 0, failed: 0 };
  }
}

/**
 * Housekeeping for hosted links, run from `npm run payments:hosted-sweep`:
 * - links past their lifetime are withdrawn (Square has no expiry of its own);
 * - links whose registration is no longer payable, or whose balance has fallen below the quote
 *   (a cancellation, a staff-recorded payment, an adjustment), are withdrawn;
 * - withdrawn links Square has not yet been told about are deleted.
 */
export async function sweepHostedCheckouts(
  options: {
    now?: Date;
    configuration?: SquareRuntimeConfiguration;
    deleteLink?: HostedProviderDeletion;
  } = {},
) {
  const now = options.now ?? new Date();
  const prisma = getPrisma();
  const open = await prisma.squareHostedCheckout.findMany({
    where: { status: { in: ["CREATING", "ACTIVE"] } },
    select: {
      id: true,
      registrationId: true,
      expiresAt: true,
      paymentAttempt: { select: { amountCents: true, surchargeCents: true } },
      registration: {
        select: {
          status: true,
          totalAmount: true,
          event: { select: { hostedPaymentLinkEnabled: true, billingMode: true } },
          payments: {
            where: { status: "SUCCEEDED" },
            select: {
              amount: true,
              refunds: {
                where: { status: "SUCCEEDED" },
                select: { amount: true },
              },
            },
          },
        },
      },
    },
    take: 500,
  });
  let withdrawn = 0;
  for (const checkout of open) {
    const offered = checkout.registration.event.hostedPaymentLinkEnabled
      && checkout.registration.event.billingMode !== "DEFERRED_ORGANIZATION_INVOICE";
    const reason: HostedInvalidationReason | null = checkout.expiresAt <= now
      ? "EXPIRED"
      : !offered
        ? "SETTING_OFF"
        : (() => {
          const stale = hostedPaymentStaleReason({
            registrationStatus: checkout.registration.status,
            balanceCents: registrationBalanceCents(checkout.registration),
            quotedBalanceCents: checkout.paymentAttempt.amountCents
              - checkout.paymentAttempt.surchargeCents,
          });
          if (!stale) return null;
          return stale === "REGISTRATION_NOT_PAYABLE"
            ? "REGISTRATION_NOT_PAYABLE"
            : "BALANCE_CHANGED";
        })();
    if (!reason) continue;
    withdrawn += await getPrisma().$transaction((tx) => (
      invalidateHostedCheckoutsInTransaction(tx, {
        registrationId: checkout.registrationId,
        hostedCheckoutId: checkout.id,
        reason,
        now,
      })
    ));
  }
  const flushed = await flushHostedProviderDeletions({
    configuration: options.configuration,
    deleteLink: options.deleteLink,
    now,
  });
  return { withdrawn, ...flushed };
}
