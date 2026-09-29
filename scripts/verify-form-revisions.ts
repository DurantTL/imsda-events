/**
 * Real-database proof of revising a published registration form (#564).
 * Sequential: a new draft beside the live version keeps public and club
 * registration open on the live version; withdrawing closes both (and the
 * builder view reflects it on reload); an edit deletes the draft's tests so
 * publishing is blocked until a fresh valid test exists for that exact
 * version; the next version needs its own test; a promotion conditioned on a
 * stale updatedAt matches nothing.
 * Concurrent (real overlapping transactions through the form-row lock, run
 * repeatedly so both orders occur): a save racing a publish never mutates the
 * version that got published; a save racing a withdraw always ends with no
 * live version and public/club closed; a test racing a save never leaves a
 * valid test on the edited draft, so publish stays blocked.
 * Fictitious staff user and events; leftovers from a crashed earlier run are
 * removed before it starts and again when it ends.
 *
 *   npm run test:form-revisions
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { publishedClubForm } from "../modules/club-registrations/repository";
import { formTemplates } from "../modules/forms/definition";
import {
  createRegistrationForm,
  createTestSubmission,
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
const raceEventSlug = `${P}-race-event`;
const userEmail = `${P}@example.test`;

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
  await prisma.event.deleteMany({ where: { slug: { in: [eventSlug, raceEventSlug] } } });
  await prisma.user.deleteMany({ where: { OR: [{ id: userId }, { email: userEmail }] } });
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
  await cleanup();
  await prisma.user.create({ data: { id: userId, email: userEmail, displayName: "Form Revision Check", globalRole: "SYSTEM_ADMIN" } });
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

  await races();
}

function eventData(slug: string) {
  return {
    slug, name: "Form revision verification event", startsAt: new Date("2028-10-09T21:00:00.000Z"), endsAt: new Date("2028-10-11T17:00:00.000Z"),
    timezone: "America/Chicago", location: "Fictitious venue", publicInfoUrl: "https://imsda.org/events/", supportContact: "registration@imsda.org", isPublished: true,
  };
}

async function settle<A, B>(a: Promise<A>, b: Promise<B>) {
  const [ra, rb] = await Promise.allSettled([a, b]);
  return [ra, rb] as const;
}

function conflictCode(result: PromiseSettledResult<unknown>) {
  return result.status === "rejected" && result.reason instanceof FormOperationError ? result.reason.code : null;
}

const contact = { first_name: "Test", last_name: "Person", email: "race@example.test" };

/** A form with every field optional, so an empty test submission is valid; live at v1. */
async function liveForm(eventId: string, title: string) {
  const simple = formTemplates.find((template) => template.key === "simple_rsvp") ?? formTemplates[0];
  const created = await createRegistrationForm(eventId, userId, simple.key);
  const relaxed = structuredClone(created.activeVersion.definition);
  relaxed.title = title;
  for (const section of relaxed.sections) for (const field of section.fields) field.required = false;
  const saved = await updateRegistrationForm(eventId, created.id, userId, { definition: relaxed, expectedUpdatedAt: created.activeVersion.updatedAt });
  const test = await createTestSubmission(eventId, created.id, userId, { versionId: saved.activeVersion.id, responses: contact });
  assert(test.isValid, `the relaxed form accepts an empty test submission ${JSON.stringify(test.validation.issues)}`);
  await publishRegistrationForm(eventId, created.id, userId);
  return { formId: created.id, relaxed };
}

