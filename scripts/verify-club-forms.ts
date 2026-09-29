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
 *   forms only), staff without and with VIEW_SENSITIVE_DATA, disabled forms;
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
import { createHash } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

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
const users = { admin: `${P}_admin`, staffPlain: `${P}_staff_plain`, staffSensitive: `${P}_staff_sens` };
const accounts = { a: `${P}_acct_a`, b: `${P}_acct_b`, area: `${P}_acct_area` };
const SLIP = "off_premises_permission_slip";
const STAFF_FORM = "pathfinder_staff_service_information";
const PASSENGERS = "transportation_passenger_list";
const templateKeys = [SLIP, STAFF_FORM, PASSENGERS, "pathfinder_membership_application"];
const emailDomain = "clubforms.example.test";
const SECRET_PHYSICIAN = "Dr. Verify Physician Only";
const SECRET_PHONE = "515-555-0177";
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
  const templates = await prisma.clubFormTemplate.findMany({ where: { key: { in: templateKeys } }, select: { id: true } });
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
  type Viewer = import("../modules/club-forms/domain").ClubFormsViewer;

  const directorA: Viewer = { kind: "CLUB_LEADER", organizationId: clubs.a, actor: { kind: "ATTENDEE", accountId: accounts.a } };
  const directorB: Viewer = { kind: "CLUB_LEADER", organizationId: clubs.b, actor: { kind: "ATTENDEE", accountId: accounts.b } };
  const area: Viewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: accounts.area } };
  const staffPlain: Viewer = { kind: "STAFF", userId: users.staffPlain, canViewSensitive: false };
  const staffSensitive: Viewer = { kind: "STAFF", userId: users.staffSensitive, canViewSensitive: true };

  await cleanup();
  await prisma.organization.createMany({
    data: [
      { id: clubs.a, type: "CLUB", name: "Verify Forms Club A", normalizedName: "verify forms club a" },
      { id: clubs.b, type: "CLUB", name: "Verify Forms Club B", normalizedName: "verify forms club b" },
      { id: `${P}_church`, type: "CHURCH", name: "Verify Forms Church", normalizedName: "verify forms church" },
    ],
  });
  for (const [key, id] of Object.entries(users)) {
    await prisma.user.create({ data: { id, email: `${key}@${emailDomain}`, displayName: `Verify ${key}`, globalRole: key === "admin" ? "SYSTEM_ADMIN" : null } });
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
  for (const viewer of [area, staffPlain, staffSensitive]) {
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
  const plainView = await submissions.getSubmissionForViewer(staffPlain, submitted.id);
  assert(!plainView.sensitiveRevealed && !JSON.stringify(plainView).includes(SECRET_PHYSICIAN), "staff without VIEW_SENSITIVE_DATA get Restricted");
  const sensitiveView = await submissions.getSubmissionForViewer(staffSensitive, submitted.id);
  assert(sensitiveView.answers.physician_name === SECRET_PHYSICIAN, "staff with VIEW_SENSITIVE_DATA read the answers");

  // 4. Audit: one row per view, who and what, never the answers ------------
  const viewRows = await prisma.auditLog.findMany({ where: { action: "CLUB_FORM_SUBMISSION_VIEWED", entityId: submitted.id }, orderBy: { createdAt: "asc" } });
  assert(viewRows.length === auditBefore + 3, "each view of a form with sensitive answers wrote one audit row");
  const newRows = viewRows.slice(auditBefore);
  assert(newRows.map((row) => (row.metadata as { viewerKind: string }).viewerKind).join() === "AREA_COORDINATOR,STAFF,STAFF", "audit rows say who viewed");
  assert(newRows.map((row) => (row.metadata as { sensitiveRevealed: boolean }).sensitiveRevealed).join() === "false,false,true", "audit rows say whether answers were revealed");
  assert(newRows[1].actorUserId === users.staffPlain && newRows[2].actorUserId === users.staffSensitive, "staff views are attributed to the staff user");
  assert((newRows[0].metadata as { actorAttendeeAccountId?: string }).actorAttendeeAccountId === accounts.area, "an attendee's view is attributed to their account");
  const everyClubFormAudit = await prisma.$queryRaw<Array<{ text: string }>>`
    SELECT a::text AS text FROM "AuditLog" a
    WHERE a."entityType" IN ('ClubFormSubmission', 'ClubFormLink', 'ClubFormTemplate')
      AND (a."actorUserId" IN (${users.admin}, ${users.staffPlain}, ${users.staffSensitive}) OR a."entityId" = ${submitted.id} OR a."entityId" = ${draft.id})`;
  for (const secret of [SECRET_PHYSICIAN, SECRET_PHONE, SECRET_HEALTH, "Riley"]) {
    assert(everyClubFormAudit.every((row) => !row.text.includes(secret)), "no answer text in any audit row");
  }
  // A form with no sensitive answers is not audited on view.
  const plainOnly = await submissions.saveClubFormSubmission(directorA, {
    organizationId: clubs.a, templateKey: PASSENGERS, answers: { contact_name: "Dana Verify", contact_cell: "515-555-0120", driver_name: "Drew Verify", driver_cell: "515-555-0121", passenger_1_name: "Riley Verify" }, submit: true,
  });
  await submissions.getSubmissionForViewer(directorA, plainOnly.id);
  assert(await prisma.auditLog.count({ where: { action: "CLUB_FORM_SUBMISSION_VIEWED", entityId: plainOnly.id } }) === 0, "a form with no sensitive answers is not audited on view");

  // Disabled forms disappear for clubs and Area Coordinators, not for staff.
  await templates.setClubFormTemplateEnabled(SLIP, false, users.admin);
  assert((await submissions.listSubmissionsForViewer(directorA, {})).every((row) => row.templateKey !== SLIP), "a club no longer sees a disabled form's submissions");
  await expectCode(submissions.getSubmissionForViewer(directorA, submitted.id), "SUBMISSION_NOT_FOUND", "a club can't open a disabled form's submission");
  await expectCode(submissions.getSubmissionForViewer(area, submitted.id), "SUBMISSION_NOT_FOUND", "an Area Coordinator can't either");
  assert((await submissions.getSubmissionForViewer(staffPlain, submitted.id)).id === submitted.id, "staff still see it");
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

  // 6. Staff-only fields on the staff form, and the CSV ----------------------------
  const staffAnswers = {
    full_name: "Alex Verify", birth_date: "1985-06-15", street: "2 Example Road", city: "Exampleville", state: "MO", zip: "64000",
    email: `alex@${emailDomain}`, church: "Verify Forms Church", club: "Verify Forms Club A", health_limitation: "Yes", health_limitation_how: SECRET_HEALTH, conduct_accused: "No",
    reference_1_name: "A", reference_1_address: "B", reference_1_phone: "C", reference_2_name: "A", reference_2_address: "B", reference_2_phone: "C",
    reference_3_name: "A", reference_3_address: "B", reference_3_phone: "C",
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

  const exported = await csv.buildClubFormsCsv(staffPlain, { templateKey: STAFF_FORM });
  assert(exported.rowCount === 1, "the CSV has the submitted staff form");
  for (const secret of [SECRET_HEALTH, "1985-06-15", "Health"]) {
    assert(!exported.csv.includes(secret), `the CSV holds no sensitive column or text (${secret})`);
  }
  assert(exported.csv.includes("Alex Verify") && exported.csv.includes("Verify Forms Club A"), "the CSV holds the non-sensitive columns");
  const slipCsv = await csv.buildClubFormsCsv(staffSensitive, { templateKey: SLIP, organizationId: clubs.a });
  assert(!slipCsv.csv.includes(SECRET_PHYSICIAN) && !slipCsv.csv.includes(SECRET_PHONE), "even staff who may read sensitive answers get none in the CSV");

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
