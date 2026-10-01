import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import {
  blankClubFormSpec,
  checkClubFormDraft,
  CLUB_FORM_DRAFT_MAX_BYTES,
  readDraftShape,
  copySpec,
  newlySensitiveKeys,
  NO_PROTECTION_HISTORY,
  specFromRecord,
  templateKeyFromName,
  type BuilderIssue,
  type ClubFormDraftSpec,
} from "@/modules/club-forms/builder-domain";
import { parseClubFormTemplate, type ClubFormTemplateRecord } from "@/modules/club-forms/domain";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { ClubFormError } from "@/modules/club-forms/errors";
import { resealClubFormSubmissions } from "@/modules/club-forms/reseal";
import { RESEAL_TRANSACTION } from "@/modules/club-forms/templates";
import { loadProtectionHistory, recordClubFormTemplateVersion } from "@/modules/club-forms/versions";

/**
 * The club form builder's server side (#712). Every function here assumes the
 * caller already proved a system administrator (the routes do, on every
 * request) and takes the administrator's user id for the audit log. Drafts
 * live on the template row; publishing writes the draft to the live columns,
 * bumps `version` and records a frozen copy of that version, so submissions
 * keep rendering against the version they were filled in against.
 *
 * Nothing here reads, returns or logs a sealed answer: the builder works on
 * definitions only. Audit rows carry the template key and version, never the
 * definition text.
 */

type Tx = Prisma.TransactionClient;

const rowSelect = {
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
  sortOrder: true,
  enabled: true,
  customizedAt: true,
  draft: true,
  draftUpdatedAt: true,
} satisfies Prisma.ClubFormTemplateSelect;

function notFound() {
  return new ClubFormError("TEMPLATE_NOT_FOUND", "That form could not be found.");
}

function changed(message = "This form changed since you opened it. Reload the page to see the latest, then make your change again.") {
  return new ClubFormError("TEMPLATE_CHANGED", message);
}

/** Locks the template row for the rest of the transaction and reads it. */
async function lockRow(tx: Tx, key: string) {
  await tx.$queryRaw`SELECT "id" FROM "ClubFormTemplate" WHERE "key" = ${key} FOR UPDATE`;
  const row = await tx.clubFormTemplate.findUnique({ where: { key }, select: rowSelect });
  if (!row) throw notFound();
  return row;
}

/** A code seed that has not been synced yet cannot be edited: the sync would then be refused for good. */
function assertSyncedForEditing(row: { key: string; version: number; customizedAt: Date | null }) {
  const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === row.key);
  if (seed && !row.customizedAt && row.version < seed.version) {
    throw new ClubFormError("TEMPLATE_NEEDS_SYNC", "This form needs to be synced before it can be edited. Run npm run club-forms:sync, then try again.");
  }
}

function validationFailed(issues: BuilderIssue[]) {
  return new ClubFormError("VALIDATION_FAILED", issues[0]?.message ?? "Check the form and try again.", issues);
}

function asRecord(row: Prisma.ClubFormTemplateGetPayload<{ select: typeof rowSelect }>): ClubFormTemplateRecord {
  return parseClubFormTemplate(row);
}

export type ClubFormBuilderView = {
  key: string;
  version: number;
  enabled: boolean;
  customized: boolean;
  submissionCount: number;
  needsSync: boolean;
  /** The published version, as an editable spec. */
  published: ClubFormDraftSpec;
  /** The unpublished draft, or null. The editor starts from this when present. */
  draft: ClubFormDraftSpec | null;
  draftUpdatedAt: string | null;
  /** A draft is stored but cannot be read (it no longer parses): show an error and offer to discard it. */
  draftUnreadable: boolean;
  /** Problems the unpublished draft still has, shown as warnings; publish refuses until they are fixed. */
  draftWarnings: BuilderIssue[];
  /** Keys that keep their sensitive or birth-date setting for good, and so cannot be deleted while submissions exist. */
  lockedSensitiveKeys: string[];
  lockedBirthDateKeys: string[];
  versions: Array<{ version: number; recordedAt: string }>;
};

