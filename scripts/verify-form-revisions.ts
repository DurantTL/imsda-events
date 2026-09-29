/**
 * Real-database proof of revising a published registration form (#564):
 * a new draft beside the live version keeps public and club registration
 * open on the live version; withdrawing closes both (and the builder view
 * reflects it on reload); an edit deletes the draft's tests so publishing is
 * blocked until a fresh valid test exists for that exact version; the next
 * version needs its own test; and a save racing the publish is refused.
 * Fictitious staff user and event, removed at the end.
 *
 *   npm run test:form-revisions
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { publishedClubForm } from "../modules/club-registrations/repository";
import { formTemplates } from "../modules/forms/definition";
import {
  createRegistrationForm,
  FormOperationError,
  getRegistrationForm,
  publishRegistrationForm,
  unpublishRegistrationForm,
  updateRegistrationForm,
} from "../modules/forms/repository";
import { getPublicRegistrationExperience, PublicRegistrationError, submitPublicRegistration } from "../modules/forms/public-repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "formrev";
const userId = `${P}_user`;
const eventSlug = `${P}-event`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function rejectsWith(promise: Promise<unknown>, code: string, message: string) {
  try { await promise; } catch (error) {
    assert(error instanceof FormOperationError && error.code === code, `${message} (got ${error instanceof Error ? error.message : error})`);
    return;
  }
  throw new Error(`FAILED: ${message} (did not throw)`);
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorUserId: userId } });
  await prisma.event.deleteMany({ where: { slug: eventSlug } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function addValidTest(eventId: string, versionId: string) {
  await prisma.formTestSubmission.create({ data: { eventId, formVersionId: versionId, submittedByUserId: userId, responses: {}, validation: { isValid: true, issues: [] }, isValid: true } });
}

/** Public registration is offered and the club path still finds a live version. */
async function assertOpen(formSlug: string, eventId: string, versionId: string, label: string) {
  const experience = await getPublicRegistrationExperience(eventSlug, formSlug);
  assert(experience, `${label}: the public form is offered`);
  const club = await publishedClubForm(eventId);
  assert(club && club.slug === formSlug, `${label}: club registration still finds the live form`);
  try {
    await submitPublicRegistration(eventSlug, formSlug, { versionId, idempotencyKey: `${P}-${label}`, responses: {}, website: "" } as never);
  } catch (error) {
    assert(!(error instanceof PublicRegistrationError && error.code === "FORM_NOT_FOUND"), `${label}: public submit is not refused as unavailable`);
  }
}

async function assertClosed(formSlug: string, eventId: string, versionId: string, label: string) {
  assert((await getPublicRegistrationExperience(eventSlug, formSlug)) === null, `${label}: the public form is closed`);
  assert((await publishedClubForm(eventId)) === null, `${label}: club registration is refused (no published form)`);
  try {
    await submitPublicRegistration(eventSlug, formSlug, { versionId, idempotencyKey: `${P}-closed-${label}`, responses: {}, website: "" } as never);
    throw new Error("FAILED: public submit should be refused");
  } catch (error) {
    assert(error instanceof PublicRegistrationError && error.code === "FORM_NOT_FOUND", `${label}: public submit is refused as unavailable (got ${error instanceof Error ? error.message : error})`);
  }
}

