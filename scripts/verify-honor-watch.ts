/**
 * Proves honor watches (#1099) against a real PostgreSQL database, with the real write paths: a director's pick save and a
 * registration cancelled (both write the #1098 change log), the watch repository's validation and audit, and the scheduled
 * daily sender. A watch matches by honor (including the second honor of a class that teaches two, #812) and by class; a join
 * and a leave of the same youth net out; nothing is sent on a quiet day; sequential sweeps and several sweeps at once send
 * each message once; the staff switch and paused events stop or suppress it; the class log's retention never takes a row a
 * day's window still needs; a watch holds no youth data and no birth date reaches an email. Uses fictitious rows it creates
 * and removes itself.
 *
 *   npm run test:honor-watch
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());
// Fictitious values so account email counts as set up (nothing is ever delivered: messages stay queued or captured locally).
process.env.ACCOUNT_EMAIL_SENDER_ADDRESS ||= "events@ci.example.test";
process.env.RESEND_API_KEY ||= "ci-placeholder-never-sent";

const prisma = new PrismaClient();
const P = "hwv";
const eventId = `${P}_event`;
const otherEventId = `${P}_other_event`;
const adminId = `${P}_admin`;
const orgId = `${P}_org`;
const regId = `${P}_reg`;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const birthSecret = "2013-02-03";
const key = "HONOR_WATCH_SUMMARIES";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function cleanup() {
  await prisma.notificationSetting.deleteMany({ where: { key } });
  await prisma.messageOutbox.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
  await prisma.honorClassChange.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
  await prisma.honorClassWaitlistEntry.deleteMany({ where: { eventId } });
  await prisma.honorEnrollment.deleteMany({ where: { eventId } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: [eventId, otherEventId] } }, { actorUserId: adminId }] } });
  await prisma.honorWatch.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
  await prisma.registrationAttendee.deleteMany({ where: { eventId } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId } });
  await prisma.registrationCapacityReservation.deleteMany({ where: { registration: { eventId } } });
  await prisma.registration.deleteMany({ where: { eventId } });
  await prisma.honorOffering.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
  await prisma.honorSession.deleteMany({ where: { eventId: { in: [eventId, otherEventId] } } });
  await prisma.eventMessageSettings.deleteMany({ where: { eventId } });
  await prisma.event.deleteMany({ where: { id: { in: [eventId, otherEventId] } } });
  await prisma.honor.deleteMany({ where: { id: { startsWith: `${P}_honor_` } } });
  await prisma.organization.deleteMany({ where: { id: orgId } });
  await prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
}

const ymd = (date: Date) => date.toISOString().slice(0, 10);

async function main() {
  const { setClassSelections } = await import("../modules/honors/enrollment-repository");
  const { cancelRegistration } = await import("../modules/registrations/lifecycle-repository");
  const { sendDueClassChangeEmails } = await import("../modules/honors/class-change-emails");
  const { sendDueHonorWatchSummaries } = await import("../modules/honors/watch-emails");
  const { replaceHonorWatches, getHonorWatchPanel } = await import("../modules/honors/watch-repository");
  const { centralDateKey, centralInstant } = await import("../modules/event-locations/waitlist-digest-domain");
  const { resetNotificationSettingsCache } = await import("../modules/notifications/settings");

  await cleanup();
  const real = new Date();
  await prisma.user.create({ data: { id: adminId, email: `${P}-admin@example.test`, displayName: "Honor Watch Admin", globalRole: "SYSTEM_ADMIN" } });
  const makeEvent = (id: string, slug: string) => prisma.event.create({
    data: {
      id, slug, name: id === eventId ? "Honor watch verification" : "Another synthetic event", startsAt: new Date(real.getTime() + 10 * DAY), endsAt: new Date(real.getTime() + 12 * DAY),
      isPublished: true, registrationOpensOn: ymd(new Date(real.getTime() - 30 * DAY)), registrationClosesOn: ymd(new Date(real.getTime() + 8 * DAY)),
      billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB", waitlistEnabled: false,
    },
  });
  await makeEvent(eventId, `${P}-event`);
  await makeEvent(otherEventId, `${P}-other`);
  await prisma.organization.create({ data: { id: orgId, type: "CLUB", name: "Synthetic Pathfinders", normalizedName: "synthetic pathfinders" } });
  const sessionA = await prisma.honorSession.create({ data: { eventId, name: "Sabbath afternoon", normalizedName: "sabbath afternoon" } });
  const sessionB = await prisma.honorSession.create({ data: { eventId, name: "Sunday morning", normalizedName: "sunday morning" } });
  const otherSession = await prisma.honorSession.create({ data: { eventId: otherEventId, name: "Elsewhere", normalizedName: "elsewhere" } });
  const honors = [1, 2, 3, 4].map((n) => `${P}_honor_${n}`);
  for (const [index, id] of honors.entries()) await prisma.honor.create({ data: { id, code: `HWV-${index + 1}`, name: `Watch honor ${index + 1}`, normalizedName: `watch honor ${index + 1}` } });
  const makeClass = async (honorId: string, sessionId: string, capacity = 5, forEvent = eventId) =>
    (await prisma.honorOffering.create({ data: { eventId: forEvent, honorId, sessionId, span: "SINGLE_SESSION", capacity, location: "Room 1" }, select: { id: true } })).id;
  const knots = await makeClass(honors[0]!, sessionA.id);
  // A class that teaches two honors (#812): honor 2 first, honor 3 second.
  const multi = await makeClass(honors[1]!, sessionB.id);
  await prisma.honorOfferingHonor.create({ data: { offeringId: multi, honorId: honors[2]!, eventId, sessionId: sessionB.id, position: 1 } });
  const quiet = await makeClass(honors[3]!, sessionA.id);
  const foreign = await makeClass(honors[0]!, otherSession.id, 5, otherEventId);

  const holder = await prisma.person.create({ data: { id: `${P}_holder`, firstName: "Holder", lastName: "Sample" } });
  await prisma.registration.create({ data: { id: regId, eventId, accountHolderPersonId: holder.id, confirmationCode: `REG-${P}`, status: "SUBMITTED", totalAmount: 0, submittedAt: real } });
  await prisma.clubEventRegistration.create({ data: { eventId, organizationId: orgId, registrationId: regId } });
  const attendee: Record<string, string> = {};
  for (const [name, age] of [["y1", 12], ["y2", 13], ["y3", 11]] as const) {
    const person = await prisma.person.create({ data: { id: `${P}_p_${name}`, firstName: "Kid", lastName: name } });
    attendee[name] = (await prisma.registrationAttendee.create({
      data: {
        eventId, registrationId: regId, personId: person.id, attendeeType: "YOUTH", position: Number(name.slice(1)),
        profileSnapshot: { firstName: "Kid", lastName: name, ageOnEventDate: age, birthDate: birthSecret, temporaryAttendeeType: "YOUTH" },
      },
      select: { id: true },
    })).id;
  }
  const director = { accountId: `${P}-director` };
  const pick = (name: string, classIds: string[], at: Date) => setClassSelections(orgId, eventId, director, { [attendee[name]!]: classIds }, at);
  const mail = (email: string) => prisma.messageOutbox.findMany({ where: { eventId, templateKey: "HONOR_WATCH_SUMMARY", recipientEmail: email }, orderBy: { createdAt: "asc" } });
  const allWatchMail = () => prisma.messageOutbox.count({ where: { eventId, templateKey: "HONOR_WATCH_SUMMARY" } });

  // Each morning is 6:05 AM Central on a Central calendar day, never a fixed 24-hour step: a daylight saving change (1 Nov) moves
  // the 6:00 AM cutoff by an hour in UTC. Noon Central is far from midnight, so adding whole days to it lands on the right date.
  const noonToday = centralInstant(centralDateKey(real), 12);
  const morningOn = (days: number) => new Date(centralInstant(centralDateKey(new Date(noonToday.getTime() + days * DAY)), 6).getTime() + 5 * 60 * 1000);
  const cutoffOf = (morning: Date) => centralInstant(centralDateKey(morning), 6);
  const tomorrowKey = centralDateKey(morningOn(1));
  const [morning1, morning2, morning3, morning4, morning5, morning6, morning7] = [1, 2, 3, 4, 5, 6, 7].map(morningOn) as [Date, Date, Date, Date, Date, Date, Date];

  // ---------------------------------------------------------------- setup: validation, audit, and a watch holds no youth data
  const created = new Date(real.getTime() - 60 * 1000);
  const addr = { honor: ["honor-watch@example.test", "second-honor-watch@example.test"], klass: ["class-watch@example.test"], none: ["none-watch@example.test"] };
  const bad = async (body: unknown, fragment: string) => {
    try {
      await replaceHonorWatches(eventId, adminId, body, created);
    } catch (error) {
      assert((error as { code?: string }).code === "INVALID_WATCHES" && String((error as Error).message).includes(fragment), `refused with "${fragment}" (got ${(error as Error).message})`);
      return;
    }
    throw new Error(`FAILED: a bad save was accepted (${fragment})`);
  };
  await bad({ watches: [{ name: "No addresses", recipients: [], honorIds: [honors[0]], offeringIds: [] }] }, "at least one email");
  await bad({ watches: [{ name: "Bad address", recipients: ["nobody"], honorIds: [honors[0]], offeringIds: [] }] }, "Enter a valid email address");
  await bad({ watches: [{ name: "Nothing watched", recipients: addr.none, honorIds: [], offeringIds: [] }] }, "at least one honor or class");
  await bad({ watches: [{ name: "Unknown honor", recipients: addr.none, honorIds: ["nope"], offeringIds: [] }] }, "from the catalog");
  await bad({ watches: [{ name: "Another event's class", recipients: addr.none, honorIds: [], offeringIds: [foreign] }] }, "from this event");
  await bad({ watches: Array.from({ length: 21 }, (_, index) => ({ name: `Watch ${index}`, recipients: addr.none, honorIds: [honors[0]], offeringIds: [] })) }, "at most 20");
  await bad({ watches: [{ name: "Eleven", recipients: Array.from({ length: 11 }, (_, index) => `a${index}@example.test`), honorIds: [honors[0]], offeringIds: [] }] }, "at most 10");
  assert((await prisma.honorWatch.count({ where: { eventId } })) === 0, "a refused save stores nothing");

  const saved = await replaceHonorWatches(eventId, adminId, {
    watches: [
      { name: "Second honor of the shared class", recipients: addr.honor, honorIds: [honors[2]], offeringIds: [] },
      { name: "Knots class", recipients: addr.klass, honorIds: [], offeringIds: [knots] },
      { name: "A quiet honor", recipients: addr.none, honorIds: [honors[3]], offeringIds: [] },
    ],
  }, created);
  assert(saved.watches.length === 3 && saved.classes.length === 3, "three watches saved, and the event's classes offered");
  const watchRows = await prisma.honorWatch.findMany({ where: { eventId }, orderBy: { position: "asc" } });
  const [byHonor, byClass, byQuiet] = watchRows as [typeof watchRows[number], typeof watchRows[number], typeof watchRows[number]];
  assert(!JSON.stringify(watchRows).includes("Kid") && !JSON.stringify(watchRows).includes(birthSecret), "a watch row holds no youth data");
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { eventId, action: "HONOR_WATCHES_CHANGED" } });
  const auditText = JSON.stringify(audit);
  assert(!auditText.includes("@example.test") && !auditText.includes("Knots class") && (audit.metadata as { watchCount: number }).watchCount === 3, "the audit entry holds ids and counts only");
  console.log("ok  validation refuses bad saves; a watch holds no youth data; the audit entry holds ids and counts only");

  // ---------------------------------------------------------------- picks write the change log
  await pick("y1", [multi], real);
  await pick("y2", [knots, ], new Date(real.getTime() + 1000));
  await pick("y3", [knots], new Date(real.getTime() + 2000));
  await pick("y3", [], new Date(real.getTime() + 3000)); // joins then leaves knots: nets out
  const sweep = (at: Date) => sendDueHonorWatchSummaries(at);

  // ---------------------------------------------------------------- the switch, then the window
  const early = await sweep(new Date(morning1.getTime() - 20 * 60 * 1000));
  assert(!early.due && (await allWatchMail()) === 0, "nothing goes before 6:00 AM Central");
  await prisma.notificationSetting.create({ data: { key, enabled: false } });
  resetNotificationSettingsCache();
  const off = await sweep(morning1);
  assert(off.status === "SWITCHED_OFF" && (await allWatchMail()) === 0, "the staff switch stops every watch");
  assert((await prisma.honorWatch.findMany({ where: { eventId, summaryAt: { not: null } } })).length === 0, "and stamps nothing, so the changes wait");
  await prisma.notificationSetting.deleteMany({ where: { key } });
  resetNotificationSettingsCache();

  // The real sweep order: the instructor sweep (which prunes the log) first, then the watches, several at once.
  await sendDueClassChangeEmails(morning1);
  await Promise.all([sweep(morning1), sweep(morning1), sweep(morning1)]);
  await sweep(morning1);
  await sweep(new Date(morning1.getTime() + 5 * HOUR));
  const honorMail = await mail(addr.honor[0]!);
  assert(honorMail.length === 1 && (await mail(addr.honor[1]!)).length === 1, `each address on the honor watch got one summary however many sweeps ran (got ${honorMail.length})`);
  const text = honorMail[0]!.bodyTextSnapshot;
  assert(text.includes("Joined: Kid y1 (Synthetic Pathfinders, age 12)") && text.includes("Watch honor 2 + Watch honor 3 (Sunday morning)"), "the shared class matches its SECOND honor, naming the youth, club, age, class and time");
  assert(!text.includes("Kid y2") && !text.includes("Kid y3"), "and nothing from the class it does not look at");
  assert(honorMail[0]!.idempotencyKey === `honor-watch-summary:${byHonor.id}:${tomorrowKey}:${addr.honor[0]}`, "keyed by watch, Central date and address");
  const classMail = await mail(addr.klass[0]!);
  assert(classMail.length === 1 && classMail[0]!.bodyTextSnapshot.includes("Joined: Kid y2 (Synthetic Pathfinders, age 13)"), "the class watch reports who joined that class");
  assert(!classMail[0]!.bodyTextSnapshot.includes("Kid y3"), "a join followed by a leave is not reported");
  assert((await mail(addr.none[0]!)).length === 0, "a watch whose honor had no change gets no email");
  for (const message of [...honorMail, ...classMail]) {
    assert(!`${message.subjectSnapshot}${message.bodyTextSnapshot}`.includes(birthSecret) && !/birth/i.test(message.bodyTextSnapshot), "no birth date in the email");
    assert(!JSON.stringify(message.metadata).includes("Kid") && !JSON.stringify(message.metadata).includes("example.test"), "the message record holds ids and counts only");
  }
  assert((await allWatchMail()) === 3, "three messages in all (two addresses and one)");
  const moved = await prisma.honorWatch.findMany({ where: { eventId } });
  assert(moved.every((row) => row.summaryAt?.getTime() === centralInstant(tomorrowKey, 6).getTime()), "every watch's summary point is the cutoff, quiet or not");
  console.log("ok  matches by honor (the second honor of a two-honor class) and by class, nets a join and a leave, sends once across several sweeps at once, and the switch holds");

  // ---------------------------------------------------------------- a quiet day, then a drop
  await sweep(morning2);
  assert((await allWatchMail()) === 3, "no email when nothing changed");
  // The leave is made AFTER the quiet day's sweep has moved every summary point to the day-2 cutoff, so the day-3 window owns it.
  await pick("y1", [], new Date(morning2.getTime() + HOUR)); // leaves the shared class
  await sendDueClassChangeEmails(morning3);
  await sweep(morning3);
  await sweep(morning3);
  const second = await mail(addr.honor[0]!);
  assert(second.length === 2 && second[1]!.bodyTextSnapshot.includes("Left: Kid y1") && !second[1]!.bodyTextSnapshot.includes("Joined:"), "the next summary has only what happened since");
  console.log("ok  a quiet day sends nothing; a drop is reported once, the next morning");

  // ---------------------------------------------------------------- retention: a row inside the window survives the prune
  await pick("y1", [multi], new Date(morning3.getTime() + HOUR));
  const old = await prisma.honorClassChange.create({
    data: { eventId, offeringId: multi, enrollmentId: `${P}_old`, registrationAttendeeId: attendee.y2!, kind: "JOINED", youthName: "Kid old", clubName: null, ageOnEventDate: 10, at: new Date(morning4.getTime() - 9 * DAY), immediateHandledAt: real },
    select: { id: true },
  });
  await sendDueClassChangeEmails(morning4); // prunes rows over eight days old
  assert((await prisma.honorClassChange.count({ where: { id: old.id } })) === 0, "the sweep prunes a row older than eight days");
  assert((await prisma.honorClassChange.count({ where: { eventId, youthName: "Kid y1", at: { gt: cutoffOf(morning3) } } })) === 1, "but not one inside the day's window");
  await sweep(morning4);
  const third = await mail(addr.honor[0]!);
  assert(third.length === 3 && third[2]!.bodyTextSnapshot.includes("Joined: Kid y1") && !third[2]!.bodyTextSnapshot.includes("Kid old"), "the pruned row is gone and the day's row is reported");
  console.log("ok  retention never takes a row inside a day's window");

  // ---------------------------------------------------------------- retargeting keeps the summary point; a paused event is suppressed
  const afterEdit = new Date(morning4.getTime() + 2 * HOUR);
  await replaceHonorWatches(eventId, adminId, {
    watches: [
      { id: byHonor.id, name: "Second honor of the shared class", recipients: addr.honor, honorIds: [honors[2]], offeringIds: [] },
      { id: byClass.id, name: "Knots class (renamed)", recipients: addr.klass, honorIds: [], offeringIds: [knots, quiet] },
    ],
  }, afterEdit);
  const edited = await prisma.honorWatch.findMany({ where: { eventId }, orderBy: { position: "asc" } });
  assert(edited.length === 2 && edited[0]!.id === byHonor.id && edited[1]!.name === "Knots class (renamed)" && !edited.some((row) => row.id === byQuiet.id), "the saved list replaces the old one, keeping ids");
  assert(edited.every((row) => row.summaryAt?.getTime() === cutoffOf(morning4).getTime()), "a save, even one that changes a watch's classes, keeps every summary point, so no change still owed is dropped");
  assert((await getHonorWatchPanel(eventId)).watches.length === 2, "the panel reads them back");

  await prisma.eventMessageSettings.create({ data: { eventId, senderName: "IMSDA Events", deliveryPaused: true, deliveryPausedAt: new Date() } });
  await prisma.honorClassChange.create({
    data: { eventId, offeringId: multi, enrollmentId: `${P}_p1`, registrationAttendeeId: attendee.y2!, kind: "JOINED", youthName: "Kid y2", clubName: null, ageOnEventDate: 13, at: new Date(morning4.getTime() + 3 * HOUR) },
  });
  const before = await allWatchMail();
  await sweep(morning5);
  const suppressed = await prisma.messageOutbox.findMany({ where: { eventId, templateKey: "HONOR_WATCH_SUMMARY", status: "SUPPRESSED" } });
  assert(suppressed.length === 2 && (await allWatchMail()) === before + 2, "a paused event's summaries are recorded as suppressed, never queued to send");
  console.log("ok  a retargeting save keeps each summary point; a paused event's summaries are suppressed");

  // ---------------------------------------------------------------- a cancelled registration, and a closed roster
  await prisma.eventMessageSettings.deleteMany({ where: { eventId } });
  // y2 has been in the Knots class since the start, so cancelling the registration logs its LEAVE; y1 leaves the shared class.
  await cancelRegistration(eventId, regId, adminId, "Synthetic cancellation", new Date(morning5.getTime() + 2 * HOUR));
  await sendDueClassChangeEmails(morning6);
  await sweep(morning6);
  const classMails = await mail(addr.klass[0]!);
  assert(classMails.length === 2 && classMails[1]!.bodyTextSnapshot.includes("Left: Kid y2") && !classMails[1]!.bodyTextSnapshot.includes("Joined:"), "the cancellation's leave from the watched class is reported to the class watch");
  const honorMails = await mail(addr.honor[0]!);
  assert(honorMails.length === 5 && honorMails[4]!.bodyTextSnapshot.includes("Left: Kid y1"), "and its leave from the shared class to the honor watch");
  await prisma.event.update({ where: { id: eventId }, data: { endsAt: new Date(morning6.getTime() - 20 * DAY), startsAt: new Date(morning6.getTime() - 22 * DAY) } });
  const sentBefore = await allWatchMail();
  await prisma.honorClassChange.create({
    data: { eventId, offeringId: knots, enrollmentId: `${P}_p2`, registrationAttendeeId: attendee.y3!, kind: "JOINED", youthName: "Kid y3", clubName: null, ageOnEventDate: 11, at: new Date(morning6.getTime() + HOUR) },
  });
  await sweep(morning7);
  assert((await allWatchMail()) === sentBefore, "a closed roster's watches are not read again");
  console.log("ok  a cancelled registration's picks leave the watched classes; a closed roster sends nothing");

  await cleanup();
  console.log("honor watch verified");
}

main()
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
