/**
 * Proves the annual event cloning guarantees (#157) against a real PostgreSQL
 * database. A populated source event (configuration plus synthetic
 * registrations, payments, check-ins, outbox rows, notes, staff access, and
 * more) is previewed and cloned; the clone must carry only reviewed
 * configuration and none of the transactional, private, or protected history.
 * Also covers excluded domains, disabled modules, missing and reused review
 * dates, a stale source, parallel duplicate requests, and key reuse. Uses
 * fictitious users and data it creates and removes itself.
 *
 *   npm run test:event-cloning
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { cloneEvent, EventCloneOperationError, previewEventClone } from "../modules/event-clones/repository";
import { EventCloneReviewError, cloneDomainKeys, type CloneDomainKey, type ClonePlan } from "../modules/event-clones/domain";
import { eventSettingsInputSchema } from "../modules/events/schemas";
import { registrationFormDefinitionSchema } from "../modules/forms/definition";
import { createRegistrationFormFromTemplateInTransaction } from "../modules/forms/repository";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = "evtclone";
const adminId = `${P}_admin`;
const otherAdminId = `${P}_admin_2`;
const staffId = `${P}_staff`;
const users = [adminId, otherAdminId, staffId];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function isOperationError(error: unknown, code: EventCloneOperationError["code"]) {
  return error instanceof EventCloneOperationError && error.code === code;
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: users } } });
  // Restrict foreign keys between rows that all cascade from the event: clear the referencing side first.
  const events = { eventId: { in: (await prisma.event.findMany({ where: { slug: { startsWith: `${P}-` } }, select: { id: true } })).map((event) => event.id) } };
  await prisma.messageOutbox.deleteMany({ where: events });
  await prisma.honorOffering.deleteMany({ where: events });
  await prisma.eventContentLink.deleteMany({ where: { section: events } });
  await prisma.event.deleteMany({ where: { slug: { startsWith: `${P}-` } } });
  await prisma.person.deleteMany({ where: { lastName: `${P}-person` } });
  await prisma.honor.deleteMany({ where: { code: { startsWith: `${P}-` } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}

const allIncluded = Object.fromEntries(cloneDomainKeys.map((key) => [key, true])) as Record<CloneDomainKey, boolean>;
const noneIncluded = Object.fromEntries(cloneDomainKeys.map((key) => [key, false])) as Record<CloneDomainKey, boolean>;

type Fixture = { eventId: string; lateFormId: string; capFormId: string; promoIds: string[]; offeringIds: string[]; sectionId: string; templateKey: string };

/** The payload a fully reviewed confirm sends, built from the previewed plan. */
function confirmBody(source: string, plan: ClonePlan, slug: string, requestKey: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceEventId: source,
    expectedFingerprint: plan.fingerprint,
    requestKey,
    name: `Evtclone Annual 2028 ${slug}`,
    slug,
    startsOn: "2028-05-04",
    endsOn: "2028-05-06",
    capacity: 250,
    registrationOpensOn: "2028-01-15",
    registrationClosesOn: "2028-04-20",
    include: { ...allIncluded },
    formLatePricingDates: plan.review.latePricing.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: "2028-03-01" })),
    promoCodeWindows: plan.review.promoCodes.map((promo) => ({ promoCodeId: promo.promoCodeId, startsOn: "2028-02-01", endsOn: "2028-04-30" })),
    honorOfferingCapacities: plan.review.honorOfferings.map((offering) => ({ offeringId: offering.offeringId, capacity: 12 })),
    ...overrides,
  };
}

async function publishForm(formId: string) {
  await prisma.registrationFormVersion.updateMany({ where: { formId }, data: { status: "PUBLISHED", publishedAt: new Date() } });
  await prisma.registrationForm.update({ where: { id: formId }, data: { status: "PUBLISHED" } });
}

