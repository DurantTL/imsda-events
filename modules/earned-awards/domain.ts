import { type ClubClassLevel, clubClassLevelLabels } from "@/modules/club-rosters/domain";
import { type ClubSupplySection, normalizeClubSupplyName } from "@/modules/club-supplies/domain";

/**
 * Earned awards (#532): pure rules. An earned award is a `ClubOrderNeed`
 * (#487) with source type AWARD for one member and one catalog item
 * (`ClubSupplyItem`, #531). Everything past recording the need (the order
 * list, stock, batches, exports, receiving, handing out) is the generic order
 * layer; this file only decides which catalog rows a director may pick, which
 * insignia a completed class suggests, and how Master Award progress is
 * worked out from stored rules. It knows nothing about storage.
 */

/**
 * The catalog sections a director can hand-pick an earned award from: class
 * insignia, camporee and PBE patches, Teen Leadership Training items,
 * Miscellaneous (Good Conduct bars and stars, sleeve strips...), and Master
 * Awards. Honor patches are ordered from completed honors (#487) and apparel
 * from Uniforms (#497), so they are not offered here.
 */
export const AWARD_SECTIONS = [
  "INVESTITURE",
  "CAMPOREES",
  "PATHFINDER_BIBLE_EXPERIENCE",
  "TEEN_LEADERSHIP_TRAINING",
  "MISCELLANEOUS",
  "MASTER_AWARDS",
] as const satisfies readonly ClubSupplySection[];

export type AwardSection = (typeof AWARD_SECTIONS)[number];

const awardSections = new Set<string>(AWARD_SECTIONS);

export function isAwardSection(section: string): section is AwardSection {
  return awardSections.has(section);
}

/** Up to this many members and items in one hand-picked entry (their product is bounded too). */
export const MAX_AWARD_MEMBERS = 300;
export const MAX_AWARD_ITEMS = 20;
export const MAX_AWARD_NEEDS_PER_ENTRY = 1000;

export function awardEntryTooLarge(memberCount: number, itemCount: number) {
  return memberCount * itemCount > MAX_AWARD_NEEDS_PER_ENTRY;
}

/** Where an earned item stands, in the words a director uses (needed -> ordered -> received -> awarded). */
export const awardStatusLabels = {
  NEEDED: "Needed",
  ORDERED: "Ordered",
  RECEIVED: "Received",
  AWARDED: "Awarded",
} as const;

// ---------------------------------------------------------------- need keys

/**
 * Stable keys (`ClubOrderNeed.sourceId`, unique with the source type): the
 * suggested kinds are keyed on what earned them, so confirming the same
 * suggestion twice, or from two screens at once, never makes a second need.
 */
export const classInsigniaSourceId = (personId: string, classLevel: ClubClassLevel, itemId: string) =>
  `class:${personId}:${classLevel}:${itemId}`;

export const eventPatchSourceId = (eventId: string, personId: string, itemId: string) =>
  `event:${eventId}:${personId}:${itemId}`;

export const masterAwardSourceId = (personId: string, ruleId: string) => `master:${personId}:${ruleId}`;

export type AwardOrigin = "Class insignia" | "Event patch" | "Master Award" | "Added by hand";

/** Where an earned item came from, worked out from its need key. */
export function originOf(sourceId: string): AwardOrigin {
  if (sourceId.startsWith("class:")) return "Class insignia";
  if (sourceId.startsWith("event:")) return "Event patch";
  if (sourceId.startsWith("master:")) return "Master Award";
  return "Added by hand";
}

// ---------------------------------------------------------------- class insignia

/**
 * Each class's investiture insignia set, by catalog name: the class name
 * strip, the chevron, the pin, and the ribbon bar (#531 "Investiture"
 * section). Matched by section plus normalized name, never by catalog
 * number, because AdventSource reuses numbers. Master Guide has no ribbon
 * bar or plain chevron in the catalog: its set is the name strip, the star
 * with chevrons, and the pin. TLT has no investiture insignia in the catalog
 * (TLT items are picked by hand). The set only ever *suggests*; a director
 * confirms before anything is added.
 */
export const INSIGNIA_SETS: Record<ClubClassLevel, readonly string[]> = {
  FRIEND: ["Friend Class Name Strip", "Friend Chevron", "Friend Pin", "Trail Friend Ribbon Bar"],
  COMPANION: ["Companion Class Name Strip", "Companion Chevron", "Companion Pin", "Trail Companion Ribbon Bar"],
  EXPLORER: ["Explorer Class Name Strip", "Explorer Chevron", "Explorer Pin", "Wilderness Explorer Ribbon Bar"],
  RANGER: ["Ranger Class Name Strip", "Ranger Chevron", "Ranger Pin", "Wilderness Ranger Ribbon Bar"],
  VOYAGER: ["Voyager Class Name Strip", "Voyager Chevron", "Voyager Pin", "Frontier Voyager Ribbon Bar"],
  GUIDE: ["Guide Class Name Strip", "Guide Chevron", "Guide Pin", "Frontier Guide Ribbon Bar"],
  TLT: [],
  MASTER_GUIDE: ["Master Guide Class Name Strip", "Master Guide Star with Chevrons", "Master Guide Pin"],
};

