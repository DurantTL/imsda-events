import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { authorizeRegistrationAccessToken } from "@/modules/public-access/repository";
import {
  getSquareConfiguration,
  type SquareRuntimeConfiguration,
} from "@/modules/payments/square-config";
import { SquareAdapterError } from "@/modules/payments/square-http";
import {
  createSquarePaymentLink,
  type SquarePaymentLinkResult,
} from "@/modules/payments/square-payment-link-adapter";
import {
  flushHostedProviderDeletions,
  invalidateHostedCheckoutsInTransaction,
} from "@/modules/payments/square-hosted-invalidation";
import {
  checkoutFromRegistration,
  loadCheckoutRegistration,
  runSerializable,
  SquarePaymentOperationError,
  type PaymentAccess,
  type PaymentAuthorization,
} from "@/modules/payments/square-repository";
import {
  hostedLinkLifetimeMs,
  providerHostedLinkIdempotencyKey,
  type SquareHostedLinkView,
  type SquarePaymentLinkInput,
} from "@/modules/payments/square-domain";

/**
 * "Pay on Square" (#327): a hosted Square checkout page as a second way to pay the same balance.
 *
 * What a link is. A link is a normal `PaymentAttempt` (channel HOSTED_LINK) plus a
 * `SquareHostedCheckout` mapping it to Square's order. The attempt owns the amount and surcharge,
 * quoted once at creation by the same `checkoutFromRegistration` the embedded form uses, so the fee
 * policy is the Pay Later to Pay Now one (#317) and nothing here restates it. The surcharge joins
 * the registration total only when the payment is recorded from Square's webhook, never when the
 * link is made and never twice on replay.
 *
 * What proves payment. Only the verified webhook (`processSquareWebhook`). The redirect back to the
 * registrant's private page is a courtesy and is never read as proof.
 */

type LinkAttempt = Prisma.PaymentAttemptGetPayload<{
  include: {
    registration: { select: { confirmationCode: true } };
    hostedCheckout: true;
  };
}>;

const linkAttemptInclude = {
  registration: { select: { confirmationCode: true } },
  hostedCheckout: true,
} satisfies Prisma.PaymentAttemptInclude;

type PreparedLink =
  | { operation: "RETURN_EXISTING"; attempt: LinkAttempt }
  | { operation: "CALL_PROVIDER"; attempt: LinkAttempt }
  | { operation: "UNAVAILABLE"; code: "PAYMENT_ATTEMPT_FAILED"; message: string };

type LinkOptions = {
  now?: Date;
  configuration?: SquareRuntimeConfiguration;
  createLink?: typeof createSquarePaymentLink;
  appBaseUrl?: string;
};

function quoteMatches(
  attempt: { amountCents: number; surchargeCents: number },
  checkout: { amountCents: number; surchargeCents: number },
) {
  return attempt.amountCents === checkout.amountCents
    && attempt.surchargeCents === checkout.surchargeCents;
}

function viewFromAttempt(attempt: LinkAttempt): SquareHostedLinkView {
  const hosted = attempt.hostedCheckout!;
  return {
    url: hosted.checkoutUrl!,
    amountCents: attempt.amountCents,
    balanceCents: attempt.amountCents - attempt.surchargeCents,
    surchargeCents: attempt.surchargeCents,
    currency: "USD",
    expiresAt: hosted.expiresAt.toISOString(),
  };
}

