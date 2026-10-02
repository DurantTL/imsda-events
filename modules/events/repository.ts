import { eventBillsSponsoredPromoCodes } from "@/modules/promo-codes/church-sponsored";
import { sumChurchSponsoredPromoCents } from "@/modules/promo-codes/church-sponsored-repository";
import type { MembershipRecord } from "@/modules/access/authorization";
import { Prisma } from "@prisma/client";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import { getPrisma } from "@/lib/prisma";
import {
  activeRegistrationStatuses,
  calendarDateInEventTimeZone,
  evaluateEventRegistrationPhase,
  remainingEventCapacity,
} from "@/modules/events/lifecycle";
import { CLUB_EVENT_BILLING_MESSAGE, getEventPublishReadiness } from "@/modules/events/readiness";
import { collectEventReadinessWarnings } from "@/modules/events/readiness-warnings";
import type { EventSettingsInput } from "@/modules/events/schemas";
import { writeDefaultModules } from "@/modules/event-modules/defaults";

export class EventOperationError extends Error {
  constructor(
    public readonly code: "EVENT_NOT_FOUND" | "EVENT_NOT_READY" | "EVENT_HAS_SPONSORED_PROMO_CODES" | "EVENT_BUSY",
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
      collectsShirtSizes: true,
      checksAdultBackgrounds: true,
      attendeeEditPolicy: true,
      billingMode: true,
      audience: true,
      seminarPreferenceClosesOn: true,
      seminarPreferenceSelfServiceLocked: true,
      autoPromoteWaitlist: true,
      publicInfoUrl: true,
      supportContact: true,
    },
  });
}

/**
 * Lodging fields are optional on the wire, and the two callers need opposite
 * readings of an omission.
 *
 * On create there is nothing to preserve, so an absent field is stored as "this
 * event books no rooms". On update an absent field must be left untouched: a
 * stale browser tab or an older API client saving an unrelated setting would
 * otherwise erase lodging it never knew existed. Prisma skips `undefined`
 * fields, so omitting the key entirely is what preserves the stored value —
 * whereas an explicit `null`, which staff clearing the input produces, still
 * writes the clear.
 */
type EventLodgingInput = Pick<
  EventSettingsInput,
  | "hotelName"
  | "hotelBookingUrl"
  | "hotelPhone"
  | "hotelGroupName"
  | "hotelRate"
  | "hotelInstructions"
>;

const LODGING_FIELDS = [
  "hotelName",
  "hotelBookingUrl",
  "hotelPhone",
  "hotelGroupName",
  "hotelRate",
  "hotelInstructions",
] as const satisfies readonly (keyof EventLodgingInput)[];

function lodgingCreateData(input: EventLodgingInput) {
  return Object.fromEntries(
    LODGING_FIELDS.map((field) => [field, input[field] ?? null]),
  ) as Record<keyof EventLodgingInput, string | null>;
}

function lodgingUpdateData(input: EventLodgingInput) {
  return Object.fromEntries(
    LODGING_FIELDS
      .filter((field) => input[field] !== undefined)
      .map((field) => [field, input[field] ?? null]),
  ) as Partial<Record<keyof EventLodgingInput, string | null>>;
}

