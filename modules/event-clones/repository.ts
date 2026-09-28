import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import { asEventMessageTemplateKey } from "@/modules/event-templates/domain";
import {
  buildClonePlan,
  canonicalJson,
  clonePricingSummary,
  pricingSummaryMessage,
  cloneRequestInputOf,
  cloneDomainKeys,
  confirmEventCloneInputSchema,
  EventCloneReviewError,
  excludedDomains,
  isCopyableMessageTemplate,
  parseFormDefinition,
  previewEventCloneInputSchema,
  reviewIssues,
  rewriteFormDefinitionForClone,
  sanitizeSourceForClone,
  type ClonePricingSummary,
  type ConfirmEventCloneInput,
  type SourceConfiguration,
} from "@/modules/event-clones/domain";
import { calendarDateInEventTimeZone } from "@/modules/events/lifecycle";
import { getEventSettings } from "@/modules/events/repository";
import { createRegistrationFormFromDefinitionInTransaction } from "@/modules/forms/repository";

export class EventCloneOperationError extends Error {
  constructor(
    public readonly code: "SOURCE_NOT_FOUND" | "SOURCE_CHANGED" | "SOURCE_BUSY" | "EVENT_SLUG_TAKEN" | "REQUEST_KEY_REUSED",
    message: string,
  ) {
    super(message);
    this.name = "EventCloneOperationError";
  }
}

type Db = Prisma.TransactionClient;

function eventDate(value: string) {
  return new Date(`${value}T12:00:00.000Z`);
}

/**
 * Reads everything a clone can copy from `eventId`, in one deterministic
 * shape (#157). Reads configuration only: no registration, attendee,
 * payment, check-in, outbox, audit, or other transactional table is touched
 * here, so nothing private can reach the plan, the fingerprint, or the copy.
 * The plan, the fingerprint, and the copy all come from this one object, so
 * what the reviewer saw is exactly what is copied.
 */
