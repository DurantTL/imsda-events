import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type EventTemplateStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  applyEventTemplateInputSchema,
  eventTemplatePayloadSchema,
  parseEventTemplatePayload,
  templateBillingMode,
  validateEventTemplatePayloadReferences,
  asEventMessageTemplateKey,
  type ApplyEventTemplateInput,
  type EventTemplatePayload,
} from "@/modules/event-templates/domain";
import { activeCoordinatorAccountIds } from "@/modules/event-locations/coordinators";
import { normalizeLocationName, shiftCalendarDate } from "@/modules/event-locations/domain";
import { createRegistrationFormFromTemplateInTransaction } from "@/modules/forms/repository";
import { getEventSettings } from "@/modules/events/repository";
import { writeDefaultModules } from "@/modules/event-modules/defaults";
export class EventTemplateOperationError extends Error {
  constructor(
    public readonly code:
      | "TEMPLATE_NOT_FOUND"
      | "TEMPLATE_ARCHIVED"
      | "TEMPLATE_NOT_ARCHIVED"
      | "NO_DRAFT"
      | "NO_PUBLISHED_VERSION"
      | "VERSION_NOT_FOUND"
      | "EDIT_CONFLICT"
      | "EVENT_SLUG_TAKEN"
      | "REQUEST_KEY_REUSED",
    message: string,
  ) {
    super(message);
    this.name = "EventTemplateOperationError";
  }
}

function eventDate(value: string) {
  return new Date(`${value}T12:00:00.000Z`);
}

const templateInclude = {
  createdBy: { select: { displayName: true } },
  versions: {
    orderBy: { versionNumber: "desc" as const },
    include: { createdBy: { select: { displayName: true } } },
  },
} satisfies Prisma.EventTemplateInclude;

type TemplateWithVersions = Prisma.EventTemplateGetPayload<{ include: typeof templateInclude }>;

function payloadIssues(value: Prisma.JsonValue): string[] {
  const result = eventTemplatePayloadSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
}

/**
 * The display shape of a template. Payloads are only `safeParse`d here (N6):
 * a stored version that no longer satisfies the current schema is shown with
 * its raw JSON and its `payloadIssues`, instead of one stale version making
 * every templates page fail. Publish and apply still parse strictly.
 *
 * `audience` comes from the payload only — the published version's when
 * there is one (exactly what applying will create), otherwise the current
 * draft's. `canApply` mirrors what `applyEventTemplate` accepts: not
 * archived, and a published version whose payload is valid.
 */
function serializeTemplate(template: TemplateWithVersions) {
  const versions = template.versions.map((version) => ({
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    payload: version.payload,
    payloadIssues: payloadIssues(version.payload),
    publishedAt: version.publishedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    createdBy: version.createdBy.displayName,
  }));
  const published = versions.find((version) => version.status === "PUBLISHED") ?? null;
  const draft = versions.find((version) => version.status === "DRAFT") ?? null;
  const audienceSource = published ?? draft;
  const parsedAudience = audienceSource ? eventTemplatePayloadSchema.safeParse(audienceSource.payload) : null;
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    audience: parsedAudience?.success ? parsedAudience.data.audience : "GENERAL" as const,
    status: template.status,
    canApply: template.status !== "ARCHIVED" && published !== null && published.payloadIssues.length === 0,
    createdBy: template.createdBy.displayName,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    versions,
  };
}

export type EventTemplateRecord = ReturnType<typeof serializeTemplate>;

async function loadTemplate(templateId: string) {
  return getPrisma().eventTemplate.findUnique({ where: { id: templateId }, include: templateInclude });
}

/**
 * Takes a row lock on the template inside `tx` and returns its current
 * status. Every template mutation (save, publish, archive) takes `FOR
 * UPDATE`, so they serialize per template and each one reads the versions
 * only after the previous one has committed; applying takes `FOR SHARE`, so
 * a concurrent archive or publish cannot land between its checks and its
 * writes.
 */
async function lockTemplate(tx: Prisma.TransactionClient, templateId: string, mode: "UPDATE" | "SHARE") {
  // Bounded wait: past it the lock is SQLSTATE 55P03, reported as TEMPLATE_BUSY.
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
  const rows = mode === "UPDATE"
    ? await tx.$queryRaw<{ status: EventTemplateStatus }[]>`SELECT "status"::text AS "status" FROM "EventTemplate" WHERE "id" = ${templateId} FOR UPDATE`
    : await tx.$queryRaw<{ status: EventTemplateStatus }[]>`SELECT "status"::text AS "status" FROM "EventTemplate" WHERE "id" = ${templateId} FOR SHARE`;
  // Only the template lock wait is bounded; later waits in the transaction are not.
  await tx.$executeRawUnsafe("SET LOCAL lock_timeout = 0");
  const row = rows[0];
  if (!row) throw new EventTemplateOperationError("TEMPLATE_NOT_FOUND", "That event template was not found.");
  return row.status;
}

