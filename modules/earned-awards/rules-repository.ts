import "server-only";

import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";
import { ruleReadinessProblems } from "@/modules/earned-awards/domain";
import { EarnedAwardError } from "@/modules/earned-awards/errors";
import {
  type MasterAwardImportPlan,
  type MasterAwardRuleSeed,
  masterAwardImportFingerprint,
  planMasterAwardImport,
} from "@/modules/earned-awards/master-award-import";
import type { MasterAwardRuleUpdate } from "@/modules/earned-awards/schemas";

/**
 * Master Award rules storage (#532): the rules as data (groups, minimums,
 * honor lists), changed only by a system administrator (the routes check)
 * and audited. Imported rules arrive as DRAFT; an administrator reviews,
 * edits and activates them one by one, and only ACTIVE rules are used for
 * progress (`modules/earned-awards/order-source.ts`).
 */

type Client = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

const ruleSelect = {
  id: true,
  name: true,
  itemId: true,
  status: true,
  needsManualCheck: true,
  reviewNote: true,
  item: { select: { name: true } },
  groups: {
    orderBy: { position: "asc" },
    select: {
      minimum: true,
      unmatchedHonorNames: true,
      honors: { select: { honor: { select: { id: true, name: true } } } },
    },
  },
} satisfies Prisma.MasterAwardRuleSelect;

export type MasterAwardRuleRecord = {
  id: string;
  name: string;
  status: "DRAFT" | "ACTIVE" | "INACTIVE";
  needsManualCheck: boolean;
  reviewNote: string;
  itemId: string | null;
  itemName: string | null;
  groups: Array<{ minimum: number; honors: Array<{ id: string; name: string }>; unmatchedHonorNames: string[] }>;
  /** What still blocks activating this rule; empty when it is ready. */
  problems: string[];
};

function toRecord(rule: Prisma.MasterAwardRuleGetPayload<{ select: typeof ruleSelect }>): MasterAwardRuleRecord {
  const groups = rule.groups.map((group) => ({
    minimum: group.minimum,
    honors: group.honors.map((entry) => entry.honor).sort((a, b) => a.name.localeCompare(b.name)),
    unmatchedHonorNames: group.unmatchedHonorNames,
  }));
  return {
    id: rule.id,
    name: rule.name,
    status: rule.status,
    needsManualCheck: rule.needsManualCheck,
    reviewNote: rule.reviewNote,
    itemId: rule.itemId,
    itemName: rule.item?.name ?? null,
    groups,
    problems: ruleReadinessProblems({ needsManualCheck: rule.needsManualCheck, groups: groups.map((group) => ({ minimum: group.minimum, honorIds: group.honors.map((honor) => honor.id) })) }),
  };
}

/** Every rule, DRAFT first (they need review), then by name. */
export async function listMasterAwardRules(): Promise<MasterAwardRuleRecord[]> {
  const rules = await getPrisma().masterAwardRule.findMany({ select: ruleSelect, orderBy: { name: "asc" } });
  const order = { DRAFT: 0, ACTIVE: 1, INACTIVE: 2 } as const;
  return rules.map(toRecord).sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
}