async function races() {
  const event = await prisma.event.create({ data: eventData(raceEventSlug) });
  const rounds = 8;

  // Save vs publish: the version that got published is never mutated by the save.
  const saveVsPublish = { publishedFirst: 0, savedFirst: 0 };
  for (let i = 0; i < rounds; i += 1) {
    const { formId, relaxed } = await liveForm(event.id, `Race A${i} live`);
    const draftDefinition = { ...structuredClone(relaxed), title: `Race A${i} draft` };
    const withDraft = await updateRegistrationForm(event.id, formId, userId, { definition: draftDefinition, expectedUpdatedAt: (await getRegistrationForm(event.id, formId))!.activeVersion.updatedAt });
    const draft = withDraft.activeVersion;
    const tested = await createTestSubmission(event.id, formId, userId, { versionId: draft.id, responses: contact });
    assert(tested.isValid, "the draft is tested before the race");
    const edited = { ...structuredClone(draftDefinition), title: `Race A${i} edited` };
    const [save, publish] = await settle(
      updateRegistrationForm(event.id, formId, userId, { definition: edited, expectedUpdatedAt: draft.updatedAt }),
      publishRegistrationForm(event.id, formId, userId),
    );
    const v2 = await prisma.registrationFormVersion.findUniqueOrThrow({ where: { id: draft.id } });
    const v2Title = (v2.definition as { title: string }).title;
    if (v2.status === "PUBLISHED") {
      saveVsPublish.publishedFirst += 1;
      assert(publish.status === "fulfilled", "publish won the race");
      assert(conflictCode(save) === "EDIT_CONFLICT", `the losing save is refused, not applied (got ${conflictCode(save) ?? save.status})`);
      assert(v2Title === `Race A${i} draft`, "the published version still has exactly the tested definition");
    } else {
      saveVsPublish.savedFirst += 1;
      assert(save.status === "fulfilled" && conflictCode(publish) === "TEST_REQUIRED", `the save won, so publish is blocked for lack of a test (got ${conflictCode(publish) ?? publish.status})`);
      assert(v2.status === "DRAFT" && v2Title === `Race A${i} edited`, "the save applied to the draft");
      assert((await prisma.formTestSubmission.count({ where: { formVersionId: draft.id } })) === 0, "the save deleted the draft's tests");
    }
    assert((await prisma.registrationFormVersion.count({ where: { formId, status: "PUBLISHED" } })) === 1, "exactly one version is published");
  }

  // Save vs withdraw: whoever wins, no version is live afterwards and the form ends ARCHIVED.
  const saveVsWithdraw = { withdrawnFirst: 0, savedFirst: 0 };
  for (let i = 0; i < rounds; i += 1) {
    const { formId, relaxed } = await liveForm(event.id, `Race B${i} live`);
    const live = (await getRegistrationForm(event.id, formId))!;
    const [save, withdraw] = await settle(
      updateRegistrationForm(event.id, formId, userId, { definition: { ...structuredClone(relaxed), title: `Race B${i} draft` }, expectedUpdatedAt: live.activeVersion.updatedAt }),
      unpublishRegistrationForm(event.id, formId, userId),
    );
    assert(withdraw.status === "fulfilled", "the withdraw always succeeds");
    // A withdraw that lands first bumps the version's updatedAt, so the save is refused as stale.
    assert(save.status === "fulfilled" || conflictCode(save) === "EDIT_CONFLICT", `the save either creates a draft or is refused as a conflict (got ${conflictCode(save) ?? save.status})`);
    if (save.status === "fulfilled") saveVsWithdraw.savedFirst += 1; else saveVsWithdraw.withdrawnFirst += 1;
    const form = await prisma.registrationForm.findUniqueOrThrow({ where: { id: formId }, include: { versions: true } });
    assert(!form.versions.some((version) => version.status === "PUBLISHED"), "no version is live after the withdraw");
    assert(form.status === "ARCHIVED", `the form ends ARCHIVED (got ${form.status})`);
    assert((await getPublicRegistrationExperience(raceEventSlug, form.slug)) === null, "the public form is closed");
  }

  // Test vs save: a test computed against the old content never survives as valid on the edited draft.
  const testVsSave = { testedFirst: 0, savedFirst: 0 };
  for (let i = 0; i < rounds; i += 1) {
    const { formId, relaxed } = await liveForm(event.id, `Race C${i} live`);
    const draftDefinition = { ...structuredClone(relaxed), title: `Race C${i} draft` };
    const withDraft = await updateRegistrationForm(event.id, formId, userId, { definition: draftDefinition, expectedUpdatedAt: (await getRegistrationForm(event.id, formId))!.activeVersion.updatedAt });
    const draft = withDraft.activeVersion;
    const [test, save] = await settle(
      createTestSubmission(event.id, formId, userId, { versionId: draft.id, responses: contact }),
      updateRegistrationForm(event.id, formId, userId, { definition: { ...structuredClone(draftDefinition), title: `Race C${i} edited` }, expectedUpdatedAt: draft.updatedAt }),
    );
    assert(save.status === "fulfilled", "the save applies");
    if (test.status === "fulfilled") testVsSave.testedFirst += 1;
    else { assert(conflictCode(test) === "EDIT_CONFLICT", `a losing test is refused as a conflict (got ${conflictCode(test) ?? "other"})`); testVsSave.savedFirst += 1; }
    assert((await prisma.formTestSubmission.count({ where: { formVersionId: draft.id, isValid: true } })) === 0, "no valid test remains against the edited draft");
    await rejectsWith(publishRegistrationForm(event.id, formId, userId), "TEST_REQUIRED", "the edited draft cannot publish on a stale test");
  }
  console.log("Race orders seen", JSON.stringify({ saveVsPublish, saveVsWithdraw, testVsSave }));
}

run()
  .then(() => console.log("Form revision checks passed."))
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await cleanup(); await prisma.$disconnect(); });