async function buildPopulatedSource(): Promise<Fixture> {
  const event = await prisma.event.create({
    data: {
      name: "Evtclone Annual 2027", slug: `${P}-source-2027`, startsAt: new Date("2027-05-05T12:00:00Z"), endsAt: new Date("2027-05-07T12:00:00Z"),
      timezone: "America/Denver", location: "Synthetic Lodge", publicInfoUrl: "https://example.test/annual", supportContact: "help@example.test",
      calendarCategory: "Camp meeting", hotelName: "Synthetic Inn", hotelRate: "$99", isPublished: true, capacity: 400,
      registrationOpensOn: "2027-01-10", registrationClosesOn: "2027-04-20", seminarPreferenceClosesOn: "2027-04-01", seminarPreferenceSelfServiceLocked: true,
      waitlistEnabled: true, autoPromoteWaitlist: true, collectsShirtSizes: true, checksAdultBackgrounds: true,
      audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE",
    },
  });
  const eventId = event.id;
  await prisma.user.createMany({ data: [
    { id: adminId, email: `${P}-admin@example.test`, displayName: "Clone Check Admin", globalRole: "SYSTEM_ADMIN" },
    { id: otherAdminId, email: `${P}-admin-2@example.test`, displayName: "Clone Check Admin 2", globalRole: "SYSTEM_ADMIN" },
    { id: staffId, email: `${P}-staff@example.test`, displayName: "Clone Check Staff" },
  ] });

  // Configuration.
  const asset = await prisma.eventAsset.create({ data: { eventId, displayName: "map.pdf", contentType: "application/pdf", byteSize: 10, checksum: "abc", storageKey: `${P}-storage-key` } });
  const section = await prisma.eventContentSection.create({ data: { eventId, kind: "RICH_TEXT", title: "Welcome", body: "Hello there.", position: 1, isPublished: true } });
  await prisma.eventContentSection.create({ data: {
    eventId, kind: "RESOURCE_LINKS", title: "Resources", position: 2, isPublished: true,
    links: { create: [
      { label: "Schedule", url: "https://example.test/schedule", position: 1 },
      { label: "Campus map", assetId: asset.id, position: 2 },
    ] },
  } });
  await prisma.eventCommunitySettings.create({ data: { eventId, isEnabled: true, allowReplies: false, retentionDays: 45 } });
  await prisma.eventAttendeeType.createMany({ data: [
    { eventId, code: "ADULT", label: "Adult", minimumAge: 18 },
    { eventId, code: "YOUTH", label: "Youth", minimumAge: 10, maximumAge: 17, sortOrder: 1 },
  ] });
  await prisma.eventAttendeeClassification.create({ data: { eventId, kind: "CATEGORY", code: "VOLUNTEER", label: "Volunteer" } });
  await prisma.eventTag.createMany({ data: [
    { eventId, name: "VIP", normalizedName: "vip", color: "#336699" },
    { eventId, name: "Speaker", normalizedName: "speaker", color: "#993366" },
  ] });
  const promoA = await prisma.promoCode.create({ data: { eventId, code: "EARLY", normalizedCode: "EARLY", discountType: "FIXED_CENTS", discountValue: 500, startsOn: "2027-01-10", endsOn: "2027-02-10", redeemedCount: 7, maximumUses: 100 } });
  const promoB = await prisma.promoCode.create({ data: { eventId, code: "OPEN", normalizedCode: "OPEN", discountType: "PERCENT_BPS", discountValue: 1000, redeemedCount: 2 } });

  const honor = await prisma.honor.create({ data: { code: `${P}-honor-1`, name: "Evtclone Knots", normalizedName: `${P} knots` } });
  const honor2 = await prisma.honor.create({ data: { code: `${P}-honor-2`, name: "Evtclone Birds", normalizedName: `${P} birds` } });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Friday", normalizedName: "friday" } });
  const offeringA = await prisma.honorOffering.create({ data: { eventId, honorId: honor.id, sessionId: session.id, span: "SINGLE_SESSION", capacity: 30, teacherName: "Synthetic Teacher" } });
  const offeringB = await prisma.honorOffering.create({ data: { eventId, honorId: honor2.id, span: "ALL_SESSIONS", capacity: 20, isActive: false } });

  // Forms: one with late pricing, one with capacity limits, one never published.
  const forms = await prisma.$transaction(async (tx) => ({
    late: await createRegistrationFormFromTemplateInTransaction(tx, eventId, adminId, "womens_retreat_export"),
    cap: await createRegistrationFormFromTemplateInTransaction(tx, eventId, adminId, "camp_meeting_export"),
    draft: await createRegistrationFormFromTemplateInTransaction(tx, eventId, adminId, "simple_rsvp"),
  }));
  await publishForm(forms.late.id);
  await publishForm(forms.cap.id);

  // Message templates: one published (with a newer draft), one draft-only.
  const published = await prisma.eventMessageTemplate.create({ data: { eventId, key: "EVENT_ANNOUNCEMENT", isEnabled: false, versions: { create: [
    { createdByUserId: adminId, versionNumber: 1, status: "PUBLISHED", subjectTemplate: "News from {{event_name}}", bodyTemplate: "Hello {{recipient_name}}.", publishedAt: new Date() },
    { createdByUserId: adminId, versionNumber: 2, status: "DRAFT", subjectTemplate: "Draft subject", bodyTemplate: "Draft body." },
  ] } }, include: { versions: true } });
  await prisma.eventMessageTemplate.create({ data: { eventId, key: "WAITLIST_JOINED", versions: { create: { createdByUserId: adminId, versionNumber: 1, status: "DRAFT", subjectTemplate: "Waitlisted", bodyTemplate: "You are waitlisted." } } } });

  // Unsupported configuration.
  await prisma.merchandiseCatalog.create({ data: { eventId, isEnabled: true } });
  await prisma.merchandiseProduct.create({ data: { eventId, name: "Synthetic shirt" } });
  await prisma.eventPaymentInstructionVersion.create({ data: { eventId, versionNumber: 1, instructions: "Pay by synthetic check.", approvedByUserId: adminId } });
  await prisma.eventMessageSettings.create({ data: { eventId, senderName: "Synthetic Sender", senderEmail: "sender@example.test" } });

  // Transactional, private, and protected history that must never be copied.
  const person = await prisma.person.create({ data: { firstName: "Synthetic", lastName: `${P}-person`, normalizedEmail: `${P}-person@example.test` } });
  const registration = await prisma.registration.create({ data: { eventId, accountHolderPersonId: person.id, confirmationCode: `${P.toUpperCase()}1`, status: "CONFIRMED", totalAmount: 120 } });
  const attendee = await prisma.registrationAttendee.create({ data: { eventId, registrationId: registration.id, personId: person.id, attendeeType: "ADULT", profileSnapshot: { note: "synthetic" } } });
  await prisma.payment.create({ data: { eventId, registrationId: registration.id, amount: 120, status: "SUCCEEDED", method: "CASH" } });
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendee.id, idempotencyKey: `${P}-checkin` } });
  await prisma.messageOutbox.create({ data: {
    eventId, registrationId: registration.id, templateKey: "EVENT_ANNOUNCEMENT", recipientKind: "REGISTRANT", recipientEmail: `${P}-person@example.test`,
    senderNameSnapshot: "Synthetic Sender", subjectSnapshot: "Hi", bodyTextSnapshot: "Hi", idempotencyKey: `${P}-outbox`, correlationId: `${P}-corr`,
    templateVersionId: published.versions.find((version) => version.status === "PUBLISHED")!.id,
  } });
  await prisma.registrationWaitlistEntry.create({ data: { eventId, registrationId: registration.id, position: 1, attendeeCount: 1 } });
  const note = await prisma.staffNote.create({ data: { eventId, registrationId: registration.id, authorUserId: staffId, visibility: "RESTRICTED", restrictedPermission: "VIEW_MEDICAL" } });
  await prisma.staffNoteRevision.create({ data: { noteId: note.id, sequence: 1, body: "synthetic restricted note", authorUserId: staffId } });
  await prisma.announcement.create({ data: { eventId, createdByUserId: adminId, title: "Synthetic", body: "Synthetic", audience: {}, placement: "HOME" } });
  await prisma.eventMembership.create({ data: { eventId, userId: staffId, role: "REGISTRATION_MANAGER", status: "ACTIVE" } });
  await prisma.eventMembership.create({ data: { eventId, userId: adminId, role: "EVENT_ADMIN", status: "ACTIVE" } });
  await prisma.auditLog.create({ data: { eventId, actorUserId: staffId, action: "SYNTHETIC_HISTORY", entityType: "Event", entityId: eventId, correlationId: `${P}-audit`, summary: "Synthetic history." } });

  return { eventId, lateFormId: forms.late.id, capFormId: forms.cap.id, promoIds: [promoA.id, promoB.id], offeringIds: [offeringA.id, offeringB.id], sectionId: section.id, templateKey: "EVENT_ANNOUNCEMENT" };
}

