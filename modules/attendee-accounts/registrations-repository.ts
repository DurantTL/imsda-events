import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  editableAttendeeFields,
  type EditableAttendeeField,
} from "@/modules/attendee-accounts/registration-answer-policy";
import { updateTieredRegistrationAnswersWithClient } from "@/modules/attendee-accounts/answer-update-repository";
import { consumeAttendeeEditStepUp } from "@/modules/attendee-accounts/step-up-service";
import {
  processQueuedMessageIdsAfterCommit,
} from "@/modules/communications/messaging-repository";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { enqueueRegistrationContactUpdatedMessage } from "@/modules/communications/transactional-messages";
import { moneyToCents, registrationBalanceCents } from "@/modules/payments/square-domain";
import {
  describePublicRegistrationStatus,
  publicAttendeeName,
  publicContactFromSnapshot,
  type PublicRegistrationStatusSummary,
  type PublicContactUpdateInput,
} from "@/modules/public-access/domain";

/**
 * Every registration an account may see: those whose contact address is the
 * account's own verified address, and nothing else (ADR 0003).
 *
 * Matching is on the address and never on the name. A shared family address
 * therefore returns several registrations, which is usually correct — one parent
 * registers the household — and where it is not, the household already shares
 * the inbox the private links were sent to. An account changes nothing about who
 * could already see what.
 */

/**
 * A registration's contact address is the one in `contactSnapshot`, falling back
 * to the account holder's `Person` record. That is the precedence
 * `publicContactFromSnapshot` applies when it renders the private management
 * page, and the two must agree: an address that shows as the contact there has
 * to be the address that claims the registration here.
 *
 * It is expressed in SQL rather than filtered in memory so a full table read is
 * not the cost of signing in. `attendee-registration-matching.test.ts` pins it
 * against the TypeScript rule so the two cannot drift apart silently.
 *
 * A DRAFT registration is excluded. It is an abandoned form rather than
 * something anyone submitted, and listing one back to a registrant as though it
 * were theirs would be a puzzle, not a service.
 */
const CONTACT_EMAIL_SQL = Prisma.sql`
  lower(coalesce(
    nullif(trim(registration."contactSnapshot"->>'email'), ''),
    person."normalizedEmail",
    ''
  ))
`;

