/**
 * Proves billing responsibility and organization billing contacts (#165, slice 1) against a real
 * PostgreSQL database, where the unit tests' in-memory stand-in can't:
 *
 * - the resolver records clubs under their sponsoring church, a group under its billing person,
 *   and leaves a club with no church and a free-text registration unresolved; it is idempotent
 *   on retry and under parallel runs (one row and one history row per registration);
 * - a staff link or override survives re-resolution and is audited with ids only;
 * - at most one active billing contact per organization, enforced by the database even when
 *   several staff members replace it at once; replacing keeps the history; a contact row can
 *   never be deleted; the same contact is reused by another event;
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
  getBillingResponsibilityView,
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
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: { in: [ids.eventA, ids.eventB] } }, { actorUserId: { in: [ids.staff, ids.staff2] } }] } });
  await prisma.event.deleteMany({ where: { id: { in: [ids.eventA, ids.eventB] } } });
  // A contact is never deleted by the application; this local cleanup turns the guard off for one transaction.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" DISABLE TRIGGER "OrganizationBillingContact_no_delete"'),
    prisma.organizationBillingContact.deleteMany({ where: { organizationId: { in: [ids.churchA, ids.churchB] } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" ENABLE TRIGGER "OrganizationBillingContact_no_delete"'),
  ]);
  await prisma.organization.deleteMany({ where: { id: { in: [ids.club1, ids.club2, ids.club3, ids.club4] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ids.churchA, ids.churchB] } } });
  await prisma.person.deleteMany({ where: { id: { in: [ids.person, ids.holder] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ids.staff, ids.staff2] } } });
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
  ] });
  const when = { startsAt: new Date("2027-04-01T00:00:00Z"), endsAt: new Date("2027-04-03T00:00:00Z"), audience: "CLUB" as const, billingMode: "DEFERRED_ORGANIZATION_INVOICE" as const };
  await prisma.event.create({ data: { id: ids.eventA, slug: `${P}-a`, name: "Synthetic Camporee A", ...when } });
  await prisma.event.create({ data: { id: ids.eventB, slug: `${P}-b`, name: "Synthetic Camporee B", ...when } });

  const rClub1 = await registration(ids.eventA, { club: ids.club1 });
  const rClub2 = await registration(ids.eventA, { club: ids.club2 });
  const rClub3 = await registration(ids.eventA, { club: ids.club3 });
  const rGroup = await registration(ids.eventA, { group: true });
  const rTyped = await registration(ids.eventA);
  const rOtherEvent = await registration(ids.eventB, { club: ids.club1 });

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

  // Billing contacts: one active, history kept, concurrent replacement settled by the database.
  await setOrganizationBillingContact({ eventId: ids.eventA, organizationId: ids.churchA, contact, actorUserId: ids.staff });
  assert(await rejects(setOrganizationBillingContact({ eventId: ids.eventA, organizationId: `${P}_nobody`, contact, actorUserId: ids.staff })), "an organization not on the event is refused");
  const first = await prisma.organizationBillingContact.findFirstOrThrow({ where: { organizationId: ids.churchA, effectiveTo: null } });
  await verifyOrganizationBillingContact({ eventId: ids.eventA, organizationId: ids.churchA, contactId: first.id, actorUserId: ids.staff });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
    setOrganizationBillingContact({ eventId: ids.eventA, organizationId: ids.churchA, contact: { ...contact, name: `Replacement ${index}` }, actorUserId: index % 2 ? ids.staff : ids.staff2 })));
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

  // The database itself refuses what the service never does.
  assert(await rejects(prisma.organizationBillingContact.create({ data: { organizationId: ids.churchA, name: "Second", email: "second@example.test", roleLabel: "Treasurer" } })), "a second active contact is refused");
  assert(await rejects(prisma.organizationBillingContact.deleteMany({ where: { organizationId: ids.churchA } })), "a contact cannot be deleted");
  assert(await rejects(prisma.organizationBillingContact.create({ data: { organizationId: ids.churchB, name: "  ", email: "x@example.test", roleLabel: "Treasurer" } })), "a blank name is refused");
  assert(await rejects(prisma.registrationBillingResponsibility.update({ where: { registrationId: rTyped }, data: { kind: "PERSON" } })), "a person kind with no person is refused");
  assert(await rejects(prisma.registrationBillingResponsibility.update({ where: { registrationId: rGroup }, data: { organizationId: ids.churchA } })), "a person and an organization together are refused");
  assert(await rejects(prisma.registrationBillingResponsibility.update({ where: { registrationId: rClub1 }, data: { reason: null } })), "an override with no reason is refused");
  assert(await rejects(prisma.registrationBillingResponsibilityChange.updateMany({ where: { registrationId: rClub1 }, data: { reason: "rewritten" } })), "history cannot be updated");

  // The contact is reused by another event without re-entering it.
  const otherView = await getBillingResponsibilityView(ids.eventB);
  const group = otherView.groups.find((entry) => entry.party.kind === "ORGANIZATION" && entry.party.id === ids.churchA);
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
  const everyAudit = JSON.stringify(await prisma.auditLog.findMany({ where: { eventId: { in: [ids.eventA, ids.eventB] } } }));
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