export async function getEventSettings(eventId: string) {
  const prisma = getPrisma();
  const [event, publishedForms, paymentInstructions] = await Promise.all([
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
        tagline: true,
        subtitle: true,
        helpEmail: true,
        hotelName: true,
        hotelBookingUrl: true,
        hotelPhone: true,
        hotelGroupName: true,
        hotelRate: true,
        hotelInstructions: true,
        isPublished: true,
        registrationOpensOn: true,
        registrationClosesOn: true,
        waitlistEnabled: true,
        collectsShirtSizes: true,
        checksAdultBackgrounds: true,
        attendeeEditPolicy: true,
        billingMode: true,
        audience: true,
        seminarPreferenceClosesOn: true,
        seminarPreferenceSelfServiceLocked: true,
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
    prisma.eventPaymentInstructionVersion.findFirst({
      where: { eventId },
      orderBy: { versionNumber: "desc" },
      select: { instructions: true, versionNumber: true },
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
    tagline: event.tagline,
    subtitle: event.subtitle,
    helpEmail: event.helpEmail,
    hotelName: event.hotelName,
    hotelBookingUrl: event.hotelBookingUrl,
    hotelPhone: event.hotelPhone,
    hotelGroupName: event.hotelGroupName,
    hotelRate: event.hotelRate,
    hotelInstructions: event.hotelInstructions,
    approvedPaymentInstructions: paymentInstructions?.instructions ?? null,
    isPublished: event.isPublished,
    registrationOpensOn: event.registrationOpensOn,
    registrationClosesOn: event.registrationClosesOn,
    waitlistEnabled: event.waitlistEnabled,
    collectsShirtSizes: event.collectsShirtSizes,
    checksAdultBackgrounds: event.checksAdultBackgrounds,
    attendeeEditPolicy: event.attendeeEditPolicy,
    billingMode: event.billingMode,
    audience: event.audience,
    seminarPreferenceClosesOn: event.seminarPreferenceClosesOn,
    seminarPreferenceSelfServiceLocked:
      event.seminarPreferenceSelfServiceLocked,
    autoPromoteWaitlist: event.autoPromoteWaitlist,
    publishedFormCount,
    publishedForms,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString(),
  };
  return {
    ...view,
    readiness: getEventPublishReadiness(view, publishedFormCount),
    warnings: await collectEventReadinessWarnings(prisma, eventId, event.billingMode),
  };
}

export type EventSettingsRecord = NonNullable<Awaited<ReturnType<typeof getEventSettings>>>;

export async function createEvent(
  input: EventSettingsInput,
  actorUserId: string,
) {
  const audience = input.audience ?? "GENERAL";
  const eventId = await getPrisma().$transaction(async (tx) => {
    const platform = await tx.platformSettings.upsert({
      where: { id: "platform" },
      update: {},
      create: { id: "platform" },
      select: { defaultAttendeeEditPolicy: true },
    });
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
        tagline: input.tagline ?? null,
        subtitle: input.subtitle ?? null,
        helpEmail: input.helpEmail ?? null,
        ...lodgingCreateData(input),
        // Every new event starts as a draft (#471); only `publishEvent` publishes.
        isPublished: false,
        registrationOpensOn: input.registrationOpensOn,
        registrationClosesOn: input.registrationClosesOn,
        waitlistEnabled: input.waitlistEnabled,
        collectsShirtSizes: input.collectsShirtSizes,
        checksAdultBackgrounds: input.checksAdultBackgrounds,
        attendeeEditPolicy: platform.defaultAttendeeEditPolicy,
        billingMode: input.billingMode,
        audience,
        seminarPreferenceClosesOn: input.seminarPreferenceClosesOn,
        seminarPreferenceSelfServiceLocked:
          input.seminarPreferenceSelfServiceLocked,
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
    await writeDefaultModules(tx, event.id, audience);
    if (input.approvedPaymentInstructions) {
      await tx.eventPaymentInstructionVersion.create({
        data: {
          eventId: event.id,
          versionNumber: 1,
          instructions: input.approvedPaymentInstructions,
          approvedByUserId: actorUserId,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        eventId: event.id,
        actorUserId,
        action: "EVENT_CREATED",
        entityType: "Event",
        entityId: event.id,
        correlationId: crypto.randomUUID(),
        summary: `Created event draft: ${event.name}.`,
        // The initial audience (#481) is recorded, since it decides whether
        // the event gets club features at all.
        metadata: { slug: event.slug, audience: event.audience },
      },
    });
    return event.id;
  });
  return getEventSettings(eventId);
}

/**
 * Publishing and unpublishing are their own actions (#471), never a side
 * effect of this save: `isPublished` is not part of the settings input and
 * is deliberately left out of the update below, so a save that races a
 * publish or unpublish can never write a stale value back over it. Toggling
 * it requires `publishEvent` or `unpublishEvent` below, each with its own
 * readiness check (publish) and audit entry.
 */
export async function updateEventSettings(
  eventId: string,
  input: EventSettingsInput,
  actorUserId: string,
) {
  const prisma = getPrisma();
  try {
  await prisma.$transaction(async (tx) => {
    // Same lock a church-sponsor link takes (#545), so a link and a billing
    // or audience change cannot both pass their checks. NO KEY UPDATE does
    // not conflict with the FOR KEY SHARE lock registration and adjustment
    // inserts take on the event, so a save cannot stall registrations or
    // deadlock with a promo claim. Only the lock wait is bounded.
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR NO KEY UPDATE`;
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
    const [current, currentPaymentInstructions] = await Promise.all([
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
          tagline: true,
          subtitle: true,
          helpEmail: true,
          hotelName: true,
          hotelBookingUrl: true,
          hotelPhone: true,
          hotelGroupName: true,
          hotelRate: true,
          hotelInstructions: true,
          isPublished: true,
          registrationOpensOn: true,
          registrationClosesOn: true,
          waitlistEnabled: true,
          collectsShirtSizes: true,
          checksAdultBackgrounds: true,
          attendeeEditPolicy: true,
          billingMode: true,
          audience: true,
          seminarPreferenceClosesOn: true,
          seminarPreferenceSelfServiceLocked: true,
          autoPromoteWaitlist: true,
        },
      }),
      tx.eventPaymentInstructionVersion.findFirst({
        where: { eventId },
        orderBy: { versionNumber: "desc" },
        select: { instructions: true, versionNumber: true },
      }),
    ]);
    if (!current) {
      throw new EventOperationError("EVENT_NOT_FOUND", "That event no longer exists.");
    }
    // An update without an audience keeps the stored one (#481 review), so a
    // stale client can't silently reset a CLUB event to GENERAL.
    const audience = input.audience ?? current.audience;
    // A church is billed for sponsored promo codes only on a GENERAL,
    // attendee-paid event (#545). Leaving that would bill it twice or strand
    // its lines, so the sponsors must be unlinked first.
    if (!eventBillsSponsoredPromoCodes({ audience, billingMode: input.billingMode })) {
      const sponsored = await tx.promoCode.count({
        where: { eventId, sponsoringOrganizationId: { not: null } },
      });
      if (sponsored > 0) {
        throw new EventOperationError(
          "EVENT_HAS_SPONSORED_PROMO_CODES",
          "Unlink the church sponsors from this event's promo codes first. A church can sponsor codes only on a general event paid by attendees, and a sponsored code that has been used can't be unlinked, so an event with used sponsored codes stays general and attendee-paid.",
        );
      }
    }
    // A published event can't be switched into CLUB + attendee-pay (#565):
    // directors would lose it. Legacy mismatches are left as they are, and an
    // unpublished event may be saved with the mix (publishing is what blocks).
    if (
      current.isPublished &&
      audience === "CLUB" &&
      input.billingMode === "ATTENDEE_PAY" &&
      (audience !== current.audience || input.billingMode !== current.billingMode)
    ) {
      throw new EventOperationError("EVENT_NOT_READY", CLUB_EVENT_BILLING_MESSAGE);
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
        // Absent keeps the stored value; an explicit null clears it.
        tagline: input.tagline,
        subtitle: input.subtitle,
        helpEmail: input.helpEmail,
        ...lodgingUpdateData(input),
        // No `isPublished` here, on purpose (#471): see the function doc above.
        registrationOpensOn: input.registrationOpensOn,
        registrationClosesOn: input.registrationClosesOn,
        waitlistEnabled: input.waitlistEnabled,
        collectsShirtSizes: input.collectsShirtSizes,
        checksAdultBackgrounds: input.checksAdultBackgrounds,
        attendeeEditPolicy: input.attendeeEditPolicy,
        billingMode: input.billingMode,
        audience,
        seminarPreferenceClosesOn: input.seminarPreferenceClosesOn,
        seminarPreferenceSelfServiceLocked:
          input.seminarPreferenceSelfServiceLocked,
        autoPromoteWaitlist: input.autoPromoteWaitlist,
      },
    });
    // Switching an event to CLUB is a deliberate act (#741): it gets the club
    // modules, even one a system administrator had switched off. Switching away
    // from CLUB removes nothing.
    if (audience === "CLUB" && current.audience !== "CLUB") await writeDefaultModules(tx, eventId, "CLUB");
    const requestedInstructions = input.approvedPaymentInstructions;
    const previousInstructions = currentPaymentInstructions?.instructions ?? null;
    if (requestedInstructions !== undefined && requestedInstructions !== previousInstructions) {
      await tx.eventPaymentInstructionVersion.create({
        data: {
          eventId,
          versionNumber: (currentPaymentInstructions?.versionNumber ?? 0) + 1,
          instructions: requestedInstructions,
          approvedByUserId: actorUserId,
        },
      });
    }
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "EVENT_SETTINGS_UPDATED",
        entityType: "Event",
        entityId: eventId,
        correlationId: crypto.randomUUID(),
        summary: `Updated event settings: ${input.name}.`,
        metadata: { before: current, after: { ...input, audience } },
      },
    });
  });
  } catch (error) {
    if (isLockTimeoutError(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034")) {
      throw new EventOperationError(
        "EVENT_BUSY",
        "This event is being changed by someone else right now. Nothing was saved; try again in a moment.",
      );
    }
    throw error;
  }
  return getEventSettings(eventId);
}

/**
 * Publishing is its own action (#471), gated by the same readiness checklist
 * the settings form always showed (checked against the saved event), but no
 * longer reachable by saving that form. Idempotent under concurrency: the
 * flip is a conditional `updateMany` on `isPublished: false`, and the audit
 * entry is written only by the one request that actually changed it, so a
 * doubled click or a race with another tab never errors or double-audits.
 */
export async function publishEvent(eventId: string, actorUserId: string) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    // Lock the event row before reading it, so a settings save that clears a
    // checklist field waits for this publish (or runs first and is seen)
    // rather than landing between the readiness check and the flip.
    await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${eventId} FOR UPDATE`;
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
          publicInfoUrl: true,
          supportContact: true,
          isPublished: true,
          audience: true,
          billingMode: true,
        },
      }),
      tx.registrationFormVersion.count({
        where: { status: "PUBLISHED", form: { eventId } },
      }),
    ]);
    if (!current) {
      throw new EventOperationError("EVENT_NOT_FOUND", "That event no longer exists.");
    }
    if (current.isPublished) return;
    const readiness = getEventPublishReadiness(
      {
        name: current.name,
        slug: current.slug,
        startsOn: current.startsAt.toISOString().slice(0, 10),
        endsOn: current.endsAt.toISOString().slice(0, 10),
        timezone: current.timezone,
        location: current.location,
        publicInfoUrl: current.publicInfoUrl,
        supportContact: current.supportContact,
        audience: current.audience,
        billingMode: current.billingMode,
      },
      publishedFormCount,
    );
    if (!readiness.ready) {
      const incomplete = readiness.items.filter((item) => !item.complete);
      if (incomplete.length === 1 && incomplete[0]!.id === "club-billing") {
        throw new EventOperationError("EVENT_NOT_READY", CLUB_EVENT_BILLING_MESSAGE);
      }
      const missing = incomplete.map((item) =>
        item.label.toLowerCase(),
      );
      throw new EventOperationError(
        "EVENT_NOT_READY",
        `Finish the publish checklist first: ${missing.join(", ")}.`,
      );
    }
    const { count } = await tx.event.updateMany({
      where: { id: eventId, isPublished: false },
      data: { isPublished: true },
    });
    if (count !== 1) return;
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "EVENT_PUBLISHED",
        entityType: "Event",
        entityId: eventId,
        correlationId: crypto.randomUUID(),
        summary: `Published event: ${current.name}.`,
        metadata: { name: current.name },
      },
    });
  });
  return getEventSettings(eventId);
}

