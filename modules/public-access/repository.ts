import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { createOpaqueToken, hashOpaqueToken } from "@/modules/access/tokens";
import { attendeePassExpiry } from "@/modules/checkin/attendee-pass-token";
import { enqueueRegistrationContactUpdatedMessage } from "@/modules/communications/transactional-messages";
import {
  defaultRegistrationAccessExpiry,
  describePublicRegistrationStatus,
  isRegistrationAccessToken,
  publicAttendeeName,
  publicContactFromSnapshot,
  summarizePublicPayment,
  type PublicContactUpdateInput,
} from "@/modules/public-access/domain";
import {
  formatPublicEventSchedule,
  publicEventWebsiteLinks,
} from "@/modules/events/public-domain";

export { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";

type RegistrationAccessClient = Prisma.TransactionClient | PrismaClient;

const registrationAccessInclude = {
  registration: {
    select: {
      id: true,
      eventId: true,
      confirmationCode: true,
      status: true,
      totalAmount: true,
      contactSnapshot: true,
      submittedAt: true,
      event: {
        select: {
          name: true,
          slug: true,
          startsAt: true,
          endsAt: true,
          timezone: true,
          location: true,
          publicInfoUrl: true,
          supportContact: true,
        },
      },
      accountHolderPerson: {
        select: {
          firstName: true,
          lastName: true,
          normalizedEmail: true,
          phone: true,
        },
      },
      attendees: {
        orderBy: [{ position: "asc" as const }, { createdAt: "asc" as const }],
        select: {
          id: true,
          profileSnapshot: true,
          person: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      payments: {
        where: { status: "SUCCEEDED" as const },
        orderBy: { createdAt: "asc" as const },
        select: {
          amount: true,
          refunds: {
            where: { status: "SUCCEEDED" as const },
            select: { amount: true },
          },
        },
      },
      waitlistEntry: {
        select: {
          position: true,
          status: true,
        },
      },
      publicFormSubmission: {
        select: {
          createdAt: true,
          pricingSnapshot: true,
          formVersion: {
            select: {
              versionNumber: true,
              form: {
                select: {
                  name: true,
                  slug: true,
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.RegistrationAccessTokenInclude;

type RegistrationAccessRecord = Prisma.RegistrationAccessTokenGetPayload<{
  include: typeof registrationAccessInclude;
}>;

export type IssueRegistrationAccessTokenInput = {
  registrationId: string;
  now?: Date;
  expiresAt?: Date;
};

export type IssuedRegistrationAccessToken = {
  token: string;
  tokenRecordId: string;
  managePath: string;
  expiresAt: Date;
};

export class RegistrationAccessIssueError extends Error {
  constructor(
    public readonly code:
      | "REGISTRATION_NOT_FOUND"
      | "INVALID_EXPIRY"
      | "STABLE_TOKEN_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationAccessIssueError";
  }
}

function registrationLinkSigningSecret() {
  const configured = process.env.MANAGE_LINK_DERIVATION_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "MANAGE_LINK_DERIVATION_SECRET must contain at least 32 characters before private links can be delivered.",
    );
  }
  return "imsda-events-local-registration-link-secret-2026";
}

function stableRegistrationAccessTokens(seed: string) {
  const current = registrationLinkSigningSecret();
  const previous = process.env.MANAGE_LINK_DERIVATION_SECRET_PREVIOUS?.trim();
  if (previous && previous.length < 32) {
    throw new Error(
      "MANAGE_LINK_DERIVATION_SECRET_PREVIOUS must contain at least 32 characters when configured.",
    );
  }
  return [...new Set([current, previous].filter((value): value is string => Boolean(value)))]
    .map((secret) => createHmac("sha256", secret)
      .update(`imsda:manage-link:v1:${seed}`)
      .digest("base64url"));
}

function isUniqueConstraintError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === "P2002";
}

function managePath(token: string) {
  return `/manage/${token}`;
}

function issuedAccess(
  token: string,
  tokenRecordId: string,
  expiresAt: Date,
) {
  return {
    token,
    tokenRecordId,
    managePath: managePath(token),
    expiresAt,
  };
}

function stableTokenUnavailable() {
  return new RegistrationAccessIssueError(
    "STABLE_TOKEN_UNAVAILABLE",
    "This delivery requires a new private registration link.",
  );
}

function validateStableExisting(
  existing: {
    id: string;
    registrationId: string;
    purpose: string;
    expiresAt: Date;
    revokedAt: Date | null;
  },
  registrationId: string,
  now: Date,
  token: string,
) {
  if (
    existing.registrationId !== registrationId
    || existing.purpose !== "MANAGE_REGISTRATION"
    || existing.revokedAt
    || existing.expiresAt.getTime() <= now.getTime()
  ) {
    throw stableTokenUnavailable();
  }
  return issuedAccess(token, existing.id, existing.expiresAt);
}

async function findStableExisting(
  client: RegistrationAccessClient,
  registrationId: string,
  token: string,
  now: Date,
) {
  const existing = await client.registrationAccessToken.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    select: {
      id: true,
      registrationId: true,
      purpose: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  return existing
    ? validateStableExisting(existing, registrationId, now, token)
    : null;
}

function moneyToCents(value: { toString(): string } | number) {
  return Math.max(0, Math.round(Number(value) * 100));
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function serializeRegistrationAccess(
  access: RegistrationAccessRecord,
  now: Date,
) {
  const registration = access.registration;
  const event = registration.event;
  const schedule = formatPublicEventSchedule(
    event.startsAt,
    event.endsAt,
    event.timezone,
  );
  const links = publicEventWebsiteLinks(event.slug, event.publicInfoUrl);
  const waitlistPosition = registration.status === "WAITLISTED"
    && registration.waitlistEntry?.status === "WAITING"
    ? registration.waitlistEntry.position
    : null;
  const status = describePublicRegistrationStatus(
    registration.status,
    waitlistPosition,
  );
  const payment = summarizePublicPayment({
    status: registration.status,
    totalCents: moneyToCents(registration.totalAmount),
    payments: registration.payments.map((entry) => ({
      amountCents: moneyToCents(entry.amount),
      refundedCents: entry.refunds.reduce(
        (total, refund) => total + moneyToCents(refund.amount),
        0,
      ),
    })),
  });
  const accountHolder = registration.accountHolderPerson;
  const contact = publicContactFromSnapshot(
    registration.contactSnapshot,
    {
      firstName: accountHolder.firstName,
      lastName: accountHolder.lastName,
      email: accountHolder.normalizedEmail ?? "",
      phone: accountHolder.phone ?? "",
    },
  );
  const submission = registration.publicFormSubmission;
  const pricingSnapshot = submission
    ? jsonRecord(submission.pricingSnapshot)
    : {};
  const pricingLineItems = Array.isArray(pricingSnapshot.lineItems)
    ? pricingSnapshot.lineItems.flatMap((entry) => {
        const line = jsonRecord(entry);
        if (
          typeof line.label !== "string"
          || typeof line.amountCents !== "number"
        ) return [];
        return [{
          label: line.label,
          amountCents: Math.max(0, Math.round(line.amountCents)),
          pricingLabel: typeof line.pricingLabel === "string"
            ? line.pricingLabel
            : null,
        }];
      })
    : [];
  const snapshotCents = (key: string, fallback = 0) => (
    typeof pricingSnapshot[key] === "number"
      ? Math.max(0, Math.round(pricingSnapshot[key]))
      : fallback
  );
  const snapshotSubtotalCents = snapshotCents(
    "subtotalCents",
    moneyToCents(registration.totalAmount),
  );
  const order = submission ? {
    lineItems: pricingLineItems,
    preDiscountSubtotalCents: snapshotCents(
      "preDiscountSubtotalCents",
      snapshotSubtotalCents,
    ),
    discountAmountCents: snapshotCents("discountAmountCents"),
    promoCode: typeof pricingSnapshot.promoCode === "string"
      ? pricingSnapshot.promoCode
      : null,
    subtotalCents: snapshotSubtotalCents,
    processingFeeCents: snapshotCents("processingFeeCents"),
    totalCents: snapshotCents(
      "totalCents",
      moneyToCents(registration.totalAmount),
    ),
  } : null;

  return {
    access: {
      expiresAt: access.expiresAt.toISOString(),
    },
    event: {
      name: event.name,
      slug: event.slug,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      timezone: event.timezone,
      location: event.location,
      dateLabel: schedule.dateLabel,
      timeLabel: schedule.timeLabel,
      detailsUrl: links.detailsUrl,
      supportUrl: links.supportUrl,
      supportContact: event.supportContact,
      attendeePassesAvailable: attendeePassExpiry(event.endsAt).getTime()
        > now.getTime(),
    },
    registration: {
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      statusLabel: status.label,
      statusDetail: status.detail,
      statusTone: status.tone,
      submittedAt: registration.submittedAt?.toISOString() ?? null,
      waitlistPosition,
    },
    contact,
    attendees: registration.attendees.map((attendee) => ({
      id: attendee.id,
      name: publicAttendeeName(attendee.profileSnapshot, attendee.person),
    })),
    payment,
    order,
    form: submission ? {
      name: submission.formVersion.form.name,
      slug: submission.formVersion.form.slug,
      versionNumber: submission.formVersion.versionNumber,
      submittedAt: submission.createdAt.toISOString(),
    } : null,
  };
}

export type PublicRegistrationAccessView = ReturnType<
  typeof serializeRegistrationAccess
>;

async function loadActiveAccessRecord(
  client: RegistrationAccessClient,
  token: string,
  now: Date,
) {
  if (!isRegistrationAccessToken(token)) return null;
  const access = await client.registrationAccessToken.findUnique({
    where: { tokenHash: hashOpaqueToken(token) },
    include: registrationAccessInclude,
  });
  if (
    !access
    || access.purpose !== "MANAGE_REGISTRATION"
    || access.revokedAt
    || access.expiresAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  return access;
}

/**
 * Transaction-friendly issuance hook for a newly created registration.
 *
 * The returned `token` is the raw bearer secret. It must only be placed into
 * the private URL sent to the registrant; never persist it in a snapshot,
 * message metadata, audit metadata, or log.
 */
async function issueRegistrationAccessTokenValue(
  client: RegistrationAccessClient,
  input: IssueRegistrationAccessTokenInput,
  token: string,
  allowExisting: boolean,
): Promise<IssuedRegistrationAccessToken> {
  const now = input.now ?? new Date();
  const registration = await client.registration.findUnique({
    where: { id: input.registrationId },
    select: {
      eventId: true,
      confirmationCode: true,
      event: { select: { endsAt: true } },
    },
  });
  if (!registration) {
    throw new RegistrationAccessIssueError(
      "REGISTRATION_NOT_FOUND",
      "A private access link cannot be issued for a missing registration.",
    );
  }

  const expiresAt = input.expiresAt
    ?? defaultRegistrationAccessExpiry(now, registration.event.endsAt);
  if (
    Number.isNaN(expiresAt.valueOf())
    || expiresAt.getTime() <= now.getTime()
  ) {
    throw new RegistrationAccessIssueError(
      "INVALID_EXPIRY",
      "A private registration access link must expire in the future.",
    );
  }

  const tokenHash = hashOpaqueToken(token);
  if (allowExisting) {
    const existing = await findStableExisting(
      client,
      input.registrationId,
      token,
      now,
    );
    if (existing) return existing;
  }

  let stored: { id: string };
  try {
    stored = await client.registrationAccessToken.create({
      data: {
        registrationId: input.registrationId,
        tokenHash,
        purpose: "MANAGE_REGISTRATION",
        expiresAt,
      },
      select: { id: true },
    });
  } catch (error) {
    if (!allowExisting || !isUniqueConstraintError(error)) throw error;
    const existing = await findStableExisting(
      client,
      input.registrationId,
      token,
      now,
    );
    if (!existing) throw error;
    return existing;
  }
  await client.auditLog.create({
    data: {
      eventId: registration.eventId,
      action: "REGISTRATION_ACCESS_ISSUED",
      entityType: "Registration",
      entityId: input.registrationId,
      correlationId: randomUUID(),
      summary: `Issued a private registration access link for ${registration.confirmationCode}.`,
      metadata: {
        accessTokenId: stored.id,
        purpose: "MANAGE_REGISTRATION",
        expiresAt: expiresAt.toISOString(),
      },
    },
  });

  return {
    token,
    tokenRecordId: stored.id,
    managePath: `/manage/${token}`,
    expiresAt,
  };
}

export async function issueRegistrationAccessToken(
  client: RegistrationAccessClient,
  input: IssueRegistrationAccessTokenInput,
) {
  return issueRegistrationAccessTokenValue(
    client,
    input,
    createOpaqueToken(),
    false,
  );
}

/**
 * Produces the same hash-only access token for every retry of one immutable
 * delivery request. The raw token is derived in memory from a server secret
 * and must never be stored in the outbox payload, metadata, audit, or logs.
 */
export async function issueStableRegistrationAccessToken(
  client: RegistrationAccessClient,
  input: IssueRegistrationAccessTokenInput & { deliveryKey: string },
) {
  if (!input.deliveryKey.trim() || input.deliveryKey.length > 240) {
    throw new RegistrationAccessIssueError(
      "STABLE_TOKEN_UNAVAILABLE",
      "A stable delivery key is required for a private registration link.",
    );
  }
  const now = input.now ?? new Date();
  const candidates = stableRegistrationAccessTokens(input.deliveryKey);
  for (const candidate of candidates) {
    const existing = await findStableExisting(
      client,
      input.registrationId,
      candidate,
      now,
    );
    if (existing) return existing;
  }
  return issueRegistrationAccessTokenValue(
    client,
    input,
    candidates[0],
    true,
  );
}

export async function createRegistrationAccessToken(
  input: IssueRegistrationAccessTokenInput,
) {
  return getPrisma().$transaction((tx) => (
    issueRegistrationAccessToken(tx, input)
  ));
}

export async function createStableRegistrationAccessToken(
  input: IssueRegistrationAccessTokenInput & { deliveryKey: string },
) {
  return getPrisma().$transaction((tx) => (
    issueStableRegistrationAccessToken(tx, input)
  ));
}

export async function resolveRegistrationAccessToken(
  token: string,
  options: { now?: Date; client?: RegistrationAccessClient } = {},
): Promise<PublicRegistrationAccessView | null> {
  const now = options.now ?? new Date();
  const client = options.client ?? getPrisma();
  const access = await loadActiveAccessRecord(client, token, now);
  return access ? serializeRegistrationAccess(access, now) : null;
}

/**
 * Server-only authorization result for another narrowly scoped operation
 * (for example, a future payment-intent endpoint). Never return this internal
 * identifier context directly from a public response.
 */
export async function authorizeRegistrationAccessToken(
  token: string,
  options: { now?: Date; client?: RegistrationAccessClient } = {},
) {
  const now = options.now ?? new Date();
  const client = options.client ?? getPrisma();
  const access = await loadActiveAccessRecord(client, token, now);
  if (!access) return null;
  return {
    accessTokenId: access.id,
    registrationId: access.registration.id,
    eventId: access.registration.eventId,
    registrationStatus: access.registration.status,
  };
}

async function updateRegistrationContactWithClient(
  client: Prisma.TransactionClient,
  token: string,
  input: PublicContactUpdateInput,
  now: Date,
) {
  const access = await loadActiveAccessRecord(client, token, now);
  if (!access) return null;
  const existingSnapshot = jsonRecord(access.registration.contactSnapshot);
  const contactSnapshot: Prisma.InputJsonObject = {
    ...existingSnapshot,
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    phone: input.phone,
  };

  await client.registration.update({
    where: { id: access.registration.id },
    data: { contactSnapshot },
  });
  const correlationId = randomUUID();
  await client.auditLog.create({
    data: {
      eventId: access.registration.eventId,
      action: "PUBLIC_REGISTRATION_CONTACT_UPDATED",
      entityType: "Registration",
      entityId: access.registration.id,
      correlationId,
      summary: `The registration contact updated contact details for ${access.registration.confirmationCode}.`,
      metadata: {
        source: "PRIVATE_MANAGE_LINK",
        changedFields: ["firstName", "lastName", "email", "phone"],
      },
    },
  });
  const queued = await enqueueRegistrationContactUpdatedMessage(client, {
    eventId: access.registration.eventId,
    registrationId: access.registration.id,
    correlationId,
    transitionKey: `PUBLIC_REGISTRATION_CONTACT_UPDATED:${correlationId}`,
    recipientEmail: input.email,
    recipientName: `${input.firstName} ${input.lastName}`.trim(),
    metadata: {
      source: "PRIVATE_MANAGE_LINK",
      destinationUpdated: true,
    },
  });
  return {
    registration: {
      ...serializeRegistrationAccess(access, now),
      contact: input,
    },
    pendingMessageIds: queued.pendingMessageIds,
  };
}

export async function updatePublicRegistrationContactWithMessages(
  token: string,
  input: PublicContactUpdateInput,
  now = new Date(),
) {
  return getPrisma().$transaction((tx) => (
    updateRegistrationContactWithClient(tx, token, input, now)
  ));
}

export async function updatePublicRegistrationContact(
  token: string,
  input: PublicContactUpdateInput,
  now = new Date(),
) {
  const result = await updatePublicRegistrationContactWithMessages(token, input, now);
  return result?.registration ?? null;
}

export async function revokeRegistrationAccessToken(
  token: string,
  now = new Date(),
) {
  if (!isRegistrationAccessToken(token)) return false;
  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const access = await tx.registrationAccessToken.findUnique({
      where: { tokenHash: hashOpaqueToken(token) },
      select: {
        id: true,
        revokedAt: true,
        registration: {
          select: {
            id: true,
            eventId: true,
            confirmationCode: true,
          },
        },
      },
    });
    if (!access || access.revokedAt) return false;

    const revoked = await tx.registrationAccessToken.updateMany({
      where: { id: access.id, revokedAt: null },
      data: { revokedAt: now },
    });
    if (revoked.count === 0) return false;

    await tx.auditLog.create({
      data: {
        eventId: access.registration.eventId,
        action: "REGISTRATION_ACCESS_REVOKED",
        entityType: "Registration",
        entityId: access.registration.id,
        correlationId: randomUUID(),
        summary: `Revoked a private registration access link for ${access.registration.confirmationCode}.`,
        metadata: {
          accessTokenId: access.id,
          purpose: "MANAGE_REGISTRATION",
          revokedAt: now.toISOString(),
        },
      },
    });
    return true;
  });
}

export async function revokeRegistrationAccessTokensForRegistration(
  client: RegistrationAccessClient,
  registrationId: string,
  now = new Date(),
) {
  return client.registrationAccessToken.updateMany({
    where: {
      registrationId,
      purpose: "MANAGE_REGISTRATION",
      revokedAt: null,
    },
    data: { revokedAt: now },
  });
}
