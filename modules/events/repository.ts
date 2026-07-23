import type { MembershipRecord } from "@/modules/access/authorization";
import { getPrisma } from "@/lib/prisma";
import {
  activeRegistrationStatuses,
  calendarDateInEventTimeZone,
  evaluateEventRegistrationPhase,
  remainingEventCapacity,
} from "@/modules/events/lifecycle";
import { getEventPublishReadiness } from "@/modules/events/readiness";
import type { EventLifecycleInput, EventSettingsInput } from "@/modules/events/schemas";

export class EventOperationError extends Error {
  constructor(
    public readonly code: "EVENT_NOT_FOUND" | "EVENT_NOT_READY",
    message: string,
  ) {
    super(message);
    this.name = "EventOperationError";
  }
}

function eventDate(value: string) {
  return new Date(`${value}T12:00:00.000Z`);
}

export async function findActiveMembership(
  userId: string,
  eventId: string,
): Promise<MembershipRecord | null> {
  const membership = await getPrisma().eventMembership.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { eventId: true, userId: true, role: true, status: true, permissions: true },
  });

  return membership;
}

export async function listEventsForUser(userId: string, isSystemAdmin: boolean) {
  return getPrisma().event.findMany({
    where: isSystemAdmin
      ? undefined
      : { memberships: { some: { userId, status: "ACTIVE" } } },
    orderBy: { startsAt: "asc" },
    select: {
      id: true,
      slug: true,
      name: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      location: true,
      capacity: true,
      isPublished: true,
      registrationOpensOn: true,
      registrationClosesOn: true,
      waitlistEnabled: true,
      autoPromoteWaitlist: true,
      publicInfoUrl: true,
      supportContact: true,
    },
  });
}

export async function getEventSettings(eventId: string) {
  const prisma = getPrisma();
  const [event, publishedForms] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        slug: true,
        startsAt: true,
        endsAt: true,
        timezone: true,
        location: true,
        capacity: true,
        publicInfoUrl: true,
        supportContact: true,
        isPublished: true,
        registrationOpensOn: true,
        registrationClosesOn: true,
        waitlistEnabled: true,
        autoPromoteWaitlist: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.registrationForm.findMany({
      where: {
        eventId,
        versions: { some: { status: "PUBLISHED" } },
      },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        slug: true,
      },
    }),
  ]);
  if (!event) return null;
  const publishedFormCount = publishedForms.length;
  const view = {
    id: event.id,
    name: event.name,
    slug: event.slug,
    startsOn: calendarDateInEventTimeZone(event.startsAt, event.timezone),
    endsOn: calendarDateInEventTimeZone(event.endsAt, event.timezone),
    timezone: event.timezone,
    location: event.location,
    capacity: event.capacity,
    publicInfoUrl: event.publicInfoUrl,
    supportContact: event.supportContact,
    isPublished: event.isPublished,
    registrationOpensOn: event.registrationOpensOn,
    registrationClosesOn: event.registrationClosesOn,
    waitlistEnabled: event.waitlistEnabled,
    autoPromoteWaitlist: event.autoPromoteWaitlist,
    publishedFormCount,
    publishedForms,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
  return {
    ...view,
    readiness: getEventPublishReadiness(view, publishedFormCount),
  };
}

export type EventSettingsRecord = NonNullable<Awaited<ReturnType<typeof getEventSettings>>>;

export async function createEvent(
  input: EventSettingsInput,
  actorUserId: string,
) {
  const readiness = getEventPublishReadiness(input, 0);
  if (input.isPublished && !readiness.ready) {
    throw new EventOperationError(
      "EVENT_NOT_READY",
      "Create the event as a draft, publish a registration form, and complete the readiness checklist before publishing.",
    );
  }

  const eventId = await getPrisma().$transaction(async (tx) => {
    const event = await tx.event.create({
      data: {
        name: input.name,
        slug: input.slug,
        startsAt: eventDate(input.startsOn),
        endsAt: eventDate(input.endsOn),
        timezone: input.timezone,
        location: input.location,
        capacity: input.capacity,
        publicInfoUrl: input.publicInfoUrl,
        supportContact: input.supportContact,
        isPublished: input.isPublished,
        registrationOpensOn: input.registrationOpensOn,
        registrationClosesOn: input.registrationClosesOn,
        waitlistEnabled: input.waitlistEnabled,
        autoPromoteWaitlist: input.autoPromoteWaitlist,
      },
    });
    await tx.eventMembership.create({
      data: {
        eventId: event.id,
        userId: actorUserId,
        role: "EVENT_ADMIN",
        status: "ACTIVE",
      },
    });
    await tx.auditLog.create({
      data: {
        eventId: event.id,
        actorUserId,
        action: "EVENT_CREATED",
        entityType: "Event",
        entityId: event.id,
        correlationId: crypto.randomUUID(),
        summary: `Created event draft: ${event.name}.`,
        metadata: { slug: event.slug },
      },
    });
    return event.id;
  });
  return getEventSettings(eventId);
}

