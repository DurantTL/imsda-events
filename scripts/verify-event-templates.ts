/**
 * Proves the event template guarantees (#152) against a real PostgreSQL
 * database: applying creates a draft event with its own rows; revising and
 * republishing the template leaves an event already created from it
 * untouched; a save racing a publish can never overwrite or publish an
 * unvalidated payload, and the partial unique index allows only one
 * PUBLISHED version; parallel applies with one request key create exactly one
 * event; a reused key with different details is refused; a stale published
 * payload is refused at apply; and archiving sticks. Uses fictitious staff
 * users and templates it creates and removes itself.
 *
 *   npm run test:event-templates
 */
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  draftEventTemplateInputSchema,
  EventTemplateReferenceError,
  eventTemplatePayloadSchema,
  parseEventTemplatePayload,
  validateEventTemplatePayloadReferences,
} from "../modules/event-templates/domain";
import { addStarterEventTemplates } from "../modules/event-templates/starter-repository";
import { starterEventTemplates } from "../modules/event-templates/starters";
import {
  applyEventTemplate,
  archiveEventTemplate,
  createEventTemplate,
  EventTemplateOperationError,
  getEventTemplate,
  publishEventTemplateVersion,
  saveEventTemplateDraft,
} from "../modules/event-templates/repository";
import { eventTemplateApiError } from "../modules/event-templates/api-errors";
import { eventSettingsInputSchema } from "../modules/events/schemas";
import { getEventSettings } from "../modules/events/repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "evttpl";
const adminId = `${P}_admin`;
const otherAdminId = `${P}_admin_2`;
const actors = [adminId, otherAdminId];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function isOperationError(error: unknown, code: EventTemplateOperationError["code"]) {
  return error instanceof EventTemplateOperationError && error.code === code;
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: actors } } });
  await prisma.eventTemplateApplication.deleteMany({ where: { actorUserId: { in: actors } } });
  await prisma.event.deleteMany({ where: { slug: { startsWith: `${P}-` } } });
  await prisma.eventTemplate.deleteMany({ where: { createdByUserId: { in: actors } } });
  await prisma.user.deleteMany({ where: { id: { in: actors } } });
}

/** Seeded starter templates set aside by `verifyStarters`, put back after cleanup. */
let seededStarterSnapshot: Awaited<ReturnType<typeof starterTemplates>> = [];

async function restoreSeededStarters() {
  for (const template of seededStarterSnapshot) {
    if (await prisma.eventTemplate.findUnique({ where: { id: template.id }, select: { id: true } })) continue;
    const { versions, ...row } = template;
    await prisma.eventTemplate.create({
      data: {
        ...row,
        versions: { create: versions.map((version) => ({
          id: version.id,
          createdByUserId: version.createdByUserId,
          versionNumber: version.versionNumber,
          status: version.status,
          payload: version.payload as Prisma.InputJsonValue,
          publishedAt: version.publishedAt,
          createdAt: version.createdAt,
          updatedAt: version.updatedAt,
        })) },
      },
    });
  }
}

async function main() {
  await cleanup();
  try {
    await run();
  } finally {
    await cleanup();
    await restoreSeededStarters();
  }
}

const goodPayload = (overrides: Record<string, unknown> = {}) => eventTemplatePayloadSchema.parse({
  audience: "CLUB",
  formTemplateKeys: ["simple_rsvp"],
  attendeeTypes: [{ code: "ADULT", label: "Adult" }, { code: "YOUTH", label: "Youth" }],
  moduleEnablement: { waitlistEnabled: true, autoPromoteWaitlist: true },
  messageTemplateDefaults: [{ key: "EVENT_ANNOUNCEMENT", subjectTemplate: "News from {{event_name}}", bodyTemplate: "Hello {{recipient_name}}." }],
  reportSelections: [],
  ...overrides,
});

/** A draft that saves fine but must never be published: its form template does not exist. */
const unpublishablePayload = () => goodPayload({ formTemplateKeys: ["evttpl_missing_form_template"] });

async function latestVersion(templateId: string) {
  const template = await getEventTemplate(templateId);
  return template.versions.find((version) => version.status === "DRAFT")
    ?? template.versions.find((version) => version.status === "PUBLISHED")!;
}

