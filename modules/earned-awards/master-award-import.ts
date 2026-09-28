import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeClubSupplyName } from "@/modules/club-supplies/domain";

// ---------------------------------------------------------------- rules file (import)

/**
 * The rules file (`docs/reference/master-award-rules.json`, #532): award name
 * to its honor groups. Only honor names and minimums, never member data.
 * `groupsRequired` is how many groups the club's formula said must be met; a
 * rule that read fewer groups than that parsed only partly.
 */
const rulesFileSchema = z.record(
  z.string().trim().min(1).max(200),
  z.object({
    groups: z.array(z.object({
      minimum: z.number().int().min(1).max(100),
      honors: z.array(z.string().trim().min(1).max(200)).min(1).max(300),
    }).strict()).min(1).max(10),
    groupsRequired: z.number().int().min(1).max(10),
  }).strict(),
);

export const MAX_MASTER_AWARD_RULES_FILE_BYTES = 512 * 1024;

export class MasterAwardRulesFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterAwardRulesFileError";
  }
}

export type MasterAwardRuleSeed = {
  name: string;
  groupsRequired: number;
  groups: Array<{ minimum: number; honors: string[] }>;
};

export function parseMasterAwardRulesFile(text: string): MasterAwardRuleSeed[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MasterAwardRulesFileError("That file isn't valid JSON.");
  }
  const parsed = rulesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new MasterAwardRulesFileError(parsed.error.issues[0]?.message ?? "That file isn't a Master Award rules file.");
  }
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) throw new MasterAwardRulesFileError("That file has no rules.");
  if (entries.length > 50) throw new MasterAwardRulesFileError("Import up to 50 rules at a time.");
  const seen = new Set<string>();
  return entries.map(([name, rule]) => {
    const key = normalizeClubSupplyName(name);
    if (seen.has(key)) throw new MasterAwardRulesFileError(`"${name}" appears more than once.`);
    seen.add(key);
    return { name, groupsRequired: rule.groupsRequired, groups: rule.groups.map((group) => ({ minimum: group.minimum, honors: group.honors })) };
  });
}

/** Awards whose formula parsed only partly (#532): flagged for a manual check whatever else the file says. */
const MANUAL_CHECK_AWARDS = new Set([normalizeClubSupplyName("Family, Origins, and Heritage Master Award")]);

export type ImportHonor = { id: string; name: string; isActive: boolean };
export type ImportItem = { id: string; name: string };

export type MasterAwardImportStep = {
  name: string;
  normalizedName: string;
  action: "ADD" | "EXISTS";
  itemId: string | null;
  needsManualCheck: boolean;
  reasons: string[];
  groups: Array<{ minimum: number; honorIds: string[]; matchedNames: string[]; unmatchedNames: string[] }>;
};

export type MasterAwardImportPlan = {
  steps: MasterAwardImportStep[];
  summary: { added: number; existing: number; needsManualCheck: number; honorsMatched: number; honorsUnmatched: number };
  /** Every honor name that matched no `Honor` row, with its award, for the review list. */
  unmatched: Array<{ award: string; honor: string }>;
};

/**
 * What importing the rules file would do (#532). Rules already on file (same
 * normalized name) are left exactly as they are, so re-running the import
 * never overwrites a system administrator's edits. New rules come in as DRAFT.
 * Honor names are matched to `Honor` rows by normalized name ("X - Advanced"
 * reads as "X, Advanced"); ones that match nothing are listed and kept on the
 * group for review. A rule is flagged for a manual check when its groups
 * parsed only partly, when it is one of the awards known to parse partly, or
 * when any honor didn't match.
 */
export function planMasterAwardImport(
  seeds: readonly MasterAwardRuleSeed[],
  existingNormalizedNames: ReadonlySet<string>,
  honors: readonly ImportHonor[],
  masterAwardItems: readonly ImportItem[],
): MasterAwardImportPlan {
  const honorByName = new Map<string, ImportHonor>();
  for (const honor of [...honors].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.id.localeCompare(b.id))) {
    const key = normalizeClubSupplyName(honor.name);
    if (!honorByName.has(key)) honorByName.set(key, honor);
  }
  const itemByName = new Map<string, ImportItem>();
  for (const item of [...masterAwardItems].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = normalizeClubSupplyName(item.name);
    if (!itemByName.has(key)) itemByName.set(key, item);
  }
  const unmatched: MasterAwardImportPlan["unmatched"] = [];
  let honorsMatched = 0;
  const steps = seeds.map((seed): MasterAwardImportStep => {
    const normalizedName = normalizeClubSupplyName(seed.name);
    const groups = seed.groups.map((group) => {
      const matchedNames: string[] = [];
      const unmatchedNames: string[] = [];
      const honorIds = new Set<string>();
      for (const name of group.honors) {
        const honor = honorByName.get(normalizeClubSupplyName(name));
        if (honor) {
          honorIds.add(honor.id);
          matchedNames.push(name);
        } else {
          unmatchedNames.push(name);
        }
      }
      return { minimum: group.minimum, honorIds: [...honorIds], matchedNames, unmatchedNames };
    });
    const exists = existingNormalizedNames.has(normalizedName);
    const reasons: string[] = [];
    if (seed.groups.length < seed.groupsRequired) {
      reasons.push(`Parsed only partly: the formula needs ${seed.groupsRequired} groups but only ${seed.groups.length} could be read.`);
    }
    if (MANUAL_CHECK_AWARDS.has(normalizedName)) reasons.push("The club's formula for this award parsed only partly. Check it against the official requirements.");
    const unmatchedCount = groups.reduce((sum, group) => sum + group.unmatchedNames.length, 0);
    if (unmatchedCount > 0) reasons.push(`${unmatchedCount} honor${unmatchedCount === 1 ? "" : "s"} didn't match the honor list.`);
    if (!exists) {
      honorsMatched += groups.reduce((sum, group) => sum + group.honorIds.length, 0);
      for (const group of groups) for (const honor of group.unmatchedNames) unmatched.push({ award: seed.name, honor });
    }
    return {
      name: seed.name,
      normalizedName,
      action: exists ? "EXISTS" : "ADD",
      itemId: itemByName.get(normalizedName)?.id ?? null,
      needsManualCheck: reasons.length > 0,
      reasons,
      groups,
    };
  });
  return {
    steps,
    summary: {
      added: steps.filter((step) => step.action === "ADD").length,
      existing: steps.filter((step) => step.action === "EXISTS").length,
      needsManualCheck: steps.filter((step) => step.action === "ADD" && step.needsManualCheck).length,
      honorsMatched,
      honorsUnmatched: unmatched.length,
    },
    unmatched,
  };
}

/** A fingerprint of the plan and the catalog it was made against, so a confirm can only save what the preview showed. */
export function masterAwardImportFingerprint(plan: MasterAwardImportPlan) {
  return createHash("sha256").update(JSON.stringify(plan.steps.map((step) => [step.normalizedName, step.action, step.itemId, step.groups.map((group) => [group.minimum, group.honorIds, group.unmatchedNames])]))).digest("hex");
}