/** Everything the builder page needs for one template. Definitions only: no submission is read. */
export async function getClubFormBuilderView(key: string): Promise<ClubFormBuilderView> {
  const prisma = getPrisma();
  const row = await prisma.clubFormTemplate.findUnique({ where: { key }, select: rowSelect });
  if (!row) throw notFound();
  const record = asRecord(row);
  const [history, versions, submissionCount] = await Promise.all([
    loadProtectionHistory(prisma, row),
    prisma.clubFormTemplateVersion.findMany({ where: { templateId: row.id }, orderBy: { version: "desc" }, select: { version: true, createdAt: true } }),
    prisma.clubFormSubmission.count({ where: { templateId: row.id } }),
  ]);
  const seed = clubFormTemplateSeeds.find((candidate) => candidate.key === key);
  const draft = row.draft ? readDraftShape(row.draft) : null;
  const draftWarnings = draft ? checkClubFormDraft(draft, history).issues : [];
  return {
    key,
    version: row.version,
    enabled: row.enabled,
    customized: Boolean(row.customizedAt),
    submissionCount,
    needsSync: Boolean(seed && !row.customizedAt && row.version < seed.version),
    published: specFromRecord({ ...record, sortOrder: row.sortOrder }),
    draft,
    draftUpdatedAt: row.draft ? row.draftUpdatedAt?.toISOString() ?? null : null,
    draftUnreadable: Boolean(row.draft) && draft === null,
    draftWarnings,
    lockedSensitiveKeys: history.everSensitiveKeys.filter((candidate) => history.publishedFieldKeys.includes(candidate)),
    lockedBirthDateKeys: history.everBirthDateKeys.filter((candidate) => history.publishedFieldKeys.includes(candidate)),
    versions: versions.map((version) => ({ version: version.version, recordedAt: version.createdAt.toISOString() })),
  };
}

export type SaveDraftInput = {
  draft: unknown;
  baseVersion: number;
  expectedDraftUpdatedAt?: string | null;
};

/**
 * Saves the draft of the next version. An unfinished draft can be saved: it
 * only has to be structurally a draft and under the size cap. The full check
 * (the schema the fill-in and submission code use, plus the sensitive-flag
 * protection rules) runs here too, but its problems come back as warnings; it
 * is publish that refuses, under the lock. Saving a draft does not mark the
 * template as edited in the app: that happens at its first publish. While a
 * draft exists the sync leaves the template alone.
 */
export async function saveClubFormDraft(key: string, input: SaveDraftInput, actorUserId: string, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const row = await lockRow(tx, key);
    assertSyncedForEditing(row);
    if (row.version !== input.baseVersion) throw changed();
    const storedStamp = row.draft ? row.draftUpdatedAt?.toISOString() ?? null : null;
    if ((input.expectedDraftUpdatedAt ?? null) !== storedStamp) throw changed("Someone else saved a draft of this form. Reload the page to see it.");
    const history = await loadProtectionHistory(tx, row);
    const shaped = readDraftShape(input.draft);
    if (!shaped) {
      throw validationFailed([{ key: "template", message: `This draft could not be read, or it is larger than ${Math.round(CLUB_FORM_DRAFT_MAX_BYTES / 1000)} KB.` }]);
    }
    const warnings = checkClubFormDraft(shaped, history).issues;
    await tx.clubFormTemplate.update({
      where: { id: row.id },
      data: {
        draft: shaped as unknown as Prisma.InputJsonValue,
        draftUpdatedAt: now,
        draftUpdatedByUserId: actorUserId,
      },
    });
    await writeAuditLog({
      actorUserId,
      action: "CLUB_FORM_TEMPLATE_DRAFT_SAVED",
      entityType: "ClubFormTemplate",
      entityId: row.id,
      summary: "Saved a draft of a club form.",
      metadata: { templateKey: key, version: row.version, warnings: warnings.length },
    }, tx);
    return { key, version: row.version, draftUpdatedAt: now.toISOString(), warnings };
  });
}

/** Throws the draft away. A template that was never published from the app is managed by the sync again. */
export async function discardClubFormDraft(key: string, actorUserId: string) {
  return getPrisma().$transaction(async (tx) => {
    const row = await lockRow(tx, key);
    if (row.draft) {
      await tx.clubFormTemplate.update({
        where: { id: row.id },
        data: { draft: Prisma.DbNull, draftUpdatedAt: null, draftUpdatedByUserId: null },
      });
      await writeAuditLog({
        actorUserId,
        action: "CLUB_FORM_TEMPLATE_DRAFT_DISCARDED",
        entityType: "ClubFormTemplate",
        entityId: row.id,
        summary: "Discarded a draft of a club form.",
        metadata: { templateKey: key, version: row.version },
      }, tx);
    }
    return { key, version: row.version };
  });
}

/**
 * Publishes the saved draft as the next version. In one transaction, under the
 * template's row lock: the draft is checked again against the history as it is
 * now; answers to any newly sensitive field are sealed in every existing
 * submission (the same re-seal the sync runs; it fails, changing nothing, if
 * encryption is not set up); the live columns take the draft; `version` goes
 * up by one; and a frozen copy of the version is recorded. Earlier versions are
 * never changed, so existing submissions render and export as before.
 */
