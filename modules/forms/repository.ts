import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, RegistrationFormStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  formTemplates,
  getFormTemplate,
  registrationFormDefinitionSchema,
  summarizeChoiceUsage,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { preparePublicRegistration } from "@/modules/forms/public-domain";

export class FormOperationError extends Error {
  constructor(
    public readonly code: "FORM_NOT_FOUND" | "TEMPLATE_NOT_FOUND" | "EDIT_CONFLICT" | "NO_DRAFT" | "TEST_REQUIRED" | "VERSION_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "FormOperationError";
  }
}

const formInclude = {
  createdBy: { select: { displayName: true } },
  versions: {
    orderBy: { versionNumber: "desc" as const },
    include: {
      createdBy: { select: { displayName: true } },
      testSubmissions: {
        orderBy: { createdAt: "desc" as const },
        include: { submittedBy: { select: { displayName: true } } },
      },
      _count: { select: { testSubmissions: true } },
    },
  },
} satisfies Prisma.RegistrationFormInclude;

type FormWithVersions = Prisma.RegistrationFormGetPayload<{ include: typeof formInclude }>;

function definitionFromJson(value: Prisma.JsonValue): RegistrationFormDefinition {
  return registrationFormDefinitionSchema.parse(value);
}

function validationFromJson(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { issues: [] };
  return value as Record<string, Prisma.JsonValue>;
}

function responsesFromJson(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function usageResponseSetsFromJson(value: Prisma.JsonValue): Array<Record<string, unknown>> {
  const record = responsesFromJson(value);
  const registrationResponses = record.registrationResponses;
  const attendees = record.attendees;
  if (
    registrationResponses
    && typeof registrationResponses === "object"
    && !Array.isArray(registrationResponses)
    && Array.isArray(attendees)
  ) {
    const sets: Array<Record<string, unknown>> = [registrationResponses as Record<string, unknown>];
    for (const attendee of attendees) {
      if (!attendee || typeof attendee !== "object" || Array.isArray(attendee)) continue;
      const attendeeResponses = (attendee as Record<string, unknown>).responses;
      if (attendeeResponses && typeof attendeeResponses === "object" && !Array.isArray(attendeeResponses)) {
        sets.push(attendeeResponses as Record<string, unknown>);
      }
    }
    return sets;
  }
  return [record];
}

function serializeForm(form: FormWithVersions) {
  const versions = form.versions.map((version) => {
    const definition = definitionFromJson(version.definition);
    const validResponseSets = version.testSubmissions
      .filter((submission) => submission.isValid)
      .flatMap((submission) => usageResponseSetsFromJson(submission.responses));
    return ({
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    definition,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
    updatedAt: version.updatedAt.toISOString(),
    createdBy: version.createdBy.displayName,
    testSubmissionCount: version._count.testSubmissions,
    choiceUsage: summarizeChoiceUsage(definition, validResponseSets),
    testSubmissions: version.testSubmissions.map((submission) => ({
      id: submission.id,
      isValid: submission.isValid,
      validation: validationFromJson(submission.validation),
      responses: responsesFromJson(submission.responses),
      submittedBy: submission.submittedBy.displayName,
      createdAt: submission.createdAt.toISOString(),
    })),
  }); });
  const activeVersion = versions.find((version) => version.status === RegistrationFormStatus.DRAFT)
    ?? versions.find((version) => version.status === RegistrationFormStatus.PUBLISHED)
    ?? versions[0];
  return {
    id: form.id,
    eventId: form.eventId,
    name: form.name,
    slug: form.slug,
    status: form.status,
    createdAt: form.createdAt.toISOString(),
    updatedAt: form.updatedAt.toISOString(),
    createdBy: form.createdBy.displayName,
    activeVersion,
    versions,
  };
}

export type RegistrationFormView = ReturnType<typeof serializeForm>;

async function loadForm(eventId: string, formId: string) {
  return getPrisma().registrationForm.findFirst({ where: { id: formId, eventId }, include: formInclude });
}

export async function listRegistrationForms(eventId: string) {
  const forms = await getPrisma().registrationForm.findMany({ where: { eventId }, orderBy: { updatedAt: "desc" }, include: formInclude });
  return forms.map(serializeForm);
}

export async function getRegistrationForm(eventId: string, formId: string) {
  const form = await loadForm(eventId, formId);
  return form ? serializeForm(form) : null;
}

export function listFormTemplates() {
  return formTemplates.map(({ key, name, description, audience, definition }) => ({
    key, name, description, audience, sectionCount: definition.sections.length,
    fieldCount: definition.sections.reduce((count, section) => count + section.fields.length, 0),
  }));
}

function slugify(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "registration-form";
}

export async function createRegistrationForm(eventId: string, actorUserId: string, templateKey: string) {
  const template = getFormTemplate(templateKey);
  if (!template) throw new FormOperationError("TEMPLATE_NOT_FOUND", "That form template is not available.");
  const definition = registrationFormDefinitionSchema.parse(structuredClone(template.definition));
  const created = await getPrisma().$transaction(async (tx) => {
    const baseSlug = slugify(definition.title);
    let slug = baseSlug;
    let suffix = 2;
    while (await tx.registrationForm.findUnique({ where: { eventId_slug: { eventId, slug } }, select: { id: true } })) {
      slug = `${baseSlug}-${suffix}`;
      suffix += 1;
    }
    const form = await tx.registrationForm.create({
      data: {
        eventId,
        createdByUserId: actorUserId,
        name: definition.title,
        slug,
        versions: { create: { createdByUserId: actorUserId, versionNumber: 1, definition: definition as Prisma.InputJsonValue } },
      },
    });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "REGISTRATION_FORM_CREATED", entityType: "RegistrationForm", entityId: form.id,
      correlationId: randomUUID(), summary: `Created ${form.name} from the ${template.name} template.`, metadata: { templateKey, productionWrite: false },
    } });
    return form;
  });
  return (await getRegistrationForm(eventId, created.id))!;
}

