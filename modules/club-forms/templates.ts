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
import { recordClubFormTemplateVersion } from "@/modules/club-forms/versions";
import { logError, logInfo } from "@/lib/logger";
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
  hiddenFieldKeys: true,
  printLayout: true,
  enabled: true,
  customizedAt: true,
} satisfies Prisma.ClubFormTemplateSelect;

export type ClubFormSyncCollected = {
  refused: Array<{ key: string; message: string }>;
  skipped: Array<{ key: string; reason: string }>;
  staleDrafts: Array<{ key: string }>;
  updated: Array<{ key: string; created: boolean }>;
  unchanged: Array<{ key: string }>;
};

function emptyCollected(): ClubFormSyncCollected {
  return { refused: [], skipped: [], staleDrafts: [], updated: [], unchanged: [] };
}

/**
 * Makes sure every seeded template exists and is current. New ones are
 * created disabled; a changed definition (higher `version`) is written over
 * the stored one. The `enabled` switch is never touched. A template that has
 * been published or created in the app (`customizedAt`, #712) is never written
 * over: it is skipped and reported. A template with only an unpublished draft is
 * still updated (so the live form stays available) and its draft is reported as
 * stale. For a customized one, sensitive or birth-date keys the code seed
 * has added are still sealed in existing answers (the definition is untouched).
 * Safe to call often.
 */
export async function syncClubFormTemplates(
  client: Client = getPrisma(),
  options: { continueOnRefusal?: boolean; collect?: ClubFormSyncCollected } = {},
) {
  // A caller may pass its own arrays (`collect`) to read what was done so far if a later template throws.
  const collected = options.collect ?? emptyCollected();
  const { refused, skipped, staleDrafts, updated, unchanged } = collected;
  const existing = await client.clubFormTemplate.findMany({ select: { id: true, key: true, version: true, sensitiveFieldKeys: true, birthDateFieldKeys: true, customizedAt: true, draftUpdatedAt: true } });
  const stored = new Map(existing.map((row) => [row.key, row]));
  for (const seed of clubFormTemplateSeeds) {
    const row = stored.get(seed.key);
    if (row?.customizedAt) {
      skipped.push({ key: seed.key, reason: "edited in the app" });
      logInfo("Club form sync skipped a template that was edited in the app.", { templateKey: seed.key });
      try {
        await sealSeedKeysForCustomized(client, seed, row.id);
      } catch (error) {
        if (options.continueOnRefusal && error instanceof ClubFormError) {
          refused.push({ key: seed.key, message: `${seed.key}: ${error.message}` });
          continue;
        }
        throw error;
      }
      continue;
    }
    const hadDraft = Boolean(row?.draftUpdatedAt);
    const wasBehind = Boolean(row && row.version < seed.version);
    try {
      const outcome = await syncOneTemplate(client, seed, stored.get(seed.key));
      if (outcome === "unchanged") unchanged.push({ key: seed.key });
      else updated.push({ key: seed.key, created: outcome === "created" });
      // The live form is updated, so it stays fillable. An unpublished draft is left in place but is now stale.
      if (hadDraft && wasBehind) {
        staleDrafts.push({ key: seed.key });
        logInfo("Club form sync updated a template whose unpublished draft is now stale.", { templateKey: seed.key });
      }
    } catch (error) {
      // A refused loosening stops that form only; the operator script asks to carry on and reports every refusal.
      if (options.continueOnRefusal && error instanceof ClubFormError && error.code === "INVALID_TEMPLATE") {
        refused.push({ key: seed.key, message: error.message });
        continue;
      }
      throw error;
    }
  }
  return { refused, skipped, staleDrafts, updated, unchanged };
}

type Seed = (typeof clubFormTemplateSeeds)[number];

/**
 * A customized template ignores the code's definition, but a sensitive or
 * birth-date key the seed has since added must still be sealed (#712):
 * existing plain answers are moved into the sealed value and the stored key
 * lists gain the keys, in one transaction. The definition is not touched.
 */
async function sealSeedKeysForCustomized(client: Client, seed: Seed, templateId: string) {
  const apply = async (tx: Prisma.TransactionClient) => {
    const locked = await lockClubFormTemplateForReseal(tx, templateId);
    const newlySensitive = seed.sensitiveFieldKeys.filter((key) => !locked.sensitiveFieldKeys.includes(key));
    const newlyBirthDate = seed.birthDateFieldKeys.filter((key) => !locked.birthDateFieldKeys.includes(key));
    if (newlySensitive.length === 0 && newlyBirthDate.length === 0) return;
    await resealClubFormSubmissions(tx, templateId, newlySensitive);
    await tx.clubFormTemplate.update({
      where: { id: templateId },
      data: {
        sensitiveFieldKeys: [...new Set([...locked.sensitiveFieldKeys, ...newlySensitive])],
        birthDateFieldKeys: [...new Set([...locked.birthDateFieldKeys, ...newlyBirthDate])],
      },
    });
    const sealedKeyCount = newlySensitive.length + newlyBirthDate.length;
    logInfo("Club form sync sealed extra keys for a template edited in the app.", { templateKey: seed.key, keys: sealedKeyCount });
  };
  if ("$transaction" in client) await client.$transaction(apply, RESEAL_TRANSACTION);
  else await apply(client);
}