async function save(templateId: string, payload: ReturnType<typeof goodPayload>, expectedUpdatedAt?: string) {
  const expected = expectedUpdatedAt ?? (await latestVersion(templateId)).updatedAt;
  return saveEventTemplateDraft(templateId, adminId, { name: "Evttpl Retreat", description: "", payload, expectedUpdatedAt: expected });
}

/** Resolves once `count` backends in this database are waiting on a lock. */
async function waitForLockWaiters(count: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
      SELECT count(*) AS "waiting" FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if (Number(rows[0]?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`FAILED: expected ${count} lock waiter(s)`);
}

/**
 * Holds the template row lock from a separate transaction, starts `first`,
 * waits until it is queued behind the lock, starts `second`, waits for it
 * too, then releases — so the two run in a known order, each after the other
 * has fully committed or rolled back.
 */
async function inOrderBehindLock<A, B>(templateId: string, first: () => Promise<A>, second: () => Promise<B>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
  const blocker = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "EventTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
    locked();
    await released;
  }, { timeout: 20_000 });
  await lockTaken;
  const firstResult = first().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  await waitForLockWaiters(1);
  const secondResult = second().then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  await waitForLockWaiters(2);
  release();
  await blocker;
  return [await firstResult, await secondResult] as const;
}

async function eventRows(eventId: string) {
  const [event, attendeeTypes, forms, messages] = await Promise.all([
    prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { name: true, slug: true, audience: true, waitlistEnabled: true, updatedAt: true } }),
    prisma.eventAttendeeType.findMany({ where: { eventId }, orderBy: { code: "asc" }, select: { id: true, code: true, label: true, updatedAt: true } }),
    prisma.registrationForm.findMany({ where: { eventId }, orderBy: { slug: "asc" }, select: { id: true, slug: true, updatedAt: true, versions: { select: { id: true, definition: true, updatedAt: true } } } }),
    prisma.eventMessageTemplate.findMany({ where: { eventId }, select: { id: true, key: true, versions: { select: { status: true, subjectTemplate: true, bodyTemplate: true, updatedAt: true } } } }),
  ]);
  return JSON.stringify({ event, attendeeTypes, forms, messages });
}