export async function updateRegistrationForm(
  eventId: string,
  formId: string,
  actorUserId: string,
  input: { definition: RegistrationFormDefinition; expectedUpdatedAt: string },
) {
  const definition = registrationFormDefinitionSchema.parse(input.definition);
  await getPrisma().$transaction(async (tx) => {
    let invalidatedTestCount = 0;
    const form = await tx.registrationForm.findFirst({ where: { id: formId, eventId }, include: { versions: { orderBy: { versionNumber: "desc" } } } });
    if (!form) throw new FormOperationError("FORM_NOT_FOUND", "That registration form was not found.");
    const draft = form.versions.find((version) => version.status === RegistrationFormStatus.DRAFT);
    if (draft) {
      if (draft.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new FormOperationError("EDIT_CONFLICT", "This draft changed in another session. Reload it before saving again.");
      invalidatedTestCount = (await tx.formTestSubmission.deleteMany({ where: { formVersionId: draft.id } })).count;
      await tx.registrationFormVersion.update({ where: { id: draft.id }, data: { definition: definition as Prisma.InputJsonValue, createdByUserId: actorUserId } });
    } else {
      const source = form.versions[0];
      if (!source) throw new FormOperationError("NO_DRAFT", "This form has no version to edit.");
      if (source.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new FormOperationError("EDIT_CONFLICT", "This version changed in another session. Reload it before creating a new draft.");
      await tx.registrationFormVersion.create({ data: {
        formId, createdByUserId: actorUserId, versionNumber: source.versionNumber + 1,
        status: RegistrationFormStatus.DRAFT, definition: definition as Prisma.InputJsonValue,
      } });
    }
    await tx.registrationForm.update({ where: { id: formId }, data: { name: definition.title, status: RegistrationFormStatus.DRAFT } });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "REGISTRATION_FORM_DRAFT_SAVED", entityType: "RegistrationForm", entityId: formId,
      correlationId: randomUUID(), summary: `Saved a draft of ${definition.title}.`, metadata: { sectionCount: definition.sections.length, invalidatedTestCount, productionWrite: false },
    } });
  });
  return (await getRegistrationForm(eventId, formId))!;
}

