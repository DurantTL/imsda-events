/**
 * Proves the event deletion contract (#620, tightened in #704) against a real
 * PostgreSQL database.
 *
 * Refusal: a rich synthetic event is built with every kind of record an event
 * can accumulate (registrations and attendees, payments, refunds and sandbox
 * attempts, invoices, club drafts, honors enrollments, form submissions,
 * messages, merchandise orders, community posts, announcements, imports and
 * more). Deleting it must be refused, with the blockers named, for every actor,
 * and the refusal must change no row anywhere in the database (a full
 * table-count diff, AuditLog included).
 *
 * Deletion: an event with only setup data (locations, forms and a test
 * submission, attendee types, tags, promo codes, honors sessions and offerings,
 * message templates, content sections and assets, merchandise catalog and
 * products without orders, award items, staff memberships, settings) is
 * deleted by a system administrator. A table-count diff proves nothing the
 * event owned is left behind and nothing shared went with it, with exactly the
 * expected audit growth. It also covers permissions, the typed-name check, the
 * audit row, an all-or-nothing rollback, and a large setup-only event.
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:event-deletion
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());
process.env.SECRET_ENCRYPTION_KEY ||= "verify-event-deletion-synthetic-key-not-a-secret";

// The script inserts and removes rows in bulk and toggles a trigger, so it only ever runs against a local or CI database.
const databaseHost = (() => {
  try { return new URL(process.env.DATABASE_URL ?? "").hostname; } catch { return ""; }
})();
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(databaseHost)) {
  console.error(`Refusing to run: DATABASE_URL points at "${databaseHost || "nothing"}", not a local or CI database.`);
  process.exit(1);
}

const prisma = new PrismaClient();
const P = "evdel";
const id = (name: string) => `${P}_${name}`;
const adminId = id("sysadmin");
const eventAdminId = id("eventadmin");
const staffId = id("staff");
const eventId = id("event");
const otherEventId = id("other_event");
const draftEventId = id("draft_event");
const publishedBareEventId = id("published_event");
const BULK_REGISTRATIONS = 20;
const BULK_SETUP_ROWS = 1500;
const setupEventId = id("setup_event");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function caught(promise: Promise<unknown>) {
  return promise.then(() => null, (error: unknown) => error);
}

async function expectCode(promise: Promise<unknown>, code: string, message: string) {
  const error = await caught(promise);
  assert(
    error && typeof error === "object" && "code" in error && (error as { code: string }).code === code,
    `${message}: expected ${code}, got ${String(error)}`,
  );
}

/** Row counts of every table, for the before/after diff. */
async function tableCounts() {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
    ORDER BY table_name`;
  const counts = new Map<string, number>();
  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table_name}"`);
    counts.set(table_name, Number(rows[0].n));
  }
  return counts;
}