function refuseArchived(status: EventTemplateStatus, action: string) {
  if (status === "ARCHIVED") {
    throw new EventTemplateOperationError("TEMPLATE_ARCHIVED", `This event template is archived and cannot be ${action}.`);
  }
}

export async function listEventTemplates() {
  const templates = await getPrisma().eventTemplate.findMany({
    include: templateInclude,
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
  return templates.map(serializeTemplate);
}

export async function getEventTemplate(templateId: string) {
  const template = await loadTemplate(templateId);
  if (!template) throw new EventTemplateOperationError("TEMPLATE_NOT_FOUND", "That event template was not found.");
  return serializeTemplate(template);
}

/** Every new template starts as a name/description with one DRAFT version
 * (#152) whose payload carries only the chosen audience, exactly like a new
 * registration form starts from a chosen template but with nothing filled
 * in yet. */
export async function createEventTemplate(actorUserId: string, input: { name: string; description: string; audience: "GENERAL" | "CLUB" }) {
  const created = await getPrisma().$transaction(async (tx) => {
    const template = await tx.eventTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        createdByUserId: actorUserId,
        versions: {
          create: {
            createdByUserId: actorUserId,
            versionNumber: 1,
            payload: eventTemplatePayloadSchema.parse({ audience: input.audience }) as Prisma.InputJsonValue,
          },
        },
      },
    });
    await tx.auditLog.create({ data: {
      actorUserId, action: "EVENT_TEMPLATE_CREATED", entityType: "EventTemplate", entityId: template.id,
      correlationId: randomUUID(), summary: `Created event template ${template.name}.`, metadata: { audience: input.audience },
    } });
    return template;
  });
  return getEventTemplate(created.id);
}

/**
 * Saves the template's current draft version, or opens a new draft over the
 * published version — the same shape as `updateRegistrationForm`.
 *
 * Concurrency (#152 B1): the template row is locked first, the versions are
 * read only after that, and `expectedUpdatedAt` must equal the `updatedAt`
 * of the version the editor loaded (the draft, or the published version a
 * new draft is opened from). The draft is then written by compare-and-set on
 * its id, DRAFT status, and `updatedAt`, so a published version's payload can
 * never be overwritten, even by a save that raced a publish.
 *
 * `payload` is validated against its own schema by the caller; the second,
 * reference-availability check happens only at publish and at apply, since a
 * draft is allowed to name something that does not exist yet. An archived
 * template stays archived: saving it is refused.
 */
export async function saveEventTemplateDraft(
  templateId: string,
  actorUserId: string,
  input: { name: string; description: string; payload: EventTemplatePayload; expectedUpdatedAt: string },
) {
  await getPrisma().$transaction(async (tx) => {
    refuseArchived(await lockTemplate(tx, templateId, "UPDATE"), "edited");
    const versions = await tx.eventTemplateVersion.findMany({ where: { templateId }, orderBy: { versionNumber: "desc" } });
    const draft = versions.find((version) => version.status === "DRAFT");
    const current = draft ?? versions.find((version) => version.status === "PUBLISHED") ?? versions[0];
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt).getTime();
    if (!current || current.updatedAt.getTime() !== expectedUpdatedAt) {
      throw new EventTemplateOperationError("EDIT_CONFLICT", "This template changed in another session. Reload it before saving again.");
    }
    // `starterKey` is server-owned (#546): only "Add starter templates" and the
    // seed set it. Whatever the client sent is dropped, and the key already
    // stored on this template (or none) is written, so a save can neither
    // forge a starter's identity nor lose it.
    const storedStarterKey = versions.map((version) => (version.payload as { starterKey?: unknown } | null)?.starterKey).find((key) => typeof key === "string");
    const clientPayload = { ...input.payload };
    delete clientPayload.starterKey;
    const payload = (typeof storedStarterKey === "string"
      ? { ...clientPayload, starterKey: storedStarterKey }
      : clientPayload) as unknown as Prisma.InputJsonValue;
    if (draft) {
      const { count } = await tx.eventTemplateVersion.updateMany({
        where: { id: draft.id, status: "DRAFT", updatedAt: draft.updatedAt },
        data: { payload, createdByUserId: actorUserId, updatedAt: new Date() },
      });
      if (count === 0) {
        throw new EventTemplateOperationError("EDIT_CONFLICT", "This draft changed in another session. Reload it before saving again.");
      }
    } else {
      await tx.eventTemplateVersion.create({
        data: {
          templateId,
          createdByUserId: actorUserId,
          versionNumber: (versions[0]?.versionNumber ?? 0) + 1,
          status: "DRAFT",
          payload,
        },
      });
    }
    // The template's own status is left alone: a published template with a
    // new draft is still published (and still appliable) until it is
    // archived.
    await tx.eventTemplate.update({ where: { id: templateId }, data: { name: input.name, description: input.description } });
    await tx.auditLog.create({ data: {
      actorUserId, action: "EVENT_TEMPLATE_DRAFT_SAVED", entityType: "EventTemplate", entityId: templateId,
      correlationId: randomUUID(), summary: `Saved a draft of ${input.name}.`, metadata: {},
    } });
  });
  return getEventTemplate(templateId);
}

