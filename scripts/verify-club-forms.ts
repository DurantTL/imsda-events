/**
 * Proves club forms (#610) against a real PostgreSQL database, where the unit
 * tests' fake database can't:
 *
 * - templates are created disabled, invisible to clubs until a system
 *   administrator turns one on, and switching it off hides it again;
 * - sensitive answers are encrypted at rest: the row holds only a sealed value,
 *   the plaintext appears in no column, audit row or outbox row, it round-trips
 *   for the club's director, a value copied to another row cannot be opened,
 *   and the database CHECK constraints hold;
 * - role visibility on real rows: the club's director (drafts included), another
 *   club's director (nothing), an Area Coordinator ("Restricted", submitted
 *   forms only), an Event Admin (health and conduct answers, birth dates
 *   Restricted) and a system administrator (everything), and forms switched
 *   off (past submissions stay readable);
 * - a template version that makes a field newly sensitive re-seals existing
 *   submissions, and the club deletion check counts club forms;
 * - the re-seal and a concurrent save cannot leave plaintext behind: a save
 *   holding the template's share lock makes the re-seal wait and then seal
 *   the save's row, and a save started during a re-seal waits for it and
 *   reads the new keys;
 * - every view of a submission with sensitive answers writes one audit row that
 *   carries no answer text;
 * - a private link: the emailed token is minted at delivery and stored only as a
 *   hash, single use holds when many submits race (exactly one submission),
 *   expiry, withdrawal, a link that lost its email delivery, a submit racing a
 *   withdrawal, another club's link, and the real rate limits;
 * - the staff CSV has no sensitive column and no sensitive text.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:club-forms
 */