export type InsigniaCatalogRow = { itemId: string; section: string; name: string; catalogNumber?: string | null };

export type InsigniaItem = { itemId: string; name: string; catalogNumber: string | null };

/**
 * A class's insignia set as it exists in the catalog right now: the catalog
 * rows that match the set (in the set's own order), and the names of set
 * items the catalog doesn't have yet (flagged, never silently dropped).
 */
export function matchInsigniaSet(classLevel: ClubClassLevel, rows: readonly InsigniaCatalogRow[]) {
  const byName = new Map<string, InsigniaCatalogRow>();
  for (const row of rows) {
    if (row.section !== "INVESTITURE") continue;
    const key = normalizeClubSupplyName(row.name);
    if (!byName.has(key)) byName.set(key, row);
  }
  const items: InsigniaItem[] = [];
  const missing: string[] = [];
  for (const name of INSIGNIA_SETS[classLevel]) {
    const row = byName.get(normalizeClubSupplyName(name));
    if (row) items.push({ itemId: row.itemId, name: row.name, catalogNumber: row.catalogNumber ?? null });
    else missing.push(name);
  }
  return { items, missing };
}

export function classLabel(classLevel: ClubClassLevel) {
  return clubClassLevelLabels[classLevel];
}

// ---------------------------------------------------------------- Master Awards

export type MasterAwardRuleShape = {
  groups: ReadonlyArray<{ minimum: number; honorIds: readonly string[] }>;
};

export type GroupProgress = { minimum: number; have: number; total: number; met: boolean };

export type MasterAwardProgress = {
  groups: GroupProgress[];
  /** Every group reached its minimum (and the rule has at least one group). */
  earned: boolean;
  /** Honors counted toward the minimums (a group never counts past its own minimum). */
  counted: number;
  /** The sum of the groups' minimums. */
  required: number;
};

/**
 * Where a member stands against one rule. `completedHonorIds` is the honors
 * whose latest record (#486) is COMPLETED. Each group counts its own honors
 * independently, exactly as the club's spreadsheet does, and the award is
 * earned when every group reaches its minimum. "N of M" is `counted` of
 * `required`: Health (3 of 7, 2 of 5, 2 of 5) with 3 + 1 + 2 honors done reads
 * "5 of 7".
 */
export function evaluateMasterAward(rule: MasterAwardRuleShape, completedHonorIds: ReadonlySet<string>): MasterAwardProgress {
  const groups = rule.groups.map((group): GroupProgress => {
    const have = new Set(group.honorIds.filter((honorId) => completedHonorIds.has(honorId))).size;
    return { minimum: group.minimum, have, total: new Set(group.honorIds).size, met: have >= group.minimum };
  });
  return {
    groups,
    earned: groups.length > 0 && groups.every((group) => group.met),
    counted: groups.reduce((sum, group) => sum + Math.min(group.have, group.minimum), 0),
    required: groups.reduce((sum, group) => sum + group.minimum, 0),
  };
}

export function progressLabel(progress: Pick<MasterAwardProgress, "counted" | "required">) {
  return `${progress.counted} of ${progress.required}`;
}

/** What a rule needs before a system administrator may activate it. Empty when it is ready. */
export function ruleReadinessProblems(rule: {
  needsManualCheck: boolean;
  groups: ReadonlyArray<{ minimum: number; honorIds: readonly string[] }>;
}) {
  const problems: string[] = [];
  if (rule.needsManualCheck) problems.push("Check this rule against the official requirements, then clear the manual-check flag.");
  if (rule.groups.length === 0) problems.push("Add at least one honor group.");
  rule.groups.forEach((group, index) => {
    const total = new Set(group.honorIds).size;
    if (!Number.isInteger(group.minimum) || group.minimum < 1) problems.push(`Group ${index + 1} needs a minimum of at least 1.`);
    else if (group.minimum > total) problems.push(`Group ${index + 1} needs ${group.minimum} but lists only ${total} honor${total === 1 ? "" : "s"}.`);
  });
  return problems;
}

export const masterAwardStatusLabels = { DRAFT: "Draft", ACTIVE: "Active", INACTIVE: "Inactive" } as const;

// ---------------------------------------------------------------- dates

/** Today's calendar date (`YYYY-MM-DD`), which orders earned needs oldest-first with honors' completion dates. */
export function calendarDate(now: Date) {
  return now.toISOString().slice(0, 10);
}