async function prepareHostedLink(
  tx: Prisma.TransactionClient,
  authorization: PaymentAuthorization,
  input: SquarePaymentLinkInput,
  configuration: SquareRuntimeConfiguration,
  now: Date,
): Promise<PreparedLink> {
  const access = authorization.kind === "private-link"
    ? await authorizeRegistrationAccessToken(authorization.token, {
        now,
        client: tx,
      })
    : authorization.access;
  if (!access) {
    throw new SquarePaymentOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active.",
    );
  }
  const registration = await loadCheckoutRegistration(tx, access.registrationId);
  if (!registration || registration.eventId !== access.eventId) {
    throw new SquarePaymentOperationError(
      "REGISTRATION_ACCESS_UNAVAILABLE",
      "This private registration link is invalid or no longer active.",
    );
  }
  const checkout = checkoutFromRegistration(registration, configuration);

  const existing = await tx.paymentAttempt.findUnique({
    where: { clientIdempotencyKey: input.idempotencyKey },
    include: linkAttemptInclude,
  });
  if (existing) {
    if (
      existing.registrationId !== access.registrationId
      || existing.registrationAccessTokenId !== access.accessTokenId
      || existing.environment !== configuration.environment
      || existing.channel !== "HOSTED_LINK"
      || !existing.hostedCheckout
    ) {
      throw new SquarePaymentOperationError(
        "PAYMENT_IDEMPOTENCY_CONFLICT",
        "That payment request key belongs to a different operation.",
      );
    }
    const hosted = existing.hostedCheckout;
    if (hosted.status === "PAID") {
      return {
        operation: "UNAVAILABLE",
        code: "PAYMENT_ATTEMPT_FAILED",
        message: "A payment was already made through that link. Reload the page to see its status.",
      };
    }
    if (hosted.status === "INVALIDATED" || hosted.status === "FAILED") {
      return {
        operation: "UNAVAILABLE",
        code: "PAYMENT_ATTEMPT_FAILED",
        message: "That Pay on Square link is no longer valid. Request a new one.",
      };
    }
    // Still open: replay it only while it is unexpired and still the amount owed.
    if (
      hosted.expiresAt <= now
      || checkout.state !== "READY"
      || !quoteMatches(existing, checkout)
    ) {
      await invalidateHostedCheckoutsInTransaction(tx, {
        registrationId: registration.id,
        hostedCheckoutId: hosted.id,
        reason: hosted.expiresAt <= now ? "EXPIRED" : "BALANCE_CHANGED",
        now,
      });
      return {
        operation: "UNAVAILABLE",
        code: "PAYMENT_ATTEMPT_FAILED",
        message: "The amount due changed, so that link was withdrawn. Request a new one.",
      };
    }
    return {
      operation: hosted.status === "ACTIVE" && hosted.checkoutUrl
        ? "RETURN_EXISTING"
        : "CALL_PROVIDER",
      attempt: existing,
    };
  }

  if (checkout.state !== "READY") {
    if (checkout.state === "NO_BALANCE") {
      throw new SquarePaymentOperationError("PAYMENT_ALREADY_COMPLETE", checkout.message);
    }
    if (checkout.state === "NOT_CONFIGURED") {
      throw new SquarePaymentOperationError("SQUARE_NOT_CONFIGURED", checkout.message);
    }
    if (checkout.state === "CHOICE_REQUIRED" || checkout.state === "FORM_UNAVAILABLE") {
      throw new SquarePaymentOperationError("CARD_PAYMENT_NOT_SELECTED", checkout.message);
    }
    throw new SquarePaymentOperationError("PAYMENT_NOT_ELIGIBLE", checkout.message);
  }
  if (!checkout.hostedLink) {
    throw new SquarePaymentOperationError(
      "PAYMENT_NOT_ELIGIBLE",
      "Pay on Square is not offered for this event.",
    );
  }

  // One payment in flight at a time, whichever way it was started.
  const active = await tx.paymentAttempt.findUnique({
    where: { activeRegistrationKey: registration.id },
    select: { id: true, status: true },
  });
  if (active) {
    throw new SquarePaymentOperationError(
      "PAYMENT_IN_PROGRESS",
      "A payment is already being confirmed for this registration. Wait for that result before trying again.",
      true,
      { attemptStatus: active.status },
    );
  }

  // The same balance gets the same link, whoever asks and however many times: reuse an open link
  // whose quote is still the amount owed instead of minting a second order for it.
  const open = await tx.paymentAttempt.findMany({
    where: {
      registrationId: registration.id,
      channel: "HOSTED_LINK",
      environment: configuration.environment,
      hostedCheckout: {
        is: { status: { in: ["CREATING", "ACTIVE"] }, expiresAt: { gt: now } },
      },
    },
    include: linkAttemptInclude,
    orderBy: { createdAt: "desc" },
  });
  const reusable = open.find((attempt) => quoteMatches(attempt, checkout));
  if (reusable) {
    // Reuse is bounded to the same registrant: a link made for another access path stays theirs.
    if (reusable.registrationAccessTokenId === access.accessTokenId) {
      return {
        operation: reusable.hostedCheckout!.status === "ACTIVE"
          && reusable.hostedCheckout!.checkoutUrl
          ? "RETURN_EXISTING"
          : "CALL_PROVIDER",
        attempt: reusable,
      };
    }
  }
  await invalidateHostedCheckoutsInTransaction(tx, {
    registrationId: registration.id,
    reason: "SUPERSEDED_BY_NEW_LINK",
    now,
  });

  const attempt = await tx.paymentAttempt.create({
    data: {
      eventId: registration.eventId,
      registrationId: registration.id,
      registrationAccessTokenId: access.accessTokenId,
      provider: "SQUARE",
      environment: configuration.environment,
      channel: "HOSTED_LINK",
      clientIdempotencyKey: input.idempotencyKey,
      providerIdempotencyKey: providerHostedLinkIdempotencyKey(
        registration.id,
        input.idempotencyKey,
      ),
      // No activeRegistrationKey: an unpaid link is an offer, not a payment in flight. The webhook
      // takes the slot only when a payment through the link is actually pending.
      amountCents: checkout.amountCents,
      surchargeCents: checkout.surchargeCents,
      currency: "USD",
      status: "PROCESSING",
      requestCount: 1,
      lastRequestedAt: now,
      hostedCheckout: {
        create: {
          eventId: registration.eventId,
          registrationId: registration.id,
          environment: configuration.environment,
          status: "CREATING",
          expiresAt: new Date(now.getTime() + hostedLinkLifetimeMs),
        },
      },
    },
    include: linkAttemptInclude,
  });
  await tx.auditLog.create({
    data: {
      eventId: registration.eventId,
      action: "SQUARE_HOSTED_LINK_REQUESTED",
      entityType: "PaymentAttempt",
      entityId: attempt.id,
      correlationId: randomUUID(),
      summary: `Requested a Pay on Square link for registration ${registration.confirmationCode}.`,
      metadata: {
        provider: "SQUARE",
        environment: configuration.environment,
        amountCents: checkout.amountCents,
        balanceCents: checkout.balanceCents,
        surchargeCents: checkout.surchargeCents,
        currency: "USD",
        registrationAccessTokenId: access.accessTokenId,
      },
    },
  });
  return { operation: "CALL_PROVIDER", attempt };
}