async function run() {
  await prisma.user.createMany({ data: [
    { id: adminId, email: `${P}-admin@example.test`, displayName: "Template Check Admin", globalRole: "SYSTEM_ADMIN" },
    { id: otherAdminId, email: `${P}-admin-2@example.test`, displayName: "Template Check Admin 2", globalRole: "SYSTEM_ADMIN" },
  ] });

  // 1. Apply creates a draft event with its own rows, and it re-saves in settings.
  const created = await createEventTemplate(adminId, { name: "Evttpl Retreat", description: "", audience: "CLUB" });
  const templateId = created.id;
  await save(templateId, goodPayload());
  await publishEventTemplateVersion(templateId, adminId);
  const first = await applyEventTemplate(templateId, adminId, {
    name: "Evttpl Retreat 2027", slug: `${P}-retreat-2027`, startsOn: "2027-05-01", endsOn: "2027-05-03", requestKey: `${P}-key-apply-1`,
  });
  assert(!first.alreadyApplied && first.event, "the first apply creates an event");
  const firstEventId = first.event.id;
  assert(first.event.audience === "CLUB" && first.event.waitlistEnabled && !first.event.isPublished, "the event carries the payload's audience and toggles, unpublished");
  assert(await prisma.eventAttendeeType.count({ where: { eventId: firstEventId } }) === 2, "two attendee types were created");
  const form = await prisma.registrationForm.findFirstOrThrow({ where: { eventId: firstEventId }, include: { versions: true } });
  assert(await prisma.auditLog.count({ where: { action: "REGISTRATION_FORM_CREATED", entityId: form.id } }) === 1, "the form creation is audited (N3)");
  const message = await prisma.eventMessageTemplate.findFirstOrThrow({ where: { eventId: firstEventId }, include: { versions: true } });
  assert(message.versions.length === 1 && message.versions[0]!.status === "PUBLISHED", "the message default became the event's published version");
  const settings = await getEventSettings(firstEventId);
  const resave = eventSettingsInputSchema.safeParse({ ...settings, approvedPaymentInstructions: settings!.approvedPaymentInstructions ?? null });
  assert(resave.success, `the created event re-saves in settings: ${resave.success ? "" : JSON.stringify(resave.error.issues)}`);
  console.log("ok  apply creates a draft event with its own attendee types, audited form, and message version; it re-saves in settings");

  // 2. Revising and republishing the template leaves the existing event's rows unchanged.
  const before = await eventRows(firstEventId);
  await save(templateId, goodPayload({
    audience: "GENERAL",
    attendeeTypes: [{ code: "STAFF", label: "Staff" }],
    formTemplateKeys: ["retreat_registration"],
    messageTemplateDefaults: [{ key: "EVENT_ANNOUNCEMENT", subjectTemplate: "Changed {{event_name}}", bodyTemplate: "Changed." }],
  }));
  await publishEventTemplateVersion(templateId, adminId);
  const after = await eventRows(firstEventId);
  assert(before === after, "the existing event's rows are unchanged after the template is revised and republished");
  const firstApplication = await prisma.eventTemplateApplication.findFirstOrThrow({ where: { eventId: firstEventId } });
  const snapshot = eventTemplatePayloadSchema.parse(firstApplication.payloadSnapshot);
  assert(snapshot.attendeeTypes.length === 2 && snapshot.audience === "CLUB", "the application snapshot still records the version that was applied");
  const firstVersion = await prisma.eventTemplateVersion.findUniqueOrThrow({ where: { id: firstApplication.templateVersionId } });
  assert(firstVersion.status === "ARCHIVED" && JSON.stringify(eventTemplatePayloadSchema.parse(firstVersion.payload)) === JSON.stringify(snapshot), "the superseded version is archived with its payload intact");
  console.log("ok  revising and republishing leaves an already-created event and its provenance untouched");

  // 3a. Only one PUBLISHED version per template, enforced by the database.
  await save(templateId, goodPayload());
  const draftRow = await prisma.eventTemplateVersion.findFirstOrThrow({ where: { templateId, status: "DRAFT" } });
  const secondPublished = await prisma.eventTemplateVersion.update({ where: { id: draftRow.id }, data: { status: "PUBLISHED" } })
    .then(() => null, (error: unknown) => error);
  assert(secondPublished instanceof Prisma.PrismaClientKnownRequestError && secondPublished.code === "P2002", `a second PUBLISHED version should hit P2002, got ${String(secondPublished)}`);
  const secondDraft = await prisma.eventTemplateVersion.create({ data: { templateId, createdByUserId: adminId, versionNumber: 99, status: "DRAFT", payload: goodPayload() } })
    .then(() => null, (error: unknown) => error);
  assert(secondDraft instanceof Prisma.PrismaClientKnownRequestError && secondDraft.code === "P2002", `a second DRAFT version should hit P2002, got ${String(secondDraft)}`);
  console.log("ok  the partial unique indexes allow one PUBLISHED and one DRAFT version per template");

  // 3b. Publish queued ahead of a save: the save loses with EDIT_CONFLICT and
  // the published row keeps the payload that was validated.
  const draftBeforeRace = await latestVersion(templateId);
  assert(draftBeforeRace.status === "DRAFT", "there is a draft to race on");
  const validatedPayload = JSON.stringify(draftBeforeRace.payload);
  const [publishFirst, saveSecond] = await inOrderBehindLock(
    templateId,
    () => publishEventTemplateVersion(templateId, adminId),
    () => save(templateId, unpublishablePayload(), draftBeforeRace.updatedAt),
  );
  assert(publishFirst.ok, `the queued publish succeeds: ${publishFirst.ok ? "" : String(publishFirst.error)}`);
  assert(!saveSecond.ok && isOperationError(saveSecond.error, "EDIT_CONFLICT"), `the stale save is refused with EDIT_CONFLICT, got ${saveSecond.ok ? "success" : String(saveSecond.error)}`);
  const publishedAfterRace = await prisma.eventTemplateVersion.findMany({ where: { templateId, status: "PUBLISHED" } });
  assert(publishedAfterRace.length === 1 && publishedAfterRace[0]!.id === draftBeforeRace.id, "exactly one version is published: the one that was validated");
  assert(JSON.stringify(publishedAfterRace[0]!.payload) === validatedPayload, "the published payload is the validated one, not the racing save's");

  // 3c. Save queued ahead of a publish: publish re-reads and validates the
  // saved payload, refuses it, and publishes nothing.
  await save(templateId, goodPayload());
  const draftBeforeSecondRace = await latestVersion(templateId);
  const [saveFirst, publishSecond] = await inOrderBehindLock(
    templateId,
    () => save(templateId, unpublishablePayload(), draftBeforeSecondRace.updatedAt),
    () => publishEventTemplateVersion(templateId, adminId),
  );
  assert(saveFirst.ok, `the queued save succeeds: ${saveFirst.ok ? "" : String(saveFirst.error)}`);
  assert(!publishSecond.ok && publishSecond.error instanceof EventTemplateReferenceError, `publish refuses the unvalidated payload, got ${publishSecond.ok ? "success" : String(publishSecond.error)}`);
  const stillPublished = await prisma.eventTemplateVersion.findMany({ where: { templateId, status: "PUBLISHED" } });
  assert(stillPublished.length === 1 && stillPublished[0]!.id === draftBeforeRace.id, "the earlier published version stays the only published one");
  assert(JSON.stringify(stillPublished[0]!.payload) === validatedPayload, "its payload is still untouched");

  // 3d. Unordered races: whatever the interleaving, the published payload is always a validated one.
  await save(templateId, goodPayload());
  for (let round = 0; round < 5; round += 1) {
    const draft = await latestVersion(templateId);
    const payloadBefore = JSON.stringify(draft.payload);
    await Promise.allSettled([
      publishEventTemplateVersion(templateId, adminId),
      save(templateId, unpublishablePayload(), draft.updatedAt),
    ]);
    const published = await prisma.eventTemplateVersion.findMany({ where: { templateId, status: "PUBLISHED" } });
    assert(published.length === 1, `round ${round}: exactly one published version`);
    const publishedPayload = eventTemplatePayloadSchema.parse(published[0]!.payload);
    assert(!publishedPayload.formTemplateKeys.includes("evttpl_missing_form_template"), `round ${round}: an unvalidated payload was never published`);
    if (published[0]!.id === draft.id) assert(JSON.stringify(published[0]!.payload) === payloadBefore, `round ${round}: the published draft kept its validated payload`);
    await save(templateId, goodPayload());
  }
  console.log("ok  a save racing a publish never overwrites a published payload or publishes an unvalidated one");

  // 4. Parallel applies with one request key create exactly one event.
  await publishEventTemplateVersion(templateId, adminId);
  const parallelInput = { name: "Evttpl Parallel", slug: `${P}-parallel`, startsOn: "2027-06-01", endsOn: "2027-06-02", requestKey: `${P}-key-parallel` };
  const parallel = await Promise.allSettled([1, 2, 3].map(() => applyEventTemplate(templateId, adminId, parallelInput)));
  const rejected = parallel.filter((result) => result.status === "rejected");
  assert(rejected.length === 0, `every parallel apply returns the event: ${rejected.map((result) => String((result as PromiseRejectedResult).reason)).join("; ")}`);
  const fulfilled = parallel.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof applyEventTemplate>>>).value);
  assert(new Set(fulfilled.map((result) => result.event.id)).size === 1, "all three return the same event");
  assert(fulfilled.filter((result) => !result.alreadyApplied).length === 1, "exactly one of them created it");
  assert(await prisma.event.count({ where: { slug: parallelInput.slug } }) === 1, "one event exists for the slug");
  assert(await prisma.eventTemplateApplication.count({ where: { actorUserId: adminId, requestKey: parallelInput.requestKey } }) === 1, "one application row for the key");
  console.log("ok  three parallel applies with one request key create exactly one event and all return it");

  // 5. Key reuse: a different body is refused; another actor's same key is independent.
  const reused = await applyEventTemplate(templateId, adminId, { ...parallelInput, slug: `${P}-parallel-other` }).then(() => null, (error: unknown) => error);
  assert(isOperationError(reused, "REQUEST_KEY_REUSED"), `a reused key with a different slug is refused, got ${String(reused)}`);
  assert(await prisma.event.count({ where: { slug: `${P}-parallel-other` } }) === 0, "no event was created for the reused key");
  const otherActor = await applyEventTemplate(templateId, otherAdminId, { ...parallelInput, slug: `${P}-parallel-actor-2` });
  assert(!otherActor.alreadyApplied && otherActor.event.id !== fulfilled[0]!.event.id, "the same key from another actor is its own request");
  const slugTaken = await applyEventTemplate(templateId, adminId, { ...parallelInput, requestKey: `${P}-key-slug-taken` }).then(() => null, (error: unknown) => error);
  assert(isOperationError(slugTaken, "EVENT_SLUG_TAKEN"), `a new key for a taken slug is EVENT_SLUG_TAKEN, got ${String(slugTaken)}`);
  const badDate = await applyEventTemplate(templateId, adminId, { ...parallelInput, slug: `${P}-bad-date`, startsOn: "2027-02-30", requestKey: `${P}-key-bad-date` }).then(() => null, (error: unknown) => error);
  assert(badDate instanceof Error && badDate.name === "ZodError", `an impossible date is a validation error, got ${String(badDate)}`);
  console.log("ok  a reused key with different details is refused; keys are per actor; slugs and dates are validated");

  // 6. A published payload that no longer passes the message rules is refused at apply.
  const stale = await createEventTemplate(adminId, { name: "Evttpl Stale", description: "", audience: "GENERAL" });
  const staleVersion = await prisma.eventTemplateVersion.findFirstOrThrow({ where: { templateId: stale.id } });
  await prisma.eventTemplateVersion.update({ where: { id: staleVersion.id }, data: {
    status: "PUBLISHED",
    publishedAt: new Date(),
    payload: { ...goodPayload(), messageTemplateDefaults: [{ key: "EVENT_ANNOUNCEMENT", isEnabled: true, subjectTemplate: "Hi {{not_a_token}}\nBcc: someone@example.test", bodyTemplate: "Body" }] },
  } });
  await prisma.eventTemplate.update({ where: { id: stale.id }, data: { status: "PUBLISHED" } });
  assert(!draftEventTemplateInputSchema.safeParse({ name: "x-stale", payload: (await prisma.eventTemplateVersion.findUniqueOrThrow({ where: { id: staleVersion.id } })).payload, expectedUpdatedAt: new Date().toISOString() }).success, "the draft schema rejects that payload");
  const staleListing = await getEventTemplate(stale.id);
  assert(!staleListing.canApply && staleListing.versions[0]!.payloadIssues.length > 0, "the stale template still loads for display, flagged and not appliable");
  const staleApply = await applyEventTemplate(stale.id, adminId, { name: "Evttpl Stale Event", slug: `${P}-stale`, startsOn: "2027-07-01", endsOn: "2027-07-01", requestKey: `${P}-key-stale` })
    .then(() => null, (error: unknown) => error);
  assert(staleApply instanceof EventTemplateReferenceError, `a stale published payload is refused at apply, got ${String(staleApply)}`);
  assert(await prisma.event.count({ where: { slug: `${P}-stale` } }) === 0, "nothing was created from the stale payload");
  console.log("ok  a published message default with an unknown token or a subject line break is refused at apply");

  // 7. A template lock held elsewhere is waited on for at most lock_timeout (5s),
  // then reported as a retryable TEMPLATE_BUSY; nothing is written.
  const beforeBusy = await latestVersion(templateId);
  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
  let lockHeld!: () => void;
  const lockTaken = new Promise<void>((resolve) => { lockHeld = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "EventTemplate" WHERE "id" = ${templateId} FOR UPDATE`;
    lockHeld();
    await lockReleased;
  }, { timeout: 30_000 });
  await lockTaken;
  const busyStarted = Date.now();
  const busy = await save(templateId, goodPayload(), beforeBusy.updatedAt).then(() => null, (error: unknown) => error);
  const busyWaited = Date.now() - busyStarted;
  releaseLock();
  await holder;
  assert(busy !== null, "a save behind a held template lock fails instead of waiting forever");
  const busyResponse = eventTemplateApiError(busy, { failureMessage: "x", logMessage: "x" });
  assert(busyResponse.status === 409 && (await busyResponse.json()).error === "TEMPLATE_BUSY", `the lock timeout maps to 409 TEMPLATE_BUSY, got ${String(busy)}`);
  assert(busyWaited >= 4_000 && busyWaited < 15_000, `the wait is bounded by lock_timeout, waited ${busyWaited}ms`);
  assert((await latestVersion(templateId)).updatedAt === beforeBusy.updatedAt, "a busy save wrote nothing");
  console.log(`ok  a held template lock times out after ${Math.round(busyWaited / 100) / 10}s as a retryable 409 TEMPLATE_BUSY and writes nothing`);

  // 8. Archive sticks: saving, publishing, and applying are all refused afterward.
  await archiveEventTemplate(templateId, adminId);
  const saveArchived = await save(templateId, goodPayload()).then(() => null, (error: unknown) => error);
  assert(isOperationError(saveArchived, "TEMPLATE_ARCHIVED"), `saving an archived template is refused, got ${String(saveArchived)}`);
  const publishArchived = await publishEventTemplateVersion(templateId, adminId).then(() => null, (error: unknown) => error);
  assert(isOperationError(publishArchived, "TEMPLATE_ARCHIVED"), `publishing an archived template is refused, got ${String(publishArchived)}`);
  const applyArchived = await applyEventTemplate(templateId, adminId, { name: "Evttpl Archived", slug: `${P}-archived`, startsOn: "2027-08-01", endsOn: "2027-08-02", requestKey: `${P}-key-archived` })
    .then(() => null, (error: unknown) => error);
  assert(isOperationError(applyArchived, "TEMPLATE_ARCHIVED"), `applying an archived template is refused, got ${String(applyArchived)}`);
  const archived = await getEventTemplate(templateId);
  assert(archived.status === "ARCHIVED" && !archived.canApply, "the template is still archived and not appliable");
  assert(await eventRows(firstEventId) === after, "archiving did not touch the event created from it");
  console.log("ok  archive sticks: save, publish, and apply are refused afterward, and existing events are untouched");

  await verifyStarters();
}

/** Every template whose payload carries a `starterKey`, with its versions. */
async function starterTemplates() {
  const all = await prisma.eventTemplate.findMany({ include: { versions: true } });
  return all.filter((template) => template.versions.some((version) => typeof (version.payload as { starterKey?: unknown } | null)?.starterKey === "string"));
}

const keyOf = (template: { versions: { payload: unknown }[] }) => (template.versions[0]!.payload as { starterKey?: string }).starterKey;
const isOwn = (template: { createdByUserId: string }) => actors.includes(template.createdByUserId);

/**
 * Starter templates (#546). A dev database that was seeded already holds
 * published starters. Those never get deleted while an event was created from
 * them (the application row restricts it), so only seeded starters with no
 * applications are set aside (and restored in `main`); whatever remains is
 * simply expected to be skipped, so every count below is computed from the
 * starters that are actually missing.
 */
async function verifyStarters() {
  // 0. `starterKey` is server-owned: a client-set key on an unrelated template
  // is ignored, so it can never hide a real starter.
  const unrelated = await createEventTemplate(adminId, { name: "Evttpl Unrelated", description: "", audience: "GENERAL" });
  await saveEventTemplateDraft(unrelated.id, adminId, {
    name: "Evttpl Unrelated", description: "", payload: eventTemplatePayloadSchema.parse({ starterKey: "honors_weekend" }),
    expectedUpdatedAt: (await latestVersion(unrelated.id)).updatedAt,
  });
  const forged = await prisma.eventTemplateVersion.findMany({ where: { templateId: unrelated.id } });
  assert(forged.every((version) => (version.payload as { starterKey?: string }).starterKey === undefined), "a client-set starterKey is not stored");
  console.log("ok  a client-set starterKey on an unrelated template is ignored");

  const seeded = (await starterTemplates()).filter((template) => !isOwn(template));
  const applied = new Set((await prisma.eventTemplateApplication.findMany({ where: { templateId: { in: seeded.map((template) => template.id) } }, select: { templateId: true } })).map((row) => row.templateId));
  const setAside = seeded.filter((template) => !applied.has(template.id));
  seededStarterSnapshot = setAside;
  await prisma.eventTemplate.deleteMany({ where: { id: { in: setAside.map((template) => template.id) } } });
  const remaining = (await starterTemplates()).filter((template) => !isOwn(template));
  assert(remaining.every((template) => applied.has(template.id)), "only seeded starters that events were created from remain");
  const remainingKeys = new Set(remaining.map(keyOf));
  const missing = starterEventTemplates.filter((starter) => !remainingKeys.has(starter.starterKey));
  console.log(`ok  ${remaining.length} seeded starter(s) with applications left in place; ${missing.length} are missing`);

  // 1. One click creates every missing starter as a valid, priceless DRAFT named for its source form.
  const first = await addStarterEventTemplates(adminId);
  assert(first.added.length === missing.length && first.skipped.length === remaining.length, `one click adds the ${missing.length} missing starters, added ${first.added.length}`);
  assert(first.added.map((entry) => entry.starterKey).sort().join() === missing.map((starter) => starter.starterKey).sort().join(), "exactly the missing starters were added");
  if (remaining.length === 0) assert(first.added.length === 5, "on a database with no starters one click adds 5");
  assert(first.stillNeeded.length === 1 && first.stillNeeded[0]!.name === "Fall Camporee", "Fall Camporee is listed as still needing a form");
  const created = (await starterTemplates()).filter(isOwn);
  assert(created.length === missing.length, "the missing starters now exist");
  for (const template of created) {
    const starter = starterEventTemplates.find((entry) => entry.starterKey === keyOf(template))!;
    assert(template.status === "DRAFT" && template.versions.length === 1 && template.versions[0]!.status === "DRAFT", `${starter.name} is a DRAFT`);
    assert(template.name === starter.name && template.description.includes("Starter set") && template.description.includes(starter.formTemplateKey), `${starter.name} names its source form`);
    const payload = parseEventTemplatePayload(template.versions[0]!.payload);
    validateEventTemplatePayloadReferences(payload);
    assert(payload.audience === starter.audience, `${starter.name} audience`);
    assert(!/price|capacity|cents/i.test(JSON.stringify(template.versions[0]!.payload)), `${starter.name} carries no pricing or capacity`);
  }
  assert(await prisma.auditLog.count({ where: { actorUserId: adminId, action: "EVENT_TEMPLATE_CREATED", summary: { startsWith: "Created starter event template" } } }) === missing.length, "each starter creation is audited");
  assert((await starterTemplates()).length === 5, "five starters exist in total");
  console.log("ok  one click creates the missing starters as valid DRAFTs (no pricing or capacity); Fall Camporee is listed as form still needed");

  // 2. Re-running adds nothing.
  const second = await addStarterEventTemplates(adminId);
  assert(second.added.length === 0 && second.skipped.length === 5, `re-running adds 0, added ${second.added.length}`);
  assert((await starterTemplates()).length === 5, "still five starters after a re-run");
  console.log("ok  re-running adds 0 and skips all 5");

  // 3. Two clicks at once still add each starter only once.
  await prisma.eventTemplate.deleteMany({ where: { id: { in: created.map((template) => template.id) } } });
  const raced = await Promise.all([addStarterEventTemplates(adminId), addStarterEventTemplates(otherAdminId)]);
  assert(raced[0].added.length + raced[1].added.length === missing.length && (await starterTemplates()).length === 5, "concurrent clicks add each starter exactly once");
  console.log("ok  two simultaneous clicks add each starter exactly once");

  // 4. A held starter lock times out as a retryable 409 instead of waiting forever.
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let locked!: () => void;
  const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('event-template-starters'))`;
    locked();
    await released;
  }, { timeout: 20_000 });
  await lockTaken;
  const startedWaiting = Date.now();
  const busy = await addStarterEventTemplates(adminId).then(() => null, (error: unknown) => error);
  const waited = Date.now() - startedWaiting;
  release();
  await holder;
  assert(busy !== null, "adding starters behind a held lock fails instead of waiting forever");
  const busyResponse = eventTemplateApiError(busy, { failureMessage: "x", logMessage: "x" });
  assert(busyResponse.status === 409 && (await busyResponse.json()).error === "TEMPLATE_BUSY", `the lock timeout maps to 409 TEMPLATE_BUSY, got ${String(busy)}`);
  assert(waited >= 3_000 && waited < 15_000, `the wait is bounded, waited ${waited}ms`);
  assert((await starterTemplates()).length === 5, "a busy attempt added nothing");
  console.log(`ok  a held starter lock times out after ${Math.round(waited / 100) / 10}s as a retryable 409 TEMPLATE_BUSY`);

  // 5. Every draft this run created publishes, then applies to a complete draft event.
  const own = (await starterTemplates()).filter(isOwn);
  for (const template of own) {
    const starter = starterEventTemplates.find((entry) => entry.starterKey === keyOf(template))!;
    const published = await publishEventTemplateVersion(template.id, adminId);
    assert(published.status === "PUBLISHED" && published.canApply, `${starter.name} publishes and is appliable`);
    const slug = `${P}-starter-${starter.starterKey.replace(/_/g, "-")}`;
    const result = await applyEventTemplate(template.id, adminId, { name: `${starter.name} 2027`, slug, startsOn: "2027-06-01", endsOn: "2027-06-03", requestKey: `${P}-key-starter-${starter.starterKey}` });
    const event = result.event;
    assert(!result.alreadyApplied && !event.isPublished && event.audience === starter.audience, `${starter.name} applies to an unpublished ${starter.audience} draft event`);
    assert(event.collectsShirtSizes === starter.collectsShirtSizes && event.checksAdultBackgrounds === starter.checksAdultBackgrounds, `${starter.name} carries its module switches`);
    assert(!event.waitlistEnabled, `${starter.name} leaves the waitlist off`);
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: event.id }, select: { capacity: true } });
    assert(stored.capacity === null, `${starter.name} sets no capacity`);
    const forms = await prisma.registrationForm.findMany({ where: { eventId: event.id }, include: { versions: true } });
    assert(forms.length === 1 && forms[0]!.versions.length === 1 && forms[0]!.versions[0]!.definition !== null, `${starter.name} created its registration form draft`);
    assert(await prisma.eventMembership.count({ where: { eventId: event.id, userId: adminId, role: "EVENT_ADMIN" } }) === 1, `${starter.name} made the applier its event admin`);
    assert(await prisma.eventTemplateApplication.count({ where: { templateId: template.id, eventId: event.id } }) === 1, `${starter.name} recorded its application`);
    const resave = eventSettingsInputSchema.safeParse({ ...(await getEventSettings(event.id)), approvedPaymentInstructions: null });
    assert(resave.success, `${starter.name} event re-saves in settings`);
  }
  console.log(`ok  ${own.length} starters publish and apply to complete unpublished draft events (form, switches, no capacity)`);

  // 6. Edited and archived starters are left alone by a re-run, and the key is server-owned on save.
  assert(own.length >= 2, "at least two starters of this run are available to edit and archive");
  const editedTemplate = own[0]!;
  const archivedTemplate = own[1]!;
  const editedKey = keyOf(editedTemplate)!;
  const publishedVersion = editedTemplate.versions.find((version) => version.status === "PUBLISHED")!;
  // Staff rename it and try to change the key: the stored key is kept.
  await saveEventTemplateDraft(editedTemplate.id, adminId, {
    name: "Evttpl Renamed Retreat", description: "Edited by staff.",
    payload: eventTemplatePayloadSchema.parse({ starterKey: "fall_camporee", audience: "CLUB", formTemplateKeys: ["simple_rsvp"] }),
    expectedUpdatedAt: publishedVersion.updatedAt.toISOString(),
  });
  let draft = (await getEventTemplate(editedTemplate.id)).versions.find((version) => version.status === "DRAFT")!;
  assert((draft.payload as { starterKey?: string }).starterKey === editedKey, "a client-changed starterKey is ignored; the stored key stays");
  // A later save that drops the key keeps it too.
  await saveEventTemplateDraft(editedTemplate.id, adminId, {
    name: "Evttpl Renamed Retreat", description: "Edited by staff.",
    payload: eventTemplatePayloadSchema.parse({ audience: "CLUB", formTemplateKeys: ["simple_rsvp"] }), expectedUpdatedAt: draft.updatedAt,
  });
  await archiveEventTemplate(archivedTemplate.id, adminId);
  const third = await addStarterEventTemplates(adminId);
  assert(third.added.length === 0 && third.skipped.length === 5, `re-running after edits adds 0, added ${third.added.length}`);
  assert(third.skipped.find((entry) => entry.starterKey === keyOf(archivedTemplate))?.reason === "ARCHIVED", "the archived starter is reported as archived");
  const afterEdit = await getEventTemplate(editedTemplate.id);
  draft = afterEdit.versions.find((version) => version.status === "DRAFT")!;
  assert(afterEdit.name === "Evttpl Renamed Retreat" && afterEdit.description === "Edited by staff.", "the edited starter keeps staff's name and description");
  assert((draft.payload as { audience?: string }).audience === "CLUB" && (draft.payload as { formTemplateKeys?: string[] }).formTemplateKeys?.[0] === "simple_rsvp", "the edited starter keeps staff's payload");
  assert((draft.payload as { starterKey?: string }).starterKey === editedKey, "saving a draft keeps the starter's identity");
  const afterArchive = await getEventTemplate(archivedTemplate.id);
  assert(afterArchive.status === "ARCHIVED" && !afterArchive.canApply, "the archived starter stays archived");
  assert((await starterTemplates()).length === 5, "no duplicates after edits and archive");
  console.log("ok  an edited starter and an archived starter are left alone; the starterKey is server-owned; no duplicates");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
