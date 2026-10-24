/**
 * Proves personal staff, pastor and volunteer invitations (#804) against a real PostgreSQL database:
 *
 * - a CSV preview creates nothing and reports invalid emails, repeats in the file, and people already invited or registered;
 *   confirming creates only what was previewed (a changed list is refused), and nothing is ever emailed by an import;
 * - one personal link per email, derived (never stored), copied again, replaced by a reissue (every earlier copy stops working)
 *   or turned off by a revoke, and unusable once the event is over or unpublished;
 * - sending is only an explicit, previewed action that queues the emails in the outbox (never delivers them), is refused for
 *   a count that differs from the preview, is not repeated by a second click, and a failed delivery shows in the list;
 * - a registration through a link is one registration for the person plus a spouse and children up to 18, for $0, in the
 *   invitation's group, waiting for the office (a draft that no count, capacity check or balance sees), the office is told, and
 *   two racing submissions make exactly one registration;
 * - approval is a batch: it confirms the registration, queues its confirmation, covers every person's meals under the
 *   conference-paid plan without charging anyone, and skips what is no longer waiting; a decline cancels the registration;
 * - the event's own attendee questions on the link form (never priced, meal or lodging ones; required ones enforced), per-service
 *   conference-paid meal counts for approved people only, and re-inviting a declined person (a new link, the old one dead, the
 *   declined registration untouched) (#1027);
 * - the table's own constraints, and the deletion of an event that has invitations.
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:staff-invitations
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";

loadEnvConfig(process.cwd());
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-staff-invitations-synthetic-key-not-a-secret");
fillBlankSyntheticEnv("RATE_LIMIT_HASH_SECRET", "verify-staff-invitations-synthetic-rate-limit-hash-secret");

const prisma = new PrismaClient();
const P = `si_${randomUUID().slice(0, 8)}`;
const S = P.replace(/_/g, "-");
const userId = `${P}_staff`;
const eventId = `${P}_ev`;
const clubEventId = `${P}_club_ev`;
const draftEventId = `${P}_draft_ev`;
const officeEmail = `${P}.office@example.test`;
const email = (key: string) => `${P}.${key}@example.test`;
const surname = `Invite${P}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await caught(promise);
  const found = error && typeof error === "object" && "code" in error ? String((error as { code: string }).code) : "";
  assert(found === code, `${message}: expected ${code}, got ${String(error)}`);
}

async function cleanup() {
  const { removeEventOwnedRows } = await import("../modules/events/deletion-repository");
  const events = await prisma.event.findMany({ where: { OR: [{ id: { startsWith: `${P}_` } }, { slug: { startsWith: `${S}-` } }] }, select: { id: true } });
  for (const event of events) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`;
      await removeEventOwnedRows(tx, event.id);
    }, { timeout: 60_000 });
  }
  await prisma.person.deleteMany({ where: { OR: [{ normalizedEmail: { startsWith: `${P}.` } }, { lastName: surname }] } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: userId }, { eventId: { in: events.map((event) => event.id) } }] } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

async function main() {
  const repo = await import("../modules/staff-invitations/repository");
  const { invitationToken } = await import("../modules/staff-invitations/link");
  const { ensureEventMessagingDefaults } = await import("../modules/communications/messaging-repository");
  const { applyCampMeetingMealPreset } = await import("../modules/meals/config-repository");
  const { listRegistrations } = await import("../modules/registrations/repository");

  await cleanup();
  await prisma.user.create({ data: { id: userId, email: `${P}-staff@example.test`, displayName: "Invite Check Staff", globalRole: "SYSTEM_ADMIN" } });
  const eventData = (id: string, extra: Record<string, unknown> = {}) => ({
    id, slug: `${S}-${id.slice(P.length + 1)}`, name: `Invite check ${id.slice(P.length + 1)} ${P}`,
    startsAt: new Date("2027-06-15T15:00:00Z"), endsAt: new Date("2027-06-19T15:00:00Z"), timezone: "America/Chicago", isPublished: true, ...extra,
  });
  await prisma.event.create({ data: eventData(eventId) });
  await prisma.event.create({ data: eventData(clubEventId, { audience: "CLUB" }) });
  await prisma.event.create({ data: eventData(draftEventId, { isPublished: false }) });
  await ensureEventMessagingDefaults(eventId);
  await prisma.eventMessageSettings.update({ where: { eventId }, data: { internalNotificationEmails: [officeEmail], deliveryPaused: false } });
  const meals = await applyCampMeetingMealPreset(eventId, userId);
  assert(meals.plans === 2, "the Camp Meeting meals (with the conference-paid plan) exist");

  // ---- The CSV import: a preview creates nothing, confirming creates what was previewed --------------------------------
  const holder = await prisma.person.create({ data: { firstName: "Already", lastName: surname, normalizedEmail: email("registered") } });
  await prisma.registration.create({
    data: { eventId, accountHolderPersonId: holder.id, confirmationCode: `SI-${P.slice(-8).toUpperCase()}`, status: "SUBMITTED", totalAmount: 0, submittedAt: new Date(), contactSnapshot: { firstName: "Already", lastName: surname } },
  });
  const csv = [
    "Email,First name,Last name,Group",
    `${email("ada")},Ada,Synthetic,Staff`,
    `${email("bea")},Bea,Synthetic,Pastor`,
    `${email("cy")},Cy,Synthetic,Volunteer`,
    `${email("dee")},Dee,Synthetic,Staff`,
    `${email("eve")},Eve,Synthetic,Volunteer`,
    "not-an-email,Fay,Synthetic,Staff",
    `${email("ADA").toUpperCase()},Ada,Again,Staff`,
    `${email("registered")},Already,Registered,Staff`,
  ].join("\n");
  const preview = await repo.previewInvitationImport(eventId, { csv, defaultGroup: null });
  assert(preview.willCreate === 5 && preview.counts.INVALID_EMAIL === 1 && preview.counts.DUPLICATE_IN_FILE === 1 && preview.counts.ALREADY_REGISTERED === 1, `the preview reports every row (${JSON.stringify(preview.counts)})`);
  assert((await prisma.staffInvitation.count({ where: { eventId } })) === 0, "a preview creates nothing");
  assert((await prisma.messageOutbox.count({ where: { eventId } })) === 0, "a preview sends nothing");
  await expectCode(repo.confirmInvitationImport(eventId, userId, { csv, defaultGroup: null, digest: "0".repeat(32) }), "PREVIEW_CHANGED", "a confirm that is not the preview");
  await expectCode(repo.previewInvitationImport(clubEventId, { csv, defaultGroup: "STAFF" }), "EVENT_NOT_SUPPORTED", "a club event takes no personal staff links");
  await expectCode(repo.previewInvitationImport(eventId, { csv: "name\nAda", defaultGroup: "STAFF" }), "INVALID_IMPORT", "a file with no email column");
  const confirmed = await repo.confirmInvitationImport(eventId, userId, { csv, defaultGroup: null, digest: preview.digest });
  assert(confirmed.created === 5 && confirmed.skipped === 3, "confirming creates the five new people");
  assert((await prisma.messageOutbox.count({ where: { eventId } })) === 0, "an import sends nothing");
  assert((await prisma.auditLog.count({ where: { eventId, action: "STAFF_INVITATIONS_IMPORTED" } })) === 1, "the import is audited");
  const again = await repo.previewInvitationImport(eventId, { csv, defaultGroup: null });
  assert(again.willCreate === 0 && again.counts.ALREADY_INVITED === 5, "a second preview of the same file finds everyone already invited");
  await expectCode(repo.confirmInvitationImport(eventId, userId, { csv, defaultGroup: null, digest: again.digest }), "NOTHING_SELECTED", "confirming a file with nobody new");
  // A file with no group column uses the group chosen for the whole file.
  const plain = await repo.previewInvitationImport(eventId, { csv: `email\n${email("gus")}`, defaultGroup: "PASTOR" });
  assert(plain.rows[0].group === "PASTOR" && plain.willCreate === 1, "a file without a group column takes the group chosen for it");
  await repo.confirmInvitationImport(eventId, userId, { csv: `email\n${email("gus")}`, defaultGroup: "PASTOR", digest: plain.digest });

  // ---- The list and the links ------------------------------------------------------------------------------------------
  const list = await repo.listInvitations(eventId);
  assert(list.rows.length === 6 && list.counts.NOT_SENT === 6, "everyone starts as not sent");
  const row = (key: string) => list.rows.find((entry) => entry.email === email(key))!;
  assert(row("ada").group === "STAFF" && row("bea").group === "PASTOR" && row("cy").group === "VOLUNTEER" && row("gus").group === "PASTOR", "each person carries their group");
  const adaRow = await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("ada") } });
  const adaToken = invitationToken(adaRow);
  assert(!JSON.stringify(await prisma.staffInvitation.findMany({ where: { eventId } })).includes(adaToken.split(".")[1]), "the link is derived, never stored");
  const copied = await repo.copyInvitationLink(eventId, userId, adaRow.id);
  assert(copied.url.endsWith(`/staff-invite/${adaToken}`), "the office copies the same link again");
  const opened = await repo.getInvitationExperience(adaToken);
  assert(opened.state === "OPEN" && opened.person.groupLabel === "Staff" && opened.person.email === email("ada"), "the link opens its person's page");
  assert((await repo.getInvitationExperience(`${adaToken}x`)).state === "UNAVAILABLE", "a forged link is unavailable");
  assert((await repo.getInvitationExperience("nonsense")).state === "UNAVAILABLE", "a malformed link is unavailable");
  const reissued = await repo.reissueInvitation(eventId, userId, adaRow.id);
  assert(!reissued.url.endsWith(adaToken) && (await repo.getInvitationExperience(adaToken)).state === "UNAVAILABLE", "a reissue stops every earlier copy");
  const newAdaToken = reissued.url.split("/staff-invite/")[1];
  assert((await repo.getInvitationExperience(newAdaToken)).state === "OPEN", "the reissued link works");
  const revoked = await repo.revokeInvitations(eventId, userId, [row("gus").id]);
  assert(revoked.revoked === 1, "a link nobody used is revoked");
  const gusToken = invitationToken(await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("gus") } }));
  assert((await repo.getInvitationExperience(gusToken)).state === "UNAVAILABLE", "a revoked link is unavailable");
  await expectCode(repo.copyInvitationLink(eventId, userId, row("gus").id), "INVITATION_UNAVAILABLE", "copying a revoked link");
  assert((await repo.listInvitations(eventId)).counts.REVOKED === 1, "the list shows it revoked");
  const regained = await repo.reissueInvitation(eventId, userId, row("gus").id);
  assert((await repo.getInvitationExperience(regained.url.split("/staff-invite/")[1])).state === "OPEN", "a revoked link can be reissued");

  // ---- Sending: a preview, then an explicit send that only queues -------------------------------------------------------
  const everyone = (await repo.listInvitations(eventId)).rows.map((entry) => entry.id);
  const sendPreview = await repo.previewInvitationSend(eventId, everyone);
  assert(sendPreview.willSend === 6 && sendPreview.sample?.bodyText.includes("/staff-invite/") && sendPreview.sample.bodyText.includes("up to age 18"), "the preview shows the exact email");
  const everyToken = await prisma.staffInvitation.findMany({ where: { eventId } });
  assert(everyToken.every((invitation) => !JSON.stringify(sendPreview).includes(invitationToken(invitation))), "the preview shows a placeholder, never a working link");
  assert(/^[0-9a-f]{32}$/.test(sendPreview.digest), "the preview carries a digest of exactly who would be sent"
  );
  assert((await prisma.messageOutbox.count({ where: { eventId } })) === 0, "a send preview queues nothing");
  await expectCode(repo.sendInvitations(eventId, userId, { ids: everyone, digest: "0".repeat(32) }), "SEND_COUNT_CHANGED", "a send that is not what was previewed");
  await expectCode(repo.sendInvitations(eventId, userId, { ids: everyone.slice(1), digest: sendPreview.digest }), "SEND_COUNT_CHANGED", "a send of a different selection than the one previewed");
  assert((await prisma.messageOutbox.count({ where: { eventId } })) === 0, "a refused send queues nothing");
  const sent = await repo.sendInvitations(eventId, userId, { ids: everyone, digest: sendPreview.digest });
  assert(sent.queued === 6, "six invitations are queued");
  const queued = await prisma.messageOutbox.findMany({ where: { eventId, templateKey: "CUSTOM_MESSAGE" } });
  assert(queued.length === 6 && queued.every((message) => message.status === "PENDING" && message.recipientKind === "REGISTRANT"), "they wait in the outbox, pending, for the worker");
  assert(queued.every((message) => (message.metadata as { trigger?: string }).trigger === "STAFF_INVITATION_SENT" && message.bodyTextSnapshot.includes("/staff-invite/")), "each carries its personal link");
  const adaMessage = queued.find((message) => message.recipientEmail === email("ada"))!;
  assert(adaMessage.bodyTextSnapshot.includes(newAdaToken) && !adaMessage.bodyTextSnapshot.includes(adaToken), "the email carries the current link");
  let afterSend = await repo.listInvitations(eventId);
  assert(afterSend.counts.SENT === 6 && afterSend.counts.NOT_SENT === 0, "the list shows them sent");
  await expectCode(repo.sendInvitations(eventId, userId, { ids: everyone, digest: sendPreview.digest }), "NOTHING_TO_SEND", "a second click a moment later");
  assert((await prisma.messageOutbox.count({ where: { eventId } })) === 6, "a second click queues nothing more");
  await prisma.messageOutbox.update({ where: { id: adaMessage.id }, data: { status: "FAILED", lastError: "Synthetic bounce." } });
  afterSend = await repo.listInvitations(eventId);
  assert(afterSend.counts.DELIVERY_FAILED === 1 && afterSend.rows.find((entry) => entry.email === email("ada"))?.status === "DELIVERY_FAILED", "a failed delivery shows in the list");
  // A resend after the cooldown goes out again, and a reissue clears the sent state (nothing is emailed by it).
  const later = new Date(Date.now() + 10 * 60 * 1000);
  const resendPreview = await repo.previewInvitationSend(eventId, [row("ada").id], later);
  const resent = await repo.sendInvitations(eventId, userId, { ids: [row("ada").id], digest: resendPreview.digest }, later);
  assert(resent.queued === 1 && (await prisma.messageOutbox.count({ where: { eventId } })) === 7, "a resend after the cooldown queues one more");
  assert((await repo.listInvitations(eventId)).rows.find((entry) => entry.email === email("ada"))?.status === "SENT", "the resend shows as sent");

  // ---- Registering through a link ----------------------------------------------------------------------------------------
  const family = {
    firstName: "Ada", lastName: surname, phone: "(515) 555-0100", needsHousing: true, housingNote: "Ground floor if possible.",
    spouse: { firstName: "Alex", lastName: surname },
    dependants: [{ firstName: "Kit", lastName: surname, age: 9 }, { firstName: "Lou", lastName: surname, age: 18 }],
  };
  const activeBefore = await prisma.registrationAttendee.count({ where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } } });
  const done = await repo.submitInvitationRegistration(newAdaToken, family);
  assert(done.confirmationCode.startsWith("REG-"), "the registration has a reference");
  const registration = await prisma.registration.findFirstOrThrow({ where: { eventId, confirmationCode: done.confirmationCode }, include: { attendees: { orderBy: { position: "asc" } }, adjustments: true, payments: true } });
  assert(registration.status === "DRAFT" && Number(registration.totalAmount) === 0 && registration.submittedAt === null, "it waits for the office, as a draft, at $0");
  assert(registration.attendees.length === 4 && registration.attendees.map((attendee) => attendee.attendeeType).join() === "WORKER,ATTENDEE,CHILD,CHILD", "the person, the spouse and two children are on it");
  assert(registration.attendees.every((attendee) => (attendee.profileSnapshot as { staffGroup?: string }).staffGroup === "STAFF"), "every person carries the group");
  assert(registration.adjustments.length === 0 && registration.payments.length === 0, "there is nothing to pay or adjust");
  assert((await prisma.registrationAttendee.count({ where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } } })) === activeBefore, "a waiting registration holds no capacity and is in no count");
  const invitationAfter = await prisma.staffInvitation.findFirstOrThrow({ where: { id: adaRow.id } });
  assert(invitationAfter.approval === "WAITING" && invitationAfter.registrationId === registration.id && invitationAfter.needsHousing === true, "the invitation is used and waiting");
  assert((await repo.getInvitationExperience(newAdaToken)).state === "REGISTERED", "the used link says so");
  await expectCode(repo.submitInvitationRegistration(newAdaToken, family), "INVITATION_USED", "using a link twice");
  const notices = await prisma.messageOutbox.findMany({ where: { eventId, registrationId: registration.id } });
  assert(notices.some((message) => message.recipientEmail === email("ada") && message.subjectSnapshot.includes("We received")), "the registrant gets a receipt");
  const digests = await prisma.messageOutbox.findMany({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL" }, orderBy: { createdAt: "asc" } });
  assert(digests.length >= 1 && digests.every((message) => message.registrationId === null && message.status === "PENDING" && message.availableAt.getTime() > Date.now() - 15 * 60 * 1000), "the office is told in a digest that belongs to no registration and waits for its window to close");
  assert(digests[0].bodyTextSnapshot.includes("/people/staff-invitations/approvals?event="), "the digest links to the approval list");
  const shown = (await listRegistrations(eventId)).find((entry) => entry.id === registration.id);
  assert(shown?.staffInvitation?.group === "STAFF" && shown.staffInvitation.approval === "WAITING" && shown.totalAmountCents === 0 && shown.balanceCents === 0, "staff see the group, and nothing due");
  assert((await repo.listInvitations(eventId)).rows.find((entry) => entry.email === email("ada"))?.status === "REGISTERED", "the invite list shows registered");
  const revokeUsed = await repo.revokeInvitations(eventId, userId, [row("ada").id]);
  assert(revokeUsed.revoked === 0 && revokeUsed.skipped === 1, "revoking a used link changes nothing");
  await expectCode(repo.reissueInvitation(eventId, userId, row("ada").id), "NOT_REISSUABLE", "reissuing a used link");

  // The family rule is the server's.
  const beaToken = invitationToken(await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("bea") } }));
  const over = await caught(repo.submitInvitationRegistration(beaToken, { firstName: "Bea", lastName: surname, dependants: [{ firstName: "Old", lastName: surname, age: 19 }] }));
  assert(over && String((over as Error).message).includes("up to age 18"), "a child over 18 is refused");
  assert(await caught(repo.submitInvitationRegistration(beaToken, { firstName: "Bea", lastName: surname, relatives: [{ firstName: "Pa", lastName: surname }] })), "another adult relative is refused");
  await expectCode(repo.submitInvitationRegistration(beaToken, { firstName: "Bea", lastName: surname, spouse: { firstName: "Bea", lastName: surname } }), "INVALID_PARTY", "the same person twice");
  assert((await prisma.registration.count({ where: { eventId, confirmationCode: { startsWith: "REG-" } } })) === 1, "refusals create no registration");
  // Someone who is not allowed in: a revoked link and an event that is unpublished or over.
  await expectCode(repo.submitInvitationRegistration(gusToken, { firstName: "Gus", lastName: surname }), "INVITATION_UNAVAILABLE", "a revoked link");
  const ended = await repo.submitInvitationRegistration(beaToken, { firstName: "Bea", lastName: surname }, new Date("2027-07-01T00:00:00Z")).then(() => null, (error: unknown) => error);
  assert(ended && (ended as { code?: string }).code === "INVITATION_UNAVAILABLE", "a link is unavailable after the event");
  await prisma.event.update({ where: { id: eventId }, data: { isPublished: false } });
  assert((await repo.getInvitationExperience(beaToken)).state === "UNAVAILABLE", "an unpublished event's links are unavailable");
  await prisma.event.update({ where: { id: eventId }, data: { isPublished: true } });

  // Two clicks at once make one registration.
  const cyRow = await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("cy") } });
  const cyToken = invitationToken(cyRow);
  const results = await Promise.allSettled([
    repo.submitInvitationRegistration(cyToken, { firstName: "Cy", lastName: surname }),
    repo.submitInvitationRegistration(cyToken, { firstName: "Cy", lastName: surname }),
  ]);
  assert(results.filter((result) => result.status === "fulfilled").length === 1, `exactly one of two racing submissions registers (${results.map((result) => result.status).join()})`);
  assert((await prisma.registration.count({ where: { eventId, accountHolderPerson: { normalizedEmail: email("cy") } } })) === 1, "one registration for that person");

  // A third and fourth person, to approve and decline together.
  const deeToken = invitationToken(await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("dee") } }));
  const eveToken = invitationToken(await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("eve") } }));
  await repo.submitInvitationRegistration(deeToken, { firstName: "Dee", lastName: surname, dependants: [{ firstName: "Mo", lastName: surname, age: 4 }] });
  await repo.submitInvitationRegistration(eveToken, { firstName: "Eve", lastName: surname });

  // ---- Approval: one batch ------------------------------------------------------------------------------------------------
  const queue = await repo.listApprovals(eventId);
  assert(queue.counts.WAITING === 4 && queue.rows.find((entry) => entry.email === email("ada"))?.party.length === 4, "four registrations wait, with who is in each");
  const ids = (key: string) => queue.rows.find((entry) => entry.email === email(key))!.id;
  const outboxBefore = await prisma.messageOutbox.count({ where: { eventId } });
  const approved = await repo.approveRegistrations(eventId, userId, [ids("ada"), ids("dee"), ids("ada")]);
  assert(approved.decided === 2 && approved.failed === 0, `two are approved (${JSON.stringify(approved)})`);
  assert(approved.meals?.planFound === true && approved.meals.entitledPeople === 6 && approved.meals.failedPeople === 0, `all six people are given the conference-paid plan (${JSON.stringify(approved.meals)})`);
  const adaAfter = await prisma.registration.findUniqueOrThrow({ where: { id: registration.id }, include: { adjustments: true } });
  assert(adaAfter.status === "CONFIRMED" && adaAfter.submittedAt !== null && Number(adaAfter.totalAmount) === 0 && adaAfter.adjustments.length === 0, "approved is confirmed, still $0, with no adjustment");
  const selections = await prisma.eventMealSelection.findMany({ where: { registrationId: registration.id, status: "ACTIVE" } });
  assert(selections.length > 0 && selections.every((selection) => selection.payer === "CONFERENCE" && selection.unitPriceCents === 0 && selection.quantity === 1), "every meal is one conference-paid ticket, charged to no one");
  const perPerson = new Map<string, number>();
  for (const selection of selections) perPerson.set(selection.registrationAttendeeId ?? "", (perPerson.get(selection.registrationAttendeeId ?? "") ?? 0) + 1);
  assert(perPerson.size === 4 && new Set(perPerson.values()).size === 1, "each of the four people has the same set of meals");
  assert(selections.some((selection) => selection.ageGroup === "CHILD") && selections.some((selection) => selection.ageGroup === "ADULT"), "children are entitled as children");
  assert((await prisma.messageOutbox.count({ where: { eventId } })) === outboxBefore + 2 && (await prisma.messageOutbox.count({ where: { eventId, subjectSnapshot: { contains: "is approved" }, status: "PENDING" } })) === 2, "two confirmations are queued, not sent");
  assert((await prisma.auditLog.count({ where: { eventId, action: "STAFF_REGISTRATION_APPROVED" } })) === 2, "each approval is audited");
  const again2 = await repo.approveRegistrations(eventId, userId, [ids("ada")]);
  assert(again2.decided === 0 && again2.skipped === 1, "approving again does nothing");
  const attendeesNow = await prisma.registrationAttendee.count({ where: { eventId, registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } } } });
  assert(attendeesNow === activeBefore + 4 + 2, "approved people now count (Ada's four and Dee's two)");

  const declined = await repo.declineRegistrations(eventId, userId, [ids("cy"), ids("ada")]);
  assert(declined.decided === 1 && declined.skipped === 1 && declined.failed === 0, `one is declined, the approved one is left alone (${JSON.stringify(declined)})`);
  const cyAfter = await prisma.registration.findFirstOrThrow({ where: { eventId, accountHolderPerson: { normalizedEmail: email("cy") } } });
  assert(cyAfter.status === "CANCELLED", "a declined registration is cancelled");
  assert((await prisma.staffInvitation.findFirstOrThrow({ where: { id: cyRow.id } })).approval === "DECLINED", "its invitation says declined");
  assert((await repo.getInvitationExperience(cyToken)).state === "REGISTERED", "a declined person's link cannot register again");
  // A declined registration can't be reactivated from People: that would skip the approval it never had.
  const { reactivateRegistration, cancelRegistration } = await import("../modules/registrations/lifecycle-repository");
  const reactivation = await caught(reactivateRegistration(eventId, cyAfter.id, userId, "Try to bring back"));
  assert(reactivation && (reactivation as { code?: string }).code === "INVALID_REGISTRATION_TRANSITION", "a declined staff registration cannot be reactivated");
  assert((await prisma.registration.findUniqueOrThrow({ where: { id: cyAfter.id } })).status === "CANCELLED", "and stays cancelled");
  // Cancelling a waiting registration by hand from People settles its invitation as declined, so it never waits for ever.
  const eveReg = await prisma.registration.findFirstOrThrow({ where: { eventId, accountHolderPerson: { normalizedEmail: email("eve") } } });
  await cancelRegistration(eventId, eveReg.id, userId, "Cancelled from People");
  assert((await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("eve") } })).approval === "DECLINED", "a hand-cancelled waiting registration is declined, not waiting for ever");
  const stale = await repo.approveRegistrations(eventId, userId, [ids("eve")]);
  assert(stale.decided === 0 && stale.skipped === 1, "a registration no longer waiting is skipped");
  assert((await repo.listApprovals(eventId)).counts.WAITING === 0 && (await repo.listApprovals(eventId)).counts.APPROVED === 2, "nothing waits, and two are approved");

  // ---- The event's own questions on the link form, per-service meal counts, and re-inviting (#1027) ------------------------
  const field = (key: string, extra: Record<string, unknown> = {}) => ({ id: `fld-${key}`, key, label: key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()), helpText: "", type: "TEXT", scope: "ATTENDEE", required: false, options: [], ...extra });
  const eventForm = await prisma.registrationForm.create({ data: { eventId, createdByUserId: userId, name: "Synthetic event form", slug: "synthetic-form", status: "PUBLISHED" } });
  await prisma.registrationFormVersion.create({
    data: {
      formId: eventForm.id, createdByUserId: userId, versionNumber: 1, status: "PUBLISHED", publishedAt: new Date(),
      definition: {
        title: "Synthetic event form", description: "", confirmationMessage: "Thanks, synthetic.",
        sections: [
          { id: "people", title: "People", description: "", fields: [
            field("first_name", { required: true }), field("last_name", { required: true }),
            field("shirt_size", { type: "SELECT", options: ["Small", "Medium", "Large"], required: true }),
            field("hobby"),
            field("workshop_fee", { type: "SELECT", options: ["Yes", "No"], choicePricesCents: { Yes: 500 } }),
            field("meal_choice", { type: "RADIO", options: ["Regular", "Vegetarian"], required: true }),
            field("lodging_choice", { type: "RADIO", options: ["Dorm", "Cabin"], required: true }),
          ] },
          { id: "extras", title: "Extras", description: "", fields: [field("church_name", { scope: "REGISTRATION", required: true })] },
        ],
      },
    },
  });
  const csv2 = `email,group\n${email("ivy")},Pastor\n${email("jon")},Volunteer\n${email("kay")},Volunteer`;
  const preview2 = await repo.previewInvitationImport(eventId, { csv: csv2, defaultGroup: null });
  await repo.confirmInvitationImport(eventId, userId, { csv: csv2, defaultGroup: null, digest: preview2.digest });
  const tokenOf = async (key: string) => invitationToken(await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email(key), supersededAt: null } }));
  const ivyToken = await tokenOf("ivy");
  const jonToken = await tokenOf("jon");
  const kayToken = await tokenOf("kay");
  const opened2 = await repo.getInvitationExperience(ivyToken);
  assert(opened2.state === "OPEN" && opened2.questions.map((question) => question.key).join() === "shirt_size,hobby", `the link form asks the event's attendee questions, but not priced, meal, lodging or registration-level ones (${opened2.state === "OPEN" ? opened2.questions.map((question) => question.key).join() : ""})`);
  const regsBefore = await prisma.registration.count({ where: { eventId } });
  const ivyParty = { firstName: "Ivy", lastName: surname, spouse: { firstName: "Ian", lastName: surname } };
  await expectCode(repo.submitInvitationRegistration(ivyToken, { ...ivyParty, answers: [{ hobby: "Birdwatching" }, { shirt_size: "Large" }] }), "INVALID_ANSWERS", "a required event question left blank for the invited person");
  await expectCode(repo.submitInvitationRegistration(ivyToken, { ...ivyParty, answers: [{ shirt_size: "Large" }] }), "INVALID_ANSWERS", "a required event question left blank for the spouse");
  await expectCode(repo.submitInvitationRegistration(ivyToken, { ...ivyParty, answers: [{ shirt_size: "Huge" }, { shirt_size: "Large" }] }), "INVALID_ANSWERS", "an answer that is not a configured choice");
  await expectCode(repo.submitInvitationRegistration(ivyToken, { ...ivyParty }), "INVALID_ANSWERS", "no answers at all when a question is required");
  assert((await prisma.registration.count({ where: { eventId } })) === regsBefore && (await repo.getInvitationExperience(ivyToken)).state === "OPEN", "refused answers create no registration and leave the link usable");
  await repo.submitInvitationRegistration(ivyToken, {
    ...ivyParty,
    answers: [
      { shirt_size: "Large", hobby: "Birdwatching", lodging_choice: "Cabin", meal_choice: "Vegetarian", workshop_fee: "Yes", meal_coverage: "Not covered", church_name: "Synthetic church" },
      { shirt_size: "Small" },
    ],
  });
  const ivyReg = await prisma.registration.findFirstOrThrow({ where: { eventId, accountHolderPerson: { normalizedEmail: email("ivy") } }, include: { attendees: { orderBy: { position: "asc" } } } });
  assert(ivyReg.attendees.length === 2 && ivyReg.attendees.every((attendee) => (attendee.formResponses as Record<string, unknown>).meal_coverage === "Covered (staff)"), "everyone stays 'Covered (staff)', whatever the request said");
  const sameEntries = (left: unknown, right: unknown) => JSON.stringify(Object.entries(left as object).sort()) === JSON.stringify(Object.entries(right as object).sort());
  assert(sameEntries(ivyReg.attendees[0].formResponses, { shirt_size: "Large", hobby: "Birdwatching", meal_coverage: "Covered (staff)" })
    && sameEntries(ivyReg.attendees[1].formResponses, { shirt_size: "Small", meal_coverage: "Covered (staff)" }), `each person's own answers are saved, and a priced, meal, lodging or registration-level answer is dropped (${JSON.stringify(ivyReg.attendees.map((attendee) => attendee.formResponses))})`);
  assert(Number(ivyReg.totalAmount) === 0 && ivyReg.status === "DRAFT", "still $0 and waiting");
  await repo.submitInvitationRegistration(jonToken, { firstName: "Jon", lastName: surname, answers: [{ shirt_size: "Medium" }] });
  await repo.submitInvitationRegistration(kayToken, { firstName: "Kay", lastName: surname, answers: [{ shirt_size: "Medium" }] });
  const queue2 = await repo.listApprovals(eventId);
  const queueId = (key: string) => queue2.rows.find((entry) => entry.email === email(key))!.id;

  // Meal counts by service: waiting and declined people are never counted.
  const { loadStaffMealServiceCounts } = await import("../modules/meals/staff-coverage");
  const { loadKitchenReport } = await import("../modules/registrations/kitchen-report-loader");
  const { kitchenReportCsv } = await import("../modules/registrations/kitchen-report");
  const { mealTicketSummaryCsv } = await import("../modules/meals/view-repository");
  const beforeApproval = await loadStaffMealServiceCounts(eventId);
  assert(beforeApproval.length > 0 && beforeApproval.every((entry) => entry.counts.STAFF === 6 && entry.counts.PASTOR === 0 && entry.counts.VOLUNTEER === 0), `only Ada's four and Dee's two are counted while three others wait or were declined (${JSON.stringify(beforeApproval[0]?.counts)})`);
  await repo.approveRegistrations(eventId, userId, [queueId("ivy")]);
  await repo.declineRegistrations(eventId, userId, [queueId("jon")]);
  const afterApproval = await loadStaffMealServiceCounts(eventId);
  assert(afterApproval.length === beforeApproval.length && afterApproval.every((entry) => entry.counts.STAFF === 6 && entry.counts.PASTOR === 2 && entry.counts.VOLUNTEER === 0 && entry.total === 8), `an approved pastor's party of two is counted at every service, a declined volunteer and a waiting one are not (${JSON.stringify(afterApproval[0]?.counts)})`);
  const adaServices = new Set((await prisma.eventMealSelection.findMany({ where: { registrationId: registration.id, status: "ACTIVE" }, select: { serviceId: true } })).map((row) => row.serviceId));
  assert(afterApproval.every((entry) => adaServices.has(entry.serviceId)) && afterApproval.length === adaServices.size, "the counts come from the conference-paid plan's own selections, one row per service it covers");
  const report = await loadKitchenReport(eventId);
  assert(report.conferenceMealServices.length === afterApproval.length, "the kitchen report carries the same per-service counts");
  const reportCsv = kitchenReportCsv(report);
  assert(reportCsv.includes("Conference-paid meals by service") && reportCsv.includes('"Service date","Service","Meal","Staff","Pastor","Volunteer","Total"') && !reportCsv.includes(surname) && !reportCsv.includes("REG-"), "the kitchen report CSV has the table and no names or codes");
  const summaryCsv = await mealTicketSummaryCsv(eventId);
  assert(summaryCsv.includes("Conference-paid meals by service") && summaryCsv.includes(`"${afterApproval[0].serviceDate}","${afterApproval[0].serviceName}","${afterApproval[0].mealLabel}","6","2","0","8"`), "the meal ticket summary has the same table");
  await prisma.registration.update({ where: { id: ivyReg.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  assert((await loadStaffMealServiceCounts(eventId)).every((entry) => entry.counts.PASTOR === 0), "a cancelled registration is no longer counted");
  await prisma.registration.update({ where: { id: ivyReg.id }, data: { status: "CONFIRMED", cancelledAt: null } });

  // Re-inviting: a declined person, and a waiting registration cancelled by hand.
  const jonRow = await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("jon") } });
  const jonReg = await prisma.registration.findFirstOrThrow({ where: { id: jonRow.registrationId! } });
  assert(jonRow.approval === "DECLINED" && jonReg.status === "CANCELLED", "Jon was declined");
  const listed = await repo.listInvitations(eventId);
  assert(listed.rows.find((entry) => entry.id === jonRow.id)?.reinvitable === true && listed.rows.find((entry) => entry.email === email("kay"))?.reinvitable === false, "only the declined person can be re-invited");
  await expectCode(repo.reinviteInvitation(eventId, userId, queueId("kay")), "NOT_REINVITABLE", "re-inviting someone still waiting");
  await expectCode(repo.reinviteInvitation(eventId, userId, queueId("ivy")), "NOT_REINVITABLE", "re-inviting someone approved");
  await expectCode(repo.reinviteInvitation(clubEventId, userId, jonRow.id), "EVENT_NOT_SUPPORTED", "re-inviting in a club event");
  await expectCode(repo.reinviteInvitation(eventId, userId, "no-such-invitation"), "INVITATION_NOT_FOUND", "re-inviting an invitation that does not exist");
  const outboxBefore2 = await prisma.messageOutbox.count({ where: { eventId } });
  const reinvited = await repo.reinviteInvitation(eventId, userId, jonRow.id);
  assert((await prisma.messageOutbox.count({ where: { eventId } })) === outboxBefore2, "re-inviting emails nobody");
  const jonOld = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: jonRow.id } });
  const jonNew = await prisma.staffInvitation.findUniqueOrThrow({ where: { id: reinvited.invitationId } });
  assert(jonOld.supersededAt !== null && jonOld.approval === "DECLINED" && jonOld.registrationId === jonReg.id, "the old invitation stays as history, still declined, still tied to its registration");
  assert((await prisma.registration.findUniqueOrThrow({ where: { id: jonReg.id } })).status === "CANCELLED", "the declined registration is untouched");
  assert(jonNew.id !== jonOld.id && jonNew.email === email("jon") && jonNew.group === "VOLUNTEER" && jonNew.registrationId === null && jonNew.approval === null && jonNew.sentAt === null && jonNew.supersededAt === null, "the new invitation is a fresh, unsent one for the same person and group");
  assert((await repo.getInvitationExperience(jonToken)).state === "UNAVAILABLE", "the old link no longer opens");
  await expectCode(repo.submitInvitationRegistration(jonToken, { firstName: "Jon", lastName: surname, answers: [{ shirt_size: "Medium" }] }), "INVITATION_UNAVAILABLE", "registering through the old link");
  const jonNewToken = invitationToken(jonNew);
  assert(jonNewToken !== jonToken && (await repo.getInvitationExperience(jonNewToken)).state === "OPEN", "the new link works");
  const after = await repo.listInvitations(eventId);
  assert(after.rows.filter((entry) => entry.email === email("jon")).length === 1 && after.rows.find((entry) => entry.email === email("jon"))?.status === "NOT_SENT", "the list shows Jon once, as not sent");
  await expectCode(repo.reinviteInvitation(eventId, userId, jonRow.id), "NOT_REINVITABLE", "re-inviting the same declined invitation twice");
  await expectCode(repo.reissueInvitation(eventId, userId, jonRow.id), "NOT_REISSUABLE", "reissuing a superseded invitation");
  assert((await repo.previewInvitationImport(eventId, { csv: `email\n${email("jon")}`, defaultGroup: "STAFF" })).counts.ALREADY_INVITED === 1, "an import still sees Jon as already invited");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "STAFF_INVITATION_REINVITED" } });
  assert(sameEntries(audit.metadata, { invitationId: jonNew.id, previousInvitationId: jonOld.id, previousRegistrationId: jonReg.id }) && !JSON.stringify(audit).includes(email("jon")), "the re-invite is audited with ids only");
  // The same preview-then-Send step as any other invitation, and only then is anything queued.
  const jonPreview = await repo.previewInvitationSend(eventId, [jonNew.id]);
  assert(jonPreview.willSend === 1 && !JSON.stringify(jonPreview).includes(jonNewToken), "the new invitation previews like any other, with a placeholder instead of a link");
  assert((await repo.previewInvitationSend(eventId, [jonOld.id])).willSend === 0, "the superseded invitation can't be sent");
  const jonSent = await repo.sendInvitations(eventId, userId, { ids: [jonNew.id], digest: jonPreview.digest });
  const jonMail = await prisma.messageOutbox.findFirstOrThrow({ where: { eventId, recipientEmail: email("jon"), subjectSnapshot: { contains: "personal registration link" } } });
  assert(jonSent.queued === 1 && jonMail.bodyTextSnapshot.includes(jonNewToken) && !jonMail.bodyTextSnapshot.includes(jonToken), "Send queues the new link and never the old one");
  // He registers again through the new link; the old registration stays cancelled and can't be brought back.
  await repo.submitInvitationRegistration(jonNewToken, { firstName: "Jon", lastName: surname, answers: [{ shirt_size: "Medium" }] });
  const jonRegs = await prisma.registration.findMany({ where: { eventId, accountHolderPerson: { normalizedEmail: email("jon") } }, orderBy: { createdAt: "asc" } });
  assert(jonRegs.length === 2 && jonRegs[0].id === jonReg.id && jonRegs[0].status === "CANCELLED" && jonRegs[1].status === "DRAFT", "the old registration stays as history, and the new one waits for approval");
  const stillBlocked = await caught(reactivateRegistration(eventId, jonReg.id, userId, "Try to bring back"));
  assert(stillBlocked && (stillBlocked as { code?: string }).code === "INVALID_REGISTRATION_TRANSITION", "the old declined registration still can't be reactivated");
  assert((await repo.listApprovals(eventId)).counts.WAITING === 2 && (await repo.listApprovals(eventId)).counts.DECLINED >= 3, "the approval list shows the new waiting registration and keeps the declined one");
  // A waiting registration cancelled from People is re-invitable too (Eve, above).
  const eveRow = await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("eve"), supersededAt: null } });
  const eveNew = await repo.reinviteInvitation(eventId, userId, eveRow.id);
  assert((await repo.getInvitationExperience(eveToken)).state === "UNAVAILABLE" && (await repo.getInvitationExperience(invitationToken(await prisma.staffInvitation.findUniqueOrThrow({ where: { id: eveNew.invitationId } })))).state === "OPEN", "a person whose waiting registration was cancelled gets a new link, and the old one is dead");
  // Two racing re-invites make exactly one new invitation.
  const kayReg = await prisma.registration.findFirstOrThrow({ where: { eventId, accountHolderPerson: { normalizedEmail: email("kay") } } });
  await cancelRegistration(eventId, kayReg.id, userId, "Cancelled from People");
  const kayRow = await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("kay"), supersededAt: null } });
  const raced = await Promise.allSettled([repo.reinviteInvitation(eventId, userId, kayRow.id), repo.reinviteInvitation(eventId, userId, kayRow.id)]);
  assert(raced.filter((result) => result.status === "fulfilled").length === 1 && (await prisma.staffInvitation.count({ where: { eventId, email: email("kay"), supersededAt: null } })) === 1, `exactly one of two racing re-invites works (${raced.map((result) => result.status).join()})`);
  // The table: one live invitation per address, a superseded one only after a decline.
  assert(await caught(prisma.staffInvitation.create({ data: { eventId, email: email("jon"), group: "STAFF" } })), "a second live invitation for one address is still refused");
  assert(await caught(prisma.staffInvitation.update({ where: { id: jonNew.id }, data: { supersededAt: new Date() } })), "an invitation that was never declined can't be marked superseded");
  console.log("ok  event questions, per-service meal counts and re-invite (#1027)");

  // The registrant's own lodging paths are closed for a staff registration, the $0 direct save and the priced change request alike.
  const { saveLodgingRequest, changeRegistrantRoommates } = await import("../modules/lodging/preferences-service");
  const { applyRegistrantWaitlistAction } = await import("../modules/lodging/waitlist-service");
  const registrant = { kind: "REGISTRANT" as const, accessTokenId: "synthetic-token" };
  for (const [name, attempt] of [
    ["a save", () => saveLodgingRequest({ eventId, registrationId: registration.id, actor: registrant, raw: { category: "DORM_ROOM", roomCount: 2 } })],
    ["a roommate request", () => changeRegistrantRoommates({ eventId, registrationId: registration.id, accessTokenId: "synthetic-token", raw: { action: "add_by_code", name: "Someone", confirmationCode: "REG-NOTREAL1" } })],
    ["a waitlist join", () => applyRegistrantWaitlistAction({ eventId, registrationId: registration.id, accessTokenId: "synthetic-token", raw: { action: "join", category: "DORM_ROOM", partySize: 2 } })],
  ] as const) {
    await expectCode(attempt(), "STAFF_REGISTRATION", `${name} by the registrant of a staff registration`);
  }
  assert((await prisma.eventLodgingRequest.count({ where: { registrationId: registration.id } })) === 0 && (await prisma.eventLodgingChangeRequest.count({ where: { registrationId: registration.id } })) === 0, "no lodging request or change request was made");

  // ---- No single conference-paid plan: approval is refused unless the office says to go ahead, and meals can be retried -------
  const gusToken2 = regained.url.split("/staff-invite/")[1];
  // A digest the worker already took is not refreshed: the next registration gets a digest for the next window.
  await prisma.messageOutbox.updateMany({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL" }, data: { status: "SENT", sentAt: new Date() } });
  const digestsBefore = await prisma.messageOutbox.count({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL" } });
  await repo.submitInvitationRegistration(gusToken2, { firstName: "Gus", lastName: surname, dependants: [{ firstName: "Pip", lastName: surname, age: 3 }], answers: [{ shirt_size: "Small" }, { shirt_size: "Small" }] });
  const laterDigests = await prisma.messageOutbox.findMany({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL", status: "PENDING" } });
  assert(laterDigests.length === 1 && (await prisma.messageOutbox.count({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL" } })) === digestsBefore + 1 && laterDigests[0].idempotencyKey.includes(":next") && laterDigests[0].availableAt.getTime() > Date.now(), "a registration after a digest went out is named in a digest for the next window");
  // The office digest has its own switch (#1016): off, a registration in a new window sends the office nothing, while the
  // registrant's own notice still goes out; the switch row is removed again.
  {
    const { resetNotificationSettingsCache } = await import("../modules/notifications/settings");
    await prisma.messageOutbox.updateMany({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL" }, data: { status: "SENT", sentAt: new Date() } });
    const halCsv = `email\n${email("hal")}`;
    const halPreview = await repo.previewInvitationImport(eventId, { csv: halCsv, defaultGroup: "STAFF" });
    await repo.confirmInvitationImport(eventId, userId, { csv: halCsv, defaultGroup: "STAFF", digest: halPreview.digest });
    const halToken = invitationToken(await prisma.staffInvitation.findFirstOrThrow({ where: { eventId, email: email("hal") } }));
    await prisma.notificationSetting.upsert({ where: { key: "STAFF_INVITATION_APPROVAL_DIGEST" }, update: { enabled: false }, create: { key: "STAFF_INVITATION_APPROVAL_DIGEST", enabled: false } });
    resetNotificationSettingsCache();
    try {
      const officeBefore = await prisma.messageOutbox.count({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL" } });
      const registrantBefore = await prisma.messageOutbox.count({ where: { eventId, recipientEmail: email("hal") } });
      await repo.submitInvitationRegistration(halToken, { firstName: "Hal", lastName: surname, answers: [{ shirt_size: "Small" }] });
      assert(await prisma.messageOutbox.count({ where: { eventId, recipientEmail: officeEmail, recipientKind: "INTERNAL" } }) === officeBefore, "switch off: the office gets no digest");
      assert(await prisma.messageOutbox.count({ where: { eventId, recipientEmail: email("hal") } }) === registrantBefore + 1, "switch off: the registrant's own notice is still queued");
    } finally {
      await prisma.notificationSetting.deleteMany({ where: { key: "STAFF_INVITATION_APPROVAL_DIGEST" } });
      resetNotificationSettingsCache();
    }
    console.log("ok  the office digest skips while its switch is off; the registrant's notice is unaffected");
  }
  const gusRow = (await repo.listApprovals(eventId)).rows.find((entry) => entry.email === email("gus"))!;
  await prisma.eventMealPlan.updateMany({ where: { eventId, payer: "CONFERENCE" }, data: { isActive: false } });
  await expectCode(repo.approveRegistrations(eventId, userId, [gusRow.id]), "MEAL_PLAN_REQUIRED", "approving without a conference-paid plan");
  assert((await repo.listApprovals(eventId)).rows.find((entry) => entry.email === email("gus"))?.approval === "WAITING", "the refused approval changed nothing");
  const noMeals = await repo.approveRegistrations(eventId, userId, [gusRow.id], { withoutMealCoverage: true });
  assert(noMeals.decided === 1 && noMeals.meals?.planFound === false && noMeals.meals.failedPeople === 2 && noMeals.meals.failed.length === 2 && noMeals.meals.failed.every((person) => person.attendeeId && person.registrationId === gusRow.registrationId && person.name.length > 0), `approving without meal coverage says who has none (${JSON.stringify(noMeals.meals)})`);
  assert((await repo.listApprovals(eventId)).rows.find((entry) => entry.email === email("gus"))?.peopleWithoutMeals === 2, "the approval list shows two people without meals");
  await expectCode(repo.retryMealCoverage(eventId, userId, [gusRow.id]), "MEAL_PLAN_REQUIRED", "retrying meals with no plan");
  await prisma.eventMealPlan.updateMany({ where: { eventId, payer: "CONFERENCE" }, data: { isActive: true } });
  const retried = await repo.retryMealCoverage(eventId, userId, [gusRow.id]);
  assert(retried.decided === 1 && retried.meals?.entitledPeople === 2 && retried.meals.failedPeople === 0, `the retry covers both people (${JSON.stringify(retried.meals)})`);
  assert((await repo.listApprovals(eventId)).rows.find((entry) => entry.email === email("gus"))?.peopleWithoutMeals === 0, "nobody lacks meals now");
  assert((await prisma.eventMealSelection.count({ where: { registrationId: gusRow.registrationId, payer: "CONFERENCE", status: "ACTIVE" } })) > 0, "the meals are conference-paid tickets");
  const again3 = await repo.retryMealCoverage(eventId, userId, [gusRow.id]);
  assert(again3.meals?.failedPeople === 0, "a second retry is harmless");
  // A batch is capped.
  await expectCode(repo.approveRegistrations(eventId, userId, Array.from({ length: 201 }, (_, index) => `x${index}`)), "BATCH_TOO_LARGE", "an approval batch over 200");

  // ---- Delivery settings are respected, and the table's own constraints --------------------------------------------------
  await prisma.eventMessageSettings.update({ where: { eventId }, data: { deliveryPaused: true } });
  const fresh = await prisma.staffInvitation.create({ data: { eventId, email: email("fresh"), group: "VOLUNTEER" } });
  const disabled = await repo.sendInvitations(eventId, userId, { ids: [fresh.id], digest: (await repo.previewInvitationSend(eventId, [fresh.id])).digest });
  assert(disabled.deliveryMode === "LOCAL_CAPTURE" && (await prisma.messageOutbox.findFirstOrThrow({ where: { eventId, recipientEmail: email("fresh") } })).status === "SUPPRESSED", "a paused event records the email as suppressed and sends nothing");
  assert(await caught(prisma.staffInvitation.create({ data: { eventId, email: email("fresh").toUpperCase(), group: "STAFF" } })), "an address that is not normalized is refused by the table");
  assert(await caught(prisma.staffInvitation.create({ data: { eventId, email: email("fresh"), group: "STAFF" } })), "a second invitation for one address is refused");
  assert(await caught(prisma.staffInvitation.create({ data: { eventId, email: email("zed"), group: "STAFF", approval: "WAITING" } })), "an approval without a registration is refused");
  assert(await caught(prisma.staffInvitation.create({ data: { eventId, email: email("yan"), group: "STAFF", linkVersion: 0 } })), "link version zero is refused");

  // ---- Deleting the event removes its invitations --------------------------------------------------------------------------
  const { removeEventOwnedRows } = await import("../modules/events/deletion-repository");
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`;
    await removeEventOwnedRows(tx, eventId);
  }, { timeout: 60_000 });
  assert((await prisma.staffInvitation.count({ where: { eventId } })) === 0, "deleting the event removes its invitations");

  console.log("Staff invitation verification passed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup().catch((error) => console.error("Cleanup failed", error));
    await prisma.$disconnect();
  });