/** Every row the clone must not share with or copy from the source, counted for one event. */
async function historyCounts(eventId: string) {
  const [registrations, attendees, payments, refunds, adjustments, checkIns, outbox, waitlist, notes, noteRevisions, announcements, merchOrders, merchProducts, merchCatalog, paymentInstructions, messageSettings, assets, capacityReservations, accessTokens, tagAssignments, honorEnrollments, formSubmissions, importRuns] = await Promise.all([
    prisma.registration.count({ where: { eventId } }),
    prisma.registrationAttendee.count({ where: { eventId } }),
    prisma.payment.count({ where: { eventId } }),
    prisma.refund.count({ where: { eventId } }),
    prisma.registrationAdjustment.count({ where: { eventId } }),
    prisma.checkIn.count({ where: { eventId } }),
    prisma.messageOutbox.count({ where: { eventId } }),
    prisma.registrationWaitlistEntry.count({ where: { eventId } }),
    prisma.staffNote.count({ where: { eventId } }),
    prisma.staffNoteRevision.count({ where: { note: { eventId } } }),
    prisma.announcement.count({ where: { eventId } }),
    prisma.merchandiseOrder.count({ where: { eventId } }),
    prisma.merchandiseProduct.count({ where: { eventId } }),
    prisma.merchandiseCatalog.count({ where: { eventId } }),
    prisma.eventPaymentInstructionVersion.count({ where: { eventId } }),
    prisma.eventMessageSettings.count({ where: { eventId } }),
    prisma.eventAsset.count({ where: { eventId } }),
    prisma.registrationCapacityReservation.count({ where: { eventId } }),
    prisma.registrationAccessToken.count({ where: { registration: { eventId } } }),
    prisma.registrationTagAssignment.count({ where: { eventId } }),
    prisma.honorEnrollment.count({ where: { eventId } }),
    prisma.publicRegistrationSubmission.count({ where: { eventId } }),
    prisma.importRun.count({ where: { eventId } }),
  ]);
  return { registrations, attendees, payments, refunds, adjustments, checkIns, outbox, waitlist, notes, noteRevisions, announcements, merchOrders, merchProducts, merchCatalog, paymentInstructions, messageSettings, assets, capacityReservations, accessTokens, tagAssignments, honorEnrollments, formSubmissions, importRuns };
}

/** The whole source configuration as stored, to prove cloning and editing a clone never touch it. */
async function sourceDump(eventId: string) {
  const [event, sections, forms, types, classifications, templates, tags, promos, sessions, offerings] = await Promise.all([
    prisma.event.findUniqueOrThrow({ where: { id: eventId } }),
    prisma.eventContentSection.findMany({ where: { eventId }, orderBy: { id: "asc" }, include: { links: { orderBy: { id: "asc" } } } }),
    prisma.registrationForm.findMany({ where: { eventId }, orderBy: { id: "asc" }, include: { versions: { orderBy: { id: "asc" } } } }),
    prisma.eventAttendeeType.findMany({ where: { eventId }, orderBy: { id: "asc" } }),
    prisma.eventAttendeeClassification.findMany({ where: { eventId }, orderBy: { id: "asc" } }),
    prisma.eventMessageTemplate.findMany({ where: { eventId }, orderBy: { id: "asc" }, include: { versions: { orderBy: { id: "asc" } } } }),
    prisma.eventTag.findMany({ where: { eventId }, orderBy: { id: "asc" } }),
    prisma.promoCode.findMany({ where: { eventId }, orderBy: { id: "asc" } }),
    prisma.honorSession.findMany({ where: { eventId }, orderBy: { id: "asc" } }),
    prisma.honorOffering.findMany({ where: { eventId }, orderBy: { id: "asc" } }),
  ]);
  return JSON.stringify({ event, sections, forms, types, classifications, templates, tags, promos, sessions, offerings, history: await historyCounts(eventId) });
}