/** Publishes the current draft version. Once published, a version's payload
 * is never edited again (#152) — a later change opens a new draft version
 * instead, so every event already applied from this one stays untouched.
 *
 * The template row is locked before the draft is read and validated, and the
 * draft flips to PUBLISHED only if its `updatedAt` still equals the one that
 * was validated, so nothing unvalidated is ever published. The migration's
 * partial unique index backs "at most one PUBLISHED version" at the database
 * level. An archived template cannot be published. */
export async function publishEventTemplateVersion(templateId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    refuseArchived(await lockTemplate(tx, templateId, "UPDATE"), "published");
    const template = await tx.eventTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { name: true } });
    const draft = await tx.eventTemplateVersion.findFirst({ where: { templateId, status: "DRAFT" } });
    if (!draft) throw new EventTemplateOperationError("NO_DRAFT", "This template has no draft version to publish.");
    // Publish-time checks: the payload must satisfy the current schema and
    // everything it names must exist right now.
    validateEventTemplatePayloadReferences(parseEventTemplatePayload(draft.payload));
    await tx.eventTemplateVersion.updateMany({ where: { templateId, status: "PUBLISHED" }, data: { status: "ARCHIVED" } });
    const { count } = await tx.eventTemplateVersion.updateMany({
      where: { id: draft.id, status: "DRAFT", updatedAt: draft.updatedAt },
      data: { status: "PUBLISHED", publishedAt: new Date() },
    });
    if (count === 0) {
      throw new EventTemplateOperationError("EDIT_CONFLICT", "This draft changed while it was being published. Reload it and publish again.");
    }
    await tx.eventTemplate.update({ where: { id: templateId }, data: { status: "PUBLISHED" } });
    await tx.auditLog.create({ data: {
      actorUserId, action: "EVENT_TEMPLATE_PUBLISHED", entityType: "EventTemplate", entityId: templateId,
      correlationId: randomUUID(), summary: `Published ${template.name} version ${draft.versionNumber}.`,
      metadata: { versionId: draft.id, versionNumber: draft.versionNumber },
    } });
  });
  return getEventTemplate(templateId);
}

/** Archiving hides a template from "Start from template" without touching
 * any event already created from it (#152): applications hold their own
 * immutable copy, never a live reference back to the template. Archiving is
 * sticky — saving, publishing, and applying are all refused afterward. */
export async function archiveEventTemplate(templateId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    await lockTemplate(tx, templateId, "UPDATE");
    const template = await tx.eventTemplate.update({ where: { id: templateId }, data: { status: "ARCHIVED" } });
    await tx.auditLog.create({ data: {
      actorUserId, action: "EVENT_TEMPLATE_ARCHIVED", entityType: "EventTemplate", entityId: templateId,
      correlationId: randomUUID(), summary: `Archived event template ${template.name}.`, metadata: {},
    } });
  });
  return getEventTemplate(templateId);
}