function redirectUrlFor(
  authorization: PaymentAuthorization,
  appBaseUrl: string,
) {
  // The registrant lands back on the page they started from. This carries their private token to
  // Square, a processor they are already paying; the page never treats arriving here as payment.
  const path = authorization.kind === "private-link"
    ? `/manage/${encodeURIComponent(authorization.token)}`
    : "/account/registrations";
  const url = new URL(path, appBaseUrl);
  url.searchParams.set("pay", "square");
  return url.toString();
}

async function storeCreatedLink(
  attemptId: string,
  link: SquarePaymentLinkResult,
) {
  return runSerializable(async (tx) => {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: linkAttemptInclude,
    });
    const hosted = attempt?.hostedCheckout;
    if (!attempt || !hosted) {
      throw new SquarePaymentOperationError(
        "PAYMENT_OPERATION_CONFLICT",
        "The durable payment attempt could not be reloaded.",
        true,
      );
    }
    // A link withdrawn while Square was creating it still has to be remembered, so it can be deleted.
    const updated = await tx.squareHostedCheckout.update({
      where: { id: hosted.id },
      data: {
        providerPaymentLinkId: link.id,
        providerOrderId: link.orderId,
        checkoutUrl: link.url,
        ...(hosted.status === "CREATING" ? { status: "ACTIVE" as const } : {}),
      },
    });
    if (hosted.status === "CREATING") {
      await tx.auditLog.create({
        data: {
          eventId: attempt.eventId,
          action: "SQUARE_HOSTED_LINK_CREATED",
          entityType: "PaymentAttempt",
          entityId: attempt.id,
          correlationId: randomUUID(),
          summary: `Square created the Pay on Square link for registration ${attempt.registration.confirmationCode}.`,
          metadata: {
            provider: "SQUARE",
            environment: attempt.environment,
            providerPaymentLinkId: link.id,
            providerOrderId: link.orderId,
            amountCents: attempt.amountCents,
            surchargeCents: attempt.surchargeCents,
          },
        },
      });
    }
    return { ...attempt, hostedCheckout: updated } satisfies LinkAttempt;
  });
}