async function run() {
  const source = await buildPopulatedSource();
  const sourceId = source.eventId;
  const sourceHistory = await historyCounts(sourceId);
  assert(sourceHistory.registrations === 1 && sourceHistory.payments === 1 && sourceHistory.checkIns === 1 && sourceHistory.outbox === 1 && sourceHistory.notes === 1, "the source is populated with history");

  // 1. Preview: domain-by-domain, counts, fingerprint, review items, audited.
  const plan = await previewEventClone(adminId, { sourceEventId: sourceId });
  const domain = (key: CloneDomainKey) => plan.domains.find((entry) => entry.key === key)!;
  assert(/^[0-9a-f]{64}$/.test(plan.fingerprint), "the plan carries a fingerprint");
  assert(plan.domains.length === cloneDomainKeys.length, "every copyable domain is listed");
  assert(domain("registrationForms").count === 2 && domain("registrationForms").skipped.some((entry) => entry.reason.includes("published")), "two published forms are copyable and the never-published one is listed as skipped");
  assert(domain("contentSections").count === 2 && domain("contentSections").notes.some((note) => note.includes("uploaded")), "content sections are counted and the uploaded-file link is flagged");
  assert(domain("attendeeTypes").count === 2 && domain("attendeeClassifications").count === 1 && domain("tags").count === 2, "attendee types, categories, and tags are counted");
  assert(domain("messageTemplates").count === 1 && domain("messageTemplates").skipped.length === 1, "only the published message template is copyable; the draft-only one is skipped");
  assert(domain("promoCodes").count === 2 && domain("honors").count === 2, "promo codes and honor offerings are counted");
  assert(plan.review.latePricing.length >= 1 && plan.review.promoCodes.length === 2 && plan.review.honorOfferings.length === 2, "the plan lists what needs new dates and capacities");
  assert(plan.unsupported.every((entry) => entry.sourceCount > 0) && plan.unsupported.length === 4, "unsupported domains are listed with their source counts");
  assert(plan.neverCopied.length > 5, "the never-copied list is shown");
  assert(await prisma.auditLog.count({ where: { action: "EVENT_CLONE_PREVIEWED", entityId: sourceId, actorUserId: adminId } }) === 1, "the preview is audited");
  const previewAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: "EVENT_CLONE_PREVIEWED", entityId: sourceId } });
  assert(!JSON.stringify(previewAudit.metadata).includes("Synthetic Lodge"), "the preview audit holds ids and counts only");
  const previewMissing = await previewEventClone(adminId, { sourceEventId: "evtclone-no-such-event" }).then(() => null, (error: unknown) => error);
  assert(isOperationError(previewMissing, "SOURCE_NOT_FOUND"), "previewing a missing source is SOURCE_NOT_FOUND");
  console.log("ok  preview lists every domain with counts, review items, skipped and unsupported domains, and is audited");

  // 2. Review is required: missing and carried-over dates create nothing.
  const missingDates = await cloneEvent(adminId, confirmBody(sourceId, plan, `${P}-missing`, `${P}-key-missing`, { formLatePricingDates: [], promoCodeWindows: [], honorOfferingCapacities: [] })).then(() => null, (error: unknown) => error);
  assert(missingDates instanceof EventCloneReviewError && missingDates.issues.length >= 3, `missing review values are refused, got ${String(missingDates)}`);
  const carriedOver = await cloneEvent(adminId, confirmBody(sourceId, plan, `${P}-carried`, `${P}-key-carried`, {
    formLatePricingDates: plan.review.latePricing.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: item.sourceStartsOn })),
  })).then(() => null, (error: unknown) => error);
  assert(carriedOver instanceof EventCloneReviewError && carriedOver.issues.some((issue) => issue.includes("source event's date")), `a source date carried over is refused, got ${String(carriedOver)}`);
  const missingKeys = await cloneEvent(adminId, { ...confirmBody(sourceId, plan, `${P}-nokeys`, `${P}-key-nokeys`), capacity: undefined }).then(() => null, (error: unknown) => error);
  assert(missingKeys instanceof Error && missingKeys.name === "ZodError", "a body without an explicit capacity is a validation error");
  assert(await prisma.event.count({ where: { slug: { in: [`${P}-missing`, `${P}-carried`, `${P}-nokeys`] } } }) === 0 && await prisma.eventCloneRecord.count({ where: { actorUserId: adminId } }) === 0, "nothing was created by a refused review");
  console.log("ok  missing or carried-over dates, capacities, and windows are refused and create nothing");

  // 3. The full clone: configuration copied, history never.
  const before = await sourceDump(sourceId);
  const fullBody = confirmBody(sourceId, plan, `${P}-clone-2028`, `${P}-key-full`);
  const cloned = await cloneEvent(adminId, fullBody);
  assert(!cloned.alreadyCloned, "the first clone creates the event");
  const cloneId = cloned.event.id;
  assert(cloneId !== sourceId && cloned.event.isPublished === false, "the clone is a new unpublished draft");
  const cloneRow = await prisma.event.findUniqueOrThrow({ where: { id: cloneId } });
  assert(cloneRow.capacity === 250 && cloneRow.registrationOpensOn === "2028-01-15" && cloneRow.registrationClosesOn === "2028-04-20", "capacity and registration dates are the reviewed values");
  assert(cloned.event.startsOn === "2028-05-04" && cloned.event.endsOn === "2028-05-06", "event dates are the reviewed values");
  assert(cloneRow.seminarPreferenceClosesOn === null && !cloneRow.seminarPreferenceSelfServiceLocked, "the seminar preference deadline and lock are reset");
  assert(cloneRow.location === "Synthetic Lodge" && cloneRow.timezone === "America/Denver" && cloneRow.hotelName === "Synthetic Inn" && cloneRow.calendarCategory === "Camp meeting", "branding and details are copied");
  assert(cloneRow.audience === "CLUB" && cloneRow.billingMode === "DEFERRED_ORGANIZATION_INVOICE", "audience and billing mode are copied");
  assert(cloneRow.waitlistEnabled && cloneRow.autoPromoteWaitlist && cloneRow.collectsShirtSizes && cloneRow.checksAdultBackgrounds, "module toggles are copied");
  const community = await prisma.eventCommunitySettings.findUniqueOrThrow({ where: { eventId: cloneId } });
  assert(community.isEnabled && !community.allowReplies && community.retentionDays === 45 && community.updatedByUserId === adminId, "community settings are copied");

  const cloneHistory = await historyCounts(cloneId);
  assert(Object.values(cloneHistory).every((count) => count === 0), `no registration, attendee, payment, refund, check-in, outbox, waitlist, note, announcement, order, merchandise, payment instruction, delivery setting, file, or token was copied: ${JSON.stringify(cloneHistory)}`);
  assert(await prisma.checkIn.count({ where: { attendee: { eventId: cloneId } } }) === 0, "no check-in reaches the clone through an attendee");
  const memberships = await prisma.eventMembership.findMany({ where: { eventId: cloneId } });
  assert(memberships.length === 1 && memberships[0]!.userId === adminId && memberships[0]!.role === "EVENT_ADMIN" && memberships[0]!.status === "ACTIVE", "the only access on the clone is the creator's active admin membership; staff grants are not copied");
  const cloneAudit = await prisma.auditLog.findMany({ where: { eventId: cloneId } });
  assert(!cloneAudit.some((entry) => entry.action === "SYNTHETIC_HISTORY") && cloneAudit.some((entry) => entry.action === "EVENT_CLONED"), "no audit history is copied; the clone is audited");
  const clonedAudit = cloneAudit.find((entry) => entry.action === "EVENT_CLONED")!;
  assert(!JSON.stringify(clonedAudit.metadata).includes("Synthetic Lodge") && !JSON.stringify(clonedAudit.metadata).includes("Synthetic Inn"), "the clone audit holds ids and counts only");

  const sections = await prisma.eventContentSection.findMany({ where: { eventId: cloneId }, include: { links: true }, orderBy: { position: "asc" } });
  assert(sections.length === 2 && sections.every((section) => !section.isPublished), "content sections are copied unpublished");
  assert(sections[1]!.links.length === 1 && sections[1]!.links[0]!.url === "https://example.test/schedule" && sections.every((section) => section.links.every((link) => link.assetId === null)), "web links are copied and the uploaded-file link is skipped");
  assert(await prisma.eventAttendeeType.count({ where: { eventId: cloneId } }) === 2 && await prisma.eventAttendeeClassification.count({ where: { eventId: cloneId } }) === 1 && await prisma.eventTag.count({ where: { eventId: cloneId } }) === 2, "attendee types, categories, and tags are copied");
  assert(await prisma.registrationAttendeeClassification.count({ where: { classification: { eventId: cloneId } } }) === 0 && await prisma.attendeeTagAssignment.count({ where: { eventId: cloneId } }) === 0, "no attendee is classified or tagged on the clone");

  const cloneForms = await prisma.registrationForm.findMany({ where: { eventId: cloneId }, include: { versions: true }, orderBy: { slug: "asc" } });
  assert(cloneForms.length === 2, `the two published forms are copied and the unpublished one is not, got ${cloneForms.length}`);
  assert(cloneForms.every((form) => form.status === "DRAFT" && form.versions.length === 1 && form.versions[0]!.versionNumber === 1 && form.versions[0]!.status === "DRAFT" && form.versions[0]!.publishedAt === null), "copied forms are new draft version 1s");
  const sourceForms = await prisma.registrationForm.findMany({ where: { eventId: sourceId } });
  assert(cloneForms.every((form) => sourceForms.some((sourceForm) => sourceForm.slug === form.slug)), "copied forms keep their web addresses");
  const lateForm = cloneForms.find((form) => form.name === sourceForms.find((entry) => entry.id === source.lateFormId)!.name)!;
  const lateDefinition = registrationFormDefinitionSchema.parse(lateForm.versions[0]!.definition);
  const lateDates = lateDefinition.sections.flatMap((section) => section.fields).filter((field) => field.latePricing).map((field) => field.latePricing!.startsOn);
  assert(lateDates.length >= 1 && lateDates.every((date) => date === "2028-03-01"), "late-pricing dates are the reviewed ones");
  const capForm = cloneForms.find((form) => form.name === sourceForms.find((entry) => entry.id === source.capFormId)!.name)!;
  const capDefinition = registrationFormDefinitionSchema.parse(capForm.versions[0]!.definition);
  assert(capDefinition.sections.flatMap((section) => section.fields).every((field) => Object.keys(field.choiceLimits ?? {}).length === 0), "choice capacity limits are cleared");
  assert(await prisma.auditLog.count({ where: { eventId: cloneId, action: "REGISTRATION_FORM_CREATED" } }) === 2, "each copied form creation is audited");

  const messages = await prisma.eventMessageTemplate.findMany({ where: { eventId: cloneId }, include: { versions: true } });
  assert(messages.length === 1 && messages[0]!.key === "EVENT_ANNOUNCEMENT" && !messages[0]!.isEnabled && messages[0]!.versions.length === 1 && messages[0]!.versions[0]!.subjectTemplate === "News from {{event_name}}" && messages[0]!.versions[0]!.versionNumber === 1, "only the published message text is copied, keeping its disabled state");

  const promos = await prisma.promoCode.findMany({ where: { eventId: cloneId }, orderBy: { normalizedCode: "asc" } });
  assert(promos.length === 2 && promos.every((promo) => !promo.isActive && promo.redeemedCount === 0 && promo.startsOn === "2028-02-01" && promo.endsOn === "2028-04-30"), "promo codes are copied inactive, unused, with the reviewed window");
  assert(promos[0]!.maximumUses === 100 && await prisma.promoCodeRedemption.count({ where: { eventId: cloneId } }) === 0, "promo rules carry over but redemptions do not");
  const offerings = await prisma.honorOffering.findMany({ where: { eventId: cloneId }, include: { session: true } });
  assert(offerings.length === 2 && offerings.every((offering) => offering.capacity === 12) && offerings.some((offering) => offering.session?.name === "Friday") && offerings.some((offering) => offering.sessionId === null), "honor offerings are copied with the reviewed capacity and their own sessions");
  const cloneSessionIds = (await prisma.honorSession.findMany({ where: { eventId: cloneId } })).map((entry) => entry.id);
  assert(cloneSessionIds.length === 1 && offerings.filter((offering) => offering.sessionId).every((offering) => cloneSessionIds.includes(offering.sessionId!)), "offerings point at the clone's own session");

  const record = await prisma.eventCloneRecord.findUniqueOrThrow({ where: { resultEventId: cloneId } });
  assert(record.sourceEventId === sourceId && record.actorUserId === adminId && record.sourceFingerprint === plan.fingerprint, "provenance records the source, actor, and fingerprint");
  const versions = record.sourceVersions as { forms: Array<{ versionId: string; newFormId: string }>; messageTemplates: Array<{ key: string }> };
  assert(versions.forms.length === 2 && versions.messageTemplates.length === 1 && versions.forms.every((entry) => cloneForms.some((form) => form.id === entry.newFormId)), "provenance records the source form and message versions");
  assert(Object.keys(record.selections as object).length === cloneDomainKeys.length && Object.values(record.selections as Record<string, boolean>).every(Boolean), "provenance records the selections");
  assert(JSON.stringify(record.exclusions).includes("merchandise"), "provenance records what was unsupported");
  assert(JSON.stringify(record.snapshot).includes(`"copiedCounts"`), "provenance keeps a snapshot");

  const resave = eventSettingsInputSchema.safeParse({ ...cloned.event, approvedPaymentInstructions: cloned.event.approvedPaymentInstructions ?? null });
  assert(resave.success, `the clone re-saves in event settings: ${resave.success ? "" : JSON.stringify(resave.error.issues)}`);
  assert(before === await sourceDump(sourceId), "cloning did not change the source event");
  console.log("ok  the full clone copies reviewed configuration as a draft and none of the registrations, payments, check-ins, outbox, notes, staff access, or audit history");

  // 4. Editing the clone never reaches the source; the clone is an editable draft.
  await prisma.eventContentSection.updateMany({ where: { eventId: cloneId }, data: { title: "Edited on the clone" } });
  await prisma.event.update({ where: { id: cloneId }, data: { location: "Somewhere else" } });
  assert(before === await sourceDump(sourceId), "editing the clone did not change the source");
  console.log("ok  the clone is an independent editable draft");

  // 5. Idempotency: a retry, even after the source changed, returns the same event.
  const retry = await cloneEvent(adminId, fullBody);
  assert(retry.alreadyCloned && retry.event.id === cloneId, "a retry returns the event the first attempt created");
  await prisma.eventContentSection.update({ where: { id: source.sectionId }, data: { title: "Welcome (edited)" } });
  const retryAfterEdit = await cloneEvent(adminId, fullBody);
  assert(retryAfterEdit.alreadyCloned && retryAfterEdit.event.id === cloneId, "a retry after the source changed still returns the existing clone, not SOURCE_CHANGED");
  assert(await prisma.event.count({ where: { slug: `${P}-clone-2028` } }) === 1 && await prisma.eventCloneRecord.count({ where: { sourceEventId: sourceId } }) === 1, "retries created no duplicate");

  // 6. Stale source: each kind of configuration edit invalidates an old preview.
  const stalePlan = plan; // fingerprint from before the section edit above
  const stale = await cloneEvent(adminId, confirmBody(sourceId, stalePlan, `${P}-stale`, `${P}-key-stale`)).then(() => null, (error: unknown) => error);
  assert(isOperationError(stale, "SOURCE_CHANGED"), `a stale preview is SOURCE_CHANGED, got ${String(stale)}`);
  assert(await prisma.event.count({ where: { slug: `${P}-stale` } }) === 0, "nothing was created for a stale preview");
  const freshPlan = await previewEventClone(adminId, { sourceEventId: sourceId });
  assert(freshPlan.fingerprint !== plan.fingerprint, "editing content changes the fingerprint");
  const edits: Array<[string, () => Promise<unknown>]> = [
    ["a published form definition", async () => {
      const version = await prisma.registrationFormVersion.findFirstOrThrow({ where: { formId: source.capFormId, status: "PUBLISHED" } });
      const definition = registrationFormDefinitionSchema.parse(version.definition);
      await prisma.registrationFormVersion.update({ where: { id: version.id }, data: { definition: { ...definition, description: "Edited description" } } });
    }],
    ["a message template", async () => { await prisma.messageTemplateVersion.updateMany({ where: { template: { eventId: sourceId }, status: "PUBLISHED" }, data: { bodyTemplate: "Hello again, {{recipient_name}}." } }); }],
    ["an attendee type", async () => { await prisma.eventAttendeeType.updateMany({ where: { eventId: sourceId, code: "ADULT" }, data: { label: "Grown-up" } }); }],
    ["a promo code", async () => { await prisma.promoCode.update({ where: { id: source.promoIds[1]! }, data: { discountValue: 1500 } }); }],
    ["an honor offering", async () => { await prisma.honorOffering.update({ where: { id: source.offeringIds[0]! }, data: { location: "Room 9" } }); }],
    ["an event setting", async () => { await prisma.event.update({ where: { id: sourceId }, data: { location: "Synthetic Lodge East" } }); }],
  ];
  let previous = freshPlan;
  for (const [label, edit] of edits) {
    await edit();
    const next = await previewEventClone(adminId, { sourceEventId: sourceId });
    assert(next.fingerprint !== previous.fingerprint, `editing ${label} changes the fingerprint`);
    const refused = await cloneEvent(adminId, confirmBody(sourceId, previous, `${P}-stale-${edits.length}`, `${P}-key-stale-${label.replace(/\W+/g, "")}`)).then(() => null, (error: unknown) => error);
    assert(isOperationError(refused, "SOURCE_CHANGED"), `a preview from before ${label} was edited is refused, got ${String(refused)}`);
    previous = next;
  }
  // Changes to what is never copied do not invalidate a preview.
  await prisma.payment.updateMany({ where: { eventId: sourceId }, data: { amount: 121 } });
  await prisma.staffNote.updateMany({ where: { eventId: sourceId }, data: { updatedAt: new Date() } });
  assert((await previewEventClone(adminId, { sourceEventId: sourceId })).fingerprint === previous.fingerprint, "history changes do not affect the fingerprint");
  console.log("ok  a stale preview is refused with SOURCE_CHANGED after any copied configuration changes; history changes do not matter");

  // 7. Excluded domains: unselected domains are not copied and nothing else appears.
  const partialPlan = previous;
  const partial = await cloneEvent(adminId, confirmBody(sourceId, partialPlan, `${P}-partial`, `${P}-key-partial`, {
    include: { ...noneIncluded, attendeeTypes: true, tags: true },
    formLatePricingDates: [], promoCodeWindows: [], honorOfferingCapacities: [],
  }));
  const partialId = partial.event.id;
  assert(await prisma.eventAttendeeType.count({ where: { eventId: partialId } }) === 2 && await prisma.eventTag.count({ where: { eventId: partialId } }) === 2, "the selected domains are copied");
  assert(await prisma.registrationForm.count({ where: { eventId: partialId } }) === 0
    && await prisma.eventContentSection.count({ where: { eventId: partialId } }) === 0
    && await prisma.eventMessageTemplate.count({ where: { eventId: partialId } }) === 0
    && await prisma.promoCode.count({ where: { eventId: partialId } }) === 0
    && await prisma.honorOffering.count({ where: { eventId: partialId } }) === 0
    && await prisma.honorSession.count({ where: { eventId: partialId } }) === 0
    && await prisma.eventAttendeeClassification.count({ where: { eventId: partialId } }) === 0
    && await prisma.eventCommunitySettings.count({ where: { eventId: partialId } }) === 0, "every excluded domain is absent");
  const partialEvent = await prisma.event.findUniqueOrThrow({ where: { id: partialId } });
  assert(partialEvent.location === null && partialEvent.hotelName === null && partialEvent.audience === "GENERAL" && partialEvent.timezone === "America/Chicago", "excluded event details fall back to defaults");
  assert(!partialEvent.waitlistEnabled && !partialEvent.autoPromoteWaitlist && !partialEvent.collectsShirtSizes && !partialEvent.checksAdultBackgrounds, "excluded module settings are off");
  const partialRecord = await prisma.eventCloneRecord.findUniqueOrThrow({ where: { resultEventId: partialId } });
  assert(JSON.stringify(partialRecord.exclusions).includes("registrationForms") && JSON.stringify(partialRecord.exclusions).includes("promoCodes"), "provenance records the exclusions");
  const emptyClone = await cloneEvent(adminId, confirmBody(sourceId, partialPlan, `${P}-empty`, `${P}-key-empty`, { include: { ...noneIncluded }, formLatePricingDates: [], promoCodeWindows: [], honorOfferingCapacities: [] }));
  assert(await prisma.eventAttendeeType.count({ where: { eventId: emptyClone.event.id } }) === 0, "a clone with nothing selected is an empty draft");
  const strayReview = await cloneEvent(adminId, confirmBody(sourceId, partialPlan, `${P}-stray`, `${P}-key-stray`, { include: { ...noneIncluded } })).then(() => null, (error: unknown) => error);
  assert(strayReview instanceof EventCloneReviewError, "review values for an excluded domain are refused");
  console.log("ok  excluded domains are absent, selected ones present, and review values must match the selection");

  // 8. Disabled modules stay disabled: a source with everything off clones with everything off.
  const quiet = await prisma.event.create({ data: { name: "Evtclone Quiet", slug: `${P}-quiet-source`, startsAt: new Date("2027-09-01T12:00:00Z"), endsAt: new Date("2027-09-02T12:00:00Z"), waitlistEnabled: false, autoPromoteWaitlist: false } });
  await prisma.eventCommunitySettings.create({ data: { eventId: quiet.id, isEnabled: false } });
  await prisma.eventMessageTemplate.create({ data: { eventId: quiet.id, key: "EVENT_ANNOUNCEMENT", isEnabled: false, versions: { create: { versionNumber: 1, status: "PUBLISHED", subjectTemplate: "Off", bodyTemplate: "Off", publishedAt: new Date() } } } });
  const quietPlan = await previewEventClone(adminId, { sourceEventId: quiet.id });
  const quietClone = await cloneEvent(adminId, confirmBody(quiet.id, quietPlan, `${P}-quiet-clone`, `${P}-key-quiet`));
  const quietRow = await prisma.event.findUniqueOrThrow({ where: { id: quietClone.event.id } });
  assert(!quietRow.waitlistEnabled && !quietRow.autoPromoteWaitlist && !quietRow.collectsShirtSizes && !quietRow.checksAdultBackgrounds, "disabled toggles stay disabled");
  const quietCommunity = await prisma.eventCommunitySettings.findUniqueOrThrow({ where: { eventId: quietClone.event.id } });
  const quietMessage = await prisma.eventMessageTemplate.findFirstOrThrow({ where: { eventId: quietClone.event.id } });
  assert(!quietCommunity.isEnabled && !quietMessage.isEnabled, "a disabled module and a disabled message stay disabled");
  assert(quietClone.event.readiness && !quietClone.event.isPublished, "a clone of a source with nothing to publish is still a draft");
  console.log("ok  disabled modules and messages are copied as disabled, never switched on");

  // 9. Parallel duplicates with one request key create exactly one event.
  const parallelPlan = await previewEventClone(adminId, { sourceEventId: sourceId });
  const parallelBody = confirmBody(sourceId, parallelPlan, `${P}-parallel`, `${P}-key-parallel`);
  const parallel = await Promise.allSettled([1, 2, 3, 4].map(() => cloneEvent(adminId, parallelBody)));
  const rejected = parallel.filter((result) => result.status === "rejected");
  assert(rejected.length === 0, `every parallel clone returns the event: ${rejected.map((result) => String((result as PromiseRejectedResult).reason)).join("; ")}`);
  const fulfilled = parallel.map((result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof cloneEvent>>>).value);
  assert(new Set(fulfilled.map((result) => result.event.id)).size === 1 && fulfilled.filter((result) => !result.alreadyCloned).length === 1, "all return one event and exactly one created it");
  const parallelId = fulfilled[0]!.event.id;
  assert(await prisma.event.count({ where: { slug: `${P}-parallel` } }) === 1 && await prisma.eventCloneRecord.count({ where: { actorUserId: adminId, requestKey: `${P}-key-parallel` } }) === 1, "one event and one clone record exist");
  assert(await prisma.registrationForm.count({ where: { eventId: parallelId } }) === 2 && await prisma.promoCode.count({ where: { eventId: parallelId } }) === 2, "the winning clone is complete, not half-copied");
  assert(await prisma.eventMembership.count({ where: { eventId: parallelId } }) === 1, "one administrator membership");
  console.log("ok  four parallel clones with one request key create exactly one complete event");

  // 10. Key reuse and slug conflicts.
  const reused = await cloneEvent(adminId, { ...parallelBody, name: "Evtclone Different Name" }).then(() => null, (error: unknown) => error);
  assert(isOperationError(reused, "REQUEST_KEY_REUSED"), `a reused key with a different body is refused, got ${String(reused)}`);
  const otherSource = await cloneEvent(adminId, { ...parallelBody, sourceEventId: quiet.id }).then(() => null, (error: unknown) => error);
  assert(isOperationError(otherSource, "REQUEST_KEY_REUSED"), "a reused key with a different source is refused");
  const otherActor = await cloneEvent(otherAdminId, { ...parallelBody, slug: `${P}-parallel-actor-2` });
  assert(!otherActor.alreadyCloned && otherActor.event.id !== parallelId, "the same key from another actor is its own request");
  const slugTaken = await cloneEvent(adminId, { ...parallelBody, requestKey: `${P}-key-slug-taken` }).then(() => null, (error: unknown) => error);
  assert(isOperationError(slugTaken, "EVENT_SLUG_TAKEN"), `a new key for a taken slug is EVENT_SLUG_TAKEN, got ${String(slugTaken)}`);
  const badDates = await cloneEvent(adminId, { ...parallelBody, requestKey: `${P}-key-bad-dates`, slug: `${P}-bad-dates`, startsOn: "2028-02-30" }).then(() => null, (error: unknown) => error);
  assert(badDates instanceof Error && badDates.name === "ZodError", "an impossible date is a validation error");
  const endBeforeStart = await cloneEvent(adminId, { ...parallelBody, requestKey: `${P}-key-backwards`, slug: `${P}-backwards`, endsOn: "2028-05-01" }).then(() => null, (error: unknown) => error);
  assert(endBeforeStart instanceof Error && endBeforeStart.name === "ZodError", "an event ending before it starts is a validation error");
  const missingSource = await cloneEvent(adminId, { ...parallelBody, requestKey: `${P}-key-missing-source`, slug: `${P}-missing-source`, sourceEventId: "evtclone-no-such-event" }).then(() => null, (error: unknown) => error);
  assert(isOperationError(missingSource, "SOURCE_NOT_FOUND"), "cloning a missing source is SOURCE_NOT_FOUND");
  assert(await prisma.event.count({ where: { slug: { in: [`${P}-bad-dates`, `${P}-backwards`, `${P}-missing-source`] } } }) === 0, "refused requests created nothing");
  console.log("ok  reused keys are refused, keys are per actor, and slug, date, and source errors create nothing");
}

async function main() {
  await cleanup();
  try {
    await run();
  } finally {
    await cleanup();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