async function cleanup() {
  const events = { id: { startsWith: `${P}_` } };
  const eventIds = (await prisma.event.findMany({ where: events, select: { id: true } })).map((row) => row.id);
  const inEvents = { eventId: { in: eventIds } };
  await prisma.$transaction([
    prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS \"evdel_fail_tag_delete\" ON \"EventTag\""),
    prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS evdel_fail_tag_delete()"),
    prisma.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`,
    prisma.registrationOperation.deleteMany({ where: inEvents }),
    prisma.registrationPaymentChoiceOperation.deleteMany({ where: inEvents }),
  ]);
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: [adminId, eventAdminId, staffId] } }, { entityId: { startsWith: `${P}_` } }] } });
  await prisma.messageProviderEvent.deleteMany({ where: { providerEventId: { startsWith: `${P}_` } } });
  await prisma.squareWebhookEvent.deleteMany({ where: { providerEventId: { startsWith: `${P}_` } } });
  await prisma.messageOutbox.deleteMany({ where: { OR: [inEvents, { idempotencyKey: { startsWith: `${P}_` } }] } });
  await prisma.honorEnrollment.deleteMany({ where: inEvents });
  await prisma.honorOffering.deleteMany({ where: inEvents });
  await prisma.honorSession.deleteMany({ where: inEvents });
  await prisma.eventContentLink.deleteMany({ where: { section: inEvents } });
  await prisma.event.updateMany({ where: events, data: { badgeBackgroundAssetId: null } });
  await prisma.merchandiseProduct.deleteMany({ where: inEvents });
  await prisma.memberTransfer.deleteMany({ where: { fromOrganizationId: { startsWith: `${P}_` } } });
  await prisma.registration.deleteMany({ where: inEvents });
  await prisma.eventLocation.deleteMany({ where: inEvents });
  await prisma.event.deleteMany({ where: events });
  await prisma.clubSupplyItem.deleteMany({ where: { name: { startsWith: "Evdel" } } });
  await prisma.clubYearEndReport.deleteMany({ where: { organizationId: { startsWith: `${P}_` } } });
  await prisma.memberHonorEntry.deleteMany({ where: { honorId: { startsWith: `${P}_` } } });
  await prisma.clubRosterMember.deleteMany({ where: { organizationId: { startsWith: `${P}_` } } });
  await prisma.honor.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.attendeeAccount.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.organization.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.user.deleteMany({ where: { id: { in: [adminId, eventAdminId, staffId] } } });
}

const eventBase = {
  startsAt: new Date("2028-10-13T15:00:00Z"),
  endsAt: new Date("2028-10-15T18:00:00Z"),
  timezone: "America/Chicago",
};

async function main() {
  const { deleteEvent, getEventDeletionPreview, EventDeletionError } = await import("../modules/events/deletion-repository");

  await cleanup();

  // ---- Shared rows: everything here must survive the deletion. ----
  await prisma.user.createMany({
    data: [
      { id: adminId, email: `${P}-admin@example.test`, displayName: "Deletion Check Admin", globalRole: "SYSTEM_ADMIN" },
      { id: eventAdminId, email: `${P}-eventadmin@example.test`, displayName: "Deletion Check Event Admin" },
      { id: staffId, email: `${P}-staff@example.test`, displayName: "Deletion Check Staff" },
    ],
  });
  const club = await prisma.organization.create({ data: { id: id("club"), type: "CLUB", name: "Evdel Club", normalizedName: "evdel club" } });
  const church = await prisma.organization.create({ data: { id: id("church"), type: "CHURCH", name: "Evdel Church", normalizedName: "evdel church" } });
  const holder = await prisma.person.create({ data: { id: id("holder"), firstName: "Evdelholder", lastName: "Synthetic" } });
  const attendeePeople: Array<Awaited<ReturnType<typeof prisma.person.create>>> = [];
  for (let n = 1; n <= 3; n += 1) {
    attendeePeople.push(await prisma.person.create({ data: { id: id(`person${n}`), firstName: `Evdelperson${n}`, lastName: "Synthetic" } }));
  }
  const account = await prisma.attendeeAccount.create({ data: { id: id("account"), email: `${P}-account@example.test`, displayName: "Evdel Account" } });
  const rosterMember = await prisma.clubRosterMember.create({
    data: { organizationId: club.id, clubYear: "2028-29", personId: attendeePeople[0].id, attendeeType: "YOUTH", source: "DIRECTOR" },
  });
  const honor = await prisma.honor.create({ data: { id: id("honor"), code: id("H1"), name: "Evdel Honor", normalizedName: "evdel honor" } });
  const memberHonorEntry = await prisma.memberHonorEntry.create({
    data: { personId: attendeePeople[0].id, honorId: honor.id, status: "COMPLETED", organizationId: club.id },
  });
  await prisma.clubYearEndReport.create({ data: { organizationId: club.id, reportYear: "2028-29" } });
  const transfer = await prisma.memberTransfer.create({
    data: {
      clubYear: "2028-29", fromOrganizationId: club.id, toOrganizationId: church.id,
      requestedFirstName: "Evdelperson1", requestedLastName: "Synthetic", reason: "synthetic", acknowledgeDueAt: new Date("2028-11-01T00:00:00Z"),
    },
  });
  // An account email with no event belongs to no event, so it stays.
  await prisma.messageOutbox.create({
    data: {
      templateKey: "ACCOUNT_ACTIVATION", recipientKind: "ACCOUNT", recipientEmail: `${P}-account@example.test`, senderNameSnapshot: "Evdel",
      subjectSnapshot: "Activate", bodyTextSnapshot: "Synthetic body.", idempotencyKey: id("account_msg"), correlationId: id("corr_account"),
    },
  });
  // Another event, untouched by the deletion.
  await prisma.event.create({ data: { id: otherEventId, slug: `${P}-other`, name: "Evdel Other Event", ...eventBase } });
  const otherReg = await prisma.registration.create({
    data: { eventId: otherEventId, accountHolderPersonId: holder.id, confirmationCode: "EVDELO1", totalAmount: 10, status: "CONFIRMED" },
  });
  await prisma.payment.create({ data: { eventId: otherEventId, registrationId: otherReg.id, amount: 10, status: "SUCCEEDED", method: "CASH" } });
  const otherAudit = await prisma.auditLog.create({
    data: { eventId: otherEventId, actorUserId: adminId, action: "EVENT_CHECK", entityType: "Event", entityId: otherEventId, correlationId: id("corr_other"), summary: "Synthetic." },
  });

  // ---- A bare draft, and a bare published event, for the Event Admin rules. ----
  await prisma.event.create({ data: { id: draftEventId, slug: `${P}-draft`, name: "Evdel Draft", ...eventBase } });
  await prisma.event.create({ data: { id: publishedBareEventId, slug: `${P}-published`, name: "Evdel Published", ...eventBase, isPublished: true } });
  await prisma.eventMembership.createMany({
    data: [
      { eventId: draftEventId, userId: eventAdminId, role: "EVENT_ADMIN" },
      { eventId: draftEventId, userId: staffId, role: "REGISTRATION_MANAGER" },
      { eventId: publishedBareEventId, userId: eventAdminId, role: "EVENT_ADMIN" },
    ],
  });


  // ---- The event under test. ----
  await prisma.event.create({
    data: {
      id: eventId, slug: `${P}-event`, name: "Evdel Rich Event 2028", ...eventBase, isPublished: true,
      billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  await prisma.eventMembership.createMany({
    data: [
      { eventId, userId: eventAdminId, role: "EVENT_ADMIN" },
      { eventId, userId: staffId, role: "REGISTRATION_MANAGER" },
    ],
  });
  await prisma.eventMessageSettings.create({ data: { eventId, senderName: "Evdel" } });
  await prisma.eventPaymentInstructionVersion.create({ data: { eventId, versionNumber: 1 } });
  const location = await prisma.eventLocation.create({ data: { eventId, name: "Evdel North", normalizedName: "evdel north" } });
  const location2 = await prisma.eventLocation.create({ data: { eventId, name: "Evdel South", normalizedName: "evdel south" } });
  const type = await prisma.eventAttendeeType.create({ data: { eventId, code: "youth", label: "Youth" } });
  const classification = await prisma.eventAttendeeClassification.create({ data: { eventId, kind: "CATEGORY", code: "cat", label: "Category" } });
  const tag = await prisma.eventTag.create({ data: { eventId, name: "Evdel Tag", normalizedName: "evdel tag", color: "#336699" } });

  // Forms
  const form = await prisma.registrationForm.create({ data: { eventId, createdByUserId: adminId, name: "Evdel Form", slug: "evdel-form" } });
  const formVersion = await prisma.registrationFormVersion.create({ data: { formId: form.id, createdByUserId: adminId, versionNumber: 1, definition: {} } });
  await prisma.formTestSubmission.create({
    data: { eventId, formVersionId: formVersion.id, submittedByUserId: adminId, responses: {}, validation: {}, isValid: true },
  });

  // Files and content
  const asset = await prisma.eventAsset.create({
    data: { eventId, displayName: "flyer.pdf", contentType: "application/pdf", byteSize: 10, checksum: "abc", storageKey: id("asset_key") },
  });
  const section = await prisma.eventContentSection.create({ data: { eventId, title: "Evdel Section", position: 0 } });
  await prisma.eventContentLink.create({ data: { sectionId: section.id, label: "Flyer", position: 0, assetId: asset.id } });
  await prisma.event.update({ where: { id: eventId }, data: { badgeBackgroundAssetId: asset.id } });
  await prisma.announcement.create({
    data: { eventId, createdByUserId: adminId, title: "Evdel news", body: "Synthetic.", audience: {}, placement: "BANNER" },
  });

  // Promo
  const promo = await prisma.promoCode.create({
    data: { eventId, code: "EVDEL", normalizedCode: "EVDEL", discountType: "FIXED_CENTS", discountValue: 500 },
  });

  // Honors
  const honorSession = await prisma.honorSession.create({ data: { eventId, name: "Evdel Session", normalizedName: "evdel session", locationId: location.id } });
  const offering = await prisma.honorOffering.create({
    data: { eventId, honorId: honor.id, span: "SINGLE_SESSION", capacity: 10, sessionId: honorSession.id },
  });
  await prisma.honorOffering.create({ data: { eventId, honorId: honor.id, span: "ALL_SESSIONS", capacity: 10, locationId: location2.id } });

  // Message templates and messages
  const template = await prisma.eventMessageTemplate.create({ data: { eventId, key: "PAYMENT_RECEIPT" } });
  const templateVersion = await prisma.messageTemplateVersion.create({
    data: { templateId: template.id, versionNumber: 1, subjectTemplate: "Receipt", bodyTemplate: "Thanks." },
  });

  // Registrations: one rich (club, billed to the church), one waitlisted.
  const registration = await prisma.registration.create({
    data: {
      eventId, accountHolderPersonId: holder.id, confirmationCode: "EVDEL01", totalAmount: 100, status: "CONFIRMED",
      locationId: location.id, submittedAt: new Date(), contactSnapshot: { email: `${P}-holder@example.test` },
    },
  });
  const waitlisted = await prisma.registration.create({
    data: { eventId, accountHolderPersonId: holder.id, confirmationCode: "EVDEL02", totalAmount: 20, status: "WAITLISTED", locationId: location2.id },
  });
  await prisma.registrationWaitlistEntry.create({ data: { eventId, registrationId: waitlisted.id, position: 1, attendeeCount: 1 } });
  await prisma.locationWaitlistChange.create({
    data: { eventId, locationId: location2.id, registrationId: waitlisted.id, kind: "JOINED", clubName: "Evdel Club", locationName: "Evdel South", attendeeCount: 1 },
  });
  const attendees: Array<Awaited<ReturnType<typeof prisma.registrationAttendee.create>>> = [];
  for (const [index, person] of attendeePeople.entries()) {
    attendees.push(await prisma.registrationAttendee.create({
      data: {
        eventId, registrationId: registration.id, personId: person.id, attendeeType: "youth", profileSnapshot: {},
        attendeeTypeDefinitionId: type.id,
      },
    }));
    void index;
  }
  await prisma.registrationAttendeeClassification.create({ data: { attendeeId: attendees[0].id, classificationId: classification.id } });
  await prisma.checkIn.create({ data: { eventId, registrationAttendeeId: attendees[0].id, idempotencyKey: id("checkin") } });
  await prisma.registrationAccessToken.create({ data: { registrationId: registration.id, tokenHash: id("token_hash"), expiresAt: new Date("2029-01-01T00:00:00Z") } });

  // Club registration, assignment, draft
  const clubRegistration = await prisma.clubEventRegistration.create({ data: { eventId, organizationId: club.id, registrationId: registration.id } });
  await prisma.clubEventAssignment.create({ data: { eventId, organizationId: club.id, clubEventRegistrationId: clubRegistration.id } });
  await prisma.clubRegistrationDraft.create({ data: { eventId, organizationId: church.id } });
  // The shared roster member remembers which registration created it; that pointer is cleared, the member stays.
  await prisma.clubRosterMember.update({ where: { id: rosterMember.id }, data: { sourceRegistrationId: registration.id } });
  await prisma.memberTransferRegistrationMove.create({
    data: { transferId: transfer.id, eventId, registrationAttendeeId: attendees[0].id, fromRegistrationId: registration.id, toRegistrationId: waitlisted.id },
  });

  // Honor enrollment linked to the shared honor history
  const enrollment = await prisma.honorEnrollment.create({
    data: { eventId, offeringId: offering.id, registrationId: registration.id, registrationAttendeeId: attendees[0].id, organizationId: club.id, consumesSeat: true },
  });
  await prisma.honorWeekendCompletionLink.create({ data: { enrollmentId: enrollment.id, memberHonorEntryId: memberHonorEntry.id } });

  // Forms: submission and capacity reservation (RESTRICT the form version)
  await prisma.publicRegistrationSubmission.create({
    data: { eventId, formVersionId: formVersion.id, registrationId: registration.id, idempotencyKey: id("idem"), requestHash: "hash", responses: {}, pricingSnapshot: {} },
  });
  await prisma.registrationCapacityReservation.create({
    data: { eventId, formId: form.id, formVersionId: formVersion.id, registrationId: registration.id, fieldId: "f1", fieldKey: "field", optionValue: "a", registrationAttendeeId: attendees[0].id },
  });
  await prisma.programAssignmentRun.create({
    data: {
      eventId, formId: form.id, formVersionId: formVersion.id, fieldId: "f1", fieldKeySnapshot: "field", fieldLabelSnapshot: "Field", formNameSnapshot: "Evdel Form",
      formVersionNumber: 1, optionsSnapshot: [], limitsSnapshot: {}, summarySnapshot: {}, sourceFingerprint: "fp", sourceParticipantCount: 1,
      clientRequestId: id("run"), appliedByNameSnapshot: "Evdel",
      assignments: {
        create: [{
          attendeeIdSnapshot: attendees[0].id, registrationIdSnapshot: registration.id, confirmationCodeSnapshot: "EVDEL01", attendeePositionSnapshot: 1, stableOrder: 1,
          firstNameSnapshot: "Evdelperson1", lastNameSnapshot: "Synthetic", attendeeTypeSnapshot: "youth", preferencesSnapshot: {}, outcome: "ASSIGNED",
        }],
      },
    },
  });

  // Payments: a real cash payment, a sandbox card payment with attempt and webhook, a refund, a promo, an adjustment
  const cash = await prisma.payment.create({ data: { eventId, registrationId: registration.id, amount: 60, status: "SUCCEEDED", method: "CASH" } });
  const card = await prisma.payment.create({ data: { eventId, registrationId: registration.id, amount: 40, status: "SUCCEEDED", method: "CARD_REFERENCE" } });
  const attempt = await prisma.paymentAttempt.create({
    data: {
      eventId, registrationId: registration.id, paymentId: card.id, environment: "sandbox", clientIdempotencyKey: id("client_key"),
      providerIdempotencyKey: id("provider_key"), amountCents: 4000,
    },
  });
  await prisma.squareWebhookEvent.create({
    data: { eventId, paymentAttemptId: attempt.id, providerEventId: id("sq_evt"), eventType: "payment.updated", payloadHash: "h", status: "PROCESSED", occurredAt: new Date(), processedAt: new Date() },
  });
  await prisma.squareWebhookEvent.create({
    data: { eventId, providerEventId: id("sq_evt_2"), eventType: "payment.updated", payloadHash: "h2", status: "IGNORED", occurredAt: new Date(), processedAt: new Date() },
  });
  await prisma.refund.create({ data: { eventId, paymentId: cash.id, amount: 5, status: "SUCCEEDED" } });
  await prisma.promoCodeRedemption.create({
    data: {
      eventId, promoCodeId: promo.id, registrationId: registration.id, codeSnapshot: "EVDEL", discountTypeSnapshot: "FIXED_CENTS",
      discountValueSnapshot: 500, eligibleSubtotalCents: 10000, discountAmountCents: 500, pricingDate: "2028-09-01",
    },
  });
  await prisma.registrationAdjustment.create({
    data: {
      eventId, registrationId: registration.id, registrationAttendeeId: attendees[0].id, promoCodeId: promo.id, kind: "PROMO_CODE", amountCents: -500,
      reason: "Synthetic", createdByNameSnapshot: "Evdel",
    },
  });

  // Append-only ledgers (immutable by trigger, RESTRICT foreign keys)
  await prisma.registrationOperation.create({
    data: {
      eventId, registrationId: registration.id, attendeeId: attendees[0].id, actorUserId: staffId, type: "ATTENDEE_SUBSTITUTION", clientRequestId: id("op"),
      requestFingerprint: "fp", actorNameSnapshot: "Evdel", beforeSnapshot: {}, afterSnapshot: {}, responseSnapshot: {},
    },
  });
  await prisma.registrationPaymentChoiceOperation.create({
    data: {
      id: id("pco"), eventId, registrationId: registration.id, sequence: 1, clientRequestId: id("pco_req"), requestFingerprint: "fp",
      choice: "PAY_LATER", baseSubtotalCents: 10000, processingFeeCents: 0, resultingTotalCents: 10000, responseSnapshot: {},
    },
  });

  // Messages: sent, queued (to be cancelled), with delivery attempts and provider events
  const sent = await prisma.messageOutbox.create({
    data: {
      eventId, registrationId: registration.id, templateVersionId: templateVersion.id, templateKey: "PAYMENT_RECEIPT", recipientKind: "REGISTRANT",
      recipientEmail: `${P}-holder@example.test`, senderNameSnapshot: "Evdel", subjectSnapshot: "Receipt", bodyTextSnapshot: "Thanks.",
      idempotencyKey: id("msg_sent"), correlationId: id("corr_sent"), status: "SENT",
    },
  });
  await prisma.messageOutbox.update({ where: { id: sent.id }, data: { providerMessageId: id("prov_msg") } });
  await prisma.messageDeliveryAttempt.create({ data: { messageOutboxId: sent.id, attemptNumber: 1, provider: "LOCAL", status: "SENT" } });
  await prisma.messageProviderEvent.create({
    data: { messageOutboxId: sent.id, provider: "RESEND", providerEventId: id("prov_evt"), providerMessageId: id("prov_msg"), eventType: "delivered", occurredAt: new Date(), payload: {} },
  });
  // A webhook that arrived before it could be linked to its message still names it by provider id.
  await prisma.messageProviderEvent.create({
    data: { provider: "RESEND", providerEventId: id("prov_evt_unlinked"), providerMessageId: id("prov_msg"), eventType: "opened", occurredAt: new Date(), payload: {} },
  });
  for (const key of ["q1", "q2"]) {
    await prisma.messageOutbox.create({
      data: {
        eventId, registrationId: registration.id, templateKey: "BALANCE_REMINDER", recipientKind: "REGISTRANT", recipientEmail: `${P}-holder@example.test`,
        senderNameSnapshot: "Evdel", subjectSnapshot: "Balance", bodyTextSnapshot: "Due.", idempotencyKey: id(`msg_${key}`), correlationId: id(`corr_${key}`), status: "PENDING",
      },
    });
  }

  // Tags and notes
  await prisma.registrationTagAssignment.create({ data: { eventId, registrationId: registration.id, tagId: tag.id, appliedByUserId: staffId } });
  await prisma.attendeeTagAssignment.create({ data: { eventId, attendeeId: attendees[0].id, tagId: tag.id, appliedByUserId: staffId } });
  const note = await prisma.staffNote.create({ data: { eventId, registrationId: registration.id, authorUserId: staffId } });
  await prisma.staffNoteRevision.create({ data: { noteId: note.id, sequence: 1, body: "Synthetic note.", authorUserId: staffId } });

  // Merchandise
  const catalog = await prisma.merchandiseCatalog.create({ data: { eventId } });
  const product = await prisma.merchandiseProduct.create({ data: { eventId, name: "Evdel Shirt", artworkAssetId: asset.id, artworkAltText: "Synthetic artwork" } });
  const variant = await prisma.merchandiseProductVariant.create({ data: { productId: product.id, label: "M" } });
  const availability = await prisma.merchandiseVariantAvailability.create({
    data: { variantId: variant.id, versionNumber: 1, priceCents: 1500, taxTreatment: "TAXABLE", feePolicy: "ABSORBED_BY_EVENT", createdByUserId: adminId },
  });
  const order = await prisma.merchandiseOrder.create({
    data: { eventId, registrationId: registration.id, purchaserSnapshot: {}, clientRequestId: id("mo"), requestFingerprint: "fp", subtotalCents: 1500, totalCents: 1500 },
  });
  await prisma.merchandiseOrderLine.create({
    data: {
      orderId: order.id, eventId, productId: product.id, variantId: variant.id, availabilityId: availability.id, productNameSnapshot: "Evdel Shirt", variantLabelSnapshot: "M",
      unitPriceCentsSnapshot: 1500, quantity: 1, taxTreatmentSnapshot: "TAXABLE", feePolicySnapshot: "ABSORBED_BY_EVENT", lineTotalCents: 1500,
    },
  });
  await prisma.merchandiseOrderStatusChange.create({ data: { orderId: order.id, eventId, fromStatus: "PENDING", toStatus: "PAID", actorUserId: adminId } });
  void catalog;

  // Community
  await prisma.eventCommunitySettings.create({ data: { eventId } });
  await prisma.communityParticipation.create({ data: { eventId, accountId: account.id } });
  const post = await prisma.communityPost.create({ data: { eventId, authorAccountId: account.id, body: "Synthetic post." } });
  await prisma.communityPostRevision.create({ data: { postId: post.id, body: "Synthetic post." } });
  await prisma.communityReport.create({ data: { eventId, postId: post.id, reporterAccountId: account.id, reason: "OTHER" } });
  await prisma.communityNotification.create({ data: { eventId, recipientAccountId: account.id, actorAccountId: account.id, postId: post.id, kind: "NEW_POST" } });

  // Imports and this event's own audit history
  const importRun = await prisma.importRun.create({ data: { eventId, startedByUserId: adminId, sourceSystem: "synthetic", sourceRunKey: id("import") } });
  await prisma.importRecord.create({
    data: { importRunId: importRun.id, sourceRow: 1, sourceRecordKey: "r1", status: "CREATED", proposedAction: "create", rawSnapshot: {}, matchedRegistrationId: registration.id },
  });
  const ownAudit = await prisma.auditLog.create({
    data: { eventId, actorUserId: adminId, action: "EVENT_CHECK", entityType: "Event", entityId: eventId, correlationId: id("corr_own"), summary: "Synthetic own audit row." },
  });

  // A large event: many registrations with attendees, payments and messages.
  const bulkStarted = Date.now();
  const bulk = Array.from({ length: BULK_REGISTRATIONS }, (_, n) => n);
  for (let from = 0; from < bulk.length; from += 500) {
    const chunk = bulk.slice(from, from + 500);
    await prisma.registration.createMany({
      data: chunk.map((n) => ({
        id: id(`bulk_reg_${n}`), eventId, accountHolderPersonId: holder.id, confirmationCode: `EVBULK${n}`, totalAmount: 25, status: "CONFIRMED" as const,
      })),
    });
    await prisma.registrationAttendee.createMany({
      data: chunk.map((n) => ({
        id: id(`bulk_att_${n}`), eventId, registrationId: id(`bulk_reg_${n}`), personId: attendeePeople[1].id, attendeeType: "youth", profileSnapshot: {},
      })),
    });
    await prisma.payment.createMany({
      data: chunk.map((n) => ({ eventId, registrationId: id(`bulk_reg_${n}`), amount: 25, status: "SUCCEEDED" as const, method: "CARD_REFERENCE" as const })),
    });
    await prisma.messageOutbox.createMany({
      data: chunk.map((n) => ({
        eventId, registrationId: id(`bulk_reg_${n}`), templateKey: "REGISTRATION_CONFIRMATION_PAID" as const, recipientKind: "REGISTRANT" as const,
        recipientEmail: `${P}-bulk${n}@example.test`, senderNameSnapshot: "Evdel", subjectSnapshot: "Hi", bodyTextSnapshot: "Hi.",
        idempotencyKey: id(`bulk_msg_${n}`), correlationId: id(`bulk_corr_${n}`), status: "PENDING" as const,
      })),
    });
  }
  console.log(`Built ${BULK_REGISTRATIONS} extra registrations in ${Date.now() - bulkStarted} ms.`);

  // ---- Refusal: the rich event has records attached, so nobody may delete it. ----
  const sysAdmin = { userId: adminId, globalRole: "SYSTEM_ADMIN" as const };
  const eventAdmin = { userId: eventAdminId, globalRole: null };
  const staff = { userId: staffId, globalRole: null };

  const preview = await getEventDeletionPreview(eventId, sysAdmin);
  assert(preview, "the preview loads");
  const c = preview.counts;
  assert(c.registrations === BULK_REGISTRATIONS + 2, `registration count in the preview (${c.registrations})`);
  assert(c.attendees === BULK_REGISTRATIONS + 3, "attendee count in the preview");
  assert(c.payments === BULK_REGISTRATIONS + 2, "payment count in the preview");
  assert(c.realPayments === BULK_REGISTRATIONS + 1, "the cash payment and bulk card payments are real; the sandbox one is not");
  assert(c.invoices === 1, "one organization-billed registration is an invoice");
  assert(c.honorEnrollments === 1 && c.locations === 2 && c.forms === 1, "honors, locations and forms counted");
  assert(c.messages === BULK_REGISTRATIONS + 3 && c.queuedMessages === BULK_REGISTRATIONS + 2, "messages counted, queued ones separately");
  assert(c.formSubmissions === 1 && c.imports === 1 && c.merchandiseOrders === 1, "form submissions, imports and merchandise orders counted");
  assert(c.clubRegistrationDrafts === 1 && c.communityPosts === 1 && c.announcements === 1, "club drafts, community posts and announcements counted");
  assert(!preview.decision.allowed, "the preview refuses a system admin when records are attached");
  const reason = preview.decision.allowed ? "" : preview.decision.reason;
  for (const phrase of [
    "registrations", "attendees", "payments", "invoice", "honors enrollment", "form submission", "import run",
    "merchandise order", "club registration draft", "community post", "announcement", "messages",
  ]) {
    assert(reason.includes(phrase), `the refusal names "${phrase}" (${reason})`);
  }
  assert(/Unpublish it instead/.test(reason), "the refusal says what to do instead");
  const eventAdminPreview = await getEventDeletionPreview(eventId, eventAdmin);
  assert(eventAdminPreview && !eventAdminPreview.decision.allowed, "an Event Admin cannot delete it either");

  const beforeRefusals = await tableCounts();
  const refusal = await caught(deleteEvent({ eventId, actor: sysAdmin, confirmName: "Evdel Rich Event 2028" }));
  assert(refusal instanceof EventDeletionError && refusal.code === "EVENT_DELETE_FORBIDDEN", `a system admin is refused with the exact name typed (${String(refusal)})`);
  assert(/cannot be deleted because it has/.test((refusal as Error).message), "the refusal carries the blocker explanation");
  await expectCode(deleteEvent({ eventId, actor: eventAdmin, confirmName: "Evdel Rich Event 2028" }), "EVENT_DELETE_FORBIDDEN", "Event Admin on a live event");
  await expectCode(deleteEvent({ eventId, actor: staff, confirmName: "Evdel Rich Event 2028" }), "EVENT_DELETE_FORBIDDEN", "other staff");
  await expectCode(deleteEvent({ eventId, actor: sysAdmin, confirmName: "evdel rich event 2028" }), "EVENT_DELETE_FORBIDDEN", "blockers are reported before the name is checked");
  await expectCode(deleteEvent({ eventId: id("missing"), actor: sysAdmin, confirmName: "x" }), "EVENT_NOT_FOUND", "unknown event");
  const afterRefusals = await tableCounts();
  const refusalChanges = [...beforeRefusals].filter(([table, count]) => afterRefusals.get(table) !== count).map(([table, count]) => `${table}: ${count} -> ${afterRefusals.get(table)}`);
  assert(refusalChanges.length === 0, `refused deletions change no table, audit log included:\n  ${refusalChanges.join("\n  ")}`);
  assert(await prisma.auditLog.count({ where: { action: "EVENT_DELETED", entityId: eventId } }) === 0, "a refused deletion writes no deletion audit row");
  assert(await prisma.messageOutbox.count({ where: { eventId, status: "PENDING" } }) === BULK_REGISTRATIONS + 2, "a refused deletion leaves queued mail queued, not cancelled");
  assert(await prisma.payment.count({ where: { eventId } }) === BULK_REGISTRATIONS + 2, "a refused deletion leaves payments in place");
  assert(await prisma.registrationOperation.count({ where: { eventId } }) === 1, "a refused deletion leaves the ledger in place");
  assert(await prisma.clubRosterMember.count({ where: { id: rosterMember.id, sourceRegistrationId: registration.id } }) === 1, "a refused deletion leaves the roster pointer");
  assert(EventDeletionError.name === "EventDeletionError", "error class exported");

  // Empty events: an Event Admin or other staff still cannot delete; only a system admin can.
  const emptyDraftPreview = await getEventDeletionPreview(draftEventId, eventAdmin);
  assert(emptyDraftPreview && !emptyDraftPreview.decision.allowed, "an Event Admin cannot delete even an empty draft");
  await expectCode(deleteEvent({ eventId: draftEventId, actor: eventAdmin, confirmName: "Evdel Draft" }), "EVENT_DELETE_FORBIDDEN", "Event Admin on an empty draft");
  await expectCode(deleteEvent({ eventId: draftEventId, actor: staff, confirmName: "Evdel Draft" }), "EVENT_DELETE_FORBIDDEN", "non-admin staff on a draft");
  await expectCode(deleteEvent({ eventId: publishedBareEventId, actor: eventAdmin, confirmName: "Evdel Published" }), "EVENT_DELETE_FORBIDDEN", "Event Admin on a published event");
  assert(await prisma.event.count({ where: { id: { in: [eventId, draftEventId, publishedBareEventId] } } }) === 3, "refused deletions removed nothing");

  // ---- The ledger stays immutable for everyone else. ----
  const ledgerDelete = await caught(prisma.registrationOperation.deleteMany({ where: { eventId } }));
  assert(ledgerDelete, "the amendment ledger still rejects a delete outside an event deletion");

  // The flag only ever relaxes DELETE, and only inside the transaction that set it. One connection, so the
  // second transaction is guaranteed to reuse the first one's session.
  const singleConnection = new PrismaClient({ datasourceUrl: `${process.env.DATABASE_URL}${process.env.DATABASE_URL?.includes("?") ? "&" : "?"}connection_limit=1` });
  try {
    const updateWithFlag = await caught(singleConnection.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`;
      await tx.$executeRaw`UPDATE "RegistrationOperation" SET "actorNameSnapshot" = 'changed' WHERE "eventId" = ${eventId}`;
    }));
    assert(updateWithFlag, "UPDATE is still rejected while the deletion flag is on");
    await singleConnection.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`;
    });
    const carried = await singleConnection.$queryRaw<Array<{ value: string | null }>>`SELECT current_setting('imsda.event_deletion', true) AS value`;
    assert(!carried[0].value, `the deletion flag does not carry into the next transaction on the same connection (saw "${carried[0].value}")`);
    const nextDelete = await caught(singleConnection.registrationOperation.deleteMany({ where: { eventId } }));
    assert(nextDelete, "a delete in the next transaction on the same connection is still rejected");
    assert(await prisma.registrationOperation.count({ where: { eventId } }) === 1, "the ledger row is untouched by those attempts");
  } finally {
    await singleConnection.$disconnect();
  }

  // ---- Deletion: an event with only setup data. ----
  // A shared supply item referenced by an award item below: the item stays, the link goes.
  const supplyItem = await prisma.clubSupplyItem.create({ data: { section: "MISCELLANEOUS", name: "Evdel Supply Item", normalizedName: "evdel supply item" } });
  const setupBaseline = await tableCounts();
  await prisma.event.create({ data: { id: setupEventId, slug: `${P}-setup`, name: "Evdel Setup Only 2028", ...eventBase, isPublished: true } });
  await prisma.eventMembership.createMany({
    data: [
      { eventId: setupEventId, userId: eventAdminId, role: "EVENT_ADMIN" },
      { eventId: setupEventId, userId: staffId, role: "REGISTRATION_MANAGER" },
    ],
  });
  await prisma.eventMessageSettings.create({ data: { eventId: setupEventId, senderName: "Evdel" } });
  await prisma.eventPaymentInstructionVersion.create({ data: { eventId: setupEventId, versionNumber: 1 } });
  await prisma.eventCommunitySettings.create({ data: { eventId: setupEventId } });
  const setupLocation = await prisma.eventLocation.create({ data: { eventId: setupEventId, name: "Evdel Setup North", normalizedName: "evdel setup north" } });
  await prisma.eventAttendeeType.create({ data: { eventId: setupEventId, code: "youth", label: "Youth" } });
  await prisma.eventAttendeeClassification.create({ data: { eventId: setupEventId, kind: "CATEGORY", code: "cat", label: "Category" } });
  await prisma.eventTag.create({ data: { eventId: setupEventId, name: "Evdel Setup Tag", normalizedName: "evdel setup tag", color: "#336699" } });
  const setupForm = await prisma.registrationForm.create({ data: { eventId: setupEventId, createdByUserId: adminId, name: "Evdel Setup Form", slug: "evdel-setup-form" } });
  const setupFormVersion = await prisma.registrationFormVersion.create({ data: { formId: setupForm.id, createdByUserId: adminId, versionNumber: 1, definition: {} } });
  await prisma.formTestSubmission.create({
    data: { eventId: setupEventId, formVersionId: setupFormVersion.id, submittedByUserId: adminId, responses: {}, validation: {}, isValid: true },
  });
  await prisma.promoCode.create({ data: { eventId: setupEventId, code: "EVDELSETUP", normalizedCode: "EVDELSETUP", discountType: "FIXED_CENTS", discountValue: 500 } });
  const setupSession = await prisma.honorSession.create({ data: { eventId: setupEventId, name: "Evdel Setup Session", normalizedName: "evdel setup session", locationId: setupLocation.id } });
  await prisma.honorOffering.create({ data: { eventId: setupEventId, honorId: honor.id, span: "SINGLE_SESSION", capacity: 10, sessionId: setupSession.id } });
  const setupTemplate = await prisma.eventMessageTemplate.create({ data: { eventId: setupEventId, key: "PAYMENT_RECEIPT" } });
  await prisma.messageTemplateVersion.create({ data: { templateId: setupTemplate.id, versionNumber: 1, subjectTemplate: "Receipt", bodyTemplate: "Thanks." } });
  const setupAsset = await prisma.eventAsset.create({
    data: { eventId: setupEventId, displayName: "setup.pdf", contentType: "application/pdf", byteSize: 10, checksum: "abc", storageKey: id("setup_asset_key") },
  });
  const setupSection = await prisma.eventContentSection.create({ data: { eventId: setupEventId, title: "Evdel Setup Section", position: 0 } });
  await prisma.eventContentLink.create({ data: { sectionId: setupSection.id, label: "Flyer", position: 0, assetId: setupAsset.id } });
  await prisma.event.update({ where: { id: setupEventId }, data: { badgeBackgroundAssetId: setupAsset.id } });
  await prisma.merchandiseCatalog.create({ data: { eventId: setupEventId } });
  const setupProduct = await prisma.merchandiseProduct.create({ data: { eventId: setupEventId, name: "Evdel Setup Shirt", artworkAssetId: setupAsset.id, artworkAltText: "Synthetic artwork" } });
  const setupVariant = await prisma.merchandiseProductVariant.create({ data: { productId: setupProduct.id, label: "M" } });
  await prisma.merchandiseVariantAvailability.create({
    data: { variantId: setupVariant.id, versionNumber: 1, priceCents: 1500, taxTreatment: "TAXABLE", feePolicy: "ABSORBED_BY_EVENT", createdByUserId: adminId },
  });
  await prisma.eventAwardItem.create({ data: { eventId: setupEventId, itemId: supplyItem.id } });
  // This event's own audit history is kept, detached from the event.
  const setupAudit = await prisma.auditLog.create({
    data: { eventId: setupEventId, actorUserId: adminId, action: "EVENT_CHECK", entityType: "Event", entityId: setupEventId, correlationId: id("corr_setup"), summary: "Synthetic own audit row." },
  });
  // A large setup-only event: many locations, tags and content sections, to exercise the longer transaction.
  const setupBulkStarted = Date.now();
  const bulkRows = Array.from({ length: BULK_SETUP_ROWS }, (_, n) => n);
  await prisma.eventLocation.createMany({
    data: bulkRows.map((n) => ({ id: id(`bulk_loc_${n}`), eventId: setupEventId, name: `Evdel Bulk ${n}`, normalizedName: `evdel bulk ${n}` })),
  });
  await prisma.eventTag.createMany({
    data: bulkRows.map((n) => ({ eventId: setupEventId, name: `Evdel Bulk Tag ${n}`, normalizedName: `evdel bulk tag ${n}`, color: "#336699" })),
  });
  await prisma.eventContentSection.createMany({
    data: bulkRows.map((n) => ({ eventId: setupEventId, title: `Evdel Bulk Section ${n}`, position: n + 1 })),
  });
  console.log(`Built ${BULK_SETUP_ROWS} extra locations, tags and sections in ${Date.now() - setupBulkStarted} ms.`);

  const setupPreview = await getEventDeletionPreview(setupEventId, sysAdmin);
  assert(setupPreview?.decision.allowed, "a system admin may delete an event that has only setup data");
  assert(setupPreview.counts.locations === BULK_SETUP_ROWS + 1 && setupPreview.counts.registrations === 0 && setupPreview.counts.messages === 0, "setup-only counts");
  const setupEventAdminPreview = await getEventDeletionPreview(setupEventId, eventAdmin);
  assert(setupEventAdminPreview && !setupEventAdminPreview.decision.allowed, "an Event Admin may not delete even a setup-only event");
  await expectCode(deleteEvent({ eventId: setupEventId, actor: eventAdmin, confirmName: "Evdel Setup Only 2028" }), "EVENT_DELETE_FORBIDDEN", "Event Admin on a setup-only event");
  await expectCode(deleteEvent({ eventId: setupEventId, actor: sysAdmin, confirmName: "evdel setup only 2028" }), "EVENT_NAME_MISMATCH", "wrong name");
  await expectCode(deleteEvent({ eventId: setupEventId, actor: sysAdmin, confirmName: "" }), "EVENT_NAME_MISMATCH", "empty name");

  // ---- All-or-nothing: a failure late in the deletion rolls everything back. ----
  const beforeRollback = await tableCounts();
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION evdel_fail_tag_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic failure late in the deletion'; END; $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "evdel_fail_tag_delete" BEFORE DELETE ON "EventTag" FOR EACH ROW EXECUTE FUNCTION evdel_fail_tag_delete()`);
  const midFailure = await caught(deleteEvent({ eventId: setupEventId, actor: sysAdmin, confirmName: "Evdel Setup Only 2028" }));
  assert(midFailure, "the injected failure surfaces");
  await prisma.$executeRawUnsafe('DROP TRIGGER "evdel_fail_tag_delete" ON "EventTag"');
  await prisma.$executeRawUnsafe("DROP FUNCTION evdel_fail_tag_delete()");
  const afterRollback = await tableCounts();
  const rollbackChanges = [...beforeRollback].filter(([table, count]) => afterRollback.get(table) !== count).map(([table]) => table);
  assert(rollbackChanges.length === 0, `a failed deletion changes no table (${rollbackChanges.join(", ")})`);
  assert(await prisma.event.count({ where: { id: setupEventId } }) === 1, "a rolled-back deletion leaves the event");

  // ---- The deletion. ----
  const started = Date.now();
  const result = await deleteEvent({ eventId: setupEventId, actor: sysAdmin, confirmName: "  Evdel Setup Only 2028 " });
  console.log(`Deleted the setup-only event (${BULK_SETUP_ROWS * 3 + 1} setup rows) in ${Date.now() - started} ms.`);
  assert(result.counts.locations === BULK_SETUP_ROWS + 1, "the result reports what was removed");

  assert(await prisma.event.count({ where: { id: setupEventId } }) === 0, "the event is gone");
  const after = await tableCounts();
  const changes: string[] = [];
  for (const [table, count] of setupBaseline) {
    // Two audit rows are added: the deletion itself, and the event's own earlier row, kept with its event reference cleared.
    const expected = table === "AuditLog" ? count + 2 : count;
    if (after.get(table) !== expected) changes.push(`${table}: expected ${expected}, found ${after.get(table)}`);
  }
  assert(changes.length === 0, `no leftover or lost rows anywhere in the database:\n  ${changes.join("\n  ")}`);

  // Shared rows survived intact; the rich event and everything else is untouched.
  assert(await prisma.clubSupplyItem.count({ where: { id: supplyItem.id } }) === 1, "the shared supply item survives its award link");
  assert(await prisma.honor.count({ where: { id: honor.id } }) === 1, "the shared honor survives its offering");
  assert(await prisma.person.count({ where: { id: { in: [holder.id, ...attendeePeople.map((p) => p.id)] } } }) === 4, "people survive");
  assert(await prisma.attendeeAccount.count({ where: { id: account.id } }) === 1, "the attendee account survives");
  assert(await prisma.organization.count({ where: { id: { in: [club.id, church.id] } } }) === 2, "clubs and churches survive");
  assert(await prisma.user.count({ where: { id: { in: [adminId, eventAdminId, staffId] } } }) === 3, "staff accounts survive");
  assert(await prisma.memberHonorEntry.count({ where: { id: memberHonorEntry.id } }) === 1, "honor history survives");
  assert(await prisma.memberTransfer.count({ where: { id: transfer.id } }) === 1, "the club transfer survives");
  assert(await prisma.clubYearEndReport.count({ where: { organizationId: club.id } }) === 1, "the year-end report survives");
  assert(await prisma.registration.count({ where: { id: otherReg.id } }) === 1 && await prisma.payment.count({ where: { eventId: otherEventId } }) === 1, "another event and its payment are untouched");
  assert(await prisma.event.count({ where: { id: eventId } }) === 1 && await prisma.registration.count({ where: { eventId } }) === BULK_REGISTRATIONS + 2, "the refused rich event is untouched");
  assert(await prisma.messageOutbox.count({ where: { idempotencyKey: id("account_msg") } }) === 1, "an account email with no event survives");
  assert(await prisma.auditLog.count({ where: { id: otherAudit.id, eventId: otherEventId } }) === 1, "another event's audit row is untouched");
  const keptAudit = await prisma.auditLog.findUnique({ where: { id: setupAudit.id } });
  assert(keptAudit && keptAudit.eventId === null, "the event's own audit history is kept, no longer pointing at it");
  void ownAudit;

  // No row in any table that has an eventId column may still name the deleted event.
  const eventIdTables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('eventId', 'resultEventId', 'sourceEventId')`;
  for (const { table_name } of eventIdTables) {
    for (const column of ["eventId", "resultEventId", "sourceEventId"]) {
      const has = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM information_schema.columns WHERE table_schema='public' AND table_name='${table_name}' AND column_name='${column}'`,
      );
      if (Number(has[0].n) === 0) continue;
      const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${table_name}" WHERE "${column}" = '${setupEventId}'`);
      assert(Number(rows[0].n) === 0, `${table_name}.${column} still names the deleted event`);
    }
  }

  // Uploaded-file rows are gone (the file itself is removed by the service after commit).
  assert(await prisma.eventAsset.count({ where: { storageKey: id("setup_asset_key") } }) === 0, "asset rows are gone");

  // The audit row: who, which event, dates and counts, no personal data.
  const auditRows = await prisma.auditLog.findMany({ where: { action: "EVENT_DELETED", entityId: setupEventId } });
  assert(auditRows.length === 1, `exactly one deletion audit row (found ${auditRows.length})`);
  const [audit] = auditRows;
  assert(audit.actorUserId === adminId && audit.eventId === null && audit.entityType === "Event", "the audit row records the actor and the event id");
  const metadata = audit.metadata as { eventId: string; name: string; startsAt: string; endsAt: string; counts: Record<string, number> };
  assert(metadata.eventId === setupEventId && metadata.name === "Evdel Setup Only 2028", "the audit row records the event id and name");
  assert(metadata.startsAt === eventBase.startsAt.toISOString() && metadata.endsAt === eventBase.endsAt.toISOString(), "the audit row records the dates");
  assert(metadata.counts.locations === BULK_SETUP_ROWS + 1 && metadata.counts.registrations === 0, "the audit row records the counts");
  assert(!/Evdelperson|Evdelholder|@example\.test/.test(JSON.stringify(audit)), "the audit row holds no personal data");

  // A system admin can delete the empty draft and the empty published event; the draft's staff access goes with it.
  await deleteEvent({ eventId: draftEventId, actor: sysAdmin, confirmName: "Evdel Draft" });
  assert(await prisma.event.count({ where: { id: draftEventId } }) === 0, "a system admin deletes an empty draft");
  assert(await prisma.eventMembership.count({ where: { eventId: draftEventId } }) === 0, "its staff access is gone with it");
  assert(await prisma.auditLog.count({ where: { action: "EVENT_DELETED", entityId: draftEventId, actorUserId: adminId } }) === 1, "the draft deletion is audited");
  await deleteEvent({ eventId: publishedBareEventId, actor: sysAdmin, confirmName: "Evdel Published" });
  assert(await prisma.event.count({ where: { id: publishedBareEventId } }) === 0, "a system admin deletes an empty published event");

  console.log("Event deletion verified: refusal with records attached changes nothing, setup-only event deleted cleanly, shared records kept, permissions, audit row, rollback, large setup.");
}

main()
  .then(async () => {
    await cleanup();
  })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch((cleanupError) => console.error("Cleanup failed:", cleanupError));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
