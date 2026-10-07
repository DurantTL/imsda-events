/**
 * Proves who may sponsor a club (#822) against a real PostgreSQL database.
 * Synthetic names only. Companies and groups are congregations that are not yet
 * organized as churches, so an active church, company or group may sponsor a
 * club, and nothing else may:
 *
 * - a club is created under a church, a company and a group, and refused under
 *   a school, a camp, an inactive company and another club (stored unchanged);
 * - editing a club moves it to a company, the club profile does the same, and
 *   both refuse a school;
 * - the sponsor picker lists churches, companies and groups, never a school;
 * - a church, company or group with an active club cannot be deactivated from
 *   the directory until the club moves or is deactivated;
 * - a company-sponsored club's church-billed registration is billed to the
 *   company: the billing-responsibility rule names it, the church-owed list
 *   shows it by name, and staff may keep a billing contact for it;
 * - the directory options (member forms) list the company and the group.
 *
 * Creates and removes its own rows. Needs a local database with a system
 * administrator (npm run db:seed).
 *
 *   npm run test:organization-sponsors
 */
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const P = `os822${Date.now().toString(36)}`;
const ids = {
  church: `${P}_church`,
  company: `${P}_company`,
  closedCompany: `${P}_company_closed`,
  group: `${P}_group`,
  school: `${P}_school`,
  camp: `${P}_camp`,
  event: `${P}_event`,
  holder: `${P}_holder`,
};
const names = {
  church: `${P} Sample Hills SDA Church`,
  company: `${P} Sample Youth Company`,
  group: `${P} Sample Fellowship Group`,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function cleanup() {
  const orgIds = (await prisma.organization.findMany({ where: { OR: [{ id: { startsWith: P } }, { name: { startsWith: P } }] }, select: { id: true } })).map((row) => row.id);
  await prisma.registrationBillingResponsibility.deleteMany({ where: { registration: { eventId: ids.event } } });
  await prisma.clubEventRegistration.deleteMany({ where: { eventId: ids.event } });
  await prisma.registration.deleteMany({ where: { eventId: ids.event } });
  // A contact is never deleted by the application; this local cleanup turns the guard off for one transaction.
  await prisma.$transaction([
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" DISABLE TRIGGER "OrganizationBillingContact_no_delete"'),
    prisma.organizationBillingContact.deleteMany({ where: { organizationId: { in: orgIds } } }),
    prisma.$executeRawUnsafe('ALTER TABLE "OrganizationBillingContact" ENABLE TRIGGER "OrganizationBillingContact_no_delete"'),
  ]);
  await prisma.auditLog.deleteMany({ where: { OR: [{ eventId: ids.event }, { entityId: { in: orgIds } }] } });
  await prisma.event.deleteMany({ where: { id: ids.event } });
  await prisma.clubProfile.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds }, type: "CLUB" } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.person.deleteMany({ where: { id: ids.holder } });
}