export async function updateEventSettings(
  eventId: string,
  input: EventSettingsInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const [current, publishedFormCount] = await Promise.all([
      tx.event.findUnique({
        where: { id: eventId },
        select: {
          name: true,
          slug: true,
          startsAt: true,
          endsAt: true,
          timezone: true,
          location: true,
          capacity: true,
          publicInfoUrl: true,
          supportContact: true,
          isPublished: true,
          registrationOpensOn: true,
          registrationClosesOn: true,
          waitlistEnabled: true,
          autoPromoteWaitlist: true,
        },
      }),
      tx.registrationFormVersion.count({
        where: { status: "PUBLISHED", form: { eventId } },
      }),
    ]);
    if (!current) {
      throw new EventOperationError("EVENT_NOT_FOUND", "That event no longer exists.");
    }
    const readiness = getEventPublishReadiness(input, publishedFormCount);
    if (!current.isPublished && input.isPublished && !readiness.ready) {
      const missing = readiness.items
        .filter((item) => !item.complete)
        .map((item) => item.label.toLowerCase());
      throw new EventOperationError(
        "EVENT_NOT_READY",
        `Finish the publish checklist first: ${missing.join(", ")}.`,
      );
    }
    await tx.event.update({
      where: { id: eventId },
      data: {
        name: input.name,
        slug: input.slug,
        startsAt: eventDate(input.startsOn),
        endsAt: eventDate(input.endsOn),
        timezone: input.timezone,
        location: input.location,
        capacity: input.capacity,
        publicInfoUrl: input.publicInfoUrl,
        supportContact: input.supportContact,
        isPublished: input.isPublished,
        registrationOpensOn: input.registrationOpensOn,
        registrationClosesOn: input.registrationClosesOn,
        waitlistEnabled: input.waitlistEnabled,
        autoPromoteWaitlist: input.autoPromoteWaitlist,
      },
    });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: current.isPublished !== input.isPublished
          ? input.isPublished ? "EVENT_PUBLISHED" : "EVENT_UNPUBLISHED"
          : "EVENT_SETTINGS_UPDATED",
        entityType: "Event",
        entityId: eventId,
        correlationId: crypto.randomUUID(),
        summary: current.isPublished !== input.isPublished
          ? input.isPublished ? `Published event: ${input.name}.` : `Unpublished event: ${input.name}.`
          : `Updated event settings: ${input.name}.`,
        metadata: { before: current, after: input },
      },
    });
  });
  return getEventSettings(eventId);
}

export async function getEventOverview(eventId: string) {
  const prisma = getPrisma();
  const [event, registrations, attendeeCount, checkedInCount] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        slug: true,
        name: true,
        startsAt: true,
        endsAt: true,
        timezone: true,
        location: true,
        capacity: true,
        isPublished: true,
        registrationOpensOn: true,
        registrationClosesOn: true,
        waitlistEnabled: true,
        autoPromoteWaitlist: true,
      },
    }),
    prisma.registration.findMany({
      where: { eventId, status: { in: [...activeRegistrationStatuses] } },
      select: {
        totalAmount: true,
        payments: {
          where: { status: "SUCCEEDED" },
          select: { amount: true, refunds: { where: { status: "SUCCEEDED" }, select: { amount: true } } },
        },
      },
    }),
    prisma.registrationAttendee.count({
      where: {
        eventId,
        registration: { status: { in: [...activeRegistrationStatuses] } },
      },
    }),
    prisma.checkIn.count({
      where: {
        eventId,
        undoneAt: null,
        attendee: { registration: { status: { in: [...activeRegistrationStatuses] } } },
      },
    }),
  ]);

  if (!event) return null;

  let outstandingCents = 0;
  let pendingPaymentCount = 0;
  for (const registration of registrations) {
    const paid = registration.payments.reduce((paymentTotal, payment) => {
      const refunded = payment.refunds.reduce(
        (refundTotal, refund) => refundTotal + Math.round(Number(refund.amount) * 100),
        0,
      );
      return paymentTotal + Math.round(Number(payment.amount) * 100) - refunded;
    }, 0);
    const balance = Math.max(Math.round(Number(registration.totalAmount) * 100) - paid, 0);
    outstandingCents += balance;
    if (balance > 0) pendingPaymentCount += 1;
  }

  return {
    event,
    metrics: {
      registrations: registrations.length,
      people: attendeeCount,
      checkedIn: checkedInCount,
      expected: Math.max(attendeeCount - checkedInCount, 0),
      pendingPaymentCount,
      outstandingCents,
      waitlistedRegistrations: await prisma.registrationWaitlistEntry.count({
        where: { eventId, status: "WAITING" },
      }),
    },
    lifecycle: {
      phase: evaluateEventRegistrationPhase(event),
      remainingSpots: remainingEventCapacity(event.capacity, attendeeCount),
    },
  };
}

export async function getEventLifecycle(eventId: string, now = new Date()) {
  const prisma = getPrisma();
  const [event, occupied, waiting] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        timezone: true,
        capacity: true,
        isPublished: true,
        registrationOpensOn: true,
        registrationClosesOn: true,
        waitlistEnabled: true,
        autoPromoteWaitlist: true,
      },
    }),
    prisma.registrationAttendee.count({
      where: {
        eventId,
        registration: { status: { in: [...activeRegistrationStatuses] } },
      },
    }),
    prisma.registrationWaitlistEntry.count({ where: { eventId, status: "WAITING" } }),
  ]);
  if (!event) return null;
  return {
    ...event,
    phase: evaluateEventRegistrationPhase(event, now),
    occupied,
    remainingSpots: remainingEventCapacity(event.capacity, occupied),
    waiting,
  };
}

export async function updateEventLifecycle(
  eventId: string,
  input: EventLifecycleInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const current = await tx.event.findUnique({
      where: { id: eventId },
      select: {
        name: true,
        capacity: true,
        isPublished: true,
        registrationOpensOn: true,
        registrationClosesOn: true,
        waitlistEnabled: true,
        autoPromoteWaitlist: true,
      },
    });
    if (!current) return;
    await tx.event.update({ where: { id: eventId }, data: input });
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "EVENT_REGISTRATION_LIFECYCLE_UPDATED",
        entityType: "Event",
        entityId: eventId,
        correlationId: crypto.randomUUID(),
        summary: `Updated registration lifecycle settings for ${current.name}.`,
        metadata: { before: current, after: input },
      },
    });
  });
  return getEventLifecycle(eventId);
}