function versionSpec(seed: Seed, definition: RegistrationFormDefinition) {
  return {
    version: seed.version,
    name: seed.name,
    description: seed.description,
    definition,
    sectionNotes: seed.sectionNotes,
    sensitiveFieldKeys: seed.sensitiveFieldKeys,
    birthDateFieldKeys: seed.birthDateFieldKeys,
    staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
    hiddenFieldKeys: [],
    printLayout: seed.printLayout,
  };
}

async function syncOneTemplate(
  client: Client,
  seed: Seed,
  current: { id: string; version: number; sensitiveFieldKeys: string[]; birthDateFieldKeys: string[] } | undefined,
): Promise<"created" | "updated" | "unchanged"> {
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
  if (!current) {
    const created = await client.clubFormTemplate.upsert({
      where: { key: seed.key },
      create: { key: seed.key, ...data, enabled: false },
      update: {},
      select: { id: true, version: true },
    });
    if (created.version === seed.version) await recordClubFormTemplateVersion(client, created.id, versionSpec(seed, definition));
    return "created";
  } else if (current.version < seed.version) {
    const apply = async (tx: Prisma.TransactionClient): Promise<boolean> => {
      // Lock, then decide from the locked row: a concurrent save or sync cannot change the keys under us.
      const locked = await lockClubFormTemplateForReseal(tx, current.id);
      if (locked.version >= seed.version) return false;
      // Published from the app since the check above: the code no longer owns it. (A draft does not stop the update.)
      if (locked.customizedAt) return false;
      assertNotLoosened(seed, locked);
      const newlySensitive = seed.sensitiveFieldKeys.filter((key) => !locked.sensitiveFieldKeys.includes(key));
      // A newly sensitive field must be sealed in existing submissions in the same transaction as the update.
      await resealClubFormSubmissions(tx, current.id, newlySensitive);
      await tx.clubFormTemplate.update({ where: { key: seed.key }, data });
      await recordClubFormTemplateVersion(tx, current.id, versionSpec(seed, definition));
      return true;
    };
    assertNotLoosened(seed, current);
    const changed = "$transaction" in client ? await client.$transaction(apply, RESEAL_TRANSACTION) : await apply(client);
    return changed ? "updated" : "unchanged";
  }
  return "unchanged";
}

/**
 * A large re-seal touches thousands of rows, well past Prisma's 5 s default
 * for an interactive transaction, which would roll it back every time.
 */
export const RESEAL_TRANSACTION = { maxWait: 30_000, timeout: 10 * 60_000 } as const;

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
  /** Stored version is behind the code (or the form was never synced): use Sync templates on the admin page (or `npm run club-forms:sync`). */
  needsSync: boolean;
  /** Edited or created in the app (#712): the code's seed no longer applies. */
  customized: boolean;
  /** An unpublished draft is waiting. */
  hasDraft: boolean;
  /** The published version the draft was started on. */
  draftBaseVersion: number | null;
  /** A code sync moved the version on after the draft was started: it cannot be published. */
  draftStale: boolean;
};

/**
 * For the system administrator's page: every template, on or off. Read-only:
 * it never syncs or re-seals (that can touch thousands of rows and belongs to
 * the explicit sync step: Sync templates on the admin page, or
 * `npm run club-forms:sync` after migrations). A
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
      customizedAt: true,
      draftUpdatedAt: true,
      draftBaseVersion: true,
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
      needsSync: Boolean(seed && !row.customizedAt && row.version < seed.version),
      customized: Boolean(row.customizedAt),
      hasDraft: Boolean(row.draftUpdatedAt),
      draftBaseVersion: row.draftUpdatedAt ? row.draftBaseVersion : null,
      draftStale: Boolean(row.draftUpdatedAt && row.draftBaseVersion !== null && row.draftBaseVersion !== row.version),
    };
  });
  for (const seed of clubFormTemplateSeeds) {
    if (stored.has(seed.key)) continue;
    listed.push({ key: seed.key, name: seed.name, description: seed.description, enabled: false, enabledAt: null, version: 0, submissionCount: 0, needsSync: true, customized: false, hasDraft: false, draftBaseVersion: null, draftStale: false });
  }
  return listed;
}

export type ClubFormSyncResultStatus = "UPDATED" | "CREATED" | "SKIPPED" | "UNCHANGED" | "REFUSED";
export type ClubFormSyncResult = { key: string; name: string; status: ClubFormSyncResultStatus; detail: string };
export type ClubFormSyncCounts = { updated: number; created: number; skipped: number; unchanged: number; refused: number; staleDrafts: number };
export type ClubFormSyncReport = { results: ClubFormSyncResult[]; counts: ClubFormSyncCounts };
/** Returned instead of a report when another sync holds the lock. */
export type ClubFormSyncBusy = { running: true };