async function loadSourceConfiguration(db: Db, eventId: string): Promise<SourceConfiguration | null> {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: {
      id: true, name: true, slug: true, startsAt: true, endsAt: true, timezone: true, isPublished: true,
      location: true, publicInfoUrl: true, supportContact: true, calendarCategory: true, showOnCalendar: true,
      hotelName: true, hotelBookingUrl: true, hotelPhone: true, hotelGroupName: true, hotelRate: true, hotelInstructions: true,
      audience: true, billingMode: true,
      waitlistEnabled: true, autoPromoteWaitlist: true, collectsShirtSizes: true, checksAdultBackgrounds: true,
    },
  });
  if (!event) return null;

  const [community, sections, forms, attendeeTypes, classifications, messageTemplates, tags, promoCodes, honorSessions, honorOfferings,
    merchandiseProducts, paymentInstructionVersions, messageDeliverySettings, uploadedFiles] = [
    await db.eventCommunitySettings.findUnique({ where: { eventId } }),
    await db.eventContentSection.findMany({
      where: { eventId }, orderBy: [{ position: "asc" }, { id: "asc" }],
      include: { links: { orderBy: [{ position: "asc" }, { id: "asc" }] } },
    }),
    await db.registrationForm.findMany({
      where: { eventId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { versionNumber: "desc" }, take: 1 } },
    }),
    await db.eventAttendeeType.findMany({ where: { eventId }, orderBy: { code: "asc" } }),
    await db.eventAttendeeClassification.findMany({ where: { eventId }, orderBy: [{ kind: "asc" }, { code: "asc" }] }),
    await db.eventMessageTemplate.findMany({
      where: { eventId }, orderBy: { key: "asc" },
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { versionNumber: "desc" }, take: 1 } },
    }),
    await db.eventTag.findMany({ where: { eventId }, orderBy: { normalizedName: "asc" } }),
    await db.promoCode.findMany({ where: { eventId }, orderBy: { normalizedCode: "asc" } }),
    await db.honorSession.findMany({ where: { eventId }, orderBy: [{ sortOrder: "asc" }, { normalizedName: "asc" }] }),
    await db.honorOffering.findMany({
      where: { eventId }, orderBy: [{ sessionId: "asc" }, { honorId: "asc" }],
      include: { honor: { select: { name: true } }, session: { select: { name: true } } },
    }),
    await db.merchandiseProduct.count({ where: { eventId } }),
    await db.eventPaymentInstructionVersion.count({ where: { eventId } }),
    await db.eventMessageSettings.count({ where: { eventId } }),
    await db.eventAsset.count({ where: { eventId } }),
  ];

  const currentForms = forms.filter((form) => form.status !== "ARCHIVED" && form.versions.length > 0);
  const currentTemplates = messageTemplates.filter((template) => template.versions.length > 0);

  return {
    event: {
      id: event.id, name: event.name, slug: event.slug,
      startsOn: calendarDateInEventTimeZone(event.startsAt, event.timezone),
      endsOn: calendarDateInEventTimeZone(event.endsAt, event.timezone),
      isPublished: event.isPublished,
    },
    eventDetails: {
      location: event.location, timezone: event.timezone, publicInfoUrl: event.publicInfoUrl, supportContact: event.supportContact,
      calendarCategory: event.calendarCategory, showOnCalendar: event.showOnCalendar, hotelName: event.hotelName, hotelBookingUrl: event.hotelBookingUrl,
      hotelPhone: event.hotelPhone, hotelGroupName: event.hotelGroupName, hotelRate: event.hotelRate,
      hotelInstructions: event.hotelInstructions, audience: event.audience, billingMode: event.billingMode,
    },
    moduleToggles: {
      waitlistEnabled: event.waitlistEnabled, autoPromoteWaitlist: event.autoPromoteWaitlist,
      collectsShirtSizes: event.collectsShirtSizes, checksAdultBackgrounds: event.checksAdultBackgrounds,
      community: community
        ? { isEnabled: community.isEnabled, allowNewPosts: community.allowNewPosts, allowReplies: community.allowReplies, conductText: community.conductText, retentionDays: community.retentionDays }
        : null,
    },
    contentSections: sections.map((section) => ({
      kind: section.kind, title: section.title, body: section.body, position: section.position,
      links: section.links
        .filter((link) => link.assetId === null && link.url !== null)
        .map((link) => ({ label: link.label, description: link.description, url: link.url!, position: link.position })),
      assetLinkCount: section.links.filter((link) => link.assetId !== null || link.url === null).length,
    })),
    registrationForms: currentForms.map((form) => ({
      formId: form.id, name: form.name, slug: form.slug,
      versionId: form.versions[0]!.id, versionNumber: form.versions[0]!.versionNumber, definition: form.versions[0]!.definition,
    })),
    formsWithoutPublishedVersion: forms.length - currentForms.length,
    attendeeTypes: attendeeTypes.map((type) => ({
      code: type.code, label: type.label, description: type.description, sortOrder: type.sortOrder,
      isActive: type.isActive, minimumAge: type.minimumAge, maximumAge: type.maximumAge,
    })),
    attendeeClassifications: classifications.map((classification) => ({
      kind: classification.kind, code: classification.code, label: classification.label,
      description: classification.description, sortOrder: classification.sortOrder, isActive: classification.isActive,
    })),
    messageTemplates: currentTemplates.map((template) => ({
      key: template.key, isEnabled: template.isEnabled, versionId: template.versions[0]!.id,
      versionNumber: template.versions[0]!.versionNumber, subjectTemplate: template.versions[0]!.subjectTemplate,
      bodyTemplate: template.versions[0]!.bodyTemplate,
    })),
    messageTemplatesWithoutPublishedVersion: messageTemplates.length - currentTemplates.length,
    tags: tags.map((tag) => ({ name: tag.name, normalizedName: tag.normalizedName, color: tag.color, description: tag.description, isActive: tag.isActive })),
    promoCodes: promoCodes.map((promo) => ({
      id: promo.id, code: promo.code, normalizedCode: promo.normalizedCode, discountType: promo.discountType,
      discountValue: promo.discountValue, startsOn: promo.startsOn, endsOn: promo.endsOn,
      minimumSubtotalCents: promo.minimumSubtotalCents, maximumUses: promo.maximumUses, maximumDiscountCents: promo.maximumDiscountCents,
    })),
    honorSessions: honorSessions.map((session) => ({ id: session.id, name: session.name, normalizedName: session.normalizedName, sortOrder: session.sortOrder })),
    honorOfferings: honorOfferings.map((offering) => ({
      id: offering.id, honorId: offering.honorId, honorName: offering.honor.name, sessionId: offering.sessionId,
      sessionName: offering.session?.name ?? null, span: offering.span, capacity: offering.capacity,
      minimumAge: offering.minimumAge, perClubLimit: offering.perClubLimit, teacherName: offering.teacherName,
      location: offering.location, isActive: offering.isActive,
    })),
    unsupported: { merchandiseProducts, paymentInstructionVersions, messageDeliverySettings, uploadedFiles },
  };
}