async function main() {
  const repo = await import("../modules/organizations/repository");
  const profileRepo = await import("../modules/organizations/club-profile-repository");
  const { clubProfileInputSchema } = await import("../modules/organizations/club-profile-schemas");
  const { setDirectoryOrganizationActive } = await import("../modules/organizations/eadventist-import-repository");
  const { listChurchDirectoryNames } = await import("../modules/organizations/directory-options");
  const { resolveEventBillingResponsibility } = await import("../modules/billing-responsibility/repository");
  const { setOrganizationBillingContact } = await import("../modules/billing-responsibility/repository");
  const { listChurchAmountsOwed } = await import("../modules/club-registrations/repository");

  const admin = await prisma.user.findFirst({ where: { globalRole: "SYSTEM_ADMIN" }, select: { id: true, email: true, displayName: true, globalRole: true } });
  assert(admin, "needs a system administrator in the local database (npm run db:seed)");

  await cleanup();
  try {
    await prisma.organization.createMany({ data: [
      { id: ids.church, type: "CHURCH", name: names.church, normalizedName: names.church.toLowerCase() },
      { id: ids.company, type: "COMPANY", name: names.company, normalizedName: names.company.toLowerCase() },
      { id: ids.closedCompany, type: "COMPANY", name: `${P} Closed Company`, normalizedName: `${P} closed company`.toLowerCase(), isActive: false },
      { id: ids.group, type: "GROUP", name: names.group, normalizedName: names.group.toLowerCase() },
      { id: ids.school, type: "SCHOOL", name: `${P} Sample School`, normalizedName: `${P} sample school`.toLowerCase() },
      { id: ids.camp, type: "CAMP", name: `${P} Sample Camp`, normalizedName: `${P} sample camp`.toLowerCase() },
    ] });

    const refusedCode = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        return error instanceof repo.OrganizationOperationError ? error.code : `other: ${String(error)}`;
      }
      return null;
    };
    const createClub = (name: string, parentOrganizationId: string | null) =>
      repo.createOrganization({ type: "CLUB", name: `${P} ${name}`, parentOrganizationId, isActive: true }, admin.id);
    const clubNamed = (name: string) => prisma.organization.findFirst({ where: { type: "CLUB", name: `${P} ${name}` }, select: { id: true, parentOrganizationId: true, updatedAt: true, isActive: true } });

    // Accepted: church, company, group.
    await createClub("Church Club", ids.church);
    await createClub("Company Club", ids.company);
    await createClub("Group Club", ids.group);
    assert((await clubNamed("Church Club"))?.parentOrganizationId === ids.church, "a club is created under a church");
    assert((await clubNamed("Company Club"))?.parentOrganizationId === ids.company, "a club is created under a company");
    assert((await clubNamed("Group Club"))?.parentOrganizationId === ids.group, "a club is created under a group");

    // Refused: school, camp, inactive company, a club, nothing.
    for (const [label, parent] of [["School", ids.school], ["Camp", ids.camp], ["Closed", ids.closedCompany]] as const) {
      const code = await refusedCode(() => createClub(`${label} Club`, parent));
      assert(code === "ORGANIZATION_PARENT_INVALID", `a club under a ${label.toLowerCase()} is refused (${code})`);
      assert(!(await clubNamed(`${label} Club`)), `no club was stored under a ${label.toLowerCase()}`);
    }
    const clubParent = (await clubNamed("Church Club"))!.id;
    assert(await refusedCode(() => createClub("Nested Club", clubParent)) === "ORGANIZATION_PARENT_INVALID", "a club under a club is refused");
    assert(await refusedCode(() => createClub("Orphan Club", null)) === "ORGANIZATION_PARENT_REQUIRED", "a club with no sponsor is refused");

    // Edit: move the church club to the company, refuse a school.
    const churchClub = (await clubNamed("Church Club"))!;
    await repo.updateOrganization(churchClub.id, { name: `${P} Church Club`, parentOrganizationId: ids.company, isActive: true, expectedUpdatedAt: churchClub.updatedAt.toISOString() }, admin.id);
    const moved = (await clubNamed("Church Club"))!;
    assert(moved.parentOrganizationId === ids.company, "editing moves a club to a company");
    const editRefused = await refusedCode(() => repo.updateOrganization(moved.id, { name: `${P} Church Club`, parentOrganizationId: ids.school, isActive: true, expectedUpdatedAt: moved.updatedAt.toISOString() }, admin.id));
    assert(editRefused === "ORGANIZATION_PARENT_INVALID" && (await clubNamed("Church Club"))!.parentOrganizationId === ids.company, "editing a club to a school is refused and changes nothing");

    // The club profile page's sponsor field follows the same rule.
    const profile = (name: string, sponsor: string) => clubProfileInputSchema.parse({ name, sponsoringChurchId: sponsor });
    await profileRepo.updateClubProfile(moved.id, profile(`${P} Church Club`, ids.group), { userId: admin.id });
    assert((await clubNamed("Church Club"))!.parentOrganizationId === ids.group, "the club profile moves a club to a group");
    const profileRefused = await refusedCode(() => profileRepo.updateClubProfile(moved.id, profile(`${P} Church Club`, ids.school), { userId: admin.id }));
    assert(profileRefused === "ORGANIZATION_PARENT_INVALID" && (await clubNamed("Church Club"))!.parentOrganizationId === ids.group, "the club profile refuses a school");
    await profileRepo.updateClubProfile(moved.id, profile(`${P} Church Club`, ids.church), { userId: admin.id });

    // Pickers.
    const staffPicker = await repo.listSponsorOptions();
    const kind = (id: string) => staffPicker.find((option) => option.id === id)?.type;
    assert(kind(ids.church) === "CHURCH" && kind(ids.company) === "COMPANY" && kind(ids.group) === "GROUP", "the staff picker offers churches, companies and groups, with their kind");
    assert(!staffPicker.some((option) => option.id === ids.school || option.id === ids.camp), "the staff picker never offers a school or camp");
    const profilePicker = await profileRepo.listSponsorOptions(null);
    assert(profilePicker.some((option) => option.id === ids.company) && !profilePicker.some((option) => option.id === ids.closedCompany || option.id === ids.school), "the club profile picker lists active sponsors only");
    const profilePickerWithCurrent = await profileRepo.listSponsorOptions(ids.closedCompany);
    assert(profilePickerWithCurrent.some((option) => option.id === ids.closedCompany), "a club's current sponsor stays listed even when inactive");
    const directoryNames = await listChurchDirectoryNames();
    assert(directoryNames.includes(names.company) && directoryNames.includes(names.group) && directoryNames.includes(names.church), "the directory options list the company, group and church");

    // A sponsor with an active club cannot be deactivated from the directory.
    const closeRefused = await refusedCode(() => setDirectoryOrganizationActive(ids.company, false, admin.id));
    assert(closeRefused === "ORGANIZATION_HAS_ACTIVE_CLUBS" && (await prisma.organization.findUniqueOrThrow({ where: { id: ids.company } })).isActive, "a company with an active club cannot be deactivated");
    const companyClub = (await clubNamed("Company Club"))!;
    await repo.updateOrganization(companyClub.id, { name: `${P} Company Club`, parentOrganizationId: ids.company, isActive: false, expectedUpdatedAt: companyClub.updatedAt.toISOString() }, admin.id);
    await setDirectoryOrganizationActive(ids.company, false, admin.id);
    assert(!(await prisma.organization.findUniqueOrThrow({ where: { id: ids.company } })).isActive, "the company deactivates once its club is inactive");
    await setDirectoryOrganizationActive(ids.company, true, admin.id);
    await repo.updateOrganization(companyClub.id, { name: `${P} Company Club`, parentOrganizationId: ids.company, isActive: true, expectedUpdatedAt: (await clubNamed("Company Club"))!.updatedAt.toISOString() }, admin.id);

    // Church-billed charges of a company-sponsored club go to the company.
    await prisma.person.create({ data: { id: ids.holder, firstName: "Pat", lastName: "Holder" } });
    await prisma.event.create({ data: {
      id: ids.event, slug: `${P}-event`, name: "Synthetic Camporee", startsAt: new Date("2027-04-01T00:00:00Z"), endsAt: new Date("2027-04-03T00:00:00Z"),
      audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE",
    } });
    const registration = await prisma.registration.create({
      data: { eventId: ids.event, accountHolderPersonId: ids.holder, confirmationCode: `${P}-1`, status: "CONFIRMED", totalAmount: "100.00" },
      select: { id: true },
    });
    await prisma.clubEventRegistration.create({ data: { eventId: ids.event, organizationId: companyClub.id, registrationId: registration.id } });
    await resolveEventBillingResponsibility(ids.event, { apply: true, actorUserId: admin.id });
    const responsibility = await prisma.registrationBillingResponsibility.findFirstOrThrow({ where: { registrationId: registration.id } });
    assert(responsibility.organizationId === ids.company && responsibility.source === "CLUB_SPONSORING_CHURCH", "the rule bills the company-sponsored club to the company");
    const owed = await listChurchAmountsOwed(ids.event);
    const row = owed.find((entry) => entry.confirmationCode === `${P}-1`);
    assert(row?.churchId === ids.company && row.churchName === names.company && row.isBilled && row.amountOwedCents === 10_000, "the church-owed list shows the company and its $100");
    await setOrganizationBillingContact({
      organizationId: ids.company,
      contact: { name: "Terry Treasurer", email: `${P}.treasurer@example.test`, phone: null, roleLabel: "Treasurer" },
      actor: { id: admin.id, globalRole: "SYSTEM_ADMIN" },
    });
    assert(await prisma.organizationBillingContact.count({ where: { organizationId: ids.company, effectiveTo: null } }) === 1, "staff keep a billing contact for the company");

    console.log("organization sponsors verified: club accepted under a church, company and group; refused under a school, camp, inactive company and club; edit and profile follow the rule; pickers and directory options list companies and groups; deactivation guarded; church-billed charges go to the company.");
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
