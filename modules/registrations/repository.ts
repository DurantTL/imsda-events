import { getPrisma } from "@/lib/prisma";
import { decideEventCapacity } from "@/modules/events/lifecycle";
import type {
  AttendeeInput,
  RegistrationInput,
  RegistrationUpdateInput,
} from "@/modules/registrations/schemas";
import { Prisma, type RegistrationStatus } from "@prisma/client";

type RegistrationWithRelations = Awaited<ReturnType<typeof getRegistrationQuery>>[number];
type RegistrationReadClient = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

function getRegistrationQuery(
  client: RegistrationReadClient,
  eventId: string,
  statuses?: readonly RegistrationStatus[],
) {
  return client.registration.findMany({
    where: {
      eventId,
      ...(statuses ? { status: { in: [...statuses] } } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      accountHolderPerson: true,
      attendees: {
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        include: {
          person: true,
          checkIns: { where: { undoneAt: null }, orderBy: { checkedInAt: "desc" }, take: 1 },
        },
      },
      payments: {
        where: { status: "SUCCEEDED" },
        include: { refunds: { where: { status: "SUCCEEDED" } } },
      },
      publicFormSubmission: {
        include: {
          formVersion: {
            select: { versionNumber: true, definition: true, form: { select: { name: true, slug: true } } },
          },
        },
      },
    },
  });
}

function moneyToCents(value: { toString(): string } | number) {
  return Math.round(Number(value) * 100);
}

function recordFromJson(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordsFromJson(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    : [];
}

function serializeRegistration(registration: RegistrationWithRelations) {
  const paidCents = registration.payments.reduce((total, payment) => {
    const refundedCents = payment.refunds.reduce(
      (refundTotal, refund) => refundTotal + moneyToCents(refund.amount),
      0,
    );
    return total + moneyToCents(payment.amount) - refundedCents;
  }, 0);
  const totalAmountCents = moneyToCents(registration.totalAmount);
  const firstAttendee = registration.attendees[0];
  const contactSnapshot = recordFromJson(registration.contactSnapshot);
  const contactValue = (key: "firstName" | "lastName" | "email" | "phone", fallback: string) => (
    typeof contactSnapshot[key] === "string"
      ? contactSnapshot[key].trim()
      : fallback
  );

  return {
    id: registration.id,
    confirmationCode: registration.confirmationCode,
    status: registration.status,
    totalAmountCents,
    paidCents,
    balanceCents: Math.max(totalAmountCents - paidCents, 0),
    submittedAt: registration.submittedAt?.toISOString() ?? null,
    createdAt: registration.createdAt.toISOString(),
    accountHolder: {
      id: registration.accountHolderPerson.id,
      firstName: contactValue("firstName", registration.accountHolderPerson.firstName),
      lastName: contactValue("lastName", registration.accountHolderPerson.lastName),
      email: contactValue("email", registration.accountHolderPerson.normalizedEmail ?? ""),
      phone: contactValue("phone", registration.accountHolderPerson.phone ?? ""),
    },
    attendees: registration.attendees.map((attendee) => {
      const activeCheckIn = attendee.checkIns.at(0);
      const profile = recordFromJson(attendee.profileSnapshot);
      return {
        id: attendee.id,
        firstName: typeof profile.firstName === "string"
          ? profile.firstName
          : attendee.person.firstName,
        lastName: typeof profile.lastName === "string"
          ? profile.lastName
          : attendee.person.lastName,
        email: typeof profile.email === "string" ? profile.email : attendee.person.normalizedEmail ?? "",
        phone: typeof profile.phone === "string" ? profile.phone : attendee.person.phone ?? "",
        attendeeType: attendee.attendeeType,
        position: attendee.position,
        source: profile.source === "PUBLIC_REGISTRATION" ? "PUBLIC_REGISTRATION" as const : "STAFF" as const,
        responses: recordFromJson(attendee.formResponses),
        checkedIn: Boolean(activeCheckIn),
        checkInId: activeCheckIn?.id ?? null,
        checkedInAt: activeCheckIn?.checkedInAt.toISOString() ?? null,
      };
    }),
    attendeeType: firstAttendee?.attendeeType ?? "ATTENDEE",
    attendeeCount: registration.attendees.length,
    checkedInCount: registration.attendees.filter((attendee) => attendee.checkIns.length > 0).length,
    payments: registration.payments.map((payment) => ({
      id: payment.id,
      amountCents: moneyToCents(payment.amount),
      refundedCents: payment.refunds.reduce((total, refund) => total + moneyToCents(refund.amount), 0),
      method: payment.method,
      externalReference: payment.externalReference ?? "",
      receivedAt: payment.receivedAt?.toISOString() ?? null,
      refunds: payment.refunds.map((refund) => ({
        id: refund.id,
        amountCents: moneyToCents(refund.amount),
        reason: refund.reason ?? "",
        createdAt: refund.createdAt.toISOString(),
      })),
    })),
    publicSubmission: registration.publicFormSubmission ? {
      formName: registration.publicFormSubmission.formVersion.form.name,
      formSlug: registration.publicFormSubmission.formVersion.form.slug,
      versionNumber: registration.publicFormSubmission.formVersion.versionNumber,
      responses: recordFromJson(registration.publicFormSubmission.responses),
      attendeeResponses: recordsFromJson(registration.publicFormSubmission.attendeeResponses),
      definition: recordFromJson(registration.publicFormSubmission.formVersion.definition),
      pricingSnapshot: recordFromJson(registration.publicFormSubmission.pricingSnapshot),
      submittedAt: registration.publicFormSubmission.createdAt.toISOString(),
    } : null,
  };
}

export type RegistrationRecord = ReturnType<typeof serializeRegistration>;

export type RegistrationAttendeeOperationErrorCode =
  | "REGISTRATION_NOT_FOUND"
  | "REGISTRATION_NOT_ACTIVE"
  | "PUBLIC_FORM_ATTENDEE_EDIT_REQUIRES_FORM"
  | "EVENT_CAPACITY_UNAVAILABLE"
  | "REGISTRATION_ATTENDEE_CONFLICT";

export class RegistrationAttendeeOperationError extends Error {
  constructor(
    public readonly code: RegistrationAttendeeOperationErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RegistrationAttendeeOperationError";
  }
}

export async function listRegistrations(
  eventId: string,
  options?: { statuses?: readonly RegistrationStatus[] },
) {
  const registrations = await getRegistrationQuery(
    getPrisma(),
    eventId,
    options?.statuses,
  );
  return registrations.map(serializeRegistration);
}

export async function createRegistration(eventId: string, input: RegistrationInput, actorUserId: string) {
  const prisma = getPrisma();
  const confirmationCode = `REG-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

  const registrationId = await prisma.$transaction(async (tx) => {
    const person = input.email
      ? await tx.person.upsert({
          where: { normalizedEmail: input.email },
          update: {
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone || null,
          },
          create: {
            firstName: input.firstName,
            lastName: input.lastName,
            normalizedEmail: input.email,
            phone: input.phone || null,
          },
        })
      : await tx.person.create({
          data: {
            firstName: input.firstName,
            lastName: input.lastName,
            phone: input.phone || null,
          },
        });

    const registration = await tx.registration.create({
      data: {
        eventId,
        accountHolderPersonId: person.id,
        confirmationCode,
        status: input.status,
        totalAmount: input.totalAmountCents / 100,
        contactSnapshot: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          phone: input.phone,
        },
        submittedAt: input.status === "DRAFT" ? null : new Date(),
        attendees: {
          create: {
            eventId,
            personId: person.id,
            attendeeType: input.attendeeType,
            profileSnapshot: {
              firstName: input.firstName,
              lastName: input.lastName,
              email: input.email || null,
              phone: input.phone || null,
            },
          },
        },
      },
    });

    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "REGISTRATION_CREATED",
        entityType: "Registration",
        entityId: registration.id,
        correlationId: crypto.randomUUID(),
        summary: `Created registration ${confirmationCode} for ${input.firstName} ${input.lastName}.`,
      },
    });

    return registration.id;
  });

  return getRegistrationById(eventId, registrationId);
}

export async function updateRegistration(
  eventId: string,
  registrationId: string,
  input: RegistrationUpdateInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  const existing = await prisma.registration.findFirst({
    where: { id: registrationId, eventId },
    include: {
      accountHolderPerson: true,
      publicFormSubmission: { select: { id: true } },
      attendees: { orderBy: { createdAt: "asc" }, take: 1 },
    },
  });
  if (!existing) return null;

  await prisma.$transaction(async (tx) => {
    const currentContact = recordFromJson(existing.contactSnapshot);
    const currentContactValue = (key: "firstName" | "lastName" | "email" | "phone", fallback: string) => (
      typeof currentContact[key] === "string" ? currentContact[key].trim() : fallback
    );
    const nextFirstName = input.firstName ?? currentContactValue("firstName", existing.accountHolderPerson.firstName);
    const nextLastName = input.lastName ?? currentContactValue("lastName", existing.accountHolderPerson.lastName);
    const nextEmail = input.email === undefined
      ? currentContactValue("email", existing.accountHolderPerson.normalizedEmail ?? "")
      : input.email;
    const nextPhone = input.phone === undefined
      ? currentContactValue("phone", existing.accountHolderPerson.phone ?? "")
      : input.phone;

    if (!existing.publicFormSubmission) {
      await tx.person.update({
        where: { id: existing.accountHolderPersonId },
        data: {
          firstName: nextFirstName,
          lastName: nextLastName,
          normalizedEmail: nextEmail || null,
          phone: nextPhone || null,
        },
      });
    }

    await tx.registration.update({
      where: { id: registrationId },
      data: {
        totalAmount: input.totalAmountCents === undefined ? undefined : input.totalAmountCents / 100,
        contactSnapshot: {
          ...currentContact,
          firstName: nextFirstName,
          lastName: nextLastName,
          email: nextEmail,
          phone: nextPhone,
        },
      },
    });

    const firstAttendee = existing.attendees[0];
    if (firstAttendee?.personId === existing.accountHolderPersonId) {
      await tx.registrationAttendee.update({
        where: { id: firstAttendee.id },
        data: {
          attendeeType: input.attendeeType,
          profileSnapshot: {
            ...recordFromJson(firstAttendee.profileSnapshot),
            firstName: nextFirstName,
            lastName: nextLastName,
            email: nextEmail,
            phone: nextPhone,
          },
        },
      });
    }

    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "REGISTRATION_UPDATED",
        entityType: "Registration",
        entityId: registrationId,
        correlationId: crypto.randomUUID(),
        summary: `Updated registration ${existing.confirmationCode}.`,
        metadata: {
          changedFields: Object.keys(input),
          sharedPersonProfileUpdated: !existing.publicFormSubmission,
        },
      },
    });
  });

  return getRegistrationById(eventId, registrationId);
}

export async function getRegistrationById(eventId: string, registrationId: string) {
  return getRegistrationByIdWithClient(getPrisma(), eventId, registrationId);
}

export async function getRegistrationByIdWithClient(
  client: RegistrationReadClient,
  eventId: string,
  registrationId: string,
) {
  const registrations = await getRegistrationQuery(client, eventId);
  const registration = registrations.find((candidate) => candidate.id === registrationId);
  return registration ? serializeRegistration(registration) : null;
}

export async function addRegistrationAttendee(
  eventId: string,
  registrationId: string,
  input: AttendeeInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await prisma.$transaction(async (tx) => {
        const registration = await tx.registration.findFirst({
          where: { id: registrationId, eventId },
          select: {
            id: true,
            confirmationCode: true,
            status: true,
            publicFormSubmission: { select: { id: true } },
            event: { select: { capacity: true } },
          },
        });
        if (!registration) {
          throw new RegistrationAttendeeOperationError(
            "REGISTRATION_NOT_FOUND",
            "The registration could not be found for this event.",
          );
        }
        if (registration.status !== "SUBMITTED" && registration.status !== "CONFIRMED") {
          throw new RegistrationAttendeeOperationError(
            "REGISTRATION_NOT_ACTIVE",
            "Attendees can only be added to submitted or confirmed registrations.",
            { currentStatus: registration.status },
          );
        }
        if (registration.publicFormSubmission) {
          throw new RegistrationAttendeeOperationError(
            "PUBLIC_FORM_ATTENDEE_EDIT_REQUIRES_FORM",
            "Attendees on a public-form registration must be changed through its form-aware edit workflow.",
          );
        }

        const occupied = await tx.registrationAttendee.count({
          where: {
            eventId,
            registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
          },
        });
        const decision = decideEventCapacity({
          capacity: registration.event.capacity,
          occupied,
          requested: 1,
          waitlistEnabled: false,
        });
        if (decision !== "REGISTER") {
          const remaining = registration.event.capacity === null
            ? null
            : Math.max(registration.event.capacity - occupied, 0);
          throw new RegistrationAttendeeOperationError(
            "EVENT_CAPACITY_UNAVAILABLE",
            "The event does not have capacity for another attendee.",
            { occupied, requested: 1, remaining },
          );
        }

        const person = input.email
          ? await tx.person.upsert({
              where: { normalizedEmail: input.email },
              update: { firstName: input.firstName, lastName: input.lastName, phone: input.phone || null },
              create: {
                firstName: input.firstName,
                lastName: input.lastName,
                normalizedEmail: input.email,
                phone: input.phone || null,
              },
            })
          : await tx.person.create({
              data: { firstName: input.firstName, lastName: input.lastName, phone: input.phone || null },
            });

        const position = (await tx.registrationAttendee.aggregate({
          where: { registrationId },
          _max: { position: true },
        }))._max.position ?? -1;
        const attendee = await tx.registrationAttendee.create({
          data: {
            eventId,
            registrationId,
            personId: person.id,
            attendeeType: input.attendeeType,
            position: position + 1,
            profileSnapshot: {
              firstName: input.firstName,
              lastName: input.lastName,
              email: input.email || null,
              phone: input.phone || null,
            },
          },
        });

        await tx.auditLog.create({
          data: {
            eventId,
            actorUserId,
            action: "REGISTRATION_ATTENDEE_ADDED",
            entityType: "RegistrationAttendee",
            entityId: attendee.id,
            correlationId: crypto.randomUUID(),
            summary: `Added ${input.firstName} ${input.lastName} to registration ${registration.confirmationCode}.`,
            metadata: {
              registrationId,
              occupiedBefore: occupied,
              eventCapacity: registration.event.capacity,
            },
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return getRegistrationById(eventId, registrationId);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2034") {
        throw error;
      }
    }
  }
  throw new RegistrationAttendeeOperationError(
    "REGISTRATION_ATTENDEE_CONFLICT",
    "Another attendee changed event capacity at the same time. Refresh and try again.",
  );
}
