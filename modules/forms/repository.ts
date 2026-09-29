import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, RegistrationFormStatus } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { isLockTimeoutError } from "@/lib/prisma-errors";
import {
  formTemplates,
  getFormTemplate,
  registrationFormDefinitionSchema,
  summarizeChoiceUsage,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { preparePublicRegistration } from "@/modules/forms/public-domain";
import { slugCandidate, slugify, slugMatchesTitle } from "@/modules/forms/slug";
import { listActiveAttendeeTypes } from "@/modules/attendee-types/repository";
import { stripAttendeeTypeOptions, withAttendeeTypeOptions } from "@/modules/attendee-types/form-options";
import type { AttendeeTypeOption } from "@/modules/attendee-types/domain";
import { hasDirectoryOptionSource, stripDirectoryOptions, withDirectoryOptions } from "@/modules/organizations/directory-form-options";
import type { OrganizationDirectory } from "@/modules/organizations/directory-options";
import { directoryForDefinitions, hydrateFormOptions } from "@/modules/forms/form-options-repository";

/**
 * Every writer of a form's versions or slug (save, test, publish, withdraw, slug update) runs in
 * one of these: the first statement locks the form row (scoped to its event, so another event's form id locks nothing and reads as not found), so the writers are
 * serialized and each re-reads current state under the lock (#564). Because
 * they all take this one lock first, there is no lock-order cycle. The lock
 * wait gives up after 5s as a readable "busy" error instead of hanging.
 */
async function formWriteTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>, formId: string, eventId: string): Promise<T> {
  try {
    return await getPrisma().$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
      await tx.$queryRaw`SELECT "id" FROM "RegistrationForm" WHERE "id" = ${formId} AND "eventId" = ${eventId} FOR UPDATE`;
      await tx.$executeRaw`SET LOCAL lock_timeout = 0`;
      return operation(tx);
    }, { timeout: 10_000 });
  } catch (error) {
    if (isLockTimeoutError(error) || (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2028" || error.code === "P2034"))) {
      throw new FormOperationError("FORM_BUSY", "This form is being changed by someone else right now. Wait a moment and try again.");
    }
    throw error;
  }
}

const emptyDirectory: OrganizationDirectory = { clubs: [], churches: [] };

