/**
 * Proves the eAdventist organizations import (#649) against a real PostgreSQL
 * database with the synthetic fixture CSV (fictitious names only):
 *
 * - a first upload previews and commits 12 organizations of every kind, each
 *   with its EADVENTIST ExternalIdentity matching Organization.eadventistId,
 *   and one audit entry that holds counts only;
 * - uploading the same file again previews 12 unchanged and changes no row;
 * - a possible match with no choice is refused (NEEDS_CHOICES) and nothing is
 *   written; a stale choice asks again; a real choice links the church;
 * - a club holding an id is skipped and left untouched.
 *
 * Creates and removes its own rows. Needs a migrated database.
 *
 *   npm run test:eadventist-import
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvConfig } from "@next/env";
import { PrismaClient } from "@prisma/client";

loadEnvConfig(process.cwd());

const prisma = new PrismaClient();
const fixture = readFileSync(join(process.cwd(), "tests", "fixtures", "eadventist-organizations-synthetic.csv"), "utf8");
const ids = Array.from({ length: 12 }, (_, index) => String(9001 + index));
const stamp = `ea649${Date.now().toString(36)}`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

async function wipe(userId: string) {
  const found = await prisma.organization.findMany({
    where: { OR: [{ eadventistId: { in: ids } }, { name: { startsWith: stamp } }, { externalIdentities: { some: { provider: "EADVENTIST", externalId: { in: ids } } } }] },
    select: { id: true },
  });
  const orgIds = found.map((org) => org.id);
  await prisma.organization.deleteMany({ where: { id: { in: orgIds }, type: "CLUB" } });
  await prisma.organization.updateMany({ where: { id: { in: orgIds } }, data: { affiliatedOrganizationId: null } });
  await prisma.externalIdentity.deleteMany({ where: { organizationId: { in: orgIds } } });
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: userId } });
}

async function main() {
  const { commitEadventistImport, previewEadventistImport } = await import("../modules/organizations/eadventist-import-repository");
  const user = await prisma.user.create({ data: { email: `${stamp}@example.test`, displayName: `${stamp} admin`, globalRole: "SYSTEM_ADMIN" } });
  let looseId: string | null = null;
  try {
    await wipe(user.id);

    // 1. First upload.
    const preview = await previewEadventistImport(fixture);
    assert(preview.counts.new === 12 && preview.counts.flagged === 1 && preview.needsChoice === 0, `first preview: ${JSON.stringify(preview.counts)}`);
    assert((await prisma.organization.count({ where: { eadventistId: { in: ids } } })) === 0, "preview wrote nothing");
    const first = await commitEadventistImport(fixture, user.id);
    assert(first.counts.new === 12, "first commit adds 12");
    const orgs = await prisma.organization.findMany({ where: { eadventistId: { in: ids } }, include: { externalIdentities: true, affiliatedOrganization: true } });
    assert(orgs.length === 12, "12 organizations stored");
    assert(new Set(orgs.map((org) => org.type)).size === 10, "ten distinct kinds (three school levels share one)");
    assert(orgs.every((org) => org.externalIdentities.length === 1 && org.externalIdentities[0]!.provider === "EADVENTIST" && org.externalIdentities[0]!.externalId === org.eadventistId), "every organization has a matching EADVENTIST identity");
    const group = orgs.find((org) => org.type === "GROUP")!;
    assert(group.streetAddress === null && group.officePhone === null && group.city === "Sample Ridge" && group.disbandedOn?.toISOString().startsWith("2024-03-01"), "group keeps town only; disbanded date stored");
    const company = orgs.find((org) => org.type === "COMPANY")!;
    assert(company.affiliatedOrganization?.eadventistId === "9002", "company's parent is the church");
    const audit = await prisma.auditLog.findMany({ where: { actorUserId: user.id, action: "ORGANIZATIONS_EADVENTIST_IMPORTED" } });
    assert(audit.length === 1 && !JSON.stringify(audit).includes("Sample Hills"), "one audit entry, counts only");

    // 2. Re-upload is a no-op.
    const again = await previewEadventistImport(fixture);
    assert(again.counts.unchanged === 12 && again.counts.new === 0 && again.counts.updated === 0, `re-upload preview: ${JSON.stringify(again.counts)}`);
    const before = await prisma.organization.findMany({ where: { eadventistId: { in: ids } }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    await commitEadventistImport(fixture, user.id);
    const after = await prisma.organization.findMany({ where: { eadventistId: { in: ids } }, select: { id: true, updatedAt: true }, orderBy: { id: "asc" } });
    assert(JSON.stringify(before) === JSON.stringify(after), "re-upload changed no row");
    assert((await prisma.externalIdentity.count({ where: { provider: "EADVENTIST", externalId: { in: ids } } })) === 12, "still 12 identities");

    // 3. Possible match, stale choice, club holding an id.
    await wipe(user.id);
    const loose = await prisma.organization.create({ data: { type: "CHURCH", name: "Sample Hills Seventh-day Adventist Church", normalizedName: "sample hills seventh-day adventist church" } });
    looseId = loose.id;
    const club = await prisma.organization.create({ data: { type: "CLUB", name: `${stamp} Club`, normalizedName: `${stamp} club`, parentOrganizationId: loose.id, eadventistId: "9003" } });
    const countBefore = await prisma.organization.count();
    const auditBefore = await prisma.auditLog.count({ where: { actorUserId: user.id } });

    const waiting = await previewEadventistImport(fixture);
    assert(waiting.needsChoice === 1, "one possible match needs a choice");
    let refused = "";
    try { await commitEadventistImport(fixture, user.id); } catch (error) { refused = (error as { code?: string }).code ?? String(error); }
    assert(refused === "NEEDS_CHOICES", `commit without a choice refused (got ${refused})`);
    assert((await prisma.organization.count()) === countBefore && (await prisma.auditLog.count({ where: { actorUserId: user.id } })) === auditBefore, "refusal wrote nothing");

    let staleRefused = "";
    try { await commitEadventistImport(fixture, user.id, { "9002": "no-such-church" }); } catch (error) { staleRefused = (error as { code?: string }).code ?? String(error); }
    assert(staleRefused === "NEEDS_CHOICES", "a stale choice asks again");

    const linked = await commitEadventistImport(fixture, user.id, { "9002": loose.id });
    const skipped = linked.items.filter((item) => item.action === "SKIPPED");
    assert(skipped.length === 1 && skipped[0]!.eadventistId === "9003" && skipped[0]!.notes.includes("This eAdventist id belongs to a club; not imported"), "the club's id row is skipped");
    const clubAfter = await prisma.organization.findUniqueOrThrow({ where: { id: club.id } });
    assert(clubAfter.type === "CLUB" && clubAfter.name === `${stamp} Club` && clubAfter.eadventistId === "9003", "the club is untouched");
    const church = await prisma.organization.findUniqueOrThrow({ where: { id: loose.id }, include: { externalIdentities: true } });
    assert(church.eadventistId === "9002" && church.name === "Sample Hills SDA Church" && church.externalIdentities[0]?.externalId === "9002", "the church is linked, renamed, and has its identity");
    assert((await prisma.organization.count()) === countBefore + 10, "the other ten rows were created (12 minus the linked church and the club's row)");

    console.log("eAdventist import checks passed.");
  } finally {
    await wipe(user.id).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { type: "CLUB", name: { startsWith: stamp } } }).catch(() => undefined);
    if (looseId) await prisma.organization.deleteMany({ where: { id: looseId } }).catch(() => undefined);
    await prisma.organization.deleteMany({ where: { name: { startsWith: stamp } } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