import { createHash, randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { Prisma, PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());
// Outbox rows are only written, never delivered, here: placeholders turn the
// queueing path on. The encryption key is synthetic when none is configured.
process.env.RESEND_API_KEY ||= "verify-script-placeholder-never-sent";
process.env.ACCOUNT_EMAIL_SENDER_ADDRESS ||= "events@clubforms.example.test";
process.env.SECRET_ENCRYPTION_KEY ||= "verify-club-forms-synthetic-key-not-a-secret";
process.env.APP_BASE_URL ||= "https://events.clubforms.example.test";

const prisma = new PrismaClient();
const P = "cf610";
const clubs = { a: `${P}_club_a`, b: `${P}_club_b` };
const clubIds = Object.values(clubs);
const users = { admin: `${P}_admin`, eventAdmin: `${P}_event_admin`, sysAdmin: `${P}_sys_admin` };
const accounts = { a: `${P}_acct_a`, b: `${P}_acct_b`, area: `${P}_acct_area` };
const SLIP = "off_premises_permission_slip";
const STAFF_FORM = "pathfinder_staff_service_information";
const PASSENGERS = "transportation_passenger_list";
const templateKeys = [SLIP, STAFF_FORM, PASSENGERS, "pathfinder_membership_application"];
const BUILDER_PREFIX = "cf712_";
const emailDomain = "clubforms.example.test";
const SECRET_PHYSICIAN = "Dr. Verify Physician Only";
// The normalised form: phones are stored as (515) 555-0134 (#855), so the sealed round trip compares that.
const SECRET_PHONE = "(515) 555-0177";
const SECRET_HEALTH = "Verify health detail only";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  assert(
    error && typeof error === "object" && "code" in error && (error as { code: string }).code === code,
    `${message}: expected ${code}, got ${String(error)}`,
  );
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function cleanup() {
  const links = await prisma.clubFormLink.findMany({ where: { organizationId: { in: clubIds } }, select: { id: true, messageId: true } });
  const submissions = await prisma.clubFormSubmission.findMany({ where: { organizationId: { in: clubIds } }, select: { id: true } });
  const templates = await prisma.clubFormTemplate.findMany({ where: { OR: [{ key: { in: templateKeys } }, { key: { startsWith: BUILDER_PREFIX } }] }, select: { id: true } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: [...links, ...submissions].map((row) => row.id) } },
        { actorUserId: { in: Object.values(users) } },
        { entityId: { in: templates.map((row) => row.id) }, entityType: "ClubFormTemplate", actorUserId: { in: Object.values(users) } },
      ],
    },
  });
  await prisma.clubFormSubmission.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.clubFormLink.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.messageOutbox.deleteMany({ where: { OR: [{ id: { in: links.flatMap((link) => (link.messageId ? [link.messageId] : [])) } }, { recipientEmail: { endsWith: `@${emailDomain}` } }] } });
  await prisma.rateLimitBucket.deleteMany({ where: { policy: { startsWith: "club-form." } } });
  // Templates made in the builder (#712) belong to this script: remove them with their versions.
  const builderTemplateIds = (await prisma.clubFormTemplate.findMany({ where: { key: { startsWith: BUILDER_PREFIX } }, select: { id: true } })).map((row) => row.id);
  await prisma.clubFormTemplateVersion.deleteMany({ where: { templateId: { in: builderTemplateIds } } });
  await prisma.clubFormTemplate.deleteMany({ where: { id: { in: builderTemplateIds } } });
  // Templates are shared rows: leave them, but switch every one back off.
  await prisma.clubFormTemplate.updateMany({ where: { key: { in: templateKeys } }, data: { enabled: false, enabledAt: null, enabledByUserId: null } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { in: clubIds } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { in: Object.values(accounts) } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.organization.deleteMany({ where: { OR: [{ id: { in: clubIds } }, { id: `${P}_church` }] } });
}

const slipAnswers = {
  child_name: "Riley Verify",
  street: "6 Example Road",
  city: "Exampleville",
  state: "IA",
  zip: "50001",
  phone: "515-555-0110",
  activity: "Canoe trip",
  activity_date: "2026-11-07",
  ride_with: "Pat Verify",
  parent_signature: "Pat Verify",
  parent_signature_date: "2026-10-30",
  relationship: "Parent",
  physician_name: SECRET_PHYSICIAN,
  emergency_contact_phone: SECRET_PHONE,
};

async function main() {
  const templates = await import("../modules/club-forms/templates");
  const submissions = await import("../modules/club-forms/submissions");
  const links = await import("../modules/club-forms/links");
  const linkEmail = await import("../modules/club-forms/link-email");
  const sealed = await import("../modules/club-forms/sealed-answers");
  const csv = await import("../modules/club-forms/csv");
  const rateLimits = await import("../modules/rate-limit/service");
  const deliveryQueue = await import("../modules/communications/email-delivery");
  const webhooks = await import("../modules/communications/resend-webhook-repository");
  const reseal = await import("../modules/club-forms/reseal");
  const orgRepository = await import("../modules/organizations/repository");
  type Viewer = import("../modules/club-forms/domain").ClubFormsViewer;

  const directorA: Viewer = { kind: "CLUB_LEADER", organizationId: clubs.a, actor: { kind: "ATTENDEE", accountId: accounts.a } };
  const directorB: Viewer = { kind: "CLUB_LEADER", organizationId: clubs.b, actor: { kind: "ATTENDEE", accountId: accounts.b } };
  const area: Viewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: accounts.area } };
  // Conference staff is only an Event Admin of a current event, or a system administrator.
  const eventAdmin: Viewer = { kind: "STAFF", userId: users.eventAdmin, systemAdmin: false };
  const sysAdmin: Viewer = { kind: "STAFF", userId: users.sysAdmin, systemAdmin: true };

  await cleanup();
  await prisma.organization.createMany({
    data: [
      { id: clubs.a, type: "CLUB", name: "Verify Forms Club A", normalizedName: "verify forms club a" },
      { id: clubs.b, type: "CLUB", name: "Verify Forms Club B", normalizedName: "verify forms club b" },
      { id: `${P}_church`, type: "CHURCH", name: "Verify Forms Church", normalizedName: "verify forms church" },
    ],
  });
  for (const [key, id] of Object.entries(users)) {
    await prisma.user.create({ data: { id, email: `${key}@${emailDomain}`, displayName: `Verify ${key}`, globalRole: key === "admin" || key === "sysAdmin" ? "SYSTEM_ADMIN" : null } });
  }
  for (const [key, id] of Object.entries(accounts)) {
    await prisma.attendeeAccount.create({ data: { id, email: `account-${key}@${emailDomain}`, displayName: `Verify ${key}`, status: "ACTIVE" } });
  }
  const now = new Date();
  const clubYear = (await import("../modules/club-rosters/domain")).clubYearFor(now);
  await prisma.person.createMany({ data: [
    { id: `${P}_riley`, firstName: "Riley", lastName: "Verify" },
    { id: `${P}_other`, firstName: "Other", lastName: "Verify" },
  ] });
  const rileyRow = await prisma.clubRosterMember.create({
    data: { organizationId: clubs.a, clubYear, personId: `${P}_riley`, attendeeType: "YOUTH", role: "Pathfinder", source: "DIRECTOR" },
  });
  const otherClubRow = await prisma.clubRosterMember.create({
    data: { organizationId: clubs.b, clubYear, personId: `${P}_other`, attendeeType: "YOUTH", role: "Pathfinder", source: "DIRECTOR" },
  });

  // 1. Enablement --------------------------------------------------------
  await templates.syncClubFormTemplates();
  const seeded = await prisma.clubFormTemplate.findMany({ where: { key: { in: templateKeys } } });
  assert(seeded.length === 4, "all four templates are seeded");
  assert(seeded.every((row) => row.enabled === false), "every seeded template starts disabled");
  assert((await templates.listEnabledClubFormTemplates()).filter((row) => templateKeys.includes(row.key)).length === 0, "a club sees no disabled form");
  await expectCode(
    submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: SLIP, answers: slipAnswers, submit: true }),
    "TEMPLATE_NOT_FOUND",
    "a disabled form can't be filled in",
  );
  await expectCode(
    links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `parent@${emailDomain}` }),
    "TEMPLATE_NOT_FOUND",
    "a disabled form can't be sent by link",
  );
  for (const key of templateKeys) await templates.setClubFormTemplateEnabled(key, true, users.admin);
  assert((await templates.listEnabledClubFormTemplates()).filter((row) => templateKeys.includes(row.key)).length === 4, "an enabled form shows to clubs");
  const slipRow = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: SLIP } });
  assert(slipRow.enabledByUserId === users.admin && slipRow.enabledAt, "who turned it on and when is recorded");
  assert(await prisma.auditLog.count({ where: { action: "CLUB_FORM_TEMPLATE_ENABLED", entityId: slipRow.id, actorUserId: users.admin } }) === 1, "turning a form on is audited once");

  // 2. Encryption at rest --------------------------------------------------
  const draft = await submissions.saveClubFormSubmission(directorA, {
    organizationId: clubs.a, templateKey: SLIP, rosterMemberId: rileyRow.id, answers: slipAnswers, submit: false,
  });
  assert(draft.status === "DRAFT", "a draft saves");
  const submitted = await submissions.saveClubFormSubmission(directorA, {
    organizationId: clubs.a, templateKey: SLIP, rosterMemberId: rileyRow.id, answers: slipAnswers, submit: true,
  });
  assert(submitted.status === "SUBMITTED", "a submission saves");

  const stored = await prisma.$queryRaw<Array<{ text: string; sealed: string | null; flag: boolean }>>`
    SELECT s::text AS text, s."sealedSensitiveAnswers" AS sealed, s."hasSensitiveAnswers" AS flag
    FROM "ClubFormSubmission" s WHERE s.id = ${submitted.id}`;
  assert(stored.length === 1 && stored[0].flag && stored[0].sealed?.startsWith("v1."), "the row carries a sealed value");
  for (const secret of [SECRET_PHYSICIAN, SECRET_PHONE]) {
    assert(!stored[0].text.includes(secret), "no sensitive plaintext in any column of the row");
  }
  assert(stored[0].text.includes("Canoe trip"), "non-sensitive answers are stored plainly");
  assert(
    JSON.stringify(sealed.openSensitiveAnswers(submitted.id, stored[0].sealed!)) === JSON.stringify({ physician_name: SECRET_PHYSICIAN, emergency_contact_phone: SECRET_PHONE }),
    "the sealed value round-trips",
  );
  let moved = false;
  try { sealed.openSensitiveAnswers("another-submission", stored[0].sealed!); moved = true; } catch { /* expected */ }
  assert(!moved, "a sealed value can't be opened as another submission");

  // The database itself refuses inconsistent rows.
  async function dbRefuses(sql: Promise<unknown>, message: string) {
    const failed = await sql.then(() => false, () => true);
    assert(failed, message);
  }
  await dbRefuses(prisma.$executeRaw`UPDATE "ClubFormSubmission" SET "hasSensitiveAnswers" = false WHERE id = ${submitted.id}`, "the sensitive flag must match the sealed value");
  await dbRefuses(prisma.$executeRaw`UPDATE "ClubFormSubmission" SET "submittedAt" = NULL WHERE id = ${submitted.id}`, "a submitted form must have its time");

  // Round trip through the audited read.
  const opened = await submissions.getSubmissionForViewer(directorA, submitted.id);
  assert(opened.answers.physician_name === SECRET_PHYSICIAN && opened.answers.emergency_contact_phone === SECRET_PHONE, "the club's director reads the sensitive answers");
  assert(opened.sensitiveRevealed && opened.restrictedKeys.length === 0, "nothing is restricted for the club's director");
  assert(opened.subjectName === "Riley Verify", "the roster member's name labels the form");

  // 3. Role visibility on real rows ------------------------------------------
  const leaderList = await submissions.listSubmissionsForViewer(directorA, {});
  assert(leaderList.length === 2, "the director sees the draft and the submitted form");
  assert((await submissions.listSubmissionsForViewer(directorA, { rosterMemberId: rileyRow.id })).length === 2, "forms list by member");
  assert((await submissions.listSubmissionsForViewer(directorB, {})).length === 0, "another club's director sees no forms");
  await expectCode(submissions.getSubmissionForViewer(directorB, submitted.id), "SUBMISSION_NOT_FOUND", "another club's director can't open the form");
  await expectCode(submissions.listSubmissionsForViewer(directorB, { organizationId: clubs.a }), "CLUB_NOT_FOUND", "another club's director can't list this club");
  await expectCode(
    submissions.saveClubFormSubmission(directorB, { organizationId: clubs.a, templateKey: SLIP, answers: slipAnswers, submit: true }),
    "FORBIDDEN",
    "another club's director can't fill in for this club",
  );
  await expectCode(
    submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: SLIP, rosterMemberId: otherClubRow.id, answers: slipAnswers, submit: true }),
    "MEMBER_NOT_FOUND",
    "another club's roster member can't be used",
  );
  for (const viewer of [area, eventAdmin, sysAdmin]) {
    await expectCode(
      submissions.saveClubFormSubmission(viewer, { organizationId: clubs.a, templateKey: SLIP, answers: slipAnswers, submit: true }),
      "FORBIDDEN",
      "only the club's director writes",
    );
    await expectCode(
      links.createClubFormLink(viewer, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `x@${emailDomain}` }),
      "FORBIDDEN",
      "only the club's director sends a link",
    );
  }

  const areaList = await submissions.listSubmissionsForViewer(area, { organizationId: clubs.a });
  assert(areaList.length === 1 && areaList[0].status === "SUBMITTED", "an Area Coordinator sees submitted forms only");
  await expectCode(submissions.getSubmissionForViewer(area, draft.id), "SUBMISSION_NOT_FOUND", "an Area Coordinator can't open a draft");

  const auditBefore = await prisma.auditLog.count({ where: { action: "CLUB_FORM_SUBMISSION_VIEWED", entityId: submitted.id } });
  const areaView = await submissions.getSubmissionForViewer(area, submitted.id);
  assert(!areaView.sensitiveRevealed && areaView.restrictedKeys.length === slipRow.sensitiveFieldKeys.length, "an Area Coordinator gets Restricted for every sensitive field");
  assert(!("physician_name" in areaView.answers) && !JSON.stringify(areaView).includes(SECRET_PHYSICIAN) && !JSON.stringify(areaView).includes(SECRET_PHONE), "an Area Coordinator's view holds no sensitive text");
  const eventAdminView = await submissions.getSubmissionForViewer(eventAdmin, submitted.id);
  assert(eventAdminView.sensitiveRevealed && eventAdminView.answers.physician_name === SECRET_PHYSICIAN, "an Event Admin reads the physician and emergency answers");
  const sysAdminView = await submissions.getSubmissionForViewer(sysAdmin, submitted.id);
  assert(sysAdminView.answers.physician_name === SECRET_PHYSICIAN, "a system administrator reads the answers");

  // 4. Audit: one row per view, who and what, never the answers ------------
  const viewRows = await prisma.auditLog.findMany({ where: { action: "CLUB_FORM_SUBMISSION_VIEWED", entityId: submitted.id }, orderBy: { createdAt: "asc" } });
  assert(viewRows.length === auditBefore + 3, "each view of a form with sensitive answers wrote one audit row");
  const newRows = viewRows.slice(auditBefore);
  assert(newRows.map((row) => (row.metadata as { viewerKind: string }).viewerKind).join() === "AREA_COORDINATOR,STAFF,STAFF", "audit rows say who viewed");
  assert(newRows.map((row) => (row.metadata as { sensitiveRevealed: boolean }).sensitiveRevealed).join() === "false,true,true", "audit rows say whether answers were revealed");
  assert(newRows[1].actorUserId === users.eventAdmin && newRows[2].actorUserId === users.sysAdmin, "staff views are attributed to the staff user");
  assert((newRows[0].metadata as { actorAttendeeAccountId?: string }).actorAttendeeAccountId === accounts.area, "an attendee's view is attributed to their account");
  const everyClubFormAudit = await prisma.$queryRaw<Array<{ text: string }>>`
    SELECT a::text AS text FROM "AuditLog" a
    WHERE a."entityType" IN ('ClubFormSubmission', 'ClubFormLink', 'ClubFormTemplate')
      AND (a."actorUserId" IN (${users.admin}, ${users.eventAdmin}, ${users.sysAdmin}) OR a."entityId" = ${submitted.id} OR a."entityId" = ${draft.id})`;
  for (const secret of [SECRET_PHYSICIAN, SECRET_PHONE, SECRET_HEALTH, "Riley"]) {
    assert(everyClubFormAudit.every((row) => !row.text.includes(secret)), "no answer text in any audit row");
  }
  // A form with no sensitive answers is not audited on view.
  const plainOnly = await submissions.saveClubFormSubmission(directorA, {
    organizationId: clubs.a, templateKey: PASSENGERS, answers: { contact_name: "Dana Verify", contact_cell: "515-555-0120", driver_name: "Drew Verify", driver_cell: "515-555-0121", passenger_1_name: "Riley Verify" }, submit: true,
  });
  await submissions.getSubmissionForViewer(directorA, plainOnly.id);
  assert(await prisma.auditLog.count({ where: { action: "CLUB_FORM_SUBMISSION_VIEWED", entityId: plainOnly.id } }) === 0, "a form with no sensitive answers is not audited on view");

  // Birth dates follow ADR 0005 Addendum A: the club's leaders and system administrators only.
  const BIRTH = "1985-06-15";
  const birthForm = await submissions.saveClubFormSubmission(directorA, {
    organizationId: clubs.a, templateKey: STAFF_FORM, answers: {
      full_name: "Birth Verify", birth_date: BIRTH, gender: "Male", child_1_name: "Kid Verify", child_1_birth_date: "2018-02-03", street: "2 Example Road", city: "Exampleville",
      state: "MO", zip: "64000", email: `birth@${emailDomain}`, church: "Verify Forms Church", club: "Verify Forms Club A",
      health_limitation: "Yes", health_limitation_how: SECRET_HEALTH, conduct_accused: "No",
      reference_1_name: "A", reference_1_address: "B", reference_1_phone: "515-555-0140", reference_2_name: "A", reference_2_address: "B", reference_2_phone: "515-555-0140",
      reference_3_name: "A", reference_3_address: "B", reference_3_phone: "515-555-0140",
      signature: "Birth Verify", signature_date: "2026-10-02", signature_acknowledgment: true,
    }, submit: true,
  });
  const staffTemplate = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: STAFF_FORM } });
  assert(staffTemplate.birthDateFieldKeys.length === 6, "the staff template marks its six birth-date fields");
  const birthFor = async (viewer: Viewer) => submissions.getSubmissionForViewer(viewer, birthForm.id);
  for (const viewer of [directorA, sysAdmin]) {
    const view = await birthFor(viewer);
    assert(view.answers.birth_date === BIRTH && view.answers.child_1_birth_date === "2018-02-03" && view.answers.health_limitation === "Yes", "the club's director and a system administrator read birth dates");
  }
  const eventAdminBirth = await birthFor(eventAdmin);
  assert(eventAdminBirth.answers.health_limitation_how === SECRET_HEALTH, "an Event Admin reads the health answers");
  assert(!("birth_date" in eventAdminBirth.answers) && !JSON.stringify(eventAdminBirth).includes(BIRTH) && !JSON.stringify(eventAdminBirth).includes("2018-02-03"), "an Event Admin never receives a birth date");
  assert(staffTemplate.birthDateFieldKeys.every((key) => eventAdminBirth.restrictedKeys.includes(key)), "an Event Admin sees every birth date as Restricted");
  const areaBirth = await birthFor(area);
  assert(!JSON.stringify(areaBirth).includes(BIRTH) && !JSON.stringify(areaBirth).includes(SECRET_HEALTH), "an Area Coordinator receives no birth date and no health answer");
  assert(staffTemplate.sensitiveFieldKeys.every((key) => areaBirth.restrictedKeys.includes(key)), "an Area Coordinator sees every sensitive field as Restricted");
  const birthRow = await prisma.$queryRaw<Array<{ text: string }>>`SELECT s::text AS text FROM "ClubFormSubmission" s WHERE s.id = ${birthForm.id}`;
  assert(!birthRow[0].text.includes(BIRTH) && !birthRow[0].text.includes("2018-02-03"), "birth dates are sealed at rest");

  // The URL's club is checked before a view is audited.
  const viewedBefore = await prisma.auditLog.count({ where: { action: "CLUB_FORM_SUBMISSION_VIEWED", entityId: birthForm.id } });
  await expectCode(submissions.getSubmissionForViewer(area, birthForm.id, "VIEW", clubs.b), "SUBMISSION_NOT_FOUND", "a form is not opened through another club's path");
  assert(await prisma.auditLog.count({ where: { action: "CLUB_FORM_SUBMISSION_VIEWED", entityId: birthForm.id } }) === viewedBefore, "a wrong-club view writes no audit row");

  // A form that is switched off blocks new fills and links only: past submissions stay readable.
  await templates.setClubFormTemplateEnabled(SLIP, false, users.admin);
  for (const viewer of [directorA, area, eventAdmin, sysAdmin]) {
    const view = await submissions.getSubmissionForViewer(viewer, submitted.id);
    assert(view.id === submitted.id && view.template.enabled === false, "a switched-off form's past submission stays readable");
  }
  assert((await submissions.listSubmissionsForViewer(directorA, {})).some((row) => row.templateKey === SLIP), "a club still lists a switched-off form's submissions");
  assert((await submissions.listSubmissionsForViewer(area, { organizationId: clubs.a })).some((row) => row.templateKey === SLIP), "an Area Coordinator still lists them");
  await expectCode(
    submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: SLIP, answers: slipAnswers, submit: true }),
    "TEMPLATE_NOT_FOUND",
    "a switched-off form takes no new fills",
  );
  await expectCode(
    submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: SLIP, submissionId: draft.id, answers: slipAnswers, submit: true }),
    "TEMPLATE_NOT_FOUND",
    "a switched-off form's draft can't be finished",
  );
  await expectCode(
    links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `off@${emailDomain}` }),
    "TEMPLATE_NOT_FOUND",
    "a switched-off form sends no new links",
  );
  await templates.setClubFormTemplateEnabled(SLIP, true, users.admin);

  // 5. Private links ---------------------------------------------------------
  const queued = await links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `Parent@${emailDomain}`, rosterMemberId: rileyRow.id });
  const linkRow = await prisma.clubFormLink.findUniqueOrThrow({ where: { id: queued.linkId } });
  assert(linkRow.status === "OPEN" && linkRow.tokenHash === null && linkRow.messageId === queued.messageId, "a new link has no token yet");
  assert(linkRow.organizationId === clubs.a && linkRow.recipientEmail === `parent@${emailDomain}`, "the link is tied to the club and the typed address");
  const days = (linkRow.expiresAt.getTime() - linkRow.createdAt.getTime()) / 86_400_000;
  assert(days > 13.9 && days < 14.1, "a link lasts 14 days by default");
  const outbox = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: queued.messageId } });
  assert(outbox.templateKey === "CLUB_FORM_LINK" && outbox.status === "PENDING" && outbox.recipientEmail === `parent@${emailDomain}`, "one transactional email is queued for the typed address");
  assert(outbox.bodyTextSnapshot.includes(linkEmail.CLUB_FORM_LINK_SENTINEL), "the queued body holds a sentinel");

  // Delivery mints the token; only its hash is stored, and it is in no row.
  const prepared = await linkEmail.prepareClubFormLinkBodyForDelivery({ messageId: queued.messageId, bodyText: outbox.bodyTextSnapshot, now });
  const token = /\/club-forms\/([A-Za-z0-9_-]+)/.exec(prepared.bodyText)?.[1];
  assert(token && token.length >= 40, "delivery mints a long token into the emailed link");
  const afterDelivery = await prisma.clubFormLink.findUniqueOrThrow({ where: { id: queued.linkId } });
  assert(afterDelivery.tokenHash === sha256(token), "only the SHA-256 of the token is stored");
  const tokenLeaks = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT (SELECT count(*) FROM "ClubFormLink" l WHERE l::text LIKE ${`%${token}%`})
         + (SELECT count(*) FROM "MessageOutbox" m WHERE m::text LIKE ${`%${token}%`})
         + (SELECT count(*) FROM "AuditLog" a WHERE a::text LIKE ${`%${token}%`}) AS n`;
  assert(Number(tokenLeaks[0].n) === 0, "the token is in no link, outbox or audit row");

  const publicView = await links.resolveClubFormLinkForFill(token);
  assert(publicView.clubName === "Verify Forms Club A", "the link shows the club's name");
  const publicText = JSON.stringify(publicView);
  for (const leaked of ["Riley", rileyRow.id, clubs.a, queued.linkId, `parent@${emailDomain}`, accounts.a]) {
    assert(!publicText.includes(leaked), `the link page shows nothing else about the club (${leaked})`);
  }
  assert(await prisma.clubFormLink.count({ where: { id: queued.linkId, status: "OPEN" } }) === 1, "opening a link does not use it up");

  // Single use under a race.
  const racers = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => links.submitClubFormViaLink(token, { ...slipAnswers, child_name: `Racer ${index}` })));
  const winners = racers.filter((result) => result.status === "fulfilled");
  assert(winners.length === 1, `exactly one of eight racing submits wins (got ${winners.length})`);
  for (const result of racers) {
    if (result.status === "rejected") assert((result.reason as { code?: string }).code === "LINK_UNAVAILABLE", "every loser is told the link is unavailable");
  }
  assert(await prisma.clubFormSubmission.count({ where: { linkId: queued.linkId } }) === 1, "exactly one submission exists for the link");
  const spent = await prisma.clubFormLink.findUniqueOrThrow({ where: { id: queued.linkId } });
  assert(spent.status === "USED" && spent.usedAt, "the link is spent");
  const viaLink = await prisma.clubFormSubmission.findFirstOrThrow({ where: { linkId: queued.linkId } });
  assert(viaLink.organizationId === clubs.a && viaLink.enteredVia === "LINK" && viaLink.status === "SUBMITTED", "a link submission lands in the link's club");
  assert(viaLink.rosterMemberId === rileyRow.id && viaLink.enteredByAccountId === null && viaLink.enteredByUserId === null, "the link's member is kept, and no one is credited");
  assert(viaLink.hasSensitiveAnswers && viaLink.sealedSensitiveAnswers?.startsWith("v1."), "a link submission seals sensitive answers");
  assert(!JSON.stringify(viaLink).includes(SECRET_PHYSICIAN), "no sensitive plaintext in the link submission row");
  await expectCode(links.submitClubFormViaLink(token, slipAnswers), "LINK_UNAVAILABLE", "a used link is dead for submitting");
  await expectCode(links.resolveClubFormLinkForFill(token), "LINK_UNAVAILABLE", "a used link is dead for opening");

  // Expiry.
  const past = new Date(now.getTime() - 30 * 86_400_000);
  const oldLink = await links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `late@${emailDomain}` }, past);
  const oldOutbox = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: oldLink.messageId } });
  const oldPrepared = await linkEmail.prepareClubFormLinkBodyForDelivery({ messageId: oldLink.messageId, bodyText: oldOutbox.bodyTextSnapshot, now: past });
  const oldToken = /\/club-forms\/([A-Za-z0-9_-]+)/.exec(oldPrepared.bodyText)![1];
  await expectCode(links.resolveClubFormLinkForFill(oldToken), "LINK_UNAVAILABLE", "an expired link can't be opened");
  await expectCode(links.submitClubFormViaLink(oldToken, slipAnswers), "LINK_UNAVAILABLE", "an expired link can't be submitted");
  assert(await prisma.clubFormSubmission.count({ where: { linkId: oldLink.linkId } }) === 0, "an expired link makes no submission");
  const notDelivered = await linkEmail
    .prepareClubFormLinkBodyForDelivery({ messageId: oldLink.messageId, bodyText: oldOutbox.bodyTextSnapshot, now })
    .then(() => null, (caught: unknown) => caught);
  assert(notDelivered instanceof Error && /can't be delivered/.test(notDelivered.message), "an expired link is not delivered");

  // Wrong club.
  const other = await links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `other@${emailDomain}` });
  await expectCode(links.revokeClubFormLink(directorB, clubs.b, other.linkId), "LINK_NOT_FOUND", "another club can't withdraw this club's link");
  await expectCode(links.revokeClubFormLink(directorB, clubs.a, other.linkId), "FORBIDDEN", "another club can't act on this club's URL");
  assert((await links.listClubFormLinks(directorB, clubs.b)).length === 0, "another club's link list is empty");
  await expectCode(
    links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `x@${emailDomain}`, rosterMemberId: otherClubRow.id }),
    "MEMBER_NOT_FOUND",
    "a link can't be tied to another club's member",
  );

  // Withdrawal, a lost delivery, and a submit racing a withdrawal.
  const outboxOther = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: other.messageId } });
  const preparedOther = await linkEmail.prepareClubFormLinkBodyForDelivery({ messageId: other.messageId, bodyText: outboxOther.bodyTextSnapshot, now });
  const otherToken = /\/club-forms\/([A-Za-z0-9_-]+)/.exec(preparedOther.bodyText)![1];
  await links.revokeClubFormLink(directorA, clubs.a, other.linkId);
  await expectCode(links.submitClubFormViaLink(otherToken, slipAnswers), "LINK_UNAVAILABLE", "a withdrawn link can't be submitted");
  await expectCode(links.revokeClubFormLink(directorA, clubs.a, other.linkId), "LINK_UNAVAILABLE", "a withdrawn link can't be withdrawn twice");

  const lost = await links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `lost@${emailDomain}` });
  const lostOutbox = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: lost.messageId } });
  const lostPrepared = await linkEmail.prepareClubFormLinkBodyForDelivery({ messageId: lost.messageId, bodyText: lostOutbox.bodyTextSnapshot, now });
  const lostToken = /\/club-forms\/([A-Za-z0-9_-]+)/.exec(lostPrepared.bodyText)![1];
  await lostPrepared.revokeOnDefinitiveFailure?.();
  const lostRow = await prisma.clubFormLink.findUniqueOrThrow({ where: { id: lost.linkId } });
  assert(lostRow.status === "REVOKED" && lostRow.tokenHash === null, "a definitive delivery failure retires the link");
  await expectCode(links.submitClubFormViaLink(lostToken, slipAnswers), "LINK_UNAVAILABLE", "a link that lost its email can't be used");

  for (let round = 0; round < 5; round += 1) {
    const raced = await links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `race${round}@${emailDomain}` });
    const racedOutbox = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: raced.messageId } });
    const racedPrepared = await linkEmail.prepareClubFormLinkBodyForDelivery({ messageId: raced.messageId, bodyText: racedOutbox.bodyTextSnapshot, now });
    const racedToken = /\/club-forms\/([A-Za-z0-9_-]+)/.exec(racedPrepared.bodyText)![1];
    await Promise.allSettled([
      links.submitClubFormViaLink(racedToken, slipAnswers),
      links.revokeClubFormLink(directorA, clubs.a, raced.linkId),
    ]);
    const finalLink = await prisma.clubFormLink.findUniqueOrThrow({ where: { id: raced.linkId } });
    const made = await prisma.clubFormSubmission.count({ where: { linkId: raced.linkId } });
    assert(
      (finalLink.status === "USED" && made === 1) || (finalLink.status === "REVOKED" && made === 0),
      `a submit racing a withdrawal ends consistently (round ${round}: ${finalLink.status}, ${made} submissions)`,
    );
  }
  await dbRefuses(prisma.$executeRaw`UPDATE "ClubFormLink" SET "usedAt" = NULL WHERE id = ${queued.linkId}`, "a used link must record when it was used");

  // Rate limits, on the real buckets.
  const request = new Request("https://events.clubforms.example.test/x", { headers: { "user-agent": "verify-club-forms" } });
  const rateToken = "R".repeat(43);
  const outcomes: boolean[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) outcomes.push((await rateLimits.checkClubFormLinkRateLimit(request, rateToken, "submit")).allowed);
  assert(outcomes.slice(0, 6).every(Boolean) && outcomes.slice(6).every((allowed) => !allowed), `the link's submit limit stops the seventh try (${outcomes.join()})`);
  const createOutcomes: boolean[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    createOutcomes.push((await rateLimits.checkClubFormLinkCreateRateLimit(request, accounts.a, clubs.a, `ratelimited@${emailDomain}`)).allowed);
  }
  assert(createOutcomes.join() === "true,true,false,false", `sending to one address is limited to two an hour per club (${createOutcomes.join()})`);

  // Email that finally fails withdraws the link, and the director sees the delivery status.
  type Sender = NonNullable<NonNullable<Parameters<typeof deliveryQueue.processAccountEmailQueue>[0]>["dependencies"]>["sendEmail"];
  const failingSender = (retryable: boolean) => (async () => {
    const { EmailProviderRequestError } = await import("../integrations/email/resend");
    throw new EmailProviderRequestError("The provider refused the message.", "PROVIDER_REJECTED", retryable, retryable ? 503 : 422);
  }) as unknown as Sender;
  const startAt = new Date();
  async function freshLink(email: string) {
    const created = await links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: SLIP, recipientEmail: `${email}@${emailDomain}` });
    return created;
  }
  const rejected = await freshLink("rejected");
  await deliveryQueue.processAccountEmailQueue({ messageIds: [rejected.messageId], dependencies: { sendEmail: failingSender(false) } });
  assert((await prisma.clubFormLink.findUniqueOrThrow({ where: { id: rejected.linkId } })).status === "REVOKED", "a non-retryable delivery failure withdraws the link");
  assert((await links.listClubFormLinks(directorA, clubs.a)).find((row) => row.id === rejected.linkId)?.delivery === "NOT_DELIVERED", "the director's list says the email was not delivered");

  const exhausted = await freshLink("exhausted");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const before = (await prisma.clubFormLink.findUniqueOrThrow({ where: { id: exhausted.linkId } })).status;
    assert(before === "OPEN", `a link stays open while its email can still be retried (attempt ${attempt})`);
    await deliveryQueue.processAccountEmailQueue({
      messageIds: [exhausted.messageId],
      dependencies: { sendEmail: failingSender(true), now: () => new Date(startAt.getTime() + (attempt + 1) * 3 * 3_600_000) },
    });
  }
  assert((await prisma.messageOutbox.findUniqueOrThrow({ where: { id: exhausted.messageId } })).status === "FAILED", "the email is out of retries");
  assert((await prisma.clubFormLink.findUniqueOrThrow({ where: { id: exhausted.linkId } })).status === "REVOKED", "a link whose email ran out of retries is withdrawn");

  const bounced = await freshLink("bounced");
  const bouncedOutbox = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: bounced.messageId } });
  await linkEmail.prepareClubFormLinkBodyForDelivery({ messageId: bounced.messageId, bodyText: bouncedOutbox.bodyTextSnapshot, now: new Date() });
  await prisma.messageOutbox.update({ where: { id: bounced.messageId }, data: { status: "SENT", providerMessageId: `${P}_provider_bounce`, providerDeliveryStatus: "ACCEPTED", providerStatusAt: new Date(startAt.getTime() - 1000) } });
  await webhooks.recordResendWebhookEvent(`${P}_bounce_event`, { type: "email.bounced", created_at: new Date().toISOString(), data: { email_id: `${P}_provider_bounce`, to: [`bounced@${emailDomain}`] } } as never);
  const bouncedLink = await prisma.clubFormLink.findUniqueOrThrow({ where: { id: bounced.linkId } });
  assert(bouncedLink.status === "REVOKED" && bouncedLink.tokenHash === null, "a bounce withdraws the link");
  assert((await links.listClubFormLinks(directorA, clubs.a)).find((row) => row.id === bounced.linkId)?.delivery === "NOT_DELIVERED", "a bounced email shows as not delivered");
  await prisma.messageProviderEvent.deleteMany({ where: { providerEventId: `${P}_bounce_event` } });

  const delivered = await freshLink("delivered");
  let sentBody = "";
  await deliveryQueue.processAccountEmailQueue({
    messageIds: [delivered.messageId],
    dependencies: { sendEmail: (async (input: { bodyText: string }) => { sentBody = input.bodyText; return { providerMessageId: `${P}_provider_ok` }; }) as unknown as Sender },
  });
  const deliveredToken = /\/club-forms\/([A-Za-z0-9_-]+)/.exec(sentBody)?.[1];
  assert(deliveredToken, "a delivered email carries the link");
  assert((await prisma.clubFormLink.findUniqueOrThrow({ where: { id: delivered.linkId } })).status === "OPEN", "a delivered link stays open");
  assert((await links.listClubFormLinks(directorA, clubs.a)).find((row) => row.id === delivered.linkId)?.delivery === "SENT", "a sent email shows as sent");
  await links.submitClubFormViaLink(deliveredToken, slipAnswers);

  // 6. Staff-only fields on the staff form, and the CSV ----------------------------
  const staffAnswers = {
    full_name: "Alex Verify", birth_date: "1985-06-15", gender: "Male", street: "2 Example Road", city: "Exampleville", state: "MO", zip: "64000",
    email: `alex@${emailDomain}`, church: "Verify Forms Church", club: "Verify Forms Club A", health_limitation: "Yes", health_limitation_how: SECRET_HEALTH, conduct_accused: "No",
    reference_1_name: "A", reference_1_address: "B", reference_1_phone: "515-555-0140", reference_2_name: "A", reference_2_address: "B", reference_2_phone: "515-555-0140",
    reference_3_name: "A", reference_3_address: "B", reference_3_phone: "515-555-0140",
    signature: "Alex Verify", signature_date: "2026-10-02", signature_acknowledgment: true,
    office_signature: "Forged office signature",
  };
  const staffLink = await links.createClubFormLink(directorA, { organizationId: clubs.a, templateKey: STAFF_FORM, recipientEmail: `applicant@${emailDomain}` });
  const staffOutbox = await prisma.messageOutbox.findUniqueOrThrow({ where: { id: staffLink.messageId } });
  const staffPrepared = await linkEmail.prepareClubFormLinkBodyForDelivery({ messageId: staffLink.messageId, bodyText: staffOutbox.bodyTextSnapshot, now });
  const staffToken = /\/club-forms\/([A-Za-z0-9_-]+)/.exec(staffPrepared.bodyText)![1];
  const staffView = await links.resolveClubFormLinkForFill(staffToken);
  assert(!JSON.stringify(staffView).includes("office_signature"), "the office-use section is hidden from the person with the link");
  await links.submitClubFormViaLink(staffToken, staffAnswers);
  const staffRow = await prisma.clubFormSubmission.findFirstOrThrow({ where: { linkId: staffLink.linkId } });
  assert(!JSON.stringify(staffRow).includes("Forged office signature") && !JSON.stringify(staffRow).includes(SECRET_HEALTH), "office-use answers are dropped and health answers are sealed");
  assert(staffRow.subjectName === "Alex Verify", "a non-member form is labeled from its answers");

  const exported = await csv.buildClubFormsCsv(eventAdmin, { templateKey: STAFF_FORM });
  assert(exported.rowCount === 2, "the CSV has both submitted staff forms");
  for (const secret of [SECRET_HEALTH, "1985-06-15", "Health"]) {
    assert(!exported.csv.includes(secret), `the CSV holds no sensitive column or text (${secret})`);
  }
  assert(exported.csv.includes("Alex Verify") && exported.csv.includes("Verify Forms Club A"), "the CSV holds the non-sensitive columns");
  const slipCsv = await csv.buildClubFormsCsv(sysAdmin, { templateKey: SLIP, organizationId: clubs.a });
  assert(!slipCsv.csv.includes(SECRET_PHYSICIAN) && !slipCsv.csv.includes(SECRET_PHONE), "even staff who may read sensitive answers get none in the CSV");

  // A template version that makes a field newly sensitive re-seals existing submissions.
  const marker = "Resealed activity marker";
  const plainFirst = await submissions.saveClubFormSubmission(directorA, {
    organizationId: clubs.a, templateKey: SLIP, answers: { ...slipAnswers, activity: marker }, submit: true,
  });
  assert((await prisma.$queryRaw<Array<{ text: string }>>`SELECT s::text AS text FROM "ClubFormSubmission" s WHERE s.id = ${plainFirst.id}`)[0].text.includes(marker), "before re-sealing, the answer is plain");
  await prisma.$transaction((tx) => reseal.resealClubFormSubmissions(tx, slipRow.id, ["activity"]));
  const afterReseal = (await prisma.$queryRaw<Array<{ text: string }>>`SELECT s::text AS text FROM "ClubFormSubmission" s WHERE s.id = ${plainFirst.id}`)[0].text;
  assert(!afterReseal.includes(marker), "after re-sealing, the answer is in no plain column");
  assert(sealed.openSensitiveAnswers(plainFirst.id, (await prisma.clubFormSubmission.findUniqueOrThrow({ where: { id: plainFirst.id } })).sealedSensitiveAnswers!).activity === marker, "the re-sealed answer opens");
  assert(await prisma.clubFormSubmission.count({ where: { id: plainFirst.id, hasSensitiveAnswers: true } }) === 1, "the sensitive flag follows the re-seal");

  // A save that already read the old keys, committing during a re-seal, must not leave plaintext.
  const lockModule = await import("../modules/club-forms/template-lock");
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const raceMarker = "Race activity marker";
  const raceId = randomUUID();
  let raceLocked!: () => void;
  const writerHoldsLock = new Promise<void>((resolve) => { raceLocked = resolve; });
  let releaseWriter!: () => void;
  const writerMayCommit = new Promise<void>((resolve) => { releaseWriter = resolve; });
  const writer = prisma.$transaction(async (tx) => {
    await lockModule.lockClubFormTemplateForWrite(tx, slipRow);
    raceLocked();
    await tx.clubFormSubmission.create({
      data: {
        id: raceId, templateId: slipRow.id, organizationId: clubs.a, clubYear, subjectName: "Race", status: "SUBMITTED",
        answers: { child_name: "Race", activity: raceMarker }, templateVersion: slipRow.version, enteredVia: "ATTENDEE",
        enteredByAccountId: accounts.a, submittedAt: new Date(),
      },
    });
    await writerMayCommit;
  }, { timeout: 30_000 });
  await writerHoldsLock;
  let resealFinished = false;
  const resealing = prisma.$transaction((tx) => reseal.resealClubFormSubmissions(tx, slipRow.id, ["activity"]), { timeout: 30_000 }).then(() => { resealFinished = true; });
  await sleep(1000);
  assert(!resealFinished, "the re-seal waits for a save that holds the template's share lock");
  releaseWriter();
  await writer;
  await resealing;
  const raced = await prisma.clubFormSubmission.findUniqueOrThrow({ where: { id: raceId } });
  assert(!JSON.stringify(raced.answers).includes(raceMarker), "the save that committed during the re-seal is not left in plaintext");
  assert(sealed.openSensitiveAnswers(raceId, raced.sealedSensitiveAnswers!).activity === raceMarker, "the raced answer was sealed by the re-seal");

  // And a save that starts during a re-seal waits for it, then reads the new keys.
  const slipKeys = slipRow.sensitiveFieldKeys;
  let holdReseal!: () => void;
  const resealMayCommit = new Promise<void>((resolve) => { holdReseal = resolve; });
  let resealLocked!: () => void;
  const resealHoldsLock = new Promise<void>((resolve) => { resealLocked = resolve; });
  const bigReseal = prisma.$transaction(async (tx) => {
    await lockModule.lockClubFormTemplateForReseal(tx, slipRow.id);
    await tx.clubFormTemplate.update({ where: { id: slipRow.id }, data: { sensitiveFieldKeys: [...slipKeys, "activity"] } });
    resealLocked();
    await resealMayCommit;
  }, { timeout: 30_000 });
  await resealHoldsLock;
  let keysRead: string[] | null = null;
  const laterWriter = prisma.$transaction(async (tx) => {
    keysRead = (await lockModule.lockClubFormTemplateForWrite(tx, slipRow)).sensitiveFieldKeys;
  }, { timeout: 30_000 });
  await sleep(1000);
  assert(keysRead === null, "a save started during a re-seal waits for it");
  holdReseal();
  await bigReseal;
  await laterWriter;
  assert((keysRead as string[] | null)?.includes("activity"), "the waiting save reads the new sensitive keys");
  await prisma.clubFormTemplate.update({ where: { id: slipRow.id }, data: { sensitiveFieldKeys: slipKeys } });

  // A save blocked by a held FOR UPDATE gives up after the lock timeout (3 s) with FORM_BUSY, writing nothing,
  // instead of holding a pool connection for the whole re-seal.
  let releaseHeld!: () => void;
  const heldMayCommit = new Promise<void>((resolve) => { releaseHeld = resolve; });
  let heldLocked!: () => void;
  const heldHoldsLock = new Promise<void>((resolve) => { heldLocked = resolve; });
  const holder = prisma.$transaction(async (tx) => {
    await lockModule.lockClubFormTemplateForReseal(tx, slipRow.id);
    heldLocked();
    await heldMayCommit;
  }, { timeout: 60_000 });
  await heldHoldsLock;
  const draftsBefore = await prisma.clubFormSubmission.count({ where: { templateId: slipRow.id } });
  const startedAt = Date.now();
  await expectCode(
    submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: SLIP, answers: slipAnswers, submit: true }),
    "FORM_BUSY",
    "a save blocked by a held FOR UPDATE fails fast",
  );
  const waited = Date.now() - startedAt;
  assert(waited >= 2000 && waited < 8000, `the blocked save gave up at the lock timeout, not after the whole hold (${waited} ms)`);
  assert(await prisma.clubFormSubmission.count({ where: { templateId: slipRow.id } }) === draftsBefore, "the refused save wrote nothing");
  releaseHeld();
  await holder;


  // 12. The club form builder (#712) -----------------------------------------
  const builder = await import("../modules/club-forms/builder");
  const builderState = await import("../components/club-form-builder-state");
  const { allFields } = await import("../modules/club-forms/domain");
  const copy = await builder.createClubFormTemplate({ name: "cf712 Copy", copyFromKey: SLIP }, users.admin);
  assert(copy.key === "cf712_copy" && copy.version === 1, "a copy gets its own key and starts at version 1");
  const copyRow = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: copy.key } });
  assert(copyRow.enabled === false && copyRow.customizedAt !== null, "a copy starts disabled and marked as edited in the app");
  assert(copyRow.sensitiveFieldKeys.join() === slipRow.sensitiveFieldKeys.join(), "a copy keeps the sensitive flags");
  assert(await prisma.clubFormTemplateVersion.count({ where: { templateId: copyRow.id, version: 1 } }) === 1, "version 1 of a new form is recorded");
  await templates.setClubFormTemplateEnabled(copy.key, true, users.admin);
  const oldFill = await submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: copy.key, answers: slipAnswers, submit: true });
  const draftFill = await submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: copy.key, answers: slipAnswers, submit: false });

  const builderIdOf = (spec: import("../modules/club-forms/builder-domain").ClubFormDraftSpec, key: string) => allFields(spec.definition).find((field) => field.key === key)!.id;
  const viewOf = async () => builder.getClubFormBuilderView(copy.key);
  const first = await viewOf();
  const relabeled = builderState.updateField(first.published, builderIdOf(first.published, "activity"), { label: "Verify renamed activity" });
  await builder.saveClubFormDraft(copy.key, { draft: relabeled, baseVersion: 1, expectedDraftUpdatedAt: null }, users.admin);
  assert((await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: copy.key } })).version === 1, "a saved draft does not change the live form");
  const afterSave = await viewOf();
  await expectCode(
    builder.saveClubFormDraft(copy.key, { draft: relabeled, baseVersion: 1, expectedDraftUpdatedAt: null }, users.admin),
    "TEMPLATE_CHANGED",
    "a second tab with a stale draft is refused",
  );
  const published = await builder.publishClubFormDraft(copy.key, { baseVersion: 1 }, users.admin);
  assert(published.version === 2, "publishing bumps the version");
  assert(await prisma.clubFormTemplateVersion.count({ where: { templateId: copyRow.id } }) === 2, "both versions are kept");
  const oldView = await submissions.getSubmissionForViewer(directorA, oldFill.id);
  assert(oldView.template.version === 1, "an old submission is shown on its own version");
  assert(!allFields(oldView.template.definition).some((field) => field.label === "Verify renamed activity"), "an old submission shows its own version's questions");
  assert(oldView.answers.physician_name === SECRET_PHYSICIAN, "an old submission's sealed answer still opens for its director");
  const newFill = await submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: copy.key, answers: slipAnswers, submit: true });
  const newView = await submissions.getSubmissionForViewer(directorA, newFill.id);
  assert(newView.template.version === 2 && allFields(newView.template.definition).some((field) => field.label === "Verify renamed activity"), "a new fill uses the latest version");
  assert(afterSave.draft !== null, "the builder shows the saved draft");

  // The protection rules, against the real tables.
  const v2 = await viewOf();
  const physicianId = builderIdOf(v2.published, "physician_name");
  // An unfinished draft saves with warnings; publish enforces the protection rules under the lock.
  const loosened = await builder.saveClubFormDraft(copy.key, { draft: builderState.setFieldFlag(v2.published, physicianId, "sensitive", false), baseVersion: 2, expectedDraftUpdatedAt: null }, users.admin);
  assert(loosened.warnings.length > 0, "a cleared sensitive flag is flagged when the draft is saved");
  await expectCode(builder.publishClubFormDraft(copy.key, { baseVersion: 2 }, users.admin), "VALIDATION_FAILED", "a published sensitive flag cannot be cleared");
  const removedDraft = await builder.saveClubFormDraft(copy.key, { draft: builderState.removeField(v2.published, physicianId), baseVersion: 2, expectedDraftUpdatedAt: loosened.draftUpdatedAt }, users.admin);
  assert(removedDraft.warnings.some((warning) => warning.key === "removed:physician_name"), "deleting a sensitive field is flagged when the draft is saved");
  await expectCode(builder.publishClubFormDraft(copy.key, { baseVersion: 2 }, users.admin), "VALIDATION_FAILED", "a sensitive field cannot be deleted once forms exist");
  assert((await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: copy.key } })).version === 2, "a refused publish changes nothing");
  await builder.saveClubFormDraft(copy.key, { draft: builderState.setFieldFlag(v2.published, physicianId, "hidden", true), baseVersion: 2, expectedDraftUpdatedAt: removedDraft.draftUpdatedAt }, users.admin);
  assert((await builder.publishClubFormDraft(copy.key, { baseVersion: 2 }, users.admin)).version === 3, "hiding a sensitive field publishes");
  // A draft started before the hide still holds the sealed answer. Editing never returns it, and saving again keeps it.
  const editView = await submissions.getSubmissionForViewer(directorA, draftFill.id, "EDIT");
  assert(editView.answers.physician_name === undefined && !JSON.stringify(editView).includes(SECRET_PHYSICIAN), "editing a draft never returns the answer to a hidden field");
  await submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: copy.key, submissionId: draftFill.id, answers: { child_name: "Riley Verify" }, submit: false });
  const keptDraft = await prisma.clubFormSubmission.findUniqueOrThrow({ where: { id: draftFill.id } });
  assert(keptDraft.sealedSensitiveAnswers !== null && sealed.openSensitiveAnswers(draftFill.id, keptDraft.sealedSensitiveAnswers).physician_name === SECRET_PHYSICIAN, "a sealed answer survives a draft re-save after the field was hidden");
  assert(keptDraft.templateVersion === 3 && !(keptDraft.answers as Record<string, unknown>).physician_name, "the re-saved draft moves to the latest version with no plain copy of the sealed answer");
  const hiddenFill = await submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: copy.key, answers: slipAnswers, submit: true });
  const hiddenRow = await prisma.clubFormSubmission.findUniqueOrThrow({ where: { id: hiddenFill.id } });
  assert(hiddenRow.templateVersion === 3, "a fill after hiding is on the new version");
  assert((await submissions.getSubmissionForViewer(directorA, hiddenFill.id)).answers.physician_name === undefined, "a hidden field takes no new answer");
  assert((await submissions.getSubmissionForViewer(directorA, oldFill.id)).answers.physician_name === SECRET_PHYSICIAN, "hiding a field leaves old answers readable on their version");
  assert(!(await submissions.getSubmissionForViewer(area, oldFill.id)).answers.physician_name, "an Area Coordinator still sees the old answer as Restricted");

  // A field made sensitive later has its existing answers sealed by the publish.
  const v3 = await viewOf();
  await builder.saveClubFormDraft(copy.key, { draft: builderState.setFieldFlag(v3.published, builderIdOf(v3.published, "activity"), "sensitive", true), baseVersion: 3, expectedDraftUpdatedAt: null }, users.admin);
  assert((await builder.publishClubFormDraft(copy.key, { baseVersion: 3 }, users.admin)).version === 4, "marking a field sensitive publishes");
  const resealed = await prisma.$queryRaw<Array<{ text: string }>>`SELECT s::text AS text FROM "ClubFormSubmission" s WHERE s.id = ${oldFill.id}`;
  assert(!resealed[0].text.includes("Canoe trip"), "an answer to a newly sensitive field is no longer stored in plain text");
  assert((await submissions.getSubmissionForViewer(directorA, oldFill.id)).answers.activity === "Canoe trip", "the resealed answer still opens for the director");
  const builderCsv = (await csv.buildClubFormsCsv(sysAdmin, { templateKey: copy.key })).csv;
  assert(!builderCsv.includes(SECRET_PHYSICIAN) && !builderCsv.includes("Canoe trip"), "the export of an edited form has no sensitive text from any version");

  const builderAudit = await prisma.auditLog.findMany({ where: { entityId: copyRow.id, entityType: "ClubFormTemplate" }, select: { action: true, actorUserId: true, metadata: true } });
  for (const action of ["CLUB_FORM_TEMPLATE_CREATED", "CLUB_FORM_TEMPLATE_DRAFT_SAVED", "CLUB_FORM_TEMPLATE_PUBLISHED", "CLUB_FORM_TEMPLATE_ENABLED"]) {
    assert(builderAudit.some((row) => row.action === action && row.actorUserId === users.admin), `${action} is audited with the actor`);
  }
  assert(builderAudit.filter((row) => row.action === "CLUB_FORM_TEMPLATE_PUBLISHED").map((row) => (row.metadata as { version: number }).version).sort().join() === "2,3,4", "each publish is audited with its version");
  assert(!JSON.stringify(builderAudit).includes(SECRET_PHYSICIAN) && !JSON.stringify(builderAudit).includes("Verify renamed activity"), "builder audit rows hold no answer or definition text");

  // The sync leaves a template edited in the app alone.
  const original = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: SLIP } });
  try {
    await prisma.clubFormTemplate.update({ where: { key: SLIP }, data: { version: 0, name: "Verify customized name", customizedAt: new Date() } });
    const synced = await templates.syncClubFormTemplates(prisma, { continueOnRefusal: true });
    const afterSync = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: SLIP } });
    assert(synced.skipped.some((item) => item.key === SLIP), "the sync reports the template it skipped");
    assert(afterSync.name === "Verify customized name" && afterSync.version === 0, "the sync did not overwrite an edited template");
    await prisma.clubFormTemplate.update({ where: { key: SLIP }, data: { customizedAt: null } });
    await templates.syncClubFormTemplates(prisma, { continueOnRefusal: true });
    const restored = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: SLIP } });
    assert(restored.name === original.name && restored.version === original.version, "a template never edited keeps updating from the code");

    // A pending draft does not stop a code update: the live form is updated and stays fillable, and the draft goes stale.
    await prisma.clubFormTemplate.update({ where: { key: SLIP }, data: { version: 0, name: "Verify draft name", draft: { placeholder: true }, draftUpdatedAt: new Date(), draftBaseVersion: 0 } });
    const staleRun = await templates.syncClubFormTemplates(prisma, { continueOnRefusal: true });
    assert(staleRun.staleDrafts.some((item) => item.key === SLIP) && !staleRun.skipped.some((item) => item.key === SLIP), "the sync updates a template with a pending draft and reports the draft as stale");
    const staleRow = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: SLIP } });
    assert(staleRow.name === original.name && staleRow.version === original.version && staleRow.draft !== null, "the live form was updated and the draft was left in place");
    const stillFillable = await submissions.saveClubFormSubmission(directorA, { organizationId: clubs.a, templateKey: SLIP, answers: slipAnswers, submit: false });
    assert(stillFillable.status === "DRAFT", "a form with a stale draft is still fillable");
    assert((await builder.getClubFormBuilderView(SLIP)).draftStale === true, "the builder sees the draft as stale");
    await expectCode(builder.publishClubFormDraft(SLIP, { baseVersion: staleRow.version }, users.admin), "TEMPLATE_CHANGED", "a stale draft cannot be published");
    await builder.discardClubFormDraft(SLIP, users.admin);
    const discarded = await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: SLIP } });
    assert(discarded.draft === null && discarded.draftBaseVersion === null, "discarding clears a stale draft");

    // A customized template ignores the code's definition, but a key the code added as sensitive is still sealed.
    await prisma.clubFormTemplate.update({ where: { key: SLIP }, data: { customizedAt: new Date(), sensitiveFieldKeys: original.sensitiveFieldKeys.filter((key) => key !== "physician_name") } });
    const plainStored = await prisma.clubFormSubmission.create({
      data: {
        templateId: original.id, organizationId: clubs.a, clubYear, status: "DRAFT", templateVersion: 1, enteredVia: "ATTENDEE", enteredByAccountId: accounts.a,
        answers: { child_name: "Riley Verify", physician_name: SECRET_PHYSICIAN },
      },
    });
    await templates.syncClubFormTemplates(prisma, { continueOnRefusal: true });
    const sealedNow = await prisma.clubFormSubmission.findUniqueOrThrow({ where: { id: plainStored.id } });
    assert(!(sealedNow.answers as Record<string, unknown>).physician_name && sealedNow.sealedSensitiveAnswers !== null && sealed.openSensitiveAnswers(plainStored.id, sealedNow.sealedSensitiveAnswers).physician_name === SECRET_PHYSICIAN, "the sync seals a key the code added for a template edited in the app");
    assert((await prisma.clubFormTemplate.findUniqueOrThrow({ where: { key: SLIP } })).sensitiveFieldKeys.includes("physician_name"), "the stored sensitive keys gained the code's key");
  } finally {
    await prisma.clubFormTemplate.update({ where: { key: SLIP }, data: { name: original.name, version: original.version, customizedAt: original.customizedAt, sensitiveFieldKeys: original.sensitiveFieldKeys, draft: Prisma.DbNull, draftUpdatedAt: null, draftBaseVersion: null } });
  }

  // Club forms and links block deleting a club.
  const deletion = await orgRepository.getOrganizationDeletionCheck(clubs.a);
  assert(deletion.blockers.some((blocker) => /club form/i.test(blocker) && /private link/i.test(blocker)), "the club deletion check counts club forms and links");

  console.log("Club forms verification passed.");
}

main()
  .then(async () => {
    await cleanup();
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    await prisma.$disconnect();
    process.exit(1);
  });