export class FormOperationError extends Error {
  constructor(
    public readonly code: "FORM_NOT_FOUND" | "TEMPLATE_NOT_FOUND" | "EDIT_CONFLICT" | "NO_DRAFT" | "TEST_REQUIRED" | "VERSION_NOT_FOUND" | "NOT_PUBLISHED" | "FORM_BUSY" | "SLUG_LOCKED" | "FORM_SLUG_TAKEN",
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

function serializeForm(form: FormWithVersions, attendeeTypes: AttendeeTypeOption[] = [], directory: OrganizationDirectory = emptyDirectory) {
  const versions = form.versions.map((version) => {
    let definition = withAttendeeTypeOptions(definitionFromJson(version.definition), attendeeTypes);
    if (hasDirectoryOptionSource(definition)) definition = withDirectoryOptions(definition, directory);
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

function formsDirectory(forms: readonly FormWithVersions[]) {
  return directoryForDefinitions(forms.flatMap((form) => form.versions.map((version) => definitionFromJson(version.definition))));
}

export async function listRegistrationForms(eventId: string) {
  const [forms, attendeeTypes] = await Promise.all([
    getPrisma().registrationForm.findMany({ where: { eventId }, orderBy: { updatedAt: "desc" }, include: formInclude }),
    listActiveAttendeeTypes(eventId),
  ]);
  const directory = await formsDirectory(forms);
  return forms.map((form) => serializeForm(form, attendeeTypes, directory));
}

export async function getRegistrationForm(eventId: string, formId: string) {
  const [form, attendeeTypes] = await Promise.all([loadForm(eventId, formId), listActiveAttendeeTypes(eventId)]);
  const directory = form ? await formsDirectory([form]) : emptyDirectory;
  return form ? serializeForm(form, attendeeTypes, directory) : null;
}

export function listFormTemplates() {
  return formTemplates.map(({ key, name, description, audience, definition }) => ({
    key, name, description, audience, collectsPayment: Boolean(definition.payment?.enabled), sectionCount: definition.sections.length,
    fieldCount: definition.sections.reduce((count, section) => count + section.fields.length, 0),
  }));
}

/**
 * Creates one draft registration form from a code-defined form template
 * inside the caller's transaction. Shared by `createRegistrationForm` and by
 * applying an event template (#152); the storing itself is
 * `createRegistrationFormFromDefinitionInTransaction`.
 */
export async function createRegistrationFormFromTemplateInTransaction(
  tx: Prisma.TransactionClient,
  eventId: string,
  actorUserId: string,
  templateKey: string,
) {
  const template = getFormTemplate(templateKey);
  if (!template) throw new FormOperationError("TEMPLATE_NOT_FOUND", "That form template is not available.");
  return createRegistrationFormFromDefinitionInTransaction(tx, eventId, actorUserId, {
    definition: template.definition,
    summary: (formName) => `Created ${formName} from the ${template.name} template.`,
    metadata: { templateKey },
  });
}

/**
 * Creates one DRAFT registration form (version 1) from a form definition
 * inside the caller's transaction, whatever the definition came from: a
 * code-defined template, or the current published definition of another
 * event's form (annual cloning, #157). The stored definition has its attendee
 * type and directory options stripped (they are hydrated live on read), the
 * slug is made unique within the event (`preferredSlug` first, else the
 * title's), and `REGISTRATION_FORM_CREATED` is audited. The one place a new
 * form's stored shape is decided, so every creation path stores and audits
 * forms identically. The new form is always a draft: nothing here publishes.
 */
export async function createRegistrationFormFromDefinitionInTransaction(
  tx: Prisma.TransactionClient,
  eventId: string,
  actorUserId: string,
  source: {
    definition: unknown;
    preferredSlug?: string;
    summary: (formName: string) => string;
    metadata: Record<string, Prisma.InputJsonValue>;
  },
) {
  const definition = registrationFormDefinitionSchema.parse(structuredClone(source.definition));
  const storedDefinition = stripDirectoryOptions(stripAttendeeTypeOptions(definition));
  const baseSlug = source.preferredSlug || slugify(definition.title);
  let slug = baseSlug;
  let suffix = 2;
  while (await tx.registrationForm.findUnique({ where: { eventId_slug: { eventId, slug } }, select: { id: true } })) {
    slug = slugCandidate(baseSlug, suffix);
    suffix += 1;
  }
  const form = await tx.registrationForm.create({
    data: {
      eventId,
      createdByUserId: actorUserId,
      name: definition.title,
      slug,
      versions: { create: { createdByUserId: actorUserId, versionNumber: 1, definition: storedDefinition as Prisma.InputJsonValue } },
    },
  });
  await tx.auditLog.create({ data: {
    eventId, actorUserId, action: "REGISTRATION_FORM_CREATED", entityType: "RegistrationForm", entityId: form.id,
    correlationId: randomUUID(), summary: source.summary(form.name), metadata: { ...source.metadata, productionWrite: false },
  } });
  return form;
}

export async function createRegistrationForm(eventId: string, actorUserId: string, templateKey: string) {
  if (!getFormTemplate(templateKey)) throw new FormOperationError("TEMPLATE_NOT_FOUND", "That form template is not available.");
  const created = await getPrisma().$transaction((tx) => createRegistrationFormFromTemplateInTransaction(tx, eventId, actorUserId, templateKey));
  return (await getRegistrationForm(eventId, created.id))!;
}

export async function updateRegistrationForm(
  eventId: string,
  formId: string,
  actorUserId: string,
  input: { definition: RegistrationFormDefinition; expectedUpdatedAt: string },
) {
  const definition = registrationFormDefinitionSchema.parse(input.definition);
  const storedDefinition = stripDirectoryOptions(stripAttendeeTypeOptions(definition));
  try {
  await formWriteTransaction(async (tx) => {
    let invalidatedTestCount = 0;
    const form = await tx.registrationForm.findFirst({ where: { id: formId, eventId }, include: { versions: { orderBy: { versionNumber: "desc" } } } });
    if (!form) throw new FormOperationError("FORM_NOT_FOUND", "That registration form was not found.");
    const draft = form.versions.find((version) => version.status === RegistrationFormStatus.DRAFT);
    if (draft) {
      if (draft.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new FormOperationError("EDIT_CONFLICT", "This draft changed in another session. Reload it before saving again.");
      // Conditional on the draft still being exactly what the editor loaded,
      // then delete its tests: a test can no longer commit between the two.
      const saved = await tx.registrationFormVersion.updateMany({
        where: { id: draft.id, status: RegistrationFormStatus.DRAFT, updatedAt: new Date(input.expectedUpdatedAt) },
        data: { definition: storedDefinition as Prisma.InputJsonValue, createdByUserId: actorUserId },
      });
      if (saved.count !== 1) throw new FormOperationError("EDIT_CONFLICT", "This draft changed in another session. Reload it before saving again.");
      invalidatedTestCount = (await tx.formTestSubmission.deleteMany({ where: { formVersionId: draft.id } })).count;
    } else {
      const source = form.versions[0];
      if (!source) throw new FormOperationError("NO_DRAFT", "This form has no version to edit.");
      if (source.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new FormOperationError("EDIT_CONFLICT", "This version changed in another session. Reload it before creating a new draft.");
      await tx.registrationFormVersion.create({ data: {
        formId, createdByUserId: actorUserId, versionNumber: source.versionNumber + 1,
        status: RegistrationFormStatus.DRAFT, definition: storedDefinition as Prisma.InputJsonValue,
      } });
    }
    // A live version keeps the form itself PUBLISHED: a new draft must not
    // close public or club registration (#564). Only a form with no live
    // version falls back to DRAFT.
    const hasLiveVersion = form.versions.some((version) => version.status === RegistrationFormStatus.PUBLISHED);
    await tx.registrationForm.update({ where: { id: formId }, data: { name: definition.title, status: hasLiveVersion ? RegistrationFormStatus.PUBLISHED : RegistrationFormStatus.DRAFT } });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "REGISTRATION_FORM_DRAFT_SAVED", entityType: "RegistrationForm", entityId: formId,
      correlationId: randomUUID(), summary: `Saved a draft of ${definition.title}.`, metadata: { sectionCount: definition.sections.length, invalidatedTestCount, productionWrite: false },
    } });
  }, formId, eventId);
  } catch (error) {
    // Two staff creating the next draft at once collide on (formId, versionNumber).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new FormOperationError("EDIT_CONFLICT", "This form was just changed in another session. Reload it before saving again.");
    }
    throw error;
  }
  return (await getRegistrationForm(eventId, formId))!;
}

/**
 * Updates a form's web address (slug) before its first publish.
 *
 * A form copied from a template keeps the template's slug even after its
 * title changes, so the builder prompts staff to sync the two before the
 * first publish (#476). Once a version of this form has ever been published,
 * the slug is locked: shared links depend on it, so nothing may change it
 * automatically or silently — only this explicit, pre-first-publish choice
 * is allowed to move it.
 */
export async function updateRegistrationFormSlug(eventId: string, formId: string, actorUserId: string, slug: string) {
  try {
    await formWriteTransaction(async (tx) => {
      // Runs under the same form-row lock as publish, and reads inside it, so a
      // first publish committing between the SLUG_LOCKED check and the write
      // cannot slip a slug change past it (#564).
      const form = await tx.registrationForm.findFirst({
        where: { id: formId, eventId },
        select: { id: true, name: true, slug: true, versions: { select: { publishedAt: true } } },
      });
      if (!form) throw new FormOperationError("FORM_NOT_FOUND", "That registration form was not found.");
      if (form.versions.some((version) => version.publishedAt)) {
        throw new FormOperationError("SLUG_LOCKED", "This form has already been published, so its web address can no longer change automatically.");
      }
      if (slug === form.slug) return;
      const existing = await tx.registrationForm.findUnique({ where: { eventId_slug: { eventId, slug } }, select: { id: true } });
      if (existing) throw slugTakenError();
      await tx.registrationForm.update({ where: { id: formId }, data: { slug } });
      await tx.auditLog.create({ data: {
        eventId, actorUserId, action: "REGISTRATION_FORM_SLUG_UPDATED", entityType: "RegistrationForm", entityId: formId,
        correlationId: randomUUID(), summary: `Updated the web address for ${form.name} to /${slug}.`, metadata: { previousSlug: form.slug, slug, productionWrite: false },
      } });
    }, formId, eventId);
  } catch (error) {
    // Another form claimed the address between the check and the write.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw slugTakenError();
    throw error;
  }
  return (await getRegistrationForm(eventId, formId))!;
}

function slugTakenError() {
  return new FormOperationError("FORM_SLUG_TAKEN", "That web address is already used by another form for this event. Choose another address.");
}

/**
 * What the builder should offer before a form's first publish (#476): the
 * address its saved title would get, resolved to the next free one the same
 * way createRegistrationForm does (`title`, `title-2`, …), so "Update" can
 * succeed. `needsSync` is false once the form has ever been published (the
 * slug is locked) or when the slug already reflects the title, including a
 * `title-N` suffix that creation added.
 */
export async function suggestRegistrationFormSlug(eventId: string, formId: string) {
  const prisma = getPrisma();
  const form = await prisma.registrationForm.findFirst({
    where: { id: formId, eventId },
    select: { id: true, slug: true, versions: { select: { status: true, publishedAt: true, definition: true }, orderBy: { versionNumber: "desc" } } },
  });
  if (!form) throw new FormOperationError("FORM_NOT_FOUND", "That registration form was not found.");
  const locked = form.versions.some((version) => version.publishedAt);
  const titleVersion = form.versions.find((version) => version.status === RegistrationFormStatus.DRAFT) ?? form.versions[0];
  const title = titleVersion ? definitionFromJson(titleVersion.definition).title : "";
  if (locked || !title || slugMatchesTitle(form.slug, title)) {
    return { currentSlug: form.slug, offeredSlug: form.slug, needsSync: false, locked };
  }
  const baseSlug = slugify(title);
  const taken = new Set((await prisma.registrationForm.findMany({
    // An event has a handful of forms, so reading every other slug is cheap.
    where: { eventId, id: { not: formId } },
    select: { slug: true },
  })).map((row) => row.slug));
  let suffix = 1;
  while (taken.has(slugCandidate(baseSlug, suffix))) suffix += 1;
  const offeredSlug = slugCandidate(baseSlug, suffix);
  return { currentSlug: form.slug, offeredSlug, needsSync: offeredSlug !== form.slug, locked };
}

export async function publishRegistrationForm(eventId: string, formId: string, actorUserId: string) {
  await formWriteTransaction(async (tx) => {
    const form = await tx.registrationForm.findFirst({ where: { id: formId, eventId }, include: { versions: { orderBy: { versionNumber: "desc" } } } });
    if (!form) throw new FormOperationError("FORM_NOT_FOUND", "That registration form was not found.");
    const draft = form.versions.find((version) => version.status === RegistrationFormStatus.DRAFT);
    if (!draft) throw new FormOperationError("NO_DRAFT", "This form has no draft version to publish.");
    const definition = registrationFormDefinitionSchema.parse(draft.definition);
    // Every version is gated on its own valid test submission (#564). A test
    // proves the version being published can be filled in and priced; an
    // earlier version's test says nothing about a new module, a switch to team
    // registration, or a changed price. Saving a draft deletes its tests, so a
    // revised draft always needs a fresh one.
    const validTests = await tx.formTestSubmission.count({ where: { formVersionId: draft.id, isValid: true } });
    if (validTests === 0) throw new FormOperationError("TEST_REQUIRED", "Run at least one valid test submission against this version before publishing it.");
    await tx.registrationFormVersion.updateMany({ where: { formId, status: RegistrationFormStatus.PUBLISHED }, data: { status: RegistrationFormStatus.ARCHIVED } });
    // Conditional on the draft being exactly what was tested: a save that
    // landed after the test count changes updatedAt (and deletes the tests),
    // so this matches nothing and the whole publish rolls back.
    const promoted = await tx.registrationFormVersion.updateMany({
      where: { id: draft.id, status: RegistrationFormStatus.DRAFT, updatedAt: draft.updatedAt },
      data: { status: RegistrationFormStatus.PUBLISHED, publishedAt: new Date() },
    });
    if (promoted.count !== 1) throw new FormOperationError("EDIT_CONFLICT", "This draft changed while it was being published. Reload it, run a fresh test submission, and publish again.");
    await tx.registrationForm.update({ where: { id: formId }, data: { name: definition.title, status: RegistrationFormStatus.PUBLISHED } });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "REGISTRATION_FORM_PUBLISHED", entityType: "RegistrationForm", entityId: formId,
      correlationId: randomUUID(), summary: `Published ${definition.title} version ${draft.versionNumber}.`, metadata: { versionId: draft.id, versionNumber: draft.versionNumber, productionWrite: false },
    } });
  }, formId, eventId);
  return (await getRegistrationForm(eventId, formId))!;
}