/** Hash of the copyable configuration (never the event's own identity or the
 * unsupported-domain counts), so any edit to what a clone would copy changes
 * it and a stale confirm is refused (#157). */
function fingerprintOf(config: SourceConfiguration) {
  const hashed = { ...config, event: { id: config.event.id }, unsupported: null };
  return createHash("sha256").update(canonicalJson(hashed)).digest("hex");
}

/**
 * The domain-by-domain plan for cloning `sourceEventId` (#157), with the
 * fingerprint the confirm must echo. Audited with ids and counts only.
 */
export async function previewEventClone(actorUserId: string, rawInput: unknown) {
  const { sourceEventId } = previewEventCloneInputSchema.parse(rawInput);
  const prisma = getPrisma();
  const config = await loadSourceConfiguration(prisma, sourceEventId);
  if (!config) throw new EventCloneOperationError("SOURCE_NOT_FOUND", "That source event was not found.");
  const plan = buildClonePlan(config, fingerprintOf(config));
  await prisma.auditLog.create({ data: {
    eventId: sourceEventId, actorUserId, action: "EVENT_CLONE_PREVIEWED", entityType: "Event", entityId: sourceEventId,
    correlationId: randomUUID(), summary: "Previewed copying this event into a new draft.",
    metadata: { sourceEventId, fingerprint: plan.fingerprint, counts: Object.fromEntries(plan.domains.map((domain) => [domain.key, domain.count])) },
  } });
  return plan;
}

/**
 * Resolves a stored clone for this actor's `requestKey`: the same request
 * returns the event the first attempt created; anything else is a reused key
 * and is refused rather than returning an event the caller did not ask for.
 * Compared before the source is read, so a retry after success never reports
 * SOURCE_CHANGED for edits made since.
 */
async function resolveExistingClone(actorUserId: string, input: ConfirmEventCloneInput) {
  const existing = await getPrisma().eventCloneRecord.findUnique({
    where: { actorUserId_requestKey: { actorUserId, requestKey: input.requestKey } },
  });
  if (!existing) return null;
  if (canonicalJson(existing.requestInput) !== canonicalJson(cloneRequestInputOf(input))) {
    throw new EventCloneOperationError("REQUEST_KEY_REUSED", "This request was already used to create a different event. Reload the page and try again.");
  }
  const snapshot = existing.snapshot as { summary?: CloneResultSummary } | null;
  return { event: (await getEventSettings(existing.resultEventId))!, alreadyCloned: true, summary: snapshot?.summary ?? null };
}

/** What the result screen shows after a clone (#157), kept in the clone record's snapshot. */
export type CloneResultSummary = {
  copiedCounts: Record<string, number>;
  skipped: { forms: number; messageTemplates: number; assetLinks: number; privateLinks: number };
  pricing: ClonePricingSummary;
  pricingMessage: string | null;
};

/** Bounded wait for the source row lock; past it the clone is SOURCE_BUSY, never a hang. */
const sourceLockTimeout = "5s";

/**
 * Confirms a reviewed clone: creates one new DRAFT event and copies only the
 * selected, supported configuration into it (#157), then records provenance
 * in `EventCloneRecord`.
 *
 * Safety properties, in the order they are enforced:
 * - Idempotent per actor by `requestKey`: a finished request is detected up
 *   front and again on any unique-constraint race, so retries and parallel
 *   duplicates return the one event the first attempt created.
 * - The source `Event` row is share-locked for the whole copy (waiting at
 *   most `sourceLockTimeout`, then `SOURCE_BUSY`). `FOR SHARE` protects only
 *   that row, so an edit to the event's own settings waits, but child
 *   configuration (forms, sections, promo codes, offerings, ...) is not
 *   locked. Such edits are caught instead by the fingerprint: the
 *   configuration is read inside the transaction and must hash to the value
 *   the reviewer previewed (`SOURCE_CHANGED` otherwise), and the copy is made
 *   from that very object.
 * - Every date-bound or capacity value the selected domains need must have
 *   been supplied anew (`reviewIssues`); nothing is shifted or defaulted.
 * - Private links in copied text are removed (`sanitizeSourceForClone`).
 * - Only configuration tables are read (see `loadSourceConfiguration`), so no
 *   registration, payment, check-in, outbox, audit, or protected data can be
 *   copied. The new event is unpublished and its creator is its administrator.
 */
