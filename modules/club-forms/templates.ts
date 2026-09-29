import "server-only";

import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import {
  parseClubFormTemplate,
  templateSpecProblems,
  type ClubFormTemplateRecord,
} from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { resealClubFormSubmissions } from "@/modules/club-forms/reseal";
import { registrationFormDefinitionSchema, type RegistrationFormDefinition } from "@/modules/forms/definition";
import { hasDirectoryOptionSource, withDirectoryOptions } from "@/modules/organizations/directory-form-options";
import { getOrganizationDirectory } from "@/modules/organizations/directory-options";

/**
 * Club form templates (#610): the seeded definitions, the system
 * administrator's on/off switch, and what a club may see of them.
 */

type Client = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

const templateSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  version: true,
  definition: true,
  sectionNotes: true,
  sensitiveFieldKeys: true,
  birthDateFieldKeys: true,
  staffOnlyFieldKeys: true,
  printLayout: true,
  enabled: true,
} satisfies Prisma.ClubFormTemplateSelect;

/**
 * Makes sure every seeded template exists and is current. New ones are
 * created disabled; a changed definition (higher `version`) is written over
 * the stored one. The `enabled` switch is never touched. Safe to call often.
 */
export async function syncClubFormTemplates(client: Client = getPrisma()) {
  const existing = await client.clubFormTemplate.findMany({ select: { id: true, key: true, version: true, sensitiveFieldKeys: true } });
  const stored = new Map(existing.map((row) => [row.key, row]));
  for (const seed of clubFormTemplateSeeds) {
    const definition = registrationFormDefinitionSchema.parse(seed.definition);
    const problems = templateSpecProblems({ ...seed, definition });
    if (problems.length > 0) throw new ClubFormError("INVALID_TEMPLATE", `${seed.key}: ${problems[0]}`);
    const data = {
      name: seed.name,
      description: seed.description,
      version: seed.version,
      definition: definition as unknown as Prisma.InputJsonValue,
      sectionNotes: seed.sectionNotes as unknown as Prisma.InputJsonValue,
      sensitiveFieldKeys: seed.sensitiveFieldKeys,
      birthDateFieldKeys: seed.birthDateFieldKeys,
      staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
      printLayout: seed.printLayout,
      sortOrder: seed.sortOrder,
    };
    const current = stored.get(seed.key);
    if (!current) {
      await client.clubFormTemplate.upsert({
        where: { key: seed.key },
        create: { key: seed.key, ...data, enabled: false },
        update: {},
      });
    } else if (current.version < seed.version) {
      const newlySensitive = seed.sensitiveFieldKeys.filter((key) => !current.sensitiveFieldKeys.includes(key));
      const noLongerSensitive = current.sensitiveFieldKeys.filter((key) => !seed.sensitiveFieldKeys.includes(key));
      // Never silently make an answer readable: a field that stops being sensitive is a human's call.
      if (noLongerSensitive.length > 0) {
        throw new ClubFormError("INVALID_TEMPLATE", `${seed.key}: ${noLongerSensitive[0]} would stop being sensitive, which needs a reviewed change.`);
      }
      // A newly sensitive field must be sealed in existing submissions in the same transaction as the update.
      const apply = async (tx: Prisma.TransactionClient) => {
        await resealClubFormSubmissions(tx, current.id, newlySensitive);
        await tx.clubFormTemplate.update({ where: { key: seed.key }, data });
      };
      if (newlySensitive.length === 0) await client.clubFormTemplate.update({ where: { key: seed.key }, data });
      else if ("$transaction" in client) await client.$transaction(apply);
      else await apply(client);
    }
  }
}

export type ClubFormTemplateSummary = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  enabledAt: string | null;
  version: number;
  submissionCount: number;
};

/** For the system administrator's page: every template, on or off. */
export async function listClubFormTemplatesForAdmin(): Promise<ClubFormTemplateSummary[]> {
  const prisma = getPrisma();
  await syncClubFormTemplates(prisma);
  const rows = await prisma.clubFormTemplate.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      key: true,
      name: true,
      description: true,
      enabled: true,
      enabledAt: true,
      version: true,
      _count: { select: { submissions: true } },
    },
  });
  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    enabledAt: row.enabledAt?.toISOString() ?? null,
    version: row.version,
    submissionCount: row._count.submissions,
  }));
}

/** Turns one template on or off. The caller has already checked for a system administrator. */
export async function setClubFormTemplateEnabled(key: string, enabled: boolean, actorUserId: string, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    await syncClubFormTemplates(tx);
    const template = await tx.clubFormTemplate.findUnique({ where: { key }, select: { id: true, enabled: true } });
    if (!template) throw new ClubFormError("TEMPLATE_NOT_FOUND", "That form could not be found.");
    if (template.enabled !== enabled) {
      await tx.clubFormTemplate.update({
        where: { id: template.id },
        data: enabled
          ? { enabled: true, enabledAt: now, enabledByUserId: actorUserId }
          : { enabled: false, enabledAt: null, enabledByUserId: null },
      });
      await writeAuditLog({
        actorUserId,
        action: enabled ? "CLUB_FORM_TEMPLATE_ENABLED" : "CLUB_FORM_TEMPLATE_DISABLED",
        entityType: "ClubFormTemplate",
        entityId: template.id,
        summary: enabled ? "Turned on a club form." : "Turned off a club form.",
        metadata: { templateKey: key },
      }, tx);
    }
    return { key, enabled };
  });
}

/** Every template's key and name, on or off, for conference staff's filters. Reads only. */
export async function listClubFormTemplateNames() {
  return getPrisma().clubFormTemplate.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { key: true, name: true, enabled: true },
  });
}

/** Clubs see only enabled forms, and only their names and descriptions. */
export async function listEnabledClubFormTemplates() {
  return getPrisma().clubFormTemplate.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { key: true, name: true, description: true },
  });
}

/** One enabled template, or "not found" for a disabled or unknown one (the same answer either way). */
export async function getEnabledClubFormTemplate(key: string, client: Client = getPrisma()): Promise<ClubFormTemplateRecord> {
  const row = await client.clubFormTemplate.findFirst({ where: { key, enabled: true }, select: templateSelect });
  if (!row) throw new ClubFormError("TEMPLATE_NOT_FOUND", "That form isn't available.");
  return parseClubFormTemplate(row);
}

/** Any template by key, on or off, for conference staff. */
export async function getClubFormTemplateForStaff(key: string, client: Client = getPrisma()): Promise<ClubFormTemplateRecord> {
  const row = await client.clubFormTemplate.findUnique({ where: { key }, select: templateSelect });
  if (!row) throw new ClubFormError("TEMPLATE_NOT_FOUND", "That form could not be found.");
  return parseClubFormTemplate(row);
}

export async function getClubFormTemplateById(id: string, client: Client = getPrisma()): Promise<ClubFormTemplateRecord> {
  const row = await client.clubFormTemplate.findUnique({ where: { id }, select: templateSelect });
  if (!row) throw new ClubFormError("TEMPLATE_NOT_FOUND", "That form could not be found.");
  return parseClubFormTemplate(row);
}

/**
 * Fills a directory-sourced field's choices (the church and club directories)
 * with the live names plus "Not listed", the same way registration forms do,
 * so validation accepts a real entry and rejects anything else.
 */
export async function withLiveDirectory(definition: RegistrationFormDefinition, client: Client = getPrisma()) {
  if (!hasDirectoryOptionSource(definition)) return definition;
  return withDirectoryOptions(definition, await getOrganizationDirectory(client));
}