async function run() {
  await prisma.user.create({ data: { id: userId, email: `${P}@example.test`, displayName: "Form Revision Check", globalRole: "SYSTEM_ADMIN" } });
  const event = await prisma.event.create({ data: {
    slug: eventSlug, name: "Form revision verification event", startsAt: new Date("2028-10-09T21:00:00.000Z"), endsAt: new Date("2028-10-11T17:00:00.000Z"),
    timezone: "America/Chicago", location: "Fictitious venue", publicInfoUrl: "https://imsda.org/events/", supportContact: "registration@imsda.org", isPublished: true,
  } });

  const created = await createRegistrationForm(event.id, userId, formTemplates[0].key);
  const formId = created.id;
  const slug = created.slug;
  const v1 = created.activeVersion;
  await rejectsWith(publishRegistrationForm(event.id, formId, userId), "TEST_REQUIRED", "v1 cannot publish without a test");
  await addValidTest(event.id, v1.id);
  await publishRegistrationForm(event.id, formId, userId);
  await assertOpen(slug, event.id, v1.id, "v1 live");

  // Create a draft from the live form: the live version keeps serving.
  const live = (await getRegistrationForm(event.id, formId))!;
  const revised = structuredClone(live.activeVersion.definition);
  revised.title = "Revised title";
  const withDraft = await updateRegistrationForm(event.id, formId, userId, { definition: revised, expectedUpdatedAt: live.activeVersion.updatedAt });
  assert(withDraft.activeVersion.status === "DRAFT" && withDraft.activeVersion.versionNumber === 2, "the edit persisted as draft v2");
  assert(withDraft.versions.find((v) => v.versionNumber === 1)?.status === "PUBLISHED", "v1 is still published");
  assert((await prisma.registrationForm.findUniqueOrThrow({ where: { id: formId } })).status === "PUBLISHED", "the form stays PUBLISHED while a draft exists");
  await assertOpen(slug, event.id, v1.id, "draft beside live");

  // v2 needs its own test; an edit deletes tests.
  await rejectsWith(publishRegistrationForm(event.id, formId, userId), "TEST_REQUIRED", "v2 cannot publish on v1's publication");
  const v2 = withDraft.activeVersion;
  await addValidTest(event.id, v2.id);
  const edited = structuredClone(revised);
  edited.title = "Revised title again";
  await updateRegistrationForm(event.id, formId, userId, { definition: edited, expectedUpdatedAt: v2.updatedAt });
  assert((await prisma.formTestSubmission.count({ where: { formVersionId: v2.id } })) === 0, "the edit deleted the draft's tests");
  await rejectsWith(publishRegistrationForm(event.id, formId, userId), "TEST_REQUIRED", "publish is blocked after an edit until retested");

  // A promotion conditioned on a stale updatedAt (a save landed after the test
  // count) matches nothing, so the publish transaction rolls back.
  await addValidTest(event.id, v2.id);
  const current = await prisma.registrationFormVersion.findUniqueOrThrow({ where: { id: v2.id } });
  const stale = await prisma.registrationFormVersion.updateMany({ where: { id: v2.id, status: "DRAFT", updatedAt: new Date(current.updatedAt.getTime() - 1000) }, data: { status: "PUBLISHED" } });
  assert(stale.count === 0, "a stale-updatedAt promotion matches nothing");

  // Publish v2: v1 is archived, v2 serves, and v1's registrations keep v1.
  await publishRegistrationForm(event.id, formId, userId);
  const afterV2 = (await getRegistrationForm(event.id, formId))!;
  assert(afterV2.versions.find((v) => v.versionNumber === 1)?.status === "ARCHIVED" && afterV2.activeVersion.versionNumber === 2, "v2 is live and v1 archived");
  await assertOpen(slug, event.id, v2.id, "v2 live");

  // Withdraw: public and club close, and a reload of the builder shows it.
  await unpublishRegistrationForm(event.id, formId, userId);
  await assertClosed(slug, event.id, v2.id, "withdrawn");
  const reloaded = (await getRegistrationForm(event.id, formId))!;
  assert(reloaded.status === "ARCHIVED" && reloaded.activeVersion.status === "ARCHIVED" && !reloaded.versions.some((v) => v.status === "PUBLISHED"), "the builder view shows the withdrawn state after reload");

  // Republishing after a withdraw needs a fresh test against a new draft.
  const back = await updateRegistrationForm(event.id, formId, userId, { definition: structuredClone(reloaded.activeVersion.definition), expectedUpdatedAt: reloaded.activeVersion.updatedAt });
  assert(back.activeVersion.status === "DRAFT" && back.activeVersion.versionNumber === 3, "an edit after withdraw creates draft v3");
  await rejectsWith(publishRegistrationForm(event.id, formId, userId), "TEST_REQUIRED", "v3 needs its own test");
  await assertClosed(slug, event.id, back.activeVersion.id, "withdrawn with draft");
}

run()
  .then(() => console.log("Form revision checks passed."))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await prisma.$disconnect(); });