export async function cloneEvent(actorUserId: string, rawInput: unknown) {
  const input = confirmEventCloneInputSchema.parse(rawInput);
  const prisma = getPrisma();

  const alreadyCloned = await resolveExistingClone(actorUserId, input);
  if (alreadyCloned) return alreadyCloned;

  try {
    const { eventId, summary } = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${sourceLockTimeout}'`);
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Event" WHERE "id" = ${input.sourceEventId} FOR SHARE`;
      if (locked.length === 0) throw new EventCloneOperationError("SOURCE_NOT_FOUND", "That source event was not found.");
      const sourceConfig = await loadSourceConfiguration(tx, input.sourceEventId);
      if (!sourceConfig) throw new EventCloneOperationError("SOURCE_NOT_FOUND", "That source event was not found.");
      const fingerprint = fingerprintOf(sourceConfig);
      if (fingerprint !== input.expectedFingerprint) {
        throw new EventCloneOperationError("SOURCE_CHANGED", "The source event changed after you previewed it. Preview it again and review the plan.");
      }
      const issues = reviewIssues(sourceConfig, input);
      if (issues.length > 0) throw new EventCloneReviewError(issues);
      // Copy from the text as previewed: private links removed.
      const { config, findings } = sanitizeSourceForClone(sourceConfig);
      const strippedPrivateLinks = findings.filter((finding) => input.include[finding.domain]).length;

      const include = input.include;
      const platform = await tx.platformSettings.upsert({
        where: { id: "platform" }, update: {}, create: { id: "platform" }, select: { defaultAttendeeEditPolicy: true },
      });
      const details = include.eventDetails ? config.eventDetails : null;
      const toggles = include.moduleToggles ? config.moduleToggles : null;
      const event = await tx.event.create({
        data: {
          name: input.name,
          slug: input.slug,
          startsAt: eventDate(input.startsOn),
          endsAt: eventDate(input.endsOn),
          // Reset, never copied: nothing is public until staff publish.
          isPublished: false,
          capacity: input.capacity.value,
          registrationOpensOn: input.registrationOpensOn.value,
          registrationClosesOn: input.registrationClosesOn.value,
          seminarPreferenceClosesOn: null,
          seminarPreferenceSelfServiceLocked: false,
          attendeeEditPolicy: platform.defaultAttendeeEditPolicy,
          ...(details ? {
            timezone: details.timezone, location: details.location, publicInfoUrl: details.publicInfoUrl,
            supportContact: details.supportContact, calendarCategory: details.calendarCategory, showOnCalendar: details.showOnCalendar,
            hotelName: details.hotelName, hotelBookingUrl: details.hotelBookingUrl, hotelPhone: details.hotelPhone,
            hotelGroupName: details.hotelGroupName, hotelRate: details.hotelRate, hotelInstructions: details.hotelInstructions,
            audience: details.audience, billingMode: details.billingMode,
          } : {}),
          waitlistEnabled: toggles?.waitlistEnabled ?? false,
          autoPromoteWaitlist: toggles?.waitlistEnabled ? toggles.autoPromoteWaitlist : false,
          collectsShirtSizes: toggles?.collectsShirtSizes ?? false,
          checksAdultBackgrounds: toggles?.checksAdultBackgrounds ?? false,
        },
      });
      await tx.eventMembership.create({ data: { eventId: event.id, userId: actorUserId, role: "EVENT_ADMIN", status: "ACTIVE" } });

      const copied: Record<string, number> = Object.fromEntries(cloneDomainKeys.map((key) => [key, 0]));
      const sourceVersions: { forms: Array<{ sourceFormId: string; versionId: string; versionNumber: number; newFormId: string }>; messageTemplates: Array<{ key: string; versionId: string; versionNumber: number }> } = { forms: [], messageTemplates: [] };
      const skipped = { forms: 0, messageTemplates: 0, assetLinks: 0, privateLinks: strippedPrivateLinks };

      if (include.eventDetails) copied.eventDetails = 1;
      if (include.moduleToggles) {
        copied.moduleToggles = 4;
        const community = config.moduleToggles.community;
        if (community) {
          await tx.eventCommunitySettings.create({ data: { eventId: event.id, ...community, updatedByUserId: actorUserId } });
          copied.moduleToggles += 1;
        }
      }

      if (include.attendeeTypes && config.attendeeTypes.length > 0) {
        await tx.eventAttendeeType.createMany({ data: config.attendeeTypes.map((type) => ({ eventId: event.id, ...type })) });
        copied.attendeeTypes = config.attendeeTypes.length;
      }
      if (include.attendeeClassifications && config.attendeeClassifications.length > 0) {
        await tx.eventAttendeeClassification.createMany({
          data: config.attendeeClassifications.map((classification) => ({ eventId: event.id, ...classification, kind: classification.kind as "CATEGORY" })),
        });
        copied.attendeeClassifications = config.attendeeClassifications.length;
      }
      if (include.tags && config.tags.length > 0) {
        await tx.eventTag.createMany({ data: config.tags.map((tag) => ({ eventId: event.id, ...tag })) });
        copied.tags = config.tags.length;
      }

      if (include.contentSections) {
        for (const section of config.contentSections) {
          await tx.eventContentSection.create({
            data: {
              eventId: event.id, kind: section.kind, title: section.title, body: section.body, position: section.position,
              // Reset: a copied section is hidden until staff publish it.
              isPublished: false,
              links: { create: section.links },
            },
          });
          skipped.assetLinks += section.assetLinkCount;
        }
        copied.contentSections = config.contentSections.length;
      }

      if (include.registrationForms) {
        for (const form of config.registrationForms) {
          const definition = parseFormDefinition(form.definition);
          if (!definition) { skipped.forms += 1; continue; }
          const dates = new Map(input.formLatePricingDates.filter((entry) => entry.formId === form.formId).map((entry) => [entry.fieldKey, entry.startsOn]));
          const limits = new Map<string, Map<string, number | null>>();
          for (const entry of input.formChoiceLimits) {
            if (entry.formId !== form.formId) continue;
            const field = limits.get(entry.fieldKey) ?? new Map<string, number | null>();
            field.set(entry.choice, entry.limit);
            limits.set(entry.fieldKey, field);
          }
          const created = await createRegistrationFormFromDefinitionInTransaction(tx, event.id, actorUserId, {
            definition: rewriteFormDefinitionForClone(definition, dates, limits),
            preferredSlug: form.slug,
            summary: (formName) => `Copied ${formName} from the published version of a prior event's form.`,
            metadata: { sourceEventId: config.event.id, sourceFormId: form.formId, sourceVersionId: form.versionId, sourceVersionNumber: form.versionNumber },
          });
          sourceVersions.forms.push({ sourceFormId: form.formId, versionId: form.versionId, versionNumber: form.versionNumber, newFormId: created.id });
        }
        copied.registrationForms = sourceVersions.forms.length;
        skipped.forms += config.formsWithoutPublishedVersion;
      }

      if (include.messageTemplates) {
        for (const template of config.messageTemplates) {
          if (!isCopyableMessageTemplate(template)) { skipped.messageTemplates += 1; continue; }
          // Copied live, deliberately: a PUBLISHED version 1 of the source's
          // current published text, keeping the source's `isEnabled` switch.
          await tx.eventMessageTemplate.create({
            data: {
              eventId: event.id,
              key: asEventMessageTemplateKey(template.key),
              isEnabled: template.isEnabled,
              versions: { create: {
                createdByUserId: actorUserId, versionNumber: 1, status: "PUBLISHED",
                subjectTemplate: template.subjectTemplate, bodyTemplate: template.bodyTemplate, publishedAt: new Date(),
              } },
            },
          });
          sourceVersions.messageTemplates.push({ key: template.key, versionId: template.versionId, versionNumber: template.versionNumber });
        }
        copied.messageTemplates = sourceVersions.messageTemplates.length;
        skipped.messageTemplates += config.messageTemplatesWithoutPublishedVersion;
      }

      if (include.promoCodes) {
        const windows = new Map(input.promoCodeWindows.map((window) => [window.promoCodeId, window]));
        for (const promo of config.promoCodes) {
          const window = windows.get(promo.id)!;
          await tx.promoCode.create({
            data: {
              eventId: event.id, code: promo.code, normalizedCode: promo.normalizedCode,
              // Reset: inactive until staff review and activate; usage starts at zero.
              isActive: false, redeemedCount: 0,
              discountType: promo.discountType, discountValue: promo.discountValue,
              startsOn: window.startsOn.value, endsOn: window.endsOn.value,
              // Copied as they are (#157): the inactive code is the review point.
              minimumSubtotalCents: promo.minimumSubtotalCents, maximumUses: promo.maximumUses,
              maximumDiscountCents: promo.maximumDiscountCents,
            },
          });
        }
        copied.promoCodes = config.promoCodes.length;
      }

      if (include.honors) {
        const sessionIds = new Map<string, string>();
        for (const session of config.honorSessions) {
          const created = await tx.honorSession.create({
            data: { eventId: event.id, name: session.name, normalizedName: session.normalizedName, sortOrder: session.sortOrder },
          });
          sessionIds.set(session.id, created.id);
        }
        const reviewedOfferings = new Map(input.honorOfferingCapacities.map((entry) => [entry.offeringId, entry]));
        for (const offering of config.honorOfferings) {
          await tx.honorOffering.create({
            data: {
              eventId: event.id, honorId: offering.honorId,
              sessionId: offering.sessionId ? sessionIds.get(offering.sessionId) ?? null : null,
              span: offering.span, capacity: reviewedOfferings.get(offering.id)!.capacity,
              perClubLimit: reviewedOfferings.get(offering.id)!.perClubLimit,
              // Carried over as it is; shown in the preview.
              minimumAge: offering.minimumAge,
              teacherName: offering.teacherName, location: offering.location, isActive: offering.isActive,
            },
          });
        }
        copied.honors = config.honorOfferings.length;
      }

      const excluded = excludedDomains(include);
      const pricing = clonePricingSummary(config, include);
      const summary: CloneResultSummary = { copiedCounts: copied, skipped, pricing, pricingMessage: pricingSummaryMessage(pricing) };
      const record = await tx.eventCloneRecord.create({
        data: {
          sourceEventId: config.event.id,
          resultEventId: event.id,
          actorUserId,
          requestKey: input.requestKey,
          requestInput: cloneRequestInputOf(input) as unknown as Prisma.InputJsonValue,
          sourceFingerprint: fingerprint,
          sourceVersions: sourceVersions as unknown as Prisma.InputJsonValue,
          selections: include as unknown as Prisma.InputJsonValue,
          exclusions: { excludedDomains: excluded, unsupported: ["merchandise", "paymentInstructions", "messageDelivery", "uploadedFiles"] } as Prisma.InputJsonValue,
          snapshot: {
            source: config.event,
            copiedCounts: copied,
            skipped,
            summary,
            reset: {
              isPublished: false,
              capacity: input.capacity.value,
              registrationOpensOn: input.registrationOpensOn.value,
              registrationClosesOn: input.registrationClosesOn.value,
              formLatePricingDates: input.formLatePricingDates.length,
              formChoiceLimits: input.formChoiceLimits.length,
              promoCodeWindows: input.promoCodeWindows.length,
              honorOfferingCapacities: input.honorOfferingCapacities.length,
            },
          } as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({ data: {
        eventId: event.id, actorUserId, action: "EVENT_CLONED", entityType: "Event", entityId: event.id,
        correlationId: randomUUID(), summary: `Created event draft "${event.name}" by copying the configuration of a prior event.`,
        metadata: {
          sourceEventId: config.event.id, cloneRecordId: record.id, slug: event.slug, fingerprint,
          copiedCounts: copied, skipped, excludedDomains: excluded,
        },
      } });
      return { eventId: event.id, summary };
    }, { timeout: 30_000, maxWait: 10_000 });
    // Read back only after commit: the outer client is a separate connection.
    return { event: (await getEventSettings(eventId))!, alreadyCloned: false, summary };
  } catch (error) {
    if (isLockTimeoutError(error)) {
      throw new EventCloneOperationError("SOURCE_BUSY", "The source event is busy right now. Try again in a moment.");
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Whatever constraint fired, a concurrent request with this actor's key
      // may have committed first (typically the new event's slug, inserted
      // before the clone record). Its record decides.
      const raced = await resolveExistingClone(actorUserId, input);
      if (raced) return raced;
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
      if (target.includes("slug")) {
        throw new EventCloneOperationError("EVENT_SLUG_TAKEN", "That event web address is already in use. Choose another short address.");
      }
    }
    throw error;
  }
}
