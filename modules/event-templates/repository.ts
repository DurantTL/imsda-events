import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, EventTemplateStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  applyEventTemplateInputSchema,
  eventTemplatePayloadSchema,
  validateEventTemplatePayloadReferences,
  asEventMessageTemplateKey,
  type ApplyEventTemplateInput,
  type EventTemplatePayload,
} from "@/modules/event-templates/domain";
import { getFormTemplate, registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { stripAttendeeTypeOptions } from "@/modules/attendee-types/form-options";
import { slugify, slugCandidate } from "@/modules/forms/slug";
import { getEventSettings } from "@/modules/events/repository";

export class EventTemplateOperationError extends Error {
  constructor(
    public readonly code:
      | "TEMPLATE_NOT_FOUND"
      | "TEMPLATE_ARCHIVED"
      | "NO_DRAFT"
      | "NO_PUBLISHED_VERSION"
      | "VERSION_NOT_FOUND"
      | "EDIT_CONFLICT"
      | "EVENT_SLUG_TAKEN",
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

function payloadFromJson(value: Prisma.JsonValue): EventTemplatePayload {
  return eventTemplatePayloadSchema.parse(value);
}

function serializeTemplate(template: TemplateWithVersions) {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    audience: template.audience,
    status: template.status,
    createdBy: template.createdBy.displayName,
    createdAt: template.createdAt.toISOString(),
    updatedAt: template.updatedAt.toISOString(),
    versions: template.versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      status: version.status,
      payload: payloadFromJson(version.payload),
      publishedAt: version.publishedAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
      updatedAt: version.updatedAt.toISOString(),
      createdBy: version.createdBy.displayName,
    })),
  };
}

export type EventTemplateRecord = ReturnType<typeof serializeTemplate>;