export async function publishClubFormDraft(key: string, input: { baseVersion: number }, actorUserId: string, now = new Date()) {
  return getPrisma().$transaction(async (tx) => {
    const row = await lockRow(tx, key);
    assertSyncedForEditing(row);
    if (row.version !== input.baseVersion) throw changed();
    if (!row.draft) throw new ClubFormError("VALIDATION_FAILED", "There is no saved draft to publish.");
    const history = await loadProtectionHistory(tx, row);
    const check = checkClubFormDraft(row.draft, history);
    if (!check.ok) throw validationFailed(check.issues);
    const spec = check.spec;
    const newly = newlySensitiveKeys(spec, row.sensitiveFieldKeys);
    const nextVersion = row.version + 1;

    // Keep the version being replaced, whatever path wrote it, before it is overwritten.
    await recordClubFormTemplateVersion(tx, row.id, {
      version: row.version,
      name: row.name,
      description: row.description,
      definition: row.definition,
      sectionNotes: row.sectionNotes,
      sensitiveFieldKeys: row.sensitiveFieldKeys,
      birthDateFieldKeys: row.birthDateFieldKeys,
      staffOnlyFieldKeys: row.staffOnlyFieldKeys,
      hiddenFieldKeys: row.hiddenFieldKeys,
      printLayout: row.printLayout,
    });
    // Existing plain answers to a newly sensitive field are sealed in the same transaction as the change.
    const resealed = await resealClubFormSubmissions(tx, row.id, newly);
    await tx.clubFormTemplate.update({
      where: { id: row.id },
      data: {
        ...liveColumns(spec),
        version: nextVersion,
        draft: Prisma.DbNull,
        draftUpdatedAt: null,
        draftUpdatedByUserId: null,
        customizedAt: row.customizedAt ?? now,
      },
    });
    await recordClubFormTemplateVersion(tx, row.id, { version: nextVersion, ...liveColumns(spec) }, actorUserId);
    await writeAuditLog({
      actorUserId,
      action: "CLUB_FORM_TEMPLATE_PUBLISHED",
      entityType: "ClubFormTemplate",
      entityId: row.id,
      summary: "Published a new version of a club form.",
      metadata: { templateKey: key, version: nextVersion, previousVersion: row.version, newlySensitiveFields: newly.length, resealedSubmissions: resealed },
    }, tx);
    return { key, version: nextVersion };
  }, RESEAL_TRANSACTION);
}

function liveColumns(spec: ClubFormDraftSpec) {
  return {
    name: spec.name,
    description: spec.description,
    sortOrder: spec.sortOrder,
    printLayout: spec.printLayout,
    definition: spec.definition as unknown as Prisma.InputJsonValue,
    sectionNotes: spec.sectionNotes as unknown as Prisma.InputJsonValue,
    sensitiveFieldKeys: spec.sensitiveFieldKeys,
    birthDateFieldKeys: spec.birthDateFieldKeys,
    staffOnlyFieldKeys: spec.staffOnlyFieldKeys,
    hiddenFieldKeys: spec.hiddenFieldKeys,
  };
}

async function uniqueKey(tx: Tx, name: string) {
  const base = templateKeyFromName(name);
  const taken = new Set((await tx.clubFormTemplate.findMany({ where: { key: { startsWith: base } }, select: { key: true } })).map((row) => row.key));
  for (const seed of clubFormTemplateSeeds) taken.add(seed.key);
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ClubFormError("VALIDATION_FAILED", "Choose a different name for this form.");
}

/**
 * Creates a template in the app, blank or as a copy of an existing one's
 * published version (hidden fields are left out of a copy). It starts as a
 * disabled version 1 that the sync never touches.
 */
export async function createClubFormTemplate(input: { name: string; copyFromKey?: string }, actorUserId: string, now = new Date()) {
  const name = input.name.trim();
  try {
    return await getPrisma().$transaction(async (tx) => {
      let spec: ClubFormDraftSpec;
      if (input.copyFromKey) {
        const source = await tx.clubFormTemplate.findUnique({ where: { key: input.copyFromKey }, select: rowSelect });
        if (!source) throw notFound();
        assertSyncedForEditing(source);
        spec = copySpec(specFromRecord({ ...asRecord(source), sortOrder: source.sortOrder }), name);
      } else {
        spec = blankClubFormSpec(name);
      }
      const check = checkClubFormDraft(spec, NO_PROTECTION_HISTORY);
      if (!check.ok) throw validationFailed(check.issues);
      const key = await uniqueKey(tx, name);
      const created = await tx.clubFormTemplate.create({
        data: { key, version: 1, enabled: false, customizedAt: now, ...liveColumns(check.spec) },
        select: { id: true },
      });
      await recordClubFormTemplateVersion(tx, created.id, { version: 1, ...liveColumns(check.spec) }, actorUserId);
      await writeAuditLog({
        actorUserId,
        action: "CLUB_FORM_TEMPLATE_CREATED",
        entityType: "ClubFormTemplate",
        entityId: created.id,
        summary: input.copyFromKey ? "Created a club form as a copy of another." : "Created a blank club form.",
        metadata: { templateKey: key, version: 1, copiedFromKey: input.copyFromKey ?? null },
      }, tx);
      return { key, version: 1 };
    });
  } catch (error) {
    // Two creations picked the same key at once.
    if (error && typeof error === "object" && (error as { code?: unknown }).code === "P2002") {
      throw new ClubFormError("TEMPLATE_CHANGED", "Another form was created at the same moment. Try again.");
    }
    throw error;
  }
}