/** One fixed key so two administrators (or two app instances) never sync at once. */
export const CLUB_FORM_SYNC_LOCK_KEY = 7_420_001;

function buildSyncReport(collected: ClubFormSyncCollected): ClubFormSyncReport {
  const names = new Map<string, string>(clubFormTemplateSeeds.map((seed) => [seed.key, seed.name]));
  const stale = new Set(collected.staleDrafts.map((item) => item.key));
  const results: ClubFormSyncResult[] = [];
  for (const seed of clubFormTemplateSeeds) {
    const name = names.get(seed.key) ?? seed.key;
    const refusal = collected.refused.find((item) => item.key === seed.key);
    const skip = collected.skipped.find((item) => item.key === seed.key);
    const change = collected.updated.find((item) => item.key === seed.key);
    if (refusal) {
      results.push({ key: seed.key, name, status: "REFUSED", detail: `${refusal.message} Nothing was changed for this form.` });
    } else if (skip) {
      results.push({ key: seed.key, name, status: "SKIPPED", detail: `Skipped: ${skip.reason}. The code's version is not applied.` });
    } else if (change) {
      results.push({ key: seed.key, name, status: change.created ? "CREATED" : "UPDATED", detail: `${change.created ? "Created (off)" : "Updated"} to version ${seed.version}${stale.has(seed.key) ? "; its unpublished draft is now stale and must be discarded" : ""}.` });
    } else if (collected.unchanged.some((item) => item.key === seed.key)) {
      results.push({ key: seed.key, name, status: "UNCHANGED", detail: "Already up to date." });
    }
  }
  const count = (status: ClubFormSyncResultStatus) => results.filter((item) => item.status === status).length;
  return {
    results,
    counts: {
      updated: count("UPDATED"),
      created: count("CREATED"),
      skipped: count("SKIPPED"),
      unchanged: count("UNCHANGED"),
      refused: count("REFUSED"),
      staleDrafts: stale.size,
    },
  };
}

/**
 * The in-app "Sync templates" action (#742). It is the same `syncClubFormTemplates`
 * the `club-forms:sync` script runs, with the same safety rules (never loosen
 * a sensitive or birth-date flag, never overwrite a template edited in the
 * app), and it carries on past a refused form.
 *
 * Only one sync runs at a time: a transaction-scoped Postgres advisory lock is
 * held on a dedicated connection while the sync uses its own, and a second
 * caller gets `{ running: true }` at once. The audit entry holds counts only,
 * and is written even when a later template throws (`incomplete: true`, with
 * the counts reached so far). The caller has already checked for a system
 * administrator.
 */
export async function runClubFormTemplateSync(actorUserId: string): Promise<ClubFormSyncReport | ClubFormSyncBusy> {
  const prisma = getPrisma();
  return prisma.$transaction(async (lockTx) => {
    const rows = await lockTx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${CLUB_FORM_SYNC_LOCK_KEY}) AS locked`;
    if (!rows[0]?.locked) return { running: true } as const;
    const collected = emptyCollected();
    let incomplete = true;
    try {
      await syncClubFormTemplates(prisma, { continueOnRefusal: true, collect: collected });
      incomplete = false;
    } finally {
      const partial = buildSyncReport(collected);
      try {
        await writeAuditLog({
          actorUserId,
          action: "CLUB_FORM_TEMPLATES_SYNCED",
          entityType: "ClubFormTemplate",
          summary: incomplete ? "Synced club form templates from the code; the run did not finish." : "Synced club form templates from the code.",
          metadata: { ...partial.counts, incomplete },
        });
      } catch (auditError) {
        // Never mask the sync's own failure with the audit's.
        logError("Club form sync could not write its audit entry.", auditError);
      }
    }
    return buildSyncReport(collected);
  }, RESEAL_TRANSACTION);
}

function needsSync() {
  return new ClubFormError("TEMPLATE_NEEDS_SYNC", "This form needs to be synced before it can be turned on. Use Sync templates on the Club forms page (or run npm run club-forms:sync), then try again.");
}

/** Turns one template on or off. The caller has already checked for a system administrator. */
export async function setClubFormTemplateEnabled(key: string, enabled: boolean, actorUserId: string, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const template = await tx.clubFormTemplate.findUnique({ where: { key }, select: { id: true, enabled: true, version: true, customizedAt: true } });
    const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === key);
    if (!template) {
      if (seed) throw needsSync();
      throw new ClubFormError("TEMPLATE_NOT_FOUND", "That form could not be found.");
    }
    // Turning a form on needs its stored definition to be current (and its answers re-sealed). Turning one off never waits.
    if (enabled && seed && !template.customizedAt && template.version < seed.version) throw needsSync();
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
        metadata: { templateKey: key, version: template.version },
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