/** Reverses an archive (#704). The template returns to PUBLISHED when it still has a published version, otherwise DRAFT; its versions are untouched. */
export async function unarchiveEventTemplate(templateId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const status = await lockTemplate(tx, templateId, "UPDATE");
    if (status !== "ARCHIVED") {
      throw new EventTemplateOperationError("TEMPLATE_NOT_ARCHIVED", "This event template is not archived.");
    }
    const published = await tx.eventTemplateVersion.findFirst({ where: { templateId, status: "PUBLISHED" }, select: { id: true } });
    const restored = published ? "PUBLISHED" : "DRAFT";
    const template = await tx.eventTemplate.update({ where: { id: templateId }, data: { status: restored } });
    await tx.auditLog.create({ data: {
      actorUserId, action: "EVENT_TEMPLATE_UNARCHIVED", entityType: "EventTemplate", entityId: templateId,
      correlationId: randomUUID(), summary: `Unarchived event template ${template.name}.`, metadata: { restoredStatus: restored },
    } });
  });
  return getEventTemplate(templateId);
}

type RequestInput = Pick<ApplyEventTemplateInput, "name" | "slug" | "startsOn" | "endsOn">;

function requestInputOf(input: ApplyEventTemplateInput): RequestInput {
  return { name: input.name, slug: input.slug, startsOn: input.startsOn, endsOn: input.endsOn };
}

/**
 * Resolves a stored application for this actor's `requestKey`: the same
 * template and the same event details return the event it created; anything
 * else is a reused key and is refused rather than silently returning an
 * event the caller did not ask for (#152 N1).
 */
async function resolveExistingApplication(actorUserId: string, templateId: string, input: ApplyEventTemplateInput) {
  const existing = await getPrisma().eventTemplateApplication.findUnique({
    where: { actorUserId_requestKey: { actorUserId, requestKey: input.requestKey } },
  });
  if (!existing) return null;
  const stored = (existing.requestInput ?? {}) as Partial<RequestInput>;
  const requested = requestInputOf(input);
  const sameRequest = existing.templateId === templateId
    && stored.name === requested.name
    && stored.slug === requested.slug
    && stored.startsOn === requested.startsOn
    && stored.endsOn === requested.endsOn;
  if (!sameRequest) {
    throw new EventTemplateOperationError("REQUEST_KEY_REUSED", "This request was already used to create a different event. Reload the page and try again.");
  }
  return { event: (await getEventSettings(existing.eventId))!, alreadyApplied: true };
}

/**
 * Applies a published template version: a one-time, non-live copy that
 * creates a brand-new draft event and every editable row the payload
 * describes (attendee types, classifications, registration forms, message
 * template overrides), then records provenance in `EventTemplateApplication`.
 * `reportSelections` are snapshot-only in this slice: they are kept in
 * `payloadSnapshot` and nothing is created from them.
 *
 * Idempotent per actor by `requestKey` (#152): a request that already
 * succeeded is detected up front, and again on any unique-constraint race a
 * concurrent retry hits (the new event's slug or the application's key), so
 * a retried apply always returns the one event the first attempt created.
 * The template is share-locked, its published payload strictly re-parsed,
 * and every referenced form template and message template key validated
 * before the first write, so an invalid or unavailable reference fails
 * without creating anything.
 */