/**
 * Takes a published form off the public page.
 *
 * Publishing had no reverse, so an event that published two forms was stuck
 * showing both. Archiving the published version is the same move publishing
 * already makes when a newer version supersedes an older one — this just does
 * it without a replacement.
 *
 * Registrations already taken are untouched. They reference an immutable form
 * version, and withdrawing the form staff no longer want must not rewrite what
 * somebody already submitted.
 */
export async function unpublishRegistrationForm(eventId: string, formId: string, actorUserId: string) {
  await formWriteTransaction(async (tx) => {
    const form = await tx.registrationForm.findFirst({
      where: { id: formId, eventId },
      include: { versions: { where: { status: RegistrationFormStatus.PUBLISHED }, orderBy: { versionNumber: "desc" } } },
    });
    if (!form) throw new FormOperationError("FORM_NOT_FOUND", "That registration form was not found.");
    const published = form.versions[0];
    if (!published) {
      throw new FormOperationError("NOT_PUBLISHED", "This form is not published, so there is nothing to withdraw.");
    }
    await tx.registrationFormVersion.updateMany({
      where: { formId, status: RegistrationFormStatus.PUBLISHED },
      data: { status: RegistrationFormStatus.ARCHIVED },
    });
    await tx.registrationForm.update({ where: { id: formId }, data: { status: RegistrationFormStatus.ARCHIVED } });
    await tx.auditLog.create({ data: {
      eventId, actorUserId, action: "REGISTRATION_FORM_UNPUBLISHED", entityType: "RegistrationForm", entityId: formId,
      correlationId: randomUUID(),
      summary: `Withdrew ${form.name} version ${published.versionNumber} from the public event page.`,
      metadata: { versionId: published.id, versionNumber: published.versionNumber, productionWrite: false },
    } });
  }, formId, eventId);
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
  const attendeeTypes = await listActiveAttendeeTypes(eventId);
  const definition = await hydrateFormOptions(registrationFormDefinitionSchema.parse(version.definition), { attendeeTypes });
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
  const submission = await formWriteTransaction(async (tx) => {
    // Under the form lock, re-read the version: a test computed against an
    // older definition must never be stored as valid for a draft that has
    // since changed.
    const current = await tx.registrationFormVersion.findUnique({ where: { id: version.id }, select: { updatedAt: true, status: true } });
    if (!current || current.updatedAt.getTime() !== version.updatedAt.getTime() || current.status !== version.status) {
      throw new FormOperationError("EDIT_CONFLICT", "This version changed while the test ran. Reload it and run the test again.");
    }
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
  }, formId, eventId);
  return { id: submission.id, isValid: validation.isValid, validation, createdAt: submission.createdAt.toISOString() };
}

