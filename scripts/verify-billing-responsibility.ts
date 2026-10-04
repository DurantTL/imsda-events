/**
 * Proves billing responsibility and organization billing contacts (#165, slice 1) against a real
 * PostgreSQL database, where the unit tests' in-memory stand-in can't:
 *
 * - the resolver records clubs under their sponsoring church, a group under its billing person,
 *   and leaves a club with no church and a free-text registration unresolved; it is idempotent
 *   on retry and under parallel runs (one row and one history row per registration);
 * - a staff link or override survives re-resolution and is audited with ids only;
 * - billing contacts are conference-wide: only a system administrator can add, replace, verify,
 *   end or read the history of one. A finance manager of event A who links a church that is only
 *   on event B is refused for every contact action and sees only that church's active contact's
 *   name and email, never its phone or history;
 * - at most one active billing contact per organization, enforced by the database even when
 *   several administrators replace it at once; replacing keeps the history; a contact row can
 *   never be deleted or rewritten; the same contact is reused by another event;
 * - the append-only history survives event, registration and user deletion (foreign-key actions)
 *   but refuses a direct delete or update;
 * - the check constraints refuse a party that does not match its kind and an override with no
 *   reason; the responsibility history refuses updates;
 * - changing the invoice grouping is audited, and no audit row holds a contact's name, email or phone.
 *
 * Uses fictitious rows it creates and removes itself.
 *
 *   npm run test:billing-responsibility
 */
import { loadEnvConfig } from "@next/env";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { assertLocalDatabase } from "./support/local-only-guard";
import { fillBlankSyntheticEnv } from "./support/synthetic-env";
import {
  BillingResponsibilityError,
  endOrganizationBillingContact,
  getBillingResponsibilityView,
  getOrganizationBillingContactAdminView,
  linkRegistrationToOrganization,
  resolveEventBillingResponsibility,
  setInvoiceGrouping,
  setOrganizationBillingContact,
  verifyOrganizationBillingContact,
} from "@/modules/billing-responsibility/repository";

loadEnvConfig(process.cwd());
// Local-only, before any Prisma client or connection exists.
assertLocalDatabase(process.env, "run this verification");
fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "verify-billing-synthetic-key-not-a-secret");

const prisma = new PrismaClient();
const P = `br165_${randomUUID().slice(0, 8)}`;
const ids = {
  staff: `${P}_staff`,
  staff2: `${P}_staff2`,
  doomed: `${P}_doomed`,
  eventC: `${P}_ev_c`,
  club5: `${P}_club_5`,
  eventA: `${P}_ev_a`,
  eventB: `${P}_ev_b`,
  churchA: `${P}_church_a`,
  churchB: `${P}_church_b`,
  club1: `${P}_club_1`,
  club2: `${P}_club_2`,
  club3: `${P}_club_3`,
  club4: `${P}_club_4`,
  person: `${P}_person`,
  holder: `${P}_holder`,
};
const SECRET_NAME = "Verify Treasurer Only";
const SECRET_EMAIL = `verify.treasurer.${P}@example.test`;
const SECRET_PHONE = "(515) 555-0177";
const contact = { name: SECRET_NAME, email: SECRET_EMAIL, phone: SECRET_PHONE, roleLabel: "Treasurer" };

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function rejects(promise: Promise<unknown>) {
  return promise.then(() => false, () => true);
}

async function cleanup() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: [ids.eventA, ids.eventB, ids.eventC] } }, { actorUserId: { in: [ids.staff, ids.staff2, ids.doomed] } }, { entityId: { in: [ids.churchA, ids.churchB] } }] } });
  await prisma.event.deleteMany({ where: { id: { in: [ids.eventA, ids.eventB, ids.eventC] } } });
  // A contact is never deleted by the application; this local cleanup turns the guard off for one transaction.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" DISABLE TRIGGER "OrganizationBillingContact_no_delete"'),
    prisma.organizationBillingContact.deleteMany({ where: { organizationId: { in: [ids.churchA, ids.churchB] } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" ENABLE TRIGGER "OrganizationBillingContact_no_delete"'),
  ]);
  await prisma.organization.deleteMany({ where: { id: { in: [ids.club1, ids.club2, ids.club3, ids.club4, ids.club5] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ids.churchA, ids.churchB] } } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.person, ids.holder] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.staff2, ids.doomed] } } });
}