/** Active honors and Master Award catalog items, for the review screen's pickers. */
export async function listRuleChoices() {
  const [honors, items] = await Promise.all([
    getPrisma().honor.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getPrisma().clubSupplyItem.findMany({ where: { section: "MASTER_AWARDS", isActive: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return { honors, items };
}

async function importState(client: Client) {
  const [existing, honors, items] = await Promise.all([
    client.masterAwardRule.findMany({ select: { normalizedName: true } }),
    client.honor.findMany({ select: { id: true, name: true, isActive: true } }),
    client.clubSupplyItem.findMany({ where: { section: "MASTER_AWARDS", isActive: true }, select: { id: true, name: true } }),
  ]);
  return { existing: new Set(existing.map((rule) => rule.normalizedName)), honors, items };
}

async function planImport(seeds: readonly MasterAwardRuleSeed[], client: Client) {
  const state = await importState(client);
  const plan = planMasterAwardImport(seeds, state.existing, state.honors, state.items);
  return { plan, fingerprint: masterAwardImportFingerprint(plan) };
}

/** The dry run: what the file would do against the rules and honors as they are now, and the fingerprint to confirm with. */
export async function previewMasterAwardRulesImport(seeds: readonly MasterAwardRuleSeed[]) {
  return planImport(seeds, getPrisma());
}

const IMPORT_TRANSACTION = { timeout: 60_000, maxWait: 10_000 };

function isUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/**
 * Applies the import (#532) in one transaction, re-planned inside it. When the
 * plan's fingerprint isn't the one the preview returned, nothing is saved
 * (`PREVIEW_CHANGED`). New rules come in as DRAFT; a rule already on file is
 * never touched, so re-running the import can't overwrite an administrator's
 * edits. Audited with counts only.
 */
export async function applyMasterAwardRulesImport(seeds: readonly MasterAwardRuleSeed[], fingerprint: string, actorUserId: string) {
  let plan: MasterAwardImportPlan;
  try {
    plan = await getPrisma().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('master-award-rules-import'))`;
      const current = await planImport(seeds, tx);
      if (current.fingerprint !== fingerprint) {
        throw new EarnedAwardError("PREVIEW_CHANGED", "The file or the honor list changed since the preview. Review the new preview before saving.");
      }
      for (const step of current.plan.steps) {
        if (step.action !== "ADD") continue;
        await tx.masterAwardRule.create({
          data: {
            name: step.name,
            normalizedName: step.normalizedName,
            itemId: step.itemId,
            status: "DRAFT",
            needsManualCheck: step.needsManualCheck,
            reviewNote: step.reasons.join(" "),
            groups: {
              create: step.groups.map((group, index) => ({
                position: index,
                minimum: group.minimum,
                unmatchedHonorNames: group.unmatchedNames,
                honors: { create: group.honorIds.map((honorId) => ({ honorId })) },
              })),
            },
          },
        });
      }
      const { summary } = current.plan;
      await writeAuditLog({
        actorUserId,
        action: "MASTER_AWARD_RULES_IMPORTED",
        entityType: "MasterAwardRule",
        summary: `Imported Master Award rules as drafts: ${summary.added} added, ${summary.existing} already on file.`,
        metadata: { ...summary },
      }, tx);
      return current.plan;
    }, IMPORT_TRANSACTION);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      throw new EarnedAwardError("RULES_CONFLICT", "Another change to the rules landed at the same time. Run the preview again.");
    }
    throw error;
  }
  return { plan, rules: await listMasterAwardRules() };
}

/**
 * A system administrator's edit of one rule (#532): replace its groups, link
 * its catalog item, change its note, clear the manual-check flag, or move it
 * between DRAFT, ACTIVE and INACTIVE. A rule that ends up ACTIVE must be
 * ready (`ruleReadinessProblems`: checked, at least one group, every minimum
 * reachable), or nothing is saved (`RULE_NOT_READY`). One audit row records
 * what changed by field name and the status move, never the honor lists.
 */
export async function updateMasterAwardRule(ruleId: string, patch: MasterAwardRuleUpdate, actorUserId: string) {
  await getPrisma().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`master-award-rule:${ruleId}`}))`;
    const rule = await tx.masterAwardRule.findUnique({ where: { id: ruleId }, select: ruleSelect });
    if (!rule) throw new EarnedAwardError("RULE_NOT_FOUND", "That rule could not be found.");
    if (patch.itemId) {
      const item = await tx.clubSupplyItem.findFirst({ where: { id: patch.itemId, section: "MASTER_AWARDS", isActive: true }, select: { id: true } });
      if (!item) throw new EarnedAwardError("ITEM_NOT_FOUND", "Choose an active Master Awards item from the supply catalog.");
    }
    if (patch.groups) {
      const honorIds = [...new Set(patch.groups.flatMap((group) => group.honorIds))];
      const found = await tx.honor.count({ where: { id: { in: honorIds } } });
      if (found !== honorIds.length) throw new EarnedAwardError("HONOR_NOT_FOUND", "One of those honors could not be found.");
    }
    const current = toRecord(rule);
    const groups = patch.groups
      ? patch.groups.map((group) => ({ minimum: group.minimum, honorIds: [...new Set(group.honorIds)] }))
      : current.groups.map((group) => ({ minimum: group.minimum, honorIds: group.honors.map((honor) => honor.id) }));
    const status = patch.status ?? rule.status;
    const needsManualCheck = patch.needsManualCheck ?? rule.needsManualCheck;
    if (status === "ACTIVE") {
      const problems = ruleReadinessProblems({ needsManualCheck, groups });
      if (problems.length > 0) throw new EarnedAwardError("RULE_NOT_READY", problems[0]);
    }
    if (patch.groups) {
      await tx.masterAwardRuleGroup.deleteMany({ where: { ruleId } });
      for (const [index, group] of groups.entries()) {
        await tx.masterAwardRuleGroup.create({
          data: {
            ruleId,
            position: index,
            minimum: group.minimum,
            unmatchedHonorNames: [],
            honors: { create: group.honorIds.map((honorId) => ({ honorId })) },
          },
        });
      }
    }
    await tx.masterAwardRule.update({
      where: { id: ruleId },
      data: {
        ...(patch.itemId === undefined ? {} : { itemId: patch.itemId }),
        ...(patch.reviewNote === undefined ? {} : { reviewNote: patch.reviewNote }),
        ...(patch.needsManualCheck === undefined ? {} : { needsManualCheck: patch.needsManualCheck }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
      },
    });
    const changed = [
      patch.groups && "groups",
      patch.itemId !== undefined && patch.itemId !== rule.itemId && "item",
      patch.reviewNote !== undefined && patch.reviewNote !== rule.reviewNote && "note",
      patch.needsManualCheck !== undefined && patch.needsManualCheck !== rule.needsManualCheck && "manualCheck",
      patch.status !== undefined && patch.status !== rule.status && "status",
    ].filter((field): field is string => Boolean(field));
    const statusMoved = patch.status !== undefined && patch.status !== rule.status;
    await writeAuditLog({
      actorUserId,
      action: statusMoved && status === "ACTIVE" ? "MASTER_AWARD_RULE_ACTIVATED"
        : statusMoved && status === "INACTIVE" ? "MASTER_AWARD_RULE_DEACTIVATED"
          : "MASTER_AWARD_RULE_UPDATED",
      entityType: "MasterAwardRule",
      entityId: ruleId,
      summary: statusMoved && status === "ACTIVE" ? "Activated a Master Award rule."
        : statusMoved && status === "INACTIVE" ? "Deactivated a Master Award rule."
          : "Edited a Master Award rule.",
      metadata: {
        ruleId, changed, previousStatus: rule.status, status, groupCount: groups.length,
        // Counts only, never honor names: each group's minimum and how many honors it lists, before and after.
        ...(patch.groups ? {
          groupsBefore: current.groups.map((group) => ({ minimum: group.minimum, honorCount: group.honors.length })),
          groupsAfter: groups.map((group) => ({ minimum: group.minimum, honorCount: group.honorIds.length })),
        } : {}),
      },
    }, tx);
  });
  return listMasterAwardRules();
}