/**
 * Whether `formId` is one of `eventId`'s forms. The answer-count route
 * (#471) uses it so a form id from another event is a 404, never a way to
 * probe that event's data under this event's permission.
 */
export async function formBelongsToEvent(eventId: string, formId: string) {
  const form = await getPrisma().registrationForm.findFirst({
    where: { id: formId, eventId },
    select: { id: true },
  });
  return form !== null;
}

/**
 * Real counts for the builder's "review before removing" dialog (#471): how
 * many of this event's registrations already hold a submitted answer for
 * each given field key. Counted per registration, not per attendee, because
 * registration-scope answers are merged into every attendee's own
 * `formResponses` at submission time (see `usageResponseSetsFromJson` above
 * and `preparePublicRegistration`): counting attendees would multiply one
 * family's single answer by its size. `null`, `false`, `""`, `[]` and `{}`
 * are what an untouched optional field stores, so none of them count as an
 * answer. One parameterised query for every key; keys are matched exactly
 * as stored, never trimmed. Draft-only edits in the builder never change
 * this: it only ever reflects what attendees have actually submitted.
 */
export async function countFieldAnswers(
  eventId: string,
  fieldKeys: string[],
): Promise<Record<string, number>> {
  const keys = [...new Set(fieldKeys.filter((key) => key.length > 0))];
  if (keys.length === 0) return {};
  const rows = await getPrisma().$queryRaw<Array<{ key: string; count: bigint }>>(Prisma.sql`
    SELECT k.key AS key, COUNT(DISTINCT a."registrationId")::bigint AS count
    FROM unnest(${keys}::text[]) AS k(key)
    LEFT JOIN "RegistrationAttendee" a
      ON a."eventId" = ${eventId}
      AND a."formResponses" ? k.key
      AND (a."formResponses" -> k.key) NOT IN (
        'null'::jsonb, 'false'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb
      )
    GROUP BY k.key
  `);
  const counts: Record<string, number> = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(counts, row.key)) counts[row.key] = Number(row.count);
  }
  return counts;
}
