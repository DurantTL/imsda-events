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
import { lockClubFormTemplateForReseal } from "@/modules/club-forms/template-lock";
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
  const existing = await client.clubFormTemplate.findMany({ select: { id: true, key: true, version: true, sensitiveFieldKeys: true, birthDateFieldKeys: true } });
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
      const apply = async (tx: Prisma.TransactionClient) => {
        // Lock, then decide from the locked row: a concurrent save or sync cannot change the keys under us.
        const locked = await lockClubFormTemplateForReseal(tx, current.id);
        if (locked.version >= seed.version) return;
        assertNotLoosened(seed, locked);
        const newlySensitive = seed.sensitiveFieldKeys.filter((key) => !locked.sensitiveFieldKeys.includes(key));
        // A newly sensitive field must be sealed in existing submissions in the same transaction as the update.
        await resealClubFormSubmissions(tx, current.id, newlySensitive);
        await tx.clubFormTemplate.update({ where: { key: seed.key }, data });
      };
      assertNotLoosened(seed, current);
      if ("$transaction" in client) await client.$transaction(apply, RESEAL_TRANSACTION);
      else await apply(client);
    }
  }
}

/**
 * A large re-seal touches thousands of rows, well past Prisma's 5 s default
 * for an interactive transaction, which would roll it back every time.
 */
const RESEAL_TRANSACTION = { maxWait: 30_000, timeout: 10 * 60_000 } as const;

/**
 * Never silently make an answer readable: a field that stops being sensitive,
 * or stops being a birth date (ADR 0005 Addendum A), is a human's call.
 */
function assertNotLoosened(
  seed: { key: string; sensitiveFieldKeys: readonly string[]; birthDateFieldKeys: readonly string[] },
  stored: { sensitiveFieldKeys: readonly string[]; birthDateFieldKeys: readonly string[] },
) {
  const noLongerSensitive = stored.sensitiveFieldKeys.filter((key) => !seed.sensitiveFieldKeys.includes(key));
  if (noLongerSensitive.length > 0) {
    throw new ClubFormError("INVALID_TEMPLATE", `${seed.key}: ${noLongerSensitive[0]} would stop being sensitive, which needs a reviewed change.`);
  }
  const noLongerBirthDate = stored.birthDateFieldKeys.filter((key) => !seed.birthDateFieldKeys.includes(key));
  if (noLongerBirthDate.length > 0) {
    throw new ClubFormError("INVALID_TEMPLATE", `${seed.key}: ${noLongerBirthDate[0]} would stop being a birth date field, which needs a reviewed change.`);
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
  /** Stored version is behind the code (or the form was never synced): run `npm run club-forms:sync`. */
  needsSync: boolean;
};

/**
 * For the system administrator's page: every template, on or off. Read-only:
 * it never syncs or re-seals (that can touch thousands of rows and belongs to
 * the operator step `npm run club-forms:sync`, run after migrations). A
 * template whose stored version is behind the code, or that has never been
 * synced, is flagged `needsSync`.
 */
export async function listClubFormTemplatesForAdmin(): Promise<ClubFormTemplateSummary[]> {
  const rows = await getPrisma().clubFormTemplate.findMany({
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
  const stored = new Map(rows.map((row) => [row.key, row]));
  const listed: ClubFormTemplateSummary[] = rows.map((row) => {
    const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === row.key);
    return {
      key: row.key,
      name: row.name,
      description: row.description,
      enabled: row.enabled,
      enabledAt: row.enabledAt?.toISOString() ?? null,
      version: row.version,
      submissionCount: row._count.submissions,
      needsSync: Boolean(seed && row.version < seed.version),
    };
  });
  for (const seed of clubFormTemplateSeeds) {
    if (stored.has(seed.key)) continue;
    listed.push({ key: seed.key, name: seed.name, description: seed.description, enabled: false, enabledAt: null, version: 0, submissionCount: 0, needsSync: true });
  }
  return listed;
}

function needsSync() {
  return new ClubFormError("TEMPLATE_NEEDS_SYNC", "This form needs to be synced before it can be turned on. Run npm run club-forms:sync, then try again.");
}

/** Turns one template on or off. The caller has already checked for a system administrator. */
export async function setClubFormTemplateEnabled(key: string, enabled: boolean, actorUserId: string, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const template = await tx.clubFormTemplate.findUnique({ where: { key }, select: { id: true, enabled: true, version: true } });
    const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === key);
    if (!template) {
      if (seed) throw needsSync();
      throw new ClubFormError("TEMPLATE_NOT_FOUND", "That form could not be found.");
    }
    // Turning a form on needs its stored definition to be current (and its answers re-sealed). Turning one off never waits.
    if (enabled && seed && template.version < seed.version) throw needsSync();
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