let registrationCounter = 0;
async function registration(eventId: string, extras: { club?: string; group?: boolean; responses?: boolean } = {}) {
  registrationCounter += 1;
  const created = await prisma.registration.create({
    data: {
      eventId,
      accountHolderPersonId: ids.holder,
      confirmationCode: `${P}-${registrationCounter}`,
      status: "CONFIRMED",
      totalAmount: "100.00",
    },
    select: { id: true },
  });
  if (extras.club) await prisma.clubEventRegistration.create({ data: { eventId, organizationId: extras.club, registrationId: created.id } });
  if (extras.group) await prisma.groupEventRegistration.create({ data: { eventId, registrationId: created.id, billingPersonId: ids.person } });
  return created.id;
}

async function main() {
  await cleanup();
  await prisma.user.createMany({ data: [
    { id: ids.staff, email: `${P}_staff@example.test`, displayName: "Fran Finance" },
    { id: ids.staff2, email: `${P}_staff2@example.test`, displayName: "Fay Finance" },
    { id: ids.doomed, email: `${P}_doomed@example.test`, displayName: "Dee Departing" },
  ] });
  await prisma.person.createMany({ data: [
    { id: ids.person, firstName: "Gail", lastName: "Group" },
    { id: ids.holder, firstName: "Pat", lastName: "Holder" },
  ] });
  await prisma.organization.createMany({ data: [
    { id: ids.churchA, type: "CHURCH", name: `Billing Check Church A ${P}`, normalizedName: `billing check church a ${P}` },
    { id: ids.churchB, type: "CHURCH", name: `Billing Check Church B ${P}`, normalizedName: `billing check church b ${P}` },
  ] });
  await prisma.organization.createMany({ data: [
    { id: ids.club1, type: "CLUB", name: `Billing Check Club 1 ${P}`, normalizedName: `billing check club 1 ${P}`, parentOrganizationId: ids.churchA },
    { id: ids.club2, type: "CLUB", name: `Billing Check Club 2 ${P}`, normalizedName: `billing check club 2 ${P}`, parentOrganizationId: ids.churchA },
    { id: ids.club3, type: "CLUB", name: `Billing Check Club 3 ${P}`, normalizedName: `billing check club 3 ${P}` },
    { id: ids.club4, type: "CLUB", name: `Billing Check Club 4 ${P}`, normalizedName: `billing check club 4 ${P}`, parentOrganizationId: ids.churchA },
    { id: ids.club5, type: "CLUB", name: `Billing Check Club 5 ${P}`, normalizedName: `billing check club 5 ${P}`, parentOrganizationId: ids.churchB },
  ] });
  const when = { startsAt: new Date("2027-04-01T00:00:00Z"), endsAt: new Date("2027-04-03T00:00:00Z"), audience: "CLUB" as const, billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const };
  await prisma.event.create({ data: { id: ids.eventA, slug: `${P}-a`, name: "Synthetic Camporee A", ...when } });
  await prisma.event.create({ data: { id: ids.eventB, slug: `${P}-b`, name: "Synthetic Camporee B", ...when } });
  await prisma.event.create({ data: { id: ids.eventC, slug: `${P}-c`, name: "Synthetic Camporee C", ...when } });

  const rClub1 = await registration(ids.eventA, { club: ids.club1 });
  const rClub2 = await registration(ids.eventA, { club: ids.club2 });
  const rClub3 = await registration(ids.eventA, { club: ids.club3 });
  const rGroup = await registration(ids.eventA, { group: true });
  const rTyped = await registration(ids.eventA);
  const rOtherEvent = await registration(ids.eventB, { club: ids.club1 });
  // Church B is billed on event B only (through club 5); no registration of event A names it by rule.
  await registration(ids.eventB, { club: ids.club5 });

  // Dry run writes nothing; the report names what cannot be mapped.
  const dry = await resolveEventBillingResponsibility(ids.eventA, { apply: false });
  assert(dry.dryRun && dry.created === 5 && dry.unresolved.length === 2, "dry run reports five to record and two unresolved");
  assert((await prisma.registrationBillingResponsibility.count({ where: { eventId: ids.eventA } })) === 0, "dry run wrote nothing");

  // Apply, then retry: idempotent.
  await resolveEventBillingResponsibility(ids.eventA, { apply: true, actorUserId: ids.staff });
  const again = await resolveEventBillingResponsibility(ids.eventA, { apply: true, actorUserId: ids.staff });
  assert(again.created === 0 && again.updated === 0 && again.unchanged === 5, "second run changes nothing");
  const rows = await prisma.registrationBillingResponsibility.findMany({ where: { eventId: ids.eventA } });
  const byRegistration = new Map(rows.map((row) => [row.registrationId, row]));
  assert(byRegistration.get(rClub1)?.organizationId === ids.churchA && byRegistration.get(rClub1)?.source === "CLUB_SPONSORING_CHURCH", "club 1 is billed to its church");
  assert(byRegistration.get(rClub2)?.organizationId === ids.churchA, "club 2 is billed to the same church");
  assert(byRegistration.get(rClub3)?.kind === "UNRESOLVED" && byRegistration.get(rClub3)?.organizationId === null, "a club with no church is unresolved");
  assert(byRegistration.get(rGroup)?.kind === "PERSON" && byRegistration.get(rGroup)?.personId === ids.person, "a group is billed to its person");
  assert(byRegistration.get(rTyped)?.kind === "UNRESOLVED", "a free-text registration is unresolved");
  assert(!byRegistration.has(rOtherEvent), "another event's registration is untouched");
  assert((await prisma.registrationBillingResponsibilityChange.count({ where: { eventId: ids.eventA } })) === 5, "one history row per registration");

  // Parallel runs on a fresh event leave one row and one history row per registration.
  const rRace = await registration(ids.eventA, { club: ids.club4 });
  await Promise.all(Array.from({ length: 6 }, () => resolveEventBillingResponsibility(ids.eventA, { apply: true, actorUserId: ids.staff })));
  assert((await prisma.registrationBillingResponsibility.count({ where: { registrationId: rRace } })) === 1, "parallel resolvers leave one row");
  assert((await prisma.registrationBillingResponsibilityChange.count({ where: { registrationId: rRace } })) === 1, "parallel resolvers leave one history row");

  // Staff decisions: link, override (reason required), survive re-resolution.
  await linkRegistrationToOrganization({ eventId: ids.eventA, registrationId: rTyped, organizationId: ids.churchB, actorUserId: ids.staff });
  assert(await rejects(linkRegistrationToOrganization({ eventId: ids.eventA, registrationId: rClub1, organizationId: ids.churchB, actorUserId: ids.staff })), "an override needs a reason");
  await linkRegistrationToOrganization({ eventId: ids.eventA, registrationId: rClub1, organizationId: ids.churchB, reason: "Billed through the school board.", actorUserId: ids.staff });
  assert(await rejects(linkRegistrationToOrganization({ eventId: ids.eventA, registrationId: rOtherEvent, organizationId: ids.churchB, reason: "x", actorUserId: ids.staff })), "another event's registration is refused");
  const kept = await resolveEventBillingResponsibility(ids.eventA, { apply: true, actorUserId: ids.staff });
  assert(kept.keptStaffDecisions === 2 && kept.updated === 0, "re-resolution keeps staff decisions");
  const overridden = await prisma.registrationBillingResponsibility.findUniqueOrThrow({ where: { registrationId: rClub1 } });
  assert(overridden.organizationId === ids.churchB && overridden.source === "STAFF_OVERRIDE" && overridden.setByUserId === ids.staff, "override stands and names the actor");

  // Billing contacts are conference-wide. The administrators below are system administrators; the
  // event A finance manager is not, and is the one who could previously reach church B's contact.
  const admin1 = { id: ids.staff, globalRole: "SYSTEM_ADMIN" };
  const admin2 = { id: ids.staff2, globalRole: "SYSTEM_ADMIN" };
  const financeManager = { id: ids.staff, globalRole: null };
  await resolveEventBillingResponsibility(ids.eventB, { apply: true, actorUserId: ids.staff });
  await setOrganizationBillingContact({ organizationId: ids.churchB, contact: { ...contact, name: "Ended Predecessor", phone: "(515) 555-0111" }, actor: admin1 });
  const predecessor = await prisma.organizationBillingContact.findFirstOrThrow({ where: { organizationId: ids.churchB, effectiveTo: null } });
  await setOrganizationBillingContact({ organizationId: ids.churchB, contact, actor: admin1 });
  const churchBContact = await prisma.organizationBillingContact.findFirstOrThrow({ where: { organizationId: ids.churchB, effectiveTo: null } });
  // Event A's finance manager (already linked church B to a registration of event A above) cannot change it...
  const refusedWrites = [
    setOrganizationBillingContact({ organizationId: ids.churchB, contact: { ...contact, name: "Hijacked" }, actor: financeManager }),
    verifyOrganizationBillingContact({ organizationId: ids.churchB, contactId: churchBContact.id, actor: financeManager }),
    endOrganizationBillingContact({ organizationId: ids.churchB, contactId: churchBContact.id, actor: financeManager }),
    getOrganizationBillingContactAdminView(ids.churchB, financeManager),
  ];
  for (const refused of refusedWrites) assert(await rejects(refused), "a finance manager cannot manage or read a billing contact");
  const unchanged = await prisma.organizationBillingContact.findMany({ where: { organizationId: ids.churchB } });
  assert(unchanged.length === 2 && unchanged.find((row) => row.effectiveTo === null)?.id === churchBContact.id && unchanged.find((row) => row.effectiveTo === null)?.verifiedAt === null, "the refused actions changed nothing");
  // ...and reads only the active contact's name and email, never its phone, history, or the ended predecessor.
  const eventAView = await getBillingResponsibilityView(ids.eventA);
  const linkedGroup = eventAView.groups.find((entry) => entry.party.kind === "ORGANIZATION" && entry.party.id === ids.churchB);
  assert(linkedGroup?.contact?.name === SECRET_NAME && linkedGroup.contact.email === SECRET_EMAIL, "event A sees church B's active contact name and email");
  const eventAJson = JSON.stringify(eventAView);
  assert(!eventAJson.includes(SECRET_PHONE) && !eventAJson.includes("555-0111") && !eventAJson.includes("Ended Predecessor"), "event A sees no phone and no past contact");
  assert(!("history" in eventAView), "event A's view carries no contact history");
  assert((await prisma.organizationBillingContact.findUniqueOrThrow({ where: { id: predecessor.id } })).effectiveTo !== null, "the predecessor stays ended");
  // Contact audit rows are conference-wide: no event, ids only.
  const contactAudits = await prisma.auditLog.findMany({ where: { entityId: ids.churchB, action: { startsWith: "BILLING_CONTACT" } } });
  assert(contactAudits.length === 2 && contactAudits.every((row) => row.eventId === null && row.entityType === "Organization"), "contact audit rows carry no event");

  // One active, history kept, concurrent replacement settled by the database.
  await setOrganizationBillingContact({ organizationId: ids.churchA, contact, actor: admin1 });
  assert(await rejects(setOrganizationBillingContact({ organizationId: `${P}_nobody`, contact, actor: admin1 })), "an unknown organization is refused");
  const first = await prisma.organizationBillingContact.findFirstOrThrow({ where: { organizationId: ids.churchA, effectiveTo: null } });
  await verifyOrganizationBillingContact({ organizationId: ids.churchA, contactId: first.id, actor: admin1 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
    setOrganizationBillingContact({ organizationId: ids.churchA, contact: { ...contact, name: `Replacement ${index}` }, actor: index % 2 ? admin1 : admin2 })));
  const succeeded = results.filter((result) => result.status === "fulfilled").length;
  assert(succeeded >= 1, "at least one replacement succeeds");
  for (const result of results) {
    if (result.status === "rejected") assert(result.reason instanceof BillingResponsibilityError && result.reason.code === "CONCURRENT_CHANGE", "a losing replacement reports a concurrent change");
  }
  const all = await prisma.organizationBillingContact.findMany({ where: { organizationId: ids.churchA } });
  assert(all.filter((row) => row.effectiveTo === null).length === 1, "exactly one active contact");
  assert(all.length === 1 + succeeded, "every replaced contact stays in the history");
  assert(all.find((row) => row.effectiveTo === null)?.verifiedAt === null, "a replacement starts unverified");
  assert(all.find((row) => row.id === first.id)?.effectiveTo !== null && all.find((row) => row.id === first.id)?.verifiedAt !== null, "the replaced contact keeps its verification in history");
  const adminView = await getOrganizationBillingContactAdminView(ids.churchA, admin1);
  assert(adminView && adminView.history.length === all.length && adminView.active, "a system administrator reads the full history");

  // The database itself refuses what the service never does.
  assert(await rejects(prisma.organizationBillingContact.create({ data: { organizationId: ids.churchA, name: "Second", email: "second@example.test", roleLabel: "Treasurer" } })), "a second active contact is refused");
  assert(await rejects(prisma.organizationBillingContact.deleteMany({ where: { organizationId: ids.churchA } })), "a contact cannot be deleted");
  assert(await rejects(prisma.organizationBillingContact.create({ data: { organizationId: ids.churchB, name: "  ", email: "x@example.test", roleLabel: "Treasurer" } })), "a blank name is refused");
  assert(await rejects(prisma.registrationBillingResponsibility.update({ where: { registrationId: rTyped }, data: { kind: "PERSON" } })), "a person kind with no person is refused");
  assert(await rejects(prisma.registrationBillingResponsibility.update({ where: { registrationId: rGroup }, data: { organizationId: ids.churchA } })), "a person and an organization together are refused");
  assert(await rejects(prisma.registrationBillingResponsibility.update({ where: { registrationId: rClub1 }, data: { reason: null } })), "an override with no reason is refused");
  assert(await rejects(prisma.registrationBillingResponsibilityChange.updateMany({ where: { registrationId: rClub1 }, data: { reason: "rewritten" } })), "history cannot be updated");
  assert(await rejects(prisma.registrationBillingResponsibilityChange.deleteMany({ where: { registrationId: rClub1 } })), "history cannot be deleted directly");
  const active = await prisma.organizationBillingContact.findFirstOrThrow({ where: { organizationId: ids.churchA, effectiveTo: null } });
  const ended = await prisma.organizationBillingContact.findUniqueOrThrow({ where: { id: first.id } });
  assert(await rejects(prisma.organizationBillingContact.update({ where: { id: active.id }, data: { name: "Rewritten" } })), "a contact's details cannot be rewritten");
  assert(await rejects(prisma.organizationBillingContact.update({ where: { id: active.id }, data: { email: "rewritten@example.test" } })), "a contact's email cannot be rewritten");
  assert(await rejects(prisma.organizationBillingContact.update({ where: { id: ended.id }, data: { effectiveTo: new Date() } })), "an ended contact's end date cannot change");
  assert(await rejects(prisma.organizationBillingContact.update({ where: { id: ended.id }, data: { effectiveTo: null } })), "an ended contact cannot be reopened");
  assert(await rejects(prisma.organizationBillingContact.update({ where: { id: ended.id }, data: { verifiedAt: null } })), "a verification cannot be erased");
  await prisma.organizationBillingContact.update({ where: { id: active.id }, data: { verifiedAt: new Date(), verifiedByUserId: ids.staff } });
  assert(await rejects(prisma.organizationBillingContact.update({ where: { id: active.id }, data: { verifiedAt: new Date(0) } })), "a verification cannot be rewritten");

  // Foreign-key actions still work: user deletion clears the actor, registration and event deletion cascade the history.
  await prisma.organizationBillingContact.updateMany({ where: { id: active.id }, data: { effectiveTo: new Date(), endedByUserId: ids.doomed, endReason: "Departing admin test" } });
  const rDoomed = await registration(ids.eventC, { club: ids.club1 });
  await resolveEventBillingResponsibility(ids.eventC, { apply: true, actorUserId: ids.doomed });
  assert(await prisma.registrationBillingResponsibilityChange.count({ where: { registrationId: rDoomed, actorUserId: ids.doomed } }) === 1, "the change names its actor");
  await prisma.user.delete({ where: { id: ids.doomed } });
  assert(await prisma.registrationBillingResponsibilityChange.count({ where: { registrationId: rDoomed, actorUserId: null } }) === 1, "deleting a user clears the actor on the history");
  assert((await prisma.organizationBillingContact.findUniqueOrThrow({ where: { id: active.id } })).endedByUserId === null, "deleting a user clears the contact's actor");
  await prisma.registration.delete({ where: { id: rDoomed } });
  assert(await prisma.registrationBillingResponsibilityChange.count({ where: { registrationId: rDoomed } }) === 0, "deleting a registration removes its history");
  const rGone = await registration(ids.eventC, { club: ids.club2 });
  await resolveEventBillingResponsibility(ids.eventC, { apply: true, actorUserId: ids.staff });
  assert(await prisma.registrationBillingResponsibilityChange.count({ where: { eventId: ids.eventC } }) === 1, "event C has history");
  await prisma.event.delete({ where: { id: ids.eventC } });
  assert(await prisma.registrationBillingResponsibilityChange.count({ where: { registrationId: rGone } }) === 0, "deleting an event removes its history and responsibilities");

  // The contact is reused by another event without re-entering it.
  const otherView = await getBillingResponsibilityView(ids.eventB);
  const group = otherView.groups.find((entry) => entry.party.kind === "ORGANIZATION" && entry.party.id === ids.churchB);
  assert(group && group.contact && group.readiness === "NOT_VERIFIED", "another event sees the same active contact");

  // Grouping: default per church, change is audited and previews per club.
  const before = await getBillingResponsibilityView(ids.eventA);
  assert(before.invoiceGrouping === "PER_CHURCH", "default is one invoice per church");
  await setInvoiceGrouping({ eventId: ids.eventA, invoiceGrouping: "PER_CLUB", actorUserId: ids.staff });
  const perClub = await getBillingResponsibilityView(ids.eventA);
  assert(perClub.groups.length > before.groups.length, "per-club grouping splits clubs of one church");
  const audits = await prisma.auditLog.findMany({ where: { eventId: ids.eventA, action: "INVOICE_GROUPING_CHANGED" } });
  assert(audits.length === 1, "grouping change is audited once");

  // No audit row holds a contact's personal details.
  const everyAudit = JSON.stringify(await prisma.auditLog.findMany({ where: { OR: [{ eventId: { in: [ids.eventA, ids.eventB] } }, { entityId: { in: [ids.churchA, ids.churchB] } }] } }));
  for (const secret of [SECRET_NAME, SECRET_EMAIL, SECRET_PHONE]) assert(!everyAudit.includes(secret), "no audit row holds contact details");

  console.log("Billing responsibility verified: resolver idempotent and race-safe, staff decisions kept, one active contact, history kept, constraints enforced, grouping audited.");
}

main()
  .then(async () => { await cleanup(); })
  .catch(async (error) => {
    console.error(error);
    await cleanup().catch(() => undefined);
    process.exitCode = 1;
  })
  .finally(async () => { await prisma.$disconnect(); });