export async function applyEventTemplate(
  templateId: string,
  actorUserId: string,
  rawInput: unknown,
) {
  const input: ApplyEventTemplateInput = applyEventTemplateInputSchema.parse(rawInput);
  const prisma = getPrisma();

  const alreadyApplied = await resolveExistingApplication(actorUserId, templateId, input);
  if (alreadyApplied) return alreadyApplied;

  try {
    const eventId = await prisma.$transaction(async (tx) => {
      refuseArchived(await lockTemplate(tx, templateId, "SHARE"), "applied");
      const template = await tx.eventTemplate.findUniqueOrThrow({ where: { id: templateId }, select: { id: true, name: true } });
      const version = await tx.eventTemplateVersion.findFirst({ where: { templateId, status: "PUBLISHED" } });
      if (!version) throw new EventTemplateOperationError("NO_PUBLISHED_VERSION", "This event template has no published version to apply.");

      // Fails before any write: an invalid or unavailable module reference must
      // never leave a partially created event behind.
      const payload = parseEventTemplatePayload(version.payload);
      validateEventTemplatePayloadReferences(payload);

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
          isPublished: false,
          waitlistEnabled: payload.moduleEnablement.waitlistEnabled,
          autoPromoteWaitlist: payload.moduleEnablement.waitlistEnabled
            ? payload.moduleEnablement.autoPromoteWaitlist
            : false,
          collectsShirtSizes: payload.moduleEnablement.collectsShirtSizes,
          checksAdultBackgrounds: payload.moduleEnablement.checksAdultBackgrounds,
          attendeeEditPolicy: platform.defaultAttendeeEditPolicy,
          audience: payload.audience,
          billingMode: templateBillingMode(payload),
          publicInfoUrl: payload.brandingDefaults.publicInfoUrl,
          supportContact: payload.brandingDefaults.supportContact,
          calendarCategory: payload.brandingDefaults.calendarCategory,
        },
      });

      await tx.eventMembership.create({
        data: { eventId: event.id, userId: actorUserId, role: "EVENT_ADMIN", status: "ACTIVE" },
      });
      await writeDefaultModules(tx, event.id, payload.audience);

      if (payload.attendeeTypes.length > 0) {
        await tx.eventAttendeeType.createMany({
          data: payload.attendeeTypes.map((type) => ({ eventId: event.id, ...type })),
        });
      }
      if (payload.attendeeClassifications.length > 0) {
        await tx.eventAttendeeClassification.createMany({
          data: payload.attendeeClassifications.map((classification) => ({ eventId: event.id, ...classification })),
        });
      }

      const templateLocations = payload.locations ?? [];
      if (templateLocations.length > 0) {
        // A template's coordinator is applied only if still an active Area Coordinator (#599).
        const activeCoordinators = await activeCoordinatorAccountIds(tx, templateLocations.map((location) => location.coordinatorAccountId));
        // Dates count from the new event's first day, so they move with it (#413).
        await tx.eventLocation.createMany({
          data: templateLocations.map((location, position) => ({
            eventId: event.id,
            name: location.name,
            normalizedName: normalizeLocationName(location.name),
            address: location.address,
            capacity: location.capacity,
            coordinatorAccountId: location.coordinatorAccountId && activeCoordinators.has(location.coordinatorAccountId) ? location.coordinatorAccountId : null,
            sortOrder: position,
            firstDay: location.firstDayOffset === null ? null : shiftCalendarDate(input.startsOn, location.firstDayOffset),
            lastDay: location.lastDayOffset === null ? null : shiftCalendarDate(input.startsOn, location.lastDayOffset),
            registrationClosesOn: location.registrationClosesOffset === null
              ? null
              : shiftCalendarDate(input.startsOn, location.registrationClosesOffset),
          })),
        });
      }

      for (const templateKey of payload.formTemplateKeys) {
        await createRegistrationFormFromTemplateInTransaction(tx, event.id, actorUserId, templateKey);
      }

      for (const messageDefault of payload.messageTemplateDefaults) {
        const key = asEventMessageTemplateKey(messageDefault.key);
        await tx.eventMessageTemplate.create({
          data: {
            eventId: event.id,
            key,
            isEnabled: messageDefault.isEnabled,
            versions: {
              create: {
                createdByUserId: actorUserId,
                versionNumber: 1,
                status: "PUBLISHED",
                subjectTemplate: messageDefault.subjectTemplate,
                bodyTemplate: messageDefault.bodyTemplate,
                publishedAt: new Date(),
              },
            },
          },
        });
      }

      const application = await tx.eventTemplateApplication.create({
        data: {
          templateId: template.id,
          templateVersionId: version.id,
          eventId: event.id,
          actorUserId,
          requestKey: input.requestKey,
          requestInput: requestInputOf(input),
          payloadSnapshot: payload as unknown as Prisma.InputJsonValue,
        },
      });

      await tx.auditLog.create({
        data: {
          eventId: event.id,
          actorUserId,
          action: "EVENT_TEMPLATE_APPLIED",
          entityType: "Event",
          entityId: event.id,
          correlationId: randomUUID(),
          summary: `Created event draft "${event.name}" from template ${template.name} version ${version.versionNumber}.`,
          metadata: {
            templateId: template.id,
            templateVersionId: version.id,
            applicationId: application.id,
            slug: event.slug,
            audience: event.audience,
            billingMode: event.billingMode,
            formTemplateCount: payload.formTemplateKeys.length,
            attendeeTypeCount: payload.attendeeTypes.length,
            locationCount: templateLocations.length,
          },
        },
      });

      return event.id;
    });
    // Read back only after the transaction has committed: the outer client
    // used here is a separate connection from `tx` and must never be asked
    // to read rows the transaction has not yet made durable.
    return { event: (await getEventSettings(eventId))!, alreadyApplied: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Whatever constraint fired, a concurrent request with this actor's key
      // may have committed first — typically the new event's slug, which is
      // inserted before the application row. Its application decides.
      const raced = await resolveExistingApplication(actorUserId, templateId, input);
      if (raced) return raced;
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
      if (target.includes("slug")) {
        throw new EventTemplateOperationError("EVENT_SLUG_TAKEN", "That event web address is already in use. Choose another short address.");
      }
    }
    throw error;
  }
}
