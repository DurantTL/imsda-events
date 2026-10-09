/**
 * Proves the annual event cloning guarantees (#157) against a real PostgreSQL
 * database. A populated source event (configuration plus synthetic
 * registrations, payments, check-ins, outbox rows, notes, staff access, and
 * more) is previewed and cloned; the clone must carry only reviewed
 * configuration and none of the transactional, private, or protected history.
 * Also covers excluded domains, disabled modules, missing and reused review
 * dates, re-entered choice and per-club limits, explicit "none" answers,
 * private links stripped from copied text, the prices-copied summary, a
 * bounded source lock wait, a stale source, parallel duplicate requests, and
 * key reuse. Uses
 * fictitious users and data it creates and removes itself.
 *
 *   npm run test:event-cloning
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";
import { getServerEnv } from "../lib/env";
import { eventCloneApiError } from "../modules/event-clones/api-errors";
import { cloneEvent, EventCloneOperationError, previewEventClone } from "../modules/event-clones/repository";
import { EventCloneReviewError, cloneDomainKeys, type CloneDomainKey, type ClonePlan } from "../modules/event-clones/domain";
import { selectEventProperty } from "../modules/lodging/service";
import { syncLodgingTemplates } from "../modules/lodging/sync";
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
  await prisma.organization.deleteMany({ where: { id: `${P}-sponsor-church` } });
  await prisma.person.deleteMany({ where: { lastName: `${P}-person` } });
  await prisma.honor.deleteMany({ where: { code: { startsWith: `${P}-` } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
}

const allIncluded = Object.fromEntries(cloneDomainKeys.map((key) => [key, true])) as Record<CloneDomainKey, boolean>;
const noneIncluded = Object.fromEntries(cloneDomainKeys.map((key) => [key, false])) as Record<CloneDomainKey, boolean>;

type Fixture = { eventId: string; lateFormId: string; capFormId: string; promoIds: string[]; offeringIds: string[]; sectionId: string; templateKey: string };

/** The app's own origin, as the clone reads it: `/manage/` links there are private. */
function appOrigin() {
  return new URL(getServerEnv().APP_BASE_URL).origin;
}

