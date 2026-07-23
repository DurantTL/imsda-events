import {
  AnnouncementPriority,
  AnnouncementStatus,
  EventPermission,
  EventRole,
  ImportRunStatus,
  MembershipStatus,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  RefundStatus,
  RegistrationFormStatus,
  RegistrationStatus,
} from "@prisma/client";
import { hashPassword } from "../modules/access/passwords";
import { formTemplates } from "../modules/forms/definition";

const prisma = new PrismaClient();
const localPassword = "IMSDA-Local-2026!";

async function seedCredential(userId: string) {
  const passwordHash = await hashPassword(localPassword);
  await prisma.authCredential.upsert({
    where: { userId },
    update: { passwordHash, passwordUpdatedAt: new Date(), failedAttempts: 0, lockedUntil: null, disabledAt: null },
    create: { userId, passwordHash },
  });
}

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: "admin@imsda-events.test" },
    update: { displayName: "Morgan Event Admin" },
    create: {
      id: "usr_event_admin",
      email: "admin@imsda-events.test",
      displayName: "Morgan Event Admin",
    },
  });

  const systemAdmin = await prisma.user.upsert({
    where: { email: "system@imsda-events.test" },
    update: { displayName: "Casey System Admin", globalRole: "SYSTEM_ADMIN" },
    create: {
      id: "usr_system_admin",
      email: "system@imsda-events.test",
      displayName: "Casey System Admin",
      globalRole: "SYSTEM_ADMIN",
    },
  });

  const staffDefinitions: Array<{ id: string; email: string; displayName: string; role: EventRole }> = [
    { id: "usr_registration_manager", email: "registration@imsda-events.test", displayName: "Riley Registration", role: EventRole.REGISTRATION_MANAGER },
    { id: "usr_finance_manager", email: "finance@imsda-events.test", displayName: "Finley Finance", role: EventRole.FINANCE_MANAGER },
    { id: "usr_communications_manager", email: "communications@imsda-events.test", displayName: "Cameron Communications", role: EventRole.COMMUNICATIONS_MANAGER },
    { id: "usr_checkin_staff", email: "checkin@imsda-events.test", displayName: "Charlie Check-in", role: EventRole.CHECK_IN_STAFF },
    { id: "usr_readonly_staff", email: "readonly@imsda-events.test", displayName: "Robin Read-only", role: EventRole.READ_ONLY_STAFF },
  ];
  const staffUsers = await Promise.all(staffDefinitions.map(async ({ id, email, displayName, role }) => ({
    user: await prisma.user.upsert({
      where: { email },
      update: { displayName },
      create: { id, email, displayName },
    }),
    role,
  })));

  const events = await Promise.all([
    prisma.event.upsert({
      where: { slug: "womens-retreat-2026" },
      update: {
        publicInfoUrl: "https://imsda.org/event/womens-retreat-3/",
        supportContact: "communication@imsda.org",
        registrationOpensOn: "2026-06-04",
        registrationClosesOn: "2026-09-17",
        waitlistEnabled: true,
        autoPromoteWaitlist: true,
      },
      create: {
        id: "evt_wr26",
        slug: "womens-retreat-2026",
        name: "Women’s Retreat 2026",
        startsAt: new Date("2026-10-09T21:00:00.000Z"),
        endsAt: new Date("2026-10-11T17:00:00.000Z"),
        location: "Des Moines, Iowa",
        capacity: 350,
        publicInfoUrl: "https://imsda.org/event/womens-retreat-3/",
        supportContact: "communication@imsda.org",
        registrationOpensOn: "2026-06-04",
        registrationClosesOn: "2026-09-17",
        waitlistEnabled: true,
        autoPromoteWaitlist: true,
        isPublished: true,
      },
    }),
    prisma.event.upsert({
      where: { slug: "camp-meeting-2027" },
      update: {},
      create: {
        id: "evt_cm27",
        slug: "camp-meeting-2027",
        name: "Camp Meeting 2027",
        startsAt: new Date("2027-06-04T14:00:00.000Z"),
        endsAt: new Date("2027-06-12T17:00:00.000Z"),
        location: "Nevada, Iowa",
        capacity: 800,
      },
    }),
    prisma.event.upsert({
      where: { slug: "mens-convention-2027" },
      update: {},
      create: {
        id: "evt_mc27",
        slug: "mens-convention-2027",
        name: "Men’s Convention 2027",
        startsAt: new Date("2027-03-12T22:00:00.000Z"),
        endsAt: new Date("2027-03-14T17:00:00.000Z"),
        location: "West Des Moines, Iowa",
        capacity: 250,
      },
    }),
  ]);

  for (const event of events) {
    await prisma.eventMembership.upsert({
      where: { eventId_userId: { eventId: event.id, userId: admin.id } },
      update: { status: MembershipStatus.ACTIVE },
      create: {
        eventId: event.id,
        userId: admin.id,
        role: event.id === "evt_wr26" ? EventRole.EVENT_ADMIN : EventRole.READ_ONLY_STAFF,
        status: MembershipStatus.ACTIVE,
        permissions: event.id === "evt_wr26" ? Object.values(EventPermission) : [EventPermission.VIEW_EVENT],
      },
    });
  }


  for (const { user, role } of staffUsers) {
    await prisma.eventMembership.upsert({
      where: { eventId_userId: { eventId: "evt_wr26", userId: user.id } },
      update: { role, status: MembershipStatus.ACTIVE, permissions: [] },
      create: { eventId: "evt_wr26", userId: user.id, role, status: MembershipStatus.ACTIVE },
    });
  }

  for (const user of [admin, systemAdmin, ...staffUsers.map((entry) => entry.user)]) {
    await seedCredential(user.id);
  }

  const people = await Promise.all([
    prisma.person.upsert({
      where: { normalizedEmail: "alicia@example.test" },
      update: {},
      create: { id: "per_alicia", firstName: "Alicia", lastName: "Smith", normalizedEmail: "alicia@example.test", phone: "+1-555-0101" },
    }),
    prisma.person.upsert({
      where: { normalizedEmail: "jennifer@example.test" },
      update: {},
      create: { id: "per_jennifer", firstName: "Jennifer", lastName: "Miller", normalizedEmail: "jennifer@example.test", phone: "+1-555-0102" },
    }),
    prisma.person.upsert({
      where: { normalizedEmail: "taylor@example.test" },
      update: {},
      create: { id: "per_taylor", firstName: "Taylor", lastName: "Worker", normalizedEmail: "taylor@example.test", phone: "+1-555-0103" },
    }),
  ]);

  const household = await prisma.household.upsert({
    where: { id: "hh_miller" },
    update: {},
    create: { id: "hh_miller", name: "Miller household" },
  });
  await prisma.householdMember.upsert({
    where: { householdId_personId: { householdId: household.id, personId: people[1].id } },
    update: { canManage: true },
    create: { householdId: household.id, personId: people[1].id, relationship: "Account holder", canManage: true },
  });

  const wr26 = events[0];
  const existingLocalPromo = await prisma.promoCode.findUnique({
    where: {
      eventId_normalizedCode: {
        eventId: wr26.id,
        normalizedCode: "LOCAL10",
      },
    },
    select: { redeemedCount: true },
  });
  const localPromoMaximumUses =
    (existingLocalPromo?.redeemedCount ?? 0) + 25;
  await prisma.promoCode.upsert({
    where: {
      eventId_normalizedCode: {
        eventId: wr26.id,
        normalizedCode: "LOCAL10",
      },
    },
    update: {
      code: "LOCAL10",
      isActive: true,
      discountType: "PERCENT_BPS",
      discountValue: 1000,
      startsOn: null,
      endsOn: null,
      minimumSubtotalCents: 10000,
      maximumUses: localPromoMaximumUses,
      maximumDiscountCents: 5000,
    },
    create: {
      id: "promo_wr26_local10",
      eventId: wr26.id,
      code: "LOCAL10",
      normalizedCode: "LOCAL10",
      isActive: true,
      discountType: "PERCENT_BPS",
      discountValue: 1000,
      minimumSubtotalCents: 10000,
      maximumUses: localPromoMaximumUses,
      maximumDiscountCents: 5000,
    },
  });
  const registrations = await Promise.all([
    prisma.registration.upsert({
      where: { eventId_confirmationCode: { eventId: wr26.id, confirmationCode: "TEST-1001" } },
      update: {},
      create: { id: "reg_test_1001", eventId: wr26.id, accountHolderPersonId: people[0].id, confirmationCode: "TEST-1001", status: RegistrationStatus.CONFIRMED, totalAmount: 175, submittedAt: new Date("2026-07-20T15:00:00.000Z") },
    }),
    prisma.registration.upsert({
      where: { eventId_confirmationCode: { eventId: wr26.id, confirmationCode: "TEST-1002" } },
      update: {},
      create: { id: "reg_test_1002", eventId: wr26.id, accountHolderPersonId: people[1].id, householdId: household.id, confirmationCode: "TEST-1002", status: RegistrationStatus.SUBMITTED, totalAmount: 525, submittedAt: new Date("2026-07-21T16:00:00.000Z") },
    }),
    prisma.registration.upsert({
      where: { eventId_confirmationCode: { eventId: wr26.id, confirmationCode: "TEST-1003" } },
      update: {},
      create: { id: "reg_test_1003", eventId: wr26.id, accountHolderPersonId: people[2].id, confirmationCode: "TEST-1003", status: RegistrationStatus.CONFIRMED, totalAmount: 0, submittedAt: new Date("2026-07-22T14:00:00.000Z") },
    }),
  ]);

  const attendeeTypes = ["ATTENDEE", "ATTENDEE", "WORKER"];
  for (let index = 0; index < registrations.length; index += 1) {
    await prisma.registrationAttendee.upsert({
      where: { registrationId_personId: { registrationId: registrations[index].id, personId: people[index].id } },
      update: {},
      create: {
        id: `attendee_test_${index + 1}`,
        eventId: wr26.id,
        registrationId: registrations[index].id,
        personId: people[index].id,
        attendeeType: attendeeTypes[index],
        profileSnapshot: { firstName: people[index].firstName, lastName: people[index].lastName, email: people[index].normalizedEmail },
      },
    });
  }

  const partyMembers = await Promise.all([
    prisma.person.upsert({
      where: { normalizedEmail: "jordan.miller@example.test" },
      update: {},
      create: { id: "per_jordan_miller", firstName: "Jordan", lastName: "Miller", normalizedEmail: "jordan.miller@example.test", phone: "+1-555-0104" },
    }),
    prisma.person.upsert({
      where: { normalizedEmail: "avery.miller@example.test" },
      update: {},
      create: { id: "per_avery_miller", firstName: "Avery", lastName: "Miller", normalizedEmail: "avery.miller@example.test" },
    }),
  ]);

  for (const [index, person] of partyMembers.entries()) {
    await prisma.householdMember.upsert({
      where: { householdId_personId: { householdId: household.id, personId: person.id } },
      update: {},
      create: { householdId: household.id, personId: person.id, relationship: index === 0 ? "Adult" : "Child" },
    });
    await prisma.registrationAttendee.upsert({
      where: { registrationId_personId: { registrationId: registrations[1].id, personId: person.id } },
      update: {},
      create: {
        id: `attendee_miller_${index + 2}`,
        eventId: wr26.id,
        registrationId: registrations[1].id,
        personId: person.id,
        attendeeType: index === 0 ? "ATTENDEE" : "CHILD",
        profileSnapshot: { firstName: person.firstName, lastName: person.lastName, email: person.normalizedEmail },
      },
    });
  }

  await prisma.payment.upsert({
    where: { id: "pay_test_1001" },
    update: {},
    create: { id: "pay_test_1001", eventId: wr26.id, registrationId: registrations[0].id, amount: 175, status: PaymentStatus.SUCCEEDED, method: PaymentMethod.MANUAL, externalReference: "TEST-PAYMENT-ONLY", receivedAt: new Date("2026-07-20T15:05:00.000Z") },
  });

  const millerPayment = await prisma.payment.upsert({
    where: { id: "pay_test_1002" },
    update: {},
    create: { id: "pay_test_1002", eventId: wr26.id, registrationId: registrations[1].id, amount: 200, status: PaymentStatus.SUCCEEDED, method: PaymentMethod.CHECK, externalReference: "TEST-CHECK-2042", receivedAt: new Date("2026-07-21T16:10:00.000Z") },
  });

  await prisma.refund.upsert({
    where: { id: "refund_test_1002" },
    update: {},
    create: { id: "refund_test_1002", eventId: wr26.id, paymentId: millerPayment.id, amount: 25, status: RefundStatus.SUCCEEDED, reason: "Fictitious lodging adjustment" },
  });

  await prisma.announcement.upsert({
    where: { id: "ann_test_welcome" },
    update: {},
    create: { id: "ann_test_welcome", eventId: wr26.id, createdByUserId: admin.id, title: "Friday arrival information", body: "Use the south entrance for event check-in. Parking volunteers will direct you.", audience: { type: "ALL_ATTENDEES" }, placement: "HOME_BANNER", status: AnnouncementStatus.PUBLISHED, priority: AnnouncementPriority.IMPORTANT, publishedAt: new Date("2026-07-22T13:30:00.000Z") },
  });

  await prisma.auditLog.upsert({
    where: { id: "audit_seed_complete" },
    update: {},
    create: { id: "audit_seed_complete", eventId: wr26.id, actorUserId: admin.id, action: "SEED_COMPLETED", entityType: "Event", entityId: wr26.id, correlationId: "seed-foundation-v1", summary: "Created fictitious foundation preview data." },
  });

  await prisma.importRun.upsert({
    where: { sourceSystem_sourceRunKey: { sourceSystem: "SANDBOX_FIXTURE", sourceRunKey: "foundation-v1" } },
    update: { fileName: "foundation-fixture.csv", sourceChecksum: "seed-foundation-v1" },
    create: { id: "import_sandbox_fixture", eventId: wr26.id, startedByUserId: admin.id, sourceSystem: "SANDBOX_FIXTURE", sourceRunKey: "foundation-v1", fileName: "foundation-fixture.csv", sourceChecksum: "seed-foundation-v1", status: ImportRunStatus.COMPLETED, recordsCreated: 3, completedAt: new Date("2026-07-22T14:30:00.000Z"), summary: { productionSource: false, fictitiousOnly: true } },
  });

  const retreatDefinition = formTemplates.find((template) => template.key === "womens_retreat_export")!.definition;
  const retreatForm = await prisma.registrationForm.upsert({
    where: { eventId_slug: { eventId: wr26.id, slug: "womens-retreat-registration" } },
    update: {},
    create: {
      id: "form_wr26_registration",
      eventId: wr26.id,
      createdByUserId: admin.id,
      name: retreatDefinition.title,
      slug: "womens-retreat-registration",
      status: RegistrationFormStatus.DRAFT,
    },
  });
  await prisma.registrationFormVersion.upsert({
    where: { formId_versionNumber: { formId: retreatForm.id, versionNumber: 1 } },
    update: {},
    create: {
      id: "formver_wr26_registration_1",
      formId: retreatForm.id,
      createdByUserId: admin.id,
      versionNumber: 1,
      status: RegistrationFormStatus.DRAFT,
      definition: retreatDefinition,
    },
  });
}

main()
  .then(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