async function recordLinkFailure(
  attemptId: string,
  error: SquareAdapterError,
  now: Date,
) {
  return runSerializable(async (tx) => {
    const attempt = await tx.paymentAttempt.findUnique({
      where: { id: attemptId },
      include: linkAttemptInclude,
    });
    if (!attempt || !attempt.hostedCheckout) return;
    await tx.auditLog.create({
      data: {
        eventId: attempt.eventId,
        action: error.retryable
          ? "SQUARE_HOSTED_LINK_REQUEST_UNCERTAIN"
          : "SQUARE_HOSTED_LINK_FAILED",
        entityType: "PaymentAttempt",
        entityId: attempt.id,
        correlationId: randomUUID(),
        summary: error.retryable
          ? `Square did not confirm the Pay on Square link for registration ${attempt.registration.confirmationCode}.`
          : `Square rejected the Pay on Square link for registration ${attempt.registration.confirmationCode}.`,
        metadata: {
          provider: "SQUARE",
          environment: attempt.environment,
          providerCode: error.providerCode,
          retryable: error.retryable,
        },
      },
    });
    if (error.retryable) return;
    await tx.squareHostedCheckout.update({
      where: { id: attempt.hostedCheckout.id },
      data: { status: "FAILED", invalidatedAt: now, invalidationReason: "PROVIDER_REJECTED" },
    });
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: {
        status: "FAILED",
        failureCode: error.providerCode ?? error.code,
        failureMessage: error.message.slice(0, 500),
        completedAt: now,
      },
    });
  });
}

async function createHostedLinkWithAuthorization(
  authorization: PaymentAuthorization,
  input: SquarePaymentLinkInput,
  options: LinkOptions = {},
): Promise<SquareHostedLinkView> {
  const now = options.now ?? new Date();
  const configuration = options.configuration ?? getSquareConfiguration();
  if (!configuration.paymentConfigured) {
    throw new SquarePaymentOperationError(
      "SQUARE_NOT_CONFIGURED",
      "Online card payment is not configured for this site.",
    );
  }
  const prepared = await runSerializable((tx) => (
    prepareHostedLink(tx, authorization, input, configuration, now)
  ));
  if (prepared.operation === "UNAVAILABLE") {
    // Anything withdrawn while deciding this is deleted at Square now, not left for the sweep.
    await flushHostedProviderDeletions({ configuration });
    throw new SquarePaymentOperationError(prepared.code, prepared.message);
  }
  // Withdrawn-by-this-request links are deleted without making the registrant wait.
  void flushHostedProviderDeletions({
    registrationId: prepared.attempt.registrationId,
    configuration,
  });
  if (prepared.operation === "RETURN_EXISTING") {
    return viewFromAttempt(prepared.attempt);
  }

  const appBaseUrl = options.appBaseUrl ?? getServerEnv().APP_BASE_URL;
  let link: SquarePaymentLinkResult;
  try {
    link = await (options.createLink ?? createSquarePaymentLink)(configuration, {
      idempotencyKey: prepared.attempt.providerIdempotencyKey,
      amountCents: prepared.attempt.amountCents,
      currency: "USD",
      locationId: configuration.locationId,
      referenceId: prepared.attempt.id,
      itemName: `IMSDA registration ${prepared.attempt.registration.confirmationCode}`,
      paymentNote: `IMSDA registration ${prepared.attempt.registration.confirmationCode}`,
      redirectUrl: redirectUrlFor(authorization, appBaseUrl),
    });
  } catch (error) {
    if (!(error instanceof SquareAdapterError)) throw error;
    await recordLinkFailure(prepared.attempt.id, error, now);
    throw new SquarePaymentOperationError(
      error.retryable ? "PAYMENT_RESULT_UNCERTAIN" : "PAYMENT_ATTEMPT_FAILED",
      error.retryable
        ? "Square did not confirm the payment link. It is safe to try again."
        : "Square could not create the payment link.",
      error.retryable,
    );
  }

  const stored = await storeCreatedLink(prepared.attempt.id, link);
  if (stored.hostedCheckout?.status !== "ACTIVE") {
    await flushHostedProviderDeletions({
      registrationId: stored.registrationId,
      configuration,
    });
    throw new SquarePaymentOperationError(
      "PAYMENT_ATTEMPT_FAILED",
      "The amount due changed while the link was being made, so it was withdrawn. Request a new one.",
    );
  }
  return viewFromAttempt(stored);
}

export function createPublicSquarePaymentLink(
  token: string,
  input: SquarePaymentLinkInput,
  options: LinkOptions = {},
) {
  return createHostedLinkWithAuthorization(
    { kind: "private-link", token },
    input,
    options,
  );
}

export function createAttendeeSquarePaymentLink(
  access: Omit<PaymentAccess, "accessTokenId">,
  input: SquarePaymentLinkInput,
  options: LinkOptions = {},
) {
  return createHostedLinkWithAuthorization(
    { kind: "attendee-account", access: { ...access, accessTokenId: null } },
    input,
    options,
  );
}

/** Used by tests and tooling to read what a registration's links look like. */
export async function listHostedCheckoutsForRegistration(registrationId: string) {
  return getPrisma().squareHostedCheckout.findMany({
    where: { registrationId },
    orderBy: { createdAt: "asc" },
  });
}