/** Synthetic private-link markers planted in the source's free text; none may reach a clone. */
const marker = "EVTCLONE-MARKER";
const none = { value: null, none: true } as const;

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
    capacity: { value: 250 },
    registrationOpensOn: { value: "2028-01-15" },
    registrationClosesOn: { value: "2028-04-20" },
    include: { ...allIncluded },
    formLatePricingDates: plan.review.latePricing.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: "2028-03-01" })),
    formChoiceLimits: plan.review.formChoiceLimits.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, choice: item.choice, limit: 9 })),
    promoCodeWindows: plan.review.promoCodes.map((promo) => ({ promoCodeId: promo.promoCodeId, startsOn: { value: "2028-02-01" }, endsOn: { value: "2028-04-30" } })),
    honorOfferingCapacities: plan.review.honorOfferings.map((offering) => ({ offeringId: offering.offeringId, capacity: 12, perClubLimit: 3 })),
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
      audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE", showOnCalendar: false,
    },
  });
  const eventId = event.id;
  const sourceSlug = event.slug;
  await prisma.user.createMany({ data: [
    { id: adminId, email: `${P}-admin@example.test`, displayName: "Clone Check Admin", globalRole: "SYSTEM_ADMIN" },
    { id: otherAdminId, email: `${P}-admin-2@example.test`, displayName: "Clone Check Admin 2", globalRole: "SYSTEM_ADMIN" },
    { id: staffId, email: `${P}-staff@example.test`, displayName: "Clone Check Staff" },
  ] });

  // Configuration.
  const asset = await prisma.eventAsset.create({ data: { eventId, displayName: "map.pdf", contentType: "application/pdf", byteSize: 10, checksum: "abc", storageKey: `${P}-storage-key` } });
  // Private-link markers (1 of 4): a registrant's manage link in a section body.
  const section = await prisma.eventContentSection.create({ data: { eventId, kind: "RICH_TEXT", title: "Welcome", body: `Hello there. Fix your registration at ${appOrigin()}/manage/${marker}-MANAGE-TOKEN today. Photos: https://imsda.org/${sourceSlug}/photos. Give: https://www.adventistgiving.org/manage/recurring`, position: 1, isPublished: true } });
  await prisma.eventContentSection.create({ data: {
    eventId, kind: "RESOURCE_LINKS", title: "Resources", position: 2, isPublished: true,
    links: { create: [
      { label: "Schedule", url: "https://example.test/schedule", position: 1 },
      { label: "Campus map", assetId: asset.id, position: 2 },
      // Private-link markers (2 of 4): a link URL into the source's staff API.
      { label: "Roster export", url: `https://events.example.test/api/events/${eventId}/exports/roster.csv?${marker}`, position: 3 },
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
  // A church-sponsored code (#545): the sponsor is a billing agreement for this event only and must never be copied.
  await prisma.organization.create({ data: { id: `${P}-sponsor-church`, type: "CHURCH", name: "Clone Check Sponsor Church", normalizedName: "clone check sponsor church" } });
  const promoA = await prisma.promoCode.create({ data: { eventId, code: "EARLY", normalizedCode: "EARLY", discountType: "FIXED_CENTS", discountValue: 500, startsOn: "2027-01-10", endsOn: "2027-02-10", redeemedCount: 7, maximumUses: 100, sponsoringOrganizationId: `${P}-sponsor-church` } });
  const promoB = await prisma.promoCode.create({ data: { eventId, code: "OPEN", normalizedCode: "OPEN", discountType: "PERCENT_BPS", discountValue: 1000, redeemedCount: 2 } });

  const honor = await prisma.honor.create({ data: { code: `${P}-honor-1`, name: "Evtclone Knots", normalizedName: `${P} knots` } });
  const honor2 = await prisma.honor.create({ data: { code: `${P}-honor-2`, name: "Evtclone Birds", normalizedName: `${P} birds` } });
  const session = await prisma.honorSession.create({ data: { eventId, name: "Friday", normalizedName: "friday" } });
  // Tied sortOrder (both 0); Friday was created first but "Afternoon" sorts first by name (#570).
  await prisma.honorSession.create({ data: { eventId, name: "Afternoon", normalizedName: "afternoon", createdAt: new Date(Date.now() + 60_000) } });
  const offeringA = await prisma.honorOffering.create({ data: { eventId, honorId: honor.id, sessionId: session.id, span: "SINGLE_SESSION", capacity: 30, perClubLimit: 4, minimumAge: 10, minimumClassLevel: "GUIDE", teacherName: "Synthetic Teacher" } });
  await prisma.honorOfferingPrerequisite.create({ data: { offeringId: offeringA.id, honorId: honor2.id } });
  const offeringB = await prisma.honorOffering.create({ data: { eventId, honorId: honor2.id, span: "ALL_SESSIONS", capacity: 20, isActive: false } });

  // Forms: one with late pricing, one with capacity limits, one never published.
  const forms = await prisma.$transaction(async (tx) => ({
    late: await createRegistrationFormFromTemplateInTransaction(tx, eventId, adminId, "womens_retreat_export"),
    cap: await createRegistrationFormFromTemplateInTransaction(tx, eventId, adminId, "camp_meeting_export"),
    draft: await createRegistrationFormFromTemplateInTransaction(tx, eventId, adminId, "simple_rsvp"),
  }));
  await publishForm(forms.late.id);
  await publishForm(forms.cap.id);
  // Private-link markers (3 of 4): a signed URL in form help and a source asset URL in choice text.
  const lateVersion = await prisma.registrationFormVersion.findFirstOrThrow({ where: { formId: forms.late.id, status: "PUBLISHED" } });
  const lateDefinition = registrationFormDefinitionSchema.parse(lateVersion.definition);
  const choiceField = lateDefinition.sections.flatMap((entry) => entry.fields).find((field) => field.options.length > 0 && !field.optionSource)!;
  lateDefinition.sections[0]!.fields[0]!.helpText = `Details: https://files.example.test/file?sig=${marker}-SIG and https://example.test/schedule`;
  choiceField.optionDescriptions = { ...(choiceField.optionDescriptions ?? {}), [choiceField.options[0]!]: `Map: /api/public/events/${sourceSlug}/assets/${marker}-ASSET` };
  await prisma.registrationFormVersion.update({ where: { id: lateVersion.id }, data: { definition: registrationFormDefinitionSchema.parse(lateDefinition) } });

  // Message templates: one published (with a newer draft), one draft-only.
  const published = await prisma.eventMessageTemplate.create({ data: { eventId, key: "EVENT_ANNOUNCEMENT", isEnabled: false, versions: { create: [
    { createdByUserId: adminId, versionNumber: 1, status: "PUBLISHED", subjectTemplate: "News from {{event_name}}", bodyTemplate: `Hello {{recipient_name}}. Your link: https://example.test/share?token=${marker}-TOKEN`, publishedAt: new Date() },
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

/** Every copied configuration row of a clone, as text, to prove no marker reached it. */
async function cloneDump(eventId: string) {
  const [event, sections, forms, templates] = await Promise.all([
    prisma.event.findUniqueOrThrow({ where: { id: eventId } }),
    prisma.eventContentSection.findMany({ where: { eventId }, include: { links: true } }),
    prisma.registrationForm.findMany({ where: { eventId }, include: { versions: true } }),
    prisma.eventMessageTemplate.findMany({ where: { eventId }, include: { versions: true } }),
  ]);
  return JSON.stringify({ event, sections, forms, templates });
}

/** The value of `fieldKey`'s choice limits in a clone's copied form. */
function choiceLimitsOf(definition: unknown, fieldKey: string) {
  return registrationFormDefinitionSchema.parse(definition).sections.flatMap((section) => section.fields).find((field) => field.key === fieldKey)?.choiceLimits;
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
  const rvLimit = plan.review.formChoiceLimits.find((item) => item.choice === "RV / camper hookup");
  assert(rvLimit && rvLimit.sourceLimit === 16 && rvLimit.formId === source.capFormId, `the plan lists the RV hookup choice limit of 16 for review, got ${JSON.stringify(plan.review.formChoiceLimits)}`);
  const offeringReview = plan.review.honorOfferings.find((offering) => offering.offeringId === source.offeringIds[0]);
  assert(offeringReview && offeringReview.sourceCapacity === 30 && offeringReview.sourcePerClubLimit === 4 && offeringReview.minimumAge === 10, "the plan shows the old class capacity and per-club limit as hints and the minimum age that carries over");
  const findings = plan.review.privateLinks;
  assert(new Set(findings.map((finding) => finding.domain)).size === 3 && ["contentSections", "registrationForms", "messageTemplates"].every((key) => findings.some((finding) => finding.domain === key)), `private links are found in sections, forms, and messages: ${JSON.stringify(findings.map((finding) => finding.location))}`);
  assert(findings.length === 5, `five private links need review (section body, link URL, form help, choice text, message body), got ${findings.length}`);
  assert(findings.some((finding) => finding.location.includes("link \"Roster export\"")) && findings.some((finding) => finding.location.includes("help")) && findings.some((finding) => finding.location.includes("choice")) && findings.some((finding) => finding.location.endsWith("body")), "each finding names where it was found");
  assert(!JSON.stringify(plan).includes(`${marker}-MANAGE-TOKEN`) && !JSON.stringify(plan).includes(`${marker}-SIG`) && !JSON.stringify(plan).includes(`${marker}-TOKEN`), "the plan masks manage paths, signatures, and tokens");
  assert(plan.pricing.pricedFormFields > 0 && plan.pricing.promoCodes === 2 && plan.pricingMessage?.startsWith("Prices copied, review before publishing"), `the plan says prices are copied and must be reviewed, got ${plan.pricingMessage}`);
  assert(plan.unsupported.every((entry) => entry.sourceCount > 0) && plan.unsupported.length === 4, "unsupported domains are listed with their source counts");
  assert(plan.neverCopied.length > 5, "the never-copied list is shown");
  assert(await prisma.auditLog.count({ where: { action: "EVENT_CLONE_PREVIEWED", entityId: sourceId, actorUserId: adminId } }) === 1, "the preview is audited");
  const previewAudit = await prisma.auditLog.findFirstOrThrow({ where: { action: "EVENT_CLONE_PREVIEWED", entityId: sourceId } });
  assert(!JSON.stringify(previewAudit.metadata).includes("Synthetic Lodge"), "the preview audit holds ids and counts only");
  const previewMissing = await previewEventClone(adminId, { sourceEventId: "evtclone-no-such-event" }).then(() => null, (error: unknown) => error);
  assert(isOperationError(previewMissing, "SOURCE_NOT_FOUND"), "previewing a missing source is SOURCE_NOT_FOUND");
  console.log("ok  preview lists every domain with counts, review items, skipped and unsupported domains, and is audited");

  // 2. Review is required: missing and carried-over dates create nothing.
  const missingDates = await cloneEvent(adminId, confirmBody(sourceId, plan, `${P}-missing`, `${P}-key-missing`, { formLatePricingDates: [], formChoiceLimits: [], promoCodeWindows: [], honorOfferingCapacities: [] })).then(() => null, (error: unknown) => error);
  assert(missingDates instanceof EventCloneReviewError && missingDates.issues.length >= 4, `missing review values are refused, got ${String(missingDates)}`);
  const missingLimit = await cloneEvent(adminId, confirmBody(sourceId, plan, `${P}-nolimit`, `${P}-key-nolimit`, { formChoiceLimits: [] })).then(() => null, (error: unknown) => error);
  assert(missingLimit instanceof EventCloneReviewError && missingLimit.issues.some((issue) => issue.includes("RV / camper hookup")), `a choice limit left unanswered is refused, got ${String(missingLimit)}`);
  for (const [label, overrides] of [
    ["a bare null capacity", { capacity: null }],
    ["a registration date with no answer", { registrationOpensOn: { value: null } }],
    ["a promo date left blank", { promoCodeWindows: plan.review.promoCodes.map((promo) => ({ promoCodeId: promo.promoCodeId, startsOn: null, endsOn: none })) }],
    ["an offering without a per-club answer", { honorOfferingCapacities: plan.review.honorOfferings.map((offering) => ({ offeringId: offering.offeringId, capacity: 12 })) }],
  ] as const) {
    const refused = await cloneEvent(adminId, confirmBody(sourceId, plan, `${P}-unanswered`, `${P}-key-unanswered`, overrides)).then(() => null, (error: unknown) => error);
    assert(refused instanceof Error && refused.name === "ZodError", `${label} is "not answered" and refused, got ${String(refused)}`);
  }
  const carriedOver = await cloneEvent(adminId, confirmBody(sourceId, plan, `${P}-carried`, `${P}-key-carried`, {
    formLatePricingDates: plan.review.latePricing.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, startsOn: item.sourceStartsOn })),
  })).then(() => null, (error: unknown) => error);
  assert(carriedOver instanceof EventCloneReviewError && carriedOver.issues.some((issue) => issue.includes("source event's date")), `a source date carried over is refused, got ${String(carriedOver)}`);
  const missingKeys = await cloneEvent(adminId, { ...confirmBody(sourceId, plan, `${P}-nokeys`, `${P}-key-nokeys`), capacity: undefined }).then(() => null, (error: unknown) => error);
  assert(missingKeys instanceof Error && missingKeys.name === "ZodError", "a body without an explicit capacity is a validation error");
  assert(await prisma.event.count({ where: { slug: { in: [`${P}-missing`, `${P}-carried`, `${P}-nokeys`, `${P}-nolimit`, `${P}-unanswered`] } } }) === 0 && await prisma.eventCloneRecord.count({ where: { actorUserId: adminId } }) === 0, "nothing was created by a refused review");
  console.log("ok  missing or carried-over dates, unanswered limits and capacities, and blank-for-none answers are refused and create nothing");

  // 3. The full clone: configuration copied, history never.
  const before = await sourceDump(sourceId);
  // The source uses a lodging property (with its default holds); a clone must not carry any of it (#198).
  await syncLodgingTemplates(prisma);
  await selectEventProperty(sourceId, adminId, { propertyKey: "camp-heritage" }, prisma);
  assert(await prisma.eventLodgingHold.count({ where: { eventId: sourceId } }) === 3, "the source has lodging holds");
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
  assert(cloneRow.showOnCalendar === false, "showOnCalendar is copied with the event details (the source hides it; the default is shown)");
  assert(cloneRow.audience === "CLUB" && cloneRow.billingMode === "DEFERRED_ORGANIZATION_INVOICE", "audience and billing mode are copied");
  assert(cloneRow.waitlistEnabled && cloneRow.autoPromoteWaitlist && cloneRow.collectsShirtSizes && cloneRow.checksAdultBackgrounds, "module toggles are copied");
  const community = await prisma.eventCommunitySettings.findUniqueOrThrow({ where: { eventId: cloneId } });
  assert(community.isEnabled && !community.allowReplies && community.retentionDays === 45 && community.updatedByUserId === adminId, "community settings are copied");

  const cloneLodging = await Promise.all([
    prisma.eventLodging.count({ where: { eventId: cloneId } }),
    prisma.eventLodgingUnit.count({ where: { eventId: cloneId } }),
    prisma.eventLodgingHold.count({ where: { eventId: cloneId } }),
    prisma.eventLodgingHoldHistory.count({ where: { eventId: cloneId } }),
    prisma.eventLodgingRate.count({ where: { eventId: cloneId } }),
  ]);
  assert(cloneLodging.every((count) => count === 0), `a clone carries no lodging property, unit state, hold, history, or rate: ${cloneLodging.join()}`);
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
  const rvField = capDefinition.sections.flatMap((section) => section.fields).find((field) => field.choiceLimits?.["RV / camper hookup"] !== undefined);
  assert(rvField && rvField.choiceLimits!["RV / camper hookup"] === 9, `the RV hookup limit is the reviewed 9, not the source's 16 or unlimited, got ${JSON.stringify(rvField?.choiceLimits)}`);
  assert(capDefinition.sections.flatMap((section) => section.fields).every((field) => Object.values(field.choiceLimits ?? {}).every((limit) => limit === 9)), "every copied choice limit is a reviewed value");
  assert(await prisma.auditLog.count({ where: { eventId: cloneId, action: "REGISTRATION_FORM_CREATED" } }) === 2, "each copied form creation is audited");

  const messages = await prisma.eventMessageTemplate.findMany({ where: { eventId: cloneId }, include: { versions: true } });
  assert(messages.length === 1 && messages[0]!.key === "EVENT_ANNOUNCEMENT" && !messages[0]!.isEnabled && messages[0]!.versions.length === 1 && messages[0]!.versions[0]!.subjectTemplate === "News from {{event_name}}" && messages[0]!.versions[0]!.versionNumber === 1, "only the published message text is copied, keeping its disabled state");

  const promos = await prisma.promoCode.findMany({ where: { eventId: cloneId }, orderBy: { normalizedCode: "asc" } });
  assert(promos.length === 2 && promos.every((promo) => !promo.isActive && promo.redeemedCount === 0 && promo.startsOn === "2028-02-01" && promo.endsOn === "2028-04-30"), "promo codes are copied inactive, unused, with the reviewed window");
  assert(promos.every((promo) => promo.sponsoringOrganizationId === null), "a church sponsor is never copied to the clone");
  assert(await prisma.promoCode.count({ where: { eventId: sourceId, sponsoringOrganizationId: `${P}-sponsor-church` } }) === 1, "the source keeps its church sponsor");
  assert(promos[0]!.maximumUses === 100 && await prisma.promoCodeRedemption.count({ where: { eventId: cloneId } }) === 0, "promo rules carry over but redemptions do not");
  const offerings = await prisma.honorOffering.findMany({ where: { eventId: cloneId }, include: { session: true } });
  assert(offerings.length === 2 && offerings.every((offering) => offering.capacity === 12) && offerings.some((offering) => offering.session?.name === "Friday") && offerings.some((offering) => offering.sessionId === null), "honor offerings are copied with the reviewed capacity and their own sessions");
  assert(offerings.every((offering) => offering.perClubLimit === 3), "per-club limits are the reviewed values, not the source's");
  assert(offerings.some((offering) => offering.minimumAge === 10), "minimum age carries over");
  const sourcePrerequisite = await prisma.honorOfferingPrerequisite.findFirst({ where: { offeringId: source.offeringIds[0] } });
  const clonedLevelClass = offerings.find((offering) => offering.minimumClassLevel === "GUIDE");
  assert(clonedLevelClass && (await prisma.honorOfferingPrerequisite.findMany({ where: { offeringId: clonedLevelClass.id } })).map((row) => row.honorId).join() === sourcePrerequisite?.honorId, "the minimum class level and prerequisite honors carry over (#832)");
  assert((await prisma.honorOfferingPrerequisite.count({ where: { offering: { eventId: cloneId } } })) === 1, "only the class that had prerequisites has them in the clone");

  const dump = await cloneDump(cloneId);
  assert(!dump.includes(marker) && !dump.includes(`/api/events/${sourceId}/`) && !dump.includes(`/api/public/events/${P}-source-2027/assets/`) && !dump.includes(`${appOrigin()}/manage/`), "no private-link marker reached the clone's event, sections, links, forms, or messages");
  assert(dump.includes(`https://imsda.org/${P}-source-2027/photos`) && dump.includes("https://www.adventistgiving.org/manage/recurring"), "outside links that only look like the source's (its slug on another host, another site's /manage/) are kept");
  assert(dump.includes("https://example.test/schedule"), "safe links are kept");
  assert(cloned.summary?.skipped.privateLinks === 5, `the result counts the five removed private links, got ${JSON.stringify(cloned.summary?.skipped)}`);
  assert(cloned.summary?.pricingMessage?.startsWith("Prices copied, review before publishing") && cloned.summary.pricing.promoCodes === 2, "the result says prices were copied and must be reviewed");
  assert(promos.every((promo) => promo.discountValue > 0) && promos.some((promo) => promo.maximumUses === 100), "prices and promo rules are copied as they are (reviewed on the inactive code)");
  const cloneSessionIds = (await prisma.honorSession.findMany({ where: { eventId: cloneId } })).map((entry) => entry.id);
  const cloneSessions = await prisma.honorSession.findMany({ where: { eventId: cloneId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { name: "asc" }] });
  assert(cloneSessions.map((entry) => `${entry.name}:${entry.sortOrder}`).join(",") === "Friday:0,Afternoon:1", `a tied source keeps its display order in the clone, got ${cloneSessions.map((entry) => `${entry.name}:${entry.sortOrder}`).join(",")}`);
  assert(cloneSessionIds.length === 2 && offerings.filter((offering) => offering.sessionId).every((offering) => cloneSessionIds.includes(offering.sessionId!)), "offerings point at the clone's own session");

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
  assert(retry.summary?.skipped.privateLinks === 5 && retry.summary.pricingMessage === cloned.summary?.pricingMessage, "a retry shows the same result summary");
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
    formLatePricingDates: [], formChoiceLimits: [], promoCodeWindows: [], honorOfferingCapacities: [],
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
  const emptyClone = await cloneEvent(adminId, confirmBody(sourceId, partialPlan, `${P}-empty`, `${P}-key-empty`, { include: { ...noneIncluded }, formLatePricingDates: [], formChoiceLimits: [], promoCodeWindows: [], honorOfferingCapacities: [] }));
  assert(await prisma.eventAttendeeType.count({ where: { eventId: emptyClone.event.id } }) === 0, "a clone with nothing selected is an empty draft");
  const strayReview = await cloneEvent(adminId, confirmBody(sourceId, partialPlan, `${P}-stray`, `${P}-key-stray`, { include: { ...noneIncluded } })).then(() => null, (error: unknown) => error);
  assert(strayReview instanceof EventCloneReviewError, "review values for an excluded domain are refused");
  // Explicit "no limit" for a choice keeps the field in capacity mode with no limit for that choice.
  const unlimited = await cloneEvent(adminId, confirmBody(sourceId, partialPlan, `${P}-unlimited`, `${P}-key-unlimited`, {
    include: { ...noneIncluded, registrationForms: true },
    formChoiceLimits: partialPlan.review.formChoiceLimits.map((item) => ({ formId: item.formId, fieldKey: item.fieldKey, choice: item.choice, limit: null })),
    promoCodeWindows: [], honorOfferingCapacities: [],
  }));
  const unlimitedForms = await prisma.registrationForm.findMany({ where: { eventId: unlimited.event.id }, include: { versions: true } });
  const unlimitedCap = unlimitedForms.map((form) => choiceLimitsOf(form.versions[0]!.definition, rvField!.key)).find((limits) => limits !== undefined);
  assert(unlimitedCap !== undefined && Object.keys(unlimitedCap).length === 0, `an explicit no-limit answer removes the limit, got ${JSON.stringify(unlimitedCap)}`);
  console.log("ok  excluded domains are absent, selected ones present, review values must match the selection, and an explicit no-limit is honoured");

  // 8. Disabled modules stay disabled: a source with everything off clones with everything off.
  const quiet = await prisma.event.create({ data: { name: "Evtclone Quiet", slug: `${P}-quiet-source`, startsAt: new Date("2027-09-01T12:00:00Z"), endsAt: new Date("2027-09-02T12:00:00Z"), waitlistEnabled: false, autoPromoteWaitlist: false } });
  await prisma.eventCommunitySettings.create({ data: { eventId: quiet.id, isEnabled: false } });
  await prisma.eventMessageTemplate.create({ data: { eventId: quiet.id, key: "EVENT_ANNOUNCEMENT", isEnabled: false, versions: { create: { versionNumber: 1, status: "PUBLISHED", subjectTemplate: "Off", bodyTemplate: "Off", publishedAt: new Date() } } } });
  const quietPlan = await previewEventClone(adminId, { sourceEventId: quiet.id });
  const quietClone = await cloneEvent(adminId, confirmBody(quiet.id, quietPlan, `${P}-quiet-clone`, `${P}-key-quiet`, { capacity: none, registrationOpensOn: none, registrationClosesOn: none }));
  const quietRow = await prisma.event.findUniqueOrThrow({ where: { id: quietClone.event.id } });
  assert(quietRow.capacity === null && quietRow.registrationOpensOn === null && quietRow.registrationClosesOn === null, "explicit none answers store no capacity and no registration dates");
  assert(quietClone.summary?.pricingMessage === null && quietRow.showOnCalendar, "a source with nothing priced has no prices-copied message; showOnCalendar carries its default");
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

  // 11. Only the source lock wait is bounded: a clone queued on the slug unique
  // index behind an uncommitted same-slug insert held past 5s still resolves,
  // to EVENT_SLUG_TAKEN when that insert commits and to a new event when it
  // rolls back, never a 500.
  const racePlan = await previewEventClone(adminId, { sourceEventId: sourceId });
  const holdSlug = async (slug: string, outcome: "commit" | "rollback") => {
    const holderClient = new PrismaClient();
    try {
      let inserted!: () => void;
      const insertedPromise = new Promise<void>((resolve) => { inserted = resolve; });
      const holder = holderClient.$transaction(async (tx) => {
        await tx.event.create({ data: { name: "Evtclone Slug Holder", slug, startsAt: new Date("2028-01-01T12:00:00Z"), endsAt: new Date("2028-01-02T12:00:00Z") } });
        inserted();
        await new Promise((resolve) => setTimeout(resolve, 7_000));
        if (outcome === "rollback") throw new Error("synthetic rollback");
      }, { timeout: 30_000 }).catch((error: unknown) => (outcome === "rollback" ? null : Promise.reject(error)));
      await insertedPromise;
      const started = Date.now();
      const result = await cloneEvent(adminId, confirmBody(sourceId, racePlan, slug, `${P}-key-race-${outcome}`)).then((value) => ({ value }), (error: unknown) => ({ error }));
      const waited = Date.now() - started;
      await holder;
      return { result, waited };
    } finally {
      await holderClient.$disconnect();
    }
  };
  const committed = await holdSlug(`${P}-race-commit`, "commit");
  assert("error" in committed.result && isOperationError(committed.result.error, "EVENT_SLUG_TAKEN"), `a clone behind a committed same-slug insert is EVENT_SLUG_TAKEN, got ${JSON.stringify("error" in committed.result ? String(committed.result.error) : "created")}`);
  const committedResponse = eventCloneApiError(committed.result.error, { failureMessage: "x", logMessage: "x", invalidInputCode: "INVALID_EVENT_CLONE", uniqueViolationIsSlug: true });
  assert(committedResponse.status === 409 && committed.waited >= 6_000, `it waited past 5s (${committed.waited}ms) and is a 409, not a 500 (got ${committedResponse.status})`);
  const rolledBack = await holdSlug(`${P}-race-rollback`, "rollback");
  assert("value" in rolledBack.result && !rolledBack.result.value.alreadyCloned && rolledBack.waited >= 6_000, `a clone behind a rolled-back same-slug insert creates the event after waiting ${rolledBack.waited}ms`);
  const replay = await cloneEvent(adminId, confirmBody(sourceId, racePlan, `${P}-race-rollback`, `${P}-key-race-rollback`));
  assert(replay.alreadyCloned && replay.event.id === rolledBack.result.value.event.id, "its retry is the idempotent 200");
  console.log(`ok  a clone queued behind an uncommitted same-slug insert for ${Math.round(committed.waited / 100) / 10}s resolves to EVENT_SLUG_TAKEN on commit and creates the event on rollback`);

  // 12. A source row lock held elsewhere is waited on for at most lock_timeout (5s), then SOURCE_BUSY.
  const busyPlan = await previewEventClone(adminId, { sourceEventId: sourceId });
  const locker = new PrismaClient();
  try {
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = locker.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Event" WHERE "id" = ${sourceId} FOR UPDATE`;
      locked();
      await released;
    }, { timeout: 30_000 });
    await lockTaken;
    const started = Date.now();
    const busy = await cloneEvent(adminId, confirmBody(sourceId, busyPlan, `${P}-busy`, `${P}-key-busy`)).then(() => null, (error: unknown) => error);
    const waited = Date.now() - started;
    release();
    await holder;
    assert(isOperationError(busy, "SOURCE_BUSY"), `a held source lock is SOURCE_BUSY, got ${String(busy)}`);
    assert(waited >= 4_000 && waited < 15_000, `the wait is bounded by lock_timeout, waited ${waited}ms`);
    const response = eventCloneApiError(busy, { failureMessage: "x", logMessage: "x", invalidInputCode: "INVALID_EVENT_CLONE" });
    assert(response.status === 409 && (await response.json()).error === "SOURCE_BUSY", "SOURCE_BUSY is a retryable 409");
    assert(await prisma.event.count({ where: { slug: `${P}-busy` } }) === 0 && await prisma.eventCloneRecord.count({ where: { requestKey: `${P}-key-busy` } }) === 0, "a busy clone created nothing");
    const afterBusy = await cloneEvent(adminId, confirmBody(sourceId, busyPlan, `${P}-busy`, `${P}-key-busy`));
    assert(!afterBusy.alreadyCloned, "the same request succeeds once the lock is released");
    console.log(`ok  a held source lock times out after ${Math.round(waited / 100) / 10}s as a retryable 409 SOURCE_BUSY and creates nothing`);
  } finally {
    await locker.$disconnect();
  }
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