async function loadTemplate(templateId: string) {
  return getPrisma().eventTemplate.findUnique({ where: { id: templateId }, include: templateInclude });
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

/** Every new template starts as a name/description with one empty DRAFT
 * version (#152), exactly like a new registration form starts from a
 * chosen template but with nothing filled in yet. */
export async function createEventTemplate(actorUserId: string, input: { name: string; description: string; audience: "GENERAL" | "CLUB" }) {
  const created = await getPrisma().$transaction(async (tx) => {
    const template = await tx.eventTemplate.create({
      data: {
        name: input.name,
        description: input.description,
        audience: input.audience,
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
 * Saves the template's current draft version, or opens a new one over a
 * published/archived version — the same shape as `updateRegistrationForm`.
 * `payload` is validated against its own schema here; the second,
 * reference-availability check happens only at publish and at apply, since a
 * draft is allowed to name something that does not exist yet.
 */
export async function saveEventTemplateDraft(
  templateId: string,
  actorUserId: string,
  input: { name: string; description: string; payload: EventTemplatePayload; expectedUpdatedAt?: string },
) {
  await getPrisma().$transaction(async (tx) => {
    const template = await tx.eventTemplate.findUnique({ where: { id: templateId }, include: { versions: { orderBy: { versionNumber: "desc" } } } });
    if (!template) throw new EventTemplateOperationError("TEMPLATE_NOT_FOUND", "That event template was not found.");
    const draft = template.versions.find((version) => version.status === EventTemplateStatus.DRAFT);
    const payload = input.payload as unknown as Prisma.InputJsonValue;
    if (draft) {
      if (input.expectedUpdatedAt && draft.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
        throw new EventTemplateOperationError("EDIT_CONFLICT", "This draft changed in another session. Reload it before saving again.");
      }
      await tx.eventTemplateVersion.update({ where: { id: draft.id }, data: { payload, createdByUserId: actorUserId } });
    } else {
      const source = template.versions[0];
      if (source && input.expectedUpdatedAt && source.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) {
        throw new EventTemplateOperationError("EDIT_CONFLICT", "This version changed in another session. Reload it before creating a new draft.");
      }
      await tx.eventTemplateVersion.create({
        data: {
          templateId,
          createdByUserId: actorUserId,
          versionNumber: (source?.versionNumber ?? 0) + 1,
          status: EventTemplateStatus.DRAFT,
          payload,
        },
      });
    }
    await tx.eventTemplate.update({
      where: { id: templateId },
      data: { name: input.name, description: input.description, status: EventTemplateStatus.DRAFT },
    });
    await tx.auditLog.create({ data: {
      actorUserId, action: "EVENT_TEMPLATE_DRAFT_SAVED", entityType: "EventTemplate", entityId: templateId,
      correlationId: randomUUID(), summary: `Saved a draft of ${input.name}.`, metadata: {},
    } });
  });
  return getEventTemplate(templateId);
}

/** Publishes the current draft version. Once published, a version's payload
 * is never edited again (#152) — a later change opens a new draft version
 * instead, so every event already applied from this one stays untouched. */
export async function publishEventTemplateVersion(templateId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const template = await tx.eventTemplate.findUnique({ where: { id: templateId }, include: { versions: { orderBy: { versionNumber: "desc" } } } });
    if (!template) throw new EventTemplateOperationError("TEMPLATE_NOT_FOUND", "That event template was not found.");
    const draft = template.versions.find((version) => version.status === EventTemplateStatus.DRAFT);
    if (!draft) throw new EventTemplateOperationError("NO_DRAFT", "This template has no draft version to publish.");
    const payload = payloadFromJson(draft.payload);
    // Publish-time reference check: everything the payload names must exist
    // right now, or the template is not fit to be published.
    validateEventTemplatePayloadReferences(payload);
    await tx.eventTemplateVersion.updateMany({ where: { templateId, status: EventTemplateStatus.PUBLISHED }, data: { status: EventTemplateStatus.ARCHIVED } });
    await tx.eventTemplateVersion.update({ where: { id: draft.id }, data: { status: EventTemplateStatus.PUBLISHED, publishedAt: new Date() } });
    await tx.eventTemplate.update({ where: { id: templateId }, data: { status: EventTemplateStatus.PUBLISHED } });
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
 * immutable copy, never a live reference back to the template. */
export async function archiveEventTemplate(templateId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const template = await tx.eventTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new EventTemplateOperationError("TEMPLATE_NOT_FOUND", "That event template was not found.");
    await tx.eventTemplate.update({ where: { id: templateId }, data: { status: EventTemplateStatus.ARCHIVED } });
    await tx.auditLog.create({ data: {
      actorUserId, action: "EVENT_TEMPLATE_ARCHIVED", entityType: "EventTemplate", entityId: templateId,
      correlationId: randomUUID(), summary: `Archived event template ${template.name}.`, metadata: {},
    } });
  });
  return getEventTemplate(templateId);
}

/**
 * Applies a published template version: a one-time, non-live copy that
 * creates a brand-new draft event and every editable row the payload
 * describes (attendee types, classifications, registration forms, message
 * template overrides), then records provenance in `EventTemplateApplication`.
 *
 * Idempotent by `requestKey` (#152): a request that already succeeded is
 * detected up front and again by the unique-constraint race a concurrent
 * retry can hit, so a retried apply always returns the one event the first
 * attempt created rather than creating a duplicate. Every referenced form
 * template and message template key is validated *before* the transaction
 * opens, so an invalid or unavailable module reference fails without
 * creating anything.
 */
export async function applyEventTemplate(
  templateId: string,
  actorUserId: string,
  rawInput: unknown,
) {
  const input: ApplyEventTemplateInput = applyEventTemplateInputSchema.parse(rawInput);
  const prisma = getPrisma();

  const existingApplication = await prisma.eventTemplateApplication.findUnique({ where: { requestKey: input.requestKey } });
  if (existingApplication) {
    return { event: (await getEventSettings(existingApplication.eventId))!, alreadyApplied: true };
  }

  const template = await loadTemplate(templateId);
  if (!template) throw new EventTemplateOperationError("TEMPLATE_NOT_FOUND", "That event template was not found.");
  if (template.status === EventTemplateStatus.ARCHIVED) {
    throw new EventTemplateOperationError("TEMPLATE_ARCHIVED", "This event template is archived and cannot be applied.");
  }
  const version = template.versions.find((candidate) => candidate.status === EventTemplateStatus.PUBLISHED);
  if (!version) throw new EventTemplateOperationError("NO_PUBLISHED_VERSION", "This event template has no published version to apply.");

  const payload = payloadFromJson(version.payload);
  // Fails before any write: an invalid or unavailable module reference must
  // never leave a partially created event behind.
  validateEventTemplatePayloadReferences(payload);
  const payloadSnapshot = payload as unknown as Prisma.InputJsonValue;

  try {
    const eventId = await prisma.$transaction(async (tx) => {
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
          publicInfoUrl: payload.brandingDefaults.publicInfoUrl,
          supportContact: payload.brandingDefaults.supportContact,
          calendarCategory: payload.brandingDefaults.calendarCategory,
        },
      });

      await tx.eventMembership.create({
        data: { eventId: event.id, userId: actorUserId, role: "EVENT_ADMIN", status: "ACTIVE" },
      });

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

      for (const templateKey of payload.formTemplateKeys) {
        const formTemplate = getFormTemplate(templateKey);
        // Already checked by `validateEventTemplatePayloadReferences`, but a
        // missing template here would mean silently skipping it instead.
        if (!formTemplate) throw new EventTemplateOperationError("TEMPLATE_NOT_FOUND", `Form template "${templateKey}" is not available.`);
        const definition = registrationFormDefinitionSchema.parse(structuredClone(formTemplate.definition));
        const storedDefinition = stripAttendeeTypeOptions(definition);
        const baseSlug = slugify(definition.title);
        let slug = baseSlug;
        let suffix = 2;
        while (await tx.registrationForm.findUnique({ where: { eventId_slug: { eventId: event.id, slug } }, select: { id: true } })) {
          slug = slugCandidate(baseSlug, suffix);
          suffix += 1;
        }
        await tx.registrationForm.create({
          data: {
            eventId: event.id,
            createdByUserId: actorUserId,
            name: definition.title,
            slug,
            versions: { create: { createdByUserId: actorUserId, versionNumber: 1, definition: storedDefinition as Prisma.InputJsonValue } },
          },
        });
      }

      if (payload.messageTemplateDefaults.length > 0) {
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
      }

      const application = await tx.eventTemplateApplication.create({
        data: {
          templateId: template.id,
          templateVersionId: version.id,
          eventId: event.id,
          actorUserId,
          requestKey: input.requestKey,
          payloadSnapshot,
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
            formTemplateCount: payload.formTemplateKeys.length,
            attendeeTypeCount: payload.attendeeTypes.length,
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
      const target = Array.isArray(error.meta?.target) ? error.meta.target.join(",") : String(error.meta?.target ?? "");
      if (target.includes("requestKey")) {
        // A concurrent retry with the same idempotency key won the race: return
        // the event it created instead of surfacing a spurious conflict.
        const raced = await prisma.eventTemplateApplication.findUnique({ where: { requestKey: input.requestKey } });
        if (raced) return { event: (await getEventSettings(raced.eventId))!, alreadyApplied: true };
      }
      if (target.includes("slug")) {
        throw new EventTemplateOperationError("EVENT_SLUG_TAKEN", "That event web address is already in use. Choose another short address.");
      }
    }
    throw error;
  }
}