export async function publishRegistrationForm(eventId: string, formId: string, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    const form = await tx.registrationForm.findFirst({ where: { id: formId, eventId }, include: { versions: { orderBy: { versionNumber: "desc" } } } });
    if (!form) throw new FormOperationError("FORM_NOT_FOUND", "That registration form was not found.");
    const draft = form.versions.find((version) => version.status === RegistrationFormStatus.DRAFT);
    if (!draft) throw new FormOperationError("NO_DRAFT", "This form has no draft version to publish.");
    const definition = registrationFormDefinitionSchema.parse(draft.definition);
    const validTests = await tx.formTestSubmission.count({ where: { formVersionId: draft.id, isValid: true } });
    if (validTests === 0) throw new FormOperationError("TEST_REQUIRED", "Run at least one valid test submission before publishing this draft.");
    await tx.registrationFormVersion.updateMany({ where: { formId, status: RegistrationFormStatus.PUBLISHED }, data: { status: RegistrationFormStatus.ARCHIVED } });
    await tx.registrationFormVersion.update({ where: { id: draft.id }, data: { status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date() } });
    await tx.registrationForm.update({ where: { id: formId }, data: { name: definition.title, status: RegistrationFormStatus.PUBLISHED } });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "REGISTRATION_FORM_PUBLISHED", entityType: "RegistrationForm", entityId: formId,
      correlationId: randomUUID(), summary: `Published ${definition.title} version ${draft.versionNumber}.`, metadata: { versionId: draft.id, versionNumber: draft.versionNumber, productionWrite: false },
    } });
  });
  return (await getRegistrationForm(eventId, formId))!;
}

export async function createTestSubmission(
  eventId: string,
  formId: string,
  actorUserId: string,
  input: {
    versionId: string;
    responses: Record<string, unknown>;
    attendees?: Array<{ clientId: string; responses: Record<string, unknown> }>;
  },
) {
  const version = await getPrisma().registrationFormVersion.findFirst({
    where: { id: input.versionId, formId, form: { eventId } },
    include: { form: { select: { name: true, event: { select: { timezone: true } } } } },
  });
  if (!version) throw new FormOperationError("VERSION_NOT_FOUND", "That form version is not available for testing.");
  const definition = registrationFormDefinitionSchema.parse(version.definition);
  const priorValidResponses = await getPrisma().formTestSubmission.findMany({ where: { formVersionId: version.id, isValid: true }, select: { responses: true } });
  const usage = summarizeChoiceUsage(
    definition,
    priorValidResponses.flatMap((submission) => usageResponseSetsFromJson(submission.responses)),
  );
  const prepared = preparePublicRegistration(definition, {
    versionId: version.id,
    idempotencyKey: randomUUID(),
    responses: input.responses,
    attendees: input.attendees,
    website: "",
  }, {
    timeZone: version.form.event.timezone,
    usage,
  });
  const validation = {
    isValid: prepared.isValid,
    issues: prepared.issues,
    calculation: prepared.calculation,
  };
  const storedResponses = prepared.rosterEnabled
    ? {
        registrationResponses: prepared.registrationResponses,
        attendees: prepared.attendees.map((attendee) => ({
          clientId: attendee.clientId,
          responses: attendee.responses,
        })),
      }
    : prepared.responses;
  const submission = await getPrisma().$transaction(async (tx) => {
    const created = await tx.formTestSubmission.create({ data: {
      eventId, formVersionId: version.id, submittedByUserId: actorUserId,
      responses: storedResponses as Prisma.InputJsonValue, validation: validation as Prisma.InputJsonValue, isValid: validation.isValid,
    } });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "REGISTRATION_FORM_TESTED", entityType: "RegistrationFormVersion", entityId: version.id,
      correlationId: randomUUID(), summary: `Ran a ${validation.isValid ? "valid" : "failed"} test submission for ${version.form.name} version ${version.versionNumber}.`,
      metadata: { isValid: validation.isValid, issueCount: validation.issues.length, productionWrite: false },
    } });
    return created;
  });
  return { id: submission.id, isValid: validation.isValid, validation, createdAt: submission.createdAt.toISOString() };
}