/**
 * Unpublish is its own action (#471), confirmed in-page rather than folded
 * into a settings save: it names the event and warns that every public
 * registration form closes immediately, since that's the whole effect.
 * Idempotent under concurrency the same way as `publishEvent`: a conditional
 * `updateMany` on `isPublished: true`, audited only when it changed a row.
 */
export async function unpublishEvent(eventId: string, actorUserId: string) {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const current = await tx.event.findUnique({
      where: { id: eventId },
      select: { name: true, isPublished: true },
    });
    if (!current) {
      throw new EventOperationError("EVENT_NOT_FOUND", "That event no longer exists.");
    }
    if (!current.isPublished) return;
    const { count } = await tx.event.updateMany({
      where: { id: eventId, isPublished: true },
      data: { isPublished: false },
    });
    if (count !== 1) return;
    await tx.auditLog.create({
      data: {
        eventId,
        actorUserId,
        action: "EVENT_UNPUBLISHED",
        entityType: "Event",
        entityId: eventId,
        correlationId: crypto.randomUUID(),
        summary: `Unpublished event: ${current.name}.`,
        metadata: { name: current.name },
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
        collectsShirtSizes: true,
        checksAdultBackgrounds: true,
        autoPromoteWaitlist: true,
        billingMode: true,
      },
    }),
    prisma.registration.findMany({
      where: { eventId, status: { in: [...activeRegistrationStatuses] } },
      select: {
        totalAmount: true,
        groupRegistration: { select: { id: true } },
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

  // A church-billed event (#409) never has attendee balances: its recorded
  // totals are what churches owe, billed after the event, so they count as
  // billed to churches rather than as outstanding or pending payment.
  const isDeferredOrganizationBilling = event.billingMode === "DEFERRED_ORGANIZATION_INVOICE";
  let outstandingCents = 0;
  let pendingPaymentCount = 0;
  let churchBilledCents = 0;
  // Group registrations (#650) are billed to their contact, never to a church,
  // so their totals stay out of churchBilledCents.
  let groupBilledCents = 0;
  for (const registration of registrations) {
    if (isDeferredOrganizationBilling) {
      const cents = Math.max(Math.round(Number(registration.totalAmount) * 100), 0);
      if (registration.groupRegistration) groupBilledCents += cents;
      else churchBilledCents += cents;
      continue;
    }
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
      isDeferredOrganizationBilling,
      churchBilledCents,
      groupBilledCents,
      // Discounts from church-sponsored promo codes billed to churches on a
      // GENERAL attendee-paid event (#545); 0 on any event that already bills
      // churches, so a church is never billed twice.
      churchSponsoredCents: await sumChurchSponsoredPromoCents(eventId, prisma),
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
        collectsShirtSizes: true,
        checksAdultBackgrounds: true,
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

/** Just the slug, for callers that only need a file name. Null when the event does not exist. */
export async function findEventSlug(eventId: string) {
  const event = await getPrisma().event.findUnique({
    where: { id: eventId },
    select: { slug: true },
  });
  return event?.slug ?? null;
}