async function matchingRegistrationIds(verifiedEmail: string) {
  const rows = await getPrisma().$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT registration."id"
    FROM "Registration" registration
    JOIN "Person" person ON person."id" = registration."accountHolderPersonId"
    WHERE registration."status" <> 'DRAFT'
      AND ${CONTACT_EMAIL_SQL} = ${verifiedEmail}
  `);
  return rows.map((row) => row.id);
}

export async function matchingRegistrationIdsForVerifiedEmail(
  verifiedEmail: string,
) {
  return matchingRegistrationIds(verifiedEmail);
}

export async function authorizeAttendeeRegistration(
  verifiedEmail: string,
  registrationId: string,
) {
  const ids = await matchingRegistrationIds(verifiedEmail);
  if (!ids.includes(registrationId)) return null;
  const registration = await getPrisma().registration.findUnique({
    where: { id: registrationId },
    select: { id: true, eventId: true },
  });
  return registration
    ? { registrationId: registration.id, eventId: registration.eventId }
    : null;
}

export async function updateAttendeeRegistrationContact(input: {
  accountId: string;
  verifiedEmail: string;
  sessionId: string;
  registrationId: string;
  code: string;
  contact: PublicContactUpdateInput;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const result = await getPrisma().$transaction(async (tx) => {
    const owned = await tx.$queryRaw<Array<{
      id: string;
      eventId: string;
      confirmationCode: string;
      contactSnapshot: Prisma.JsonValue;
    }>>(Prisma.sql`
      SELECT registration."id", registration."eventId",
        registration."confirmationCode", registration."contactSnapshot"
      FROM "Registration" registration
      JOIN "Person" person ON person."id" = registration."accountHolderPersonId"
      WHERE registration."id" = ${input.registrationId}
        AND registration."status" <> 'DRAFT'
        AND ${CONTACT_EMAIL_SQL} = ${input.verifiedEmail}
      FOR UPDATE
    `);
    const registration = owned[0];
    if (!registration) return null;
    const authorized = await consumeAttendeeEditStepUp({
      accountId: input.accountId,
      sessionId: input.sessionId,
      code: input.code,
      now,
      client: tx,
    });
    if (!authorized) return { codeAccepted: false as const };

    const existing = registration.contactSnapshot
      && typeof registration.contactSnapshot === "object"
      && !Array.isArray(registration.contactSnapshot)
      ? registration.contactSnapshot as Prisma.JsonObject
      : {};
    await tx.registration.update({
      where: { id: registration.id },
      data: {
        contactSnapshot: {
          ...existing,
          ...input.contact,
        } satisfies Prisma.InputJsonObject,
      },
    });
    const correlationId = randomUUID();
    await tx.auditLog.create({
      data: {
        eventId: registration.eventId,
        action: "ATTENDEE_ACCOUNT_REGISTRATION_CONTACT_UPDATED",
        entityType: "Registration",
        entityId: registration.id,
        correlationId,
        summary: `The signed-in attendee account updated contact details for ${registration.confirmationCode}.`,
        metadata: {
          source: "ATTENDEE_ACCOUNT",
          attendeeAccountId: input.accountId,
          stepUp: "EMAILED_CODE",
          changedFields: ["firstName", "lastName", "email", "phone"],
        },
      },
    });
    const queued = await enqueueRegistrationContactUpdatedMessage(tx, {
      eventId: registration.eventId,
      registrationId: registration.id,
      correlationId,
      transitionKey: `ATTENDEE_ACCOUNT_REGISTRATION_CONTACT_UPDATED:${correlationId}`,
      recipientEmail: input.contact.email,
      recipientName: `${input.contact.firstName} ${input.contact.lastName}`.trim(),
      metadata: {
        source: "ATTENDEE_ACCOUNT",
        destinationUpdated: true,
      },
    });
    return {
      codeAccepted: true as const,
      contact: input.contact,
      pendingMessageIds: queued.pendingMessageIds,
    };
  });
  if (result?.codeAccepted) {
    await processQueuedMessageIdsAfterCommit(result.pendingMessageIds);
  }
  return result;
}

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function updateTieredAttendeeAnswers(input: {
  accountId: string;
  verifiedEmail: string;
  registrationId: string;
  expectedUpdatedAt: string;
  attendees: Array<{
    attendeeId: string;
    responses: Record<string, unknown>;
  }>;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return getPrisma().$transaction(async (tx) => {
    const owned = await tx.$queryRaw<Array<{
      id: string;
    }>>(Prisma.sql`
      SELECT registration."id"
      FROM "Registration" registration
      JOIN "Person" person ON person."id" = registration."accountHolderPersonId"
      WHERE registration."id" = ${input.registrationId}
        AND registration."status" IN ('SUBMITTED', 'CONFIRMED', 'WAITLISTED')
        AND ${CONTACT_EMAIL_SQL} = ${input.verifiedEmail}
      FOR UPDATE
    `);
    const ownership = owned[0];
    if (!ownership) return null;
    return updateTieredRegistrationAnswersWithClient(tx, {
      registrationId: ownership.id,
      expectedUpdatedAt: input.expectedUpdatedAt,
      attendees: input.attendees,
      now,
      audit: {
        action: "ATTENDEE_ACCOUNT_ANSWERS_UPDATED",
        summary: (confirmationCode) => (
          `The signed-in attendee account updated attendee choices for ${confirmationCode}.`
        ),
        metadata: {
          source: "ATTENDEE_ACCOUNT",
          attendeeAccountId: input.accountId,
          verification: "ACCOUNT_SESSION",
        },
      },
    });
  });
}

export type AttendeeRegistrationSummary = {
  id: string;
  confirmationCode: string;
  status: PublicRegistrationStatusSummary;
  submittedAt: string | null;
  event: {
    name: string;
    slug: string;
    startsAt: string;
    endsAt: string;
    timezone: string;
    location: string | null;
    attendeeEditPolicy: "TIERED" | "VERIFY_EVERY_EDIT";
  };
  contact: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  };
  attendeeNames: string[];
  answerEditing: {
    enabled: boolean;
    reason: string;
    expectedUpdatedAt: string;
    fields: EditableAttendeeField[];
    attendees: Array<{
      attendeeId: string;
      name: string;
      responses: Record<string, unknown>;
    }>;
  };
  totalCents: number;
  paidCents: number;
  balanceCents: number;
};

/**
 * The list behind the account's one page. Read-only: this slice recognises a
 * registrant, it does not yet let one change anything.
 */
export async function listRegistrationsForVerifiedEmail(
  verifiedEmail: string,
): Promise<AttendeeRegistrationSummary[]> {
  const ids = await matchingRegistrationIds(verifiedEmail);
  if (ids.length === 0) return [];

  const registrations = await getPrisma().registration.findMany({
    where: { id: { in: ids } },
    orderBy: [{ event: { startsAt: "desc" } }, { createdAt: "desc" }],
    select: {
      id: true,
      confirmationCode: true,
      status: true,
      submittedAt: true,
      updatedAt: true,
      totalAmount: true,
      contactSnapshot: true,
      accountHolderPerson: {
        select: {
          firstName: true,
          lastName: true,
          normalizedEmail: true,
          phone: true,
        },
      },
      event: {
        select: {
          name: true,
          slug: true,
          startsAt: true,
          endsAt: true,
          timezone: true,
          location: true,
          attendeeEditPolicy: true,
        },
      },
      attendees: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          formResponses: true,
          profileSnapshot: true,
          person: { select: { firstName: true, lastName: true } },
        },
      },
      publicFormSubmission: {
        select: {
          formVersion: { select: { definition: true } },
        },
      },
      payments: {
        where: { status: "SUCCEEDED" },
        select: {
          amount: true,
          refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } },
        },
      },
      waitlistEntry: { select: { position: true, status: true } },
    },
  });

  return registrations.map((registration) => {
    const totalCents = moneyToCents(registration.totalAmount);
    // The same arithmetic the payment path and the private management page use,
    // so a balance shown here can never disagree with the one shown there.
    const balanceCents = registrationBalanceCents(registration);
    const parsedDefinition = registration.publicFormSubmission
      ? registrationFormDefinitionSchema.safeParse(
          registration.publicFormSubmission.formVersion.definition,
        )
      : null;
    const answerFields = parsedDefinition?.success
      ? editableAttendeeFields(
          parsedDefinition.data,
          registration.event.attendeeEditPolicy,
        )
      : [];
    const answerKeys = new Set(answerFields.map((field) => field.key));
    const answerEditingEnabled = (
      registration.event.attendeeEditPolicy === "TIERED"
      && answerFields.length > 0
      && (registration.status === "SUBMITTED"
        || registration.status === "CONFIRMED"
        || registration.status === "WAITLISTED")
    );
    return {
      id: registration.id,
      confirmationCode: registration.confirmationCode,
      // The same wording the private management page uses. A registrant who
      // reaches the same registration two ways must not be told two things.
      status: describePublicRegistrationStatus(
        registration.status,
        registration.waitlistEntry?.status === "WAITING"
          ? registration.waitlistEntry.position
          : null,
      ),
      submittedAt: registration.submittedAt?.toISOString() ?? null,
      event: {
        name: registration.event.name,
        slug: registration.event.slug,
        startsAt: registration.event.startsAt.toISOString(),
        endsAt: registration.event.endsAt.toISOString(),
        timezone: registration.event.timezone,
        location: registration.event.location,
        attendeeEditPolicy: registration.event.attendeeEditPolicy,
      },
      contact: publicContactFromSnapshot(
        registration.contactSnapshot,
        {
          firstName: registration.accountHolderPerson.firstName,
          lastName: registration.accountHolderPerson.lastName,
          email: registration.accountHolderPerson.normalizedEmail ?? "",
          phone: registration.accountHolderPerson.phone ?? "",
        },
      ),
      attendeeNames: registration.attendees.map(
        (attendee) => publicAttendeeName(attendee.profileSnapshot, attendee.person),
      ),
      answerEditing: {
        enabled: answerEditingEnabled,
        reason: answerEditingEnabled
          ? "These event choices can be updated from your verified account."
          : registration.event.attendeeEditPolicy !== "TIERED"
            ? "This event requires verification before attendee choices can be changed."
            : !registration.publicFormSubmission
              ? "The event team must update this imported registration."
              : "This registration has no low-risk attendee choices available for self-service.",
        expectedUpdatedAt: registration.updatedAt.toISOString(),
        fields: answerFields,
        attendees: registration.attendees.map((attendee) => ({
          attendeeId: attendee.id,
          name: publicAttendeeName(attendee.profileSnapshot, attendee.person),
          responses: Object.fromEntries(
            Object.entries(recordFromJson(attendee.formResponses))
              .filter(([key]) => answerKeys.has(key)),
          ),
        })),
      },
      totalCents,
      paidCents: Math.max(0, totalCents - balanceCents),
      balanceCents,
    };
  });
}
