import { clubSupplySectionLabels, extractSizeLabel, type ClubSupplySection } from "@/modules/club-supplies/domain";

/**
 * Uniform ordering (#497): pure rules. A uniform is a sized `ClubSupplyItem`
 * (#531) — AdventSource gives every size its own catalog number, so each size
 * is its own catalog row — and a uniform need is a `ClubOrderNeed` (#487)
 * for one member and one of those rows. This file only decides which catalog
 * rows a director can pick from and how the size variants are grouped in the
 * picker; it knows nothing about storage.
 */

/** The catalog sections a club can record uniform needs against. */
export const UNIFORM_SECTIONS = [
  "CLASS_A_DRESS_APPAREL",
  "CLASS_A_UNIFORM_ACCESSORIES",
  "OTHER_APPAREL",
  "TEEN_LEADERSHIP_TRAINING",
] as const satisfies readonly ClubSupplySection[];

export type UniformSection = (typeof UNIFORM_SECTIONS)[number];

const uniformSections = new Set<string>(UNIFORM_SECTIONS);

export function isUniformSection(section: string): section is UniformSection {
  return uniformSections.has(section);
}

/** Up to this many members and items in one bulk entry (their product is bounded too). */
export const MAX_UNIFORM_MEMBERS = 300;
export const MAX_UNIFORM_ITEMS = 20;
export const MAX_UNIFORM_NEEDS_PER_ENTRY = 1000;

/**
 * Splits a sized catalog name into the item and its size:
 * "Boys' Short Sleeve Shirt (S, Size 8)" -> item "Boys' Short Sleeve Shirt",
 * size "S, Size 8"; "Crew sweatshirt X-Large" -> "Crew sweatshirt" / "X-Large".
 * A name whose size doesn't parse reliably (`extractSizeLabel` is null) is
 * the whole name with no size, never guessed.
 */
export function splitSizedItemName(name: string): { baseName: string; size: string } {
  if (extractSizeLabel(name) === null) return { baseName: name.trim(), size: "" };
  const trailingParen = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(name);
  if (trailingParen && trailingParen[1].trim() !== "") return { baseName: trailingParen[1].trim(), size: trailingParen[2].trim() };
  const trailingWord = /^(.*?)\s+((?:X{1,4}-?\s?)?(?:Small|Medium|Large))$/i.exec(name.trim());
  if (trailingWord && trailingWord[1].trim() !== "") return { baseName: trailingWord[1].trim(), size: trailingWord[2].trim() };
  return { baseName: name.trim(), size: "" };
}

/**
 * The item and size to show for a catalog row. Only uniform-section rows are
 * split; an honor patch or any other row keeps its whole name, so an honor
 * that happens to end in "Large" is never cut.
 */
export function itemAndSize(row: { name: string; section: string }): { itemName: string; size: string } {
  if (!isUniformSection(row.section)) return { itemName: row.name, size: "" };
  const { baseName, size } = splitSizedItemName(row.name);
  return { itemName: baseName, size };
}

export type UniformCatalogRow = { itemId: string; section: string; name: string; catalogNumber: string | null };

export type UniformVariant = { itemId: string; size: string; catalogNumber: string | null };

export type UniformItemGroup = { key: string; baseName: string; section: UniformSection; sectionLabel: string; variants: UniformVariant[] };

const SIZE_ORDER = ["XXS", "XS", "S", "SMALL", "M", "MEDIUM", "L", "LARGE", "XL", "X-LARGE", "XXL", "2XL", "XXXL", "3XL", "XXXXL", "4XL"];

function sizeRank(size: string) {
  const first = size.split(",")[0]?.trim().toUpperCase() ?? "";
  const index = SIZE_ORDER.indexOf(first);
  return index === -1 ? SIZE_ORDER.length : index;
}

/**
 * The picker's groups: every uniform-section row grouped by base item name
 * (within its section), each group's size variants in size order (S, M, L,
 * XL... then numeric, then alphabetical). Rows outside the uniform sections
 * are never offered. Groups are ordered by section then name.
 */
export function groupUniformCatalog(rows: readonly UniformCatalogRow[]): UniformItemGroup[] {
  const groups = new Map<string, UniformItemGroup>();
  for (const row of rows) {
    if (!isUniformSection(row.section)) continue;
    const { baseName, size } = splitSizedItemName(row.name);
    const key = `${row.section}\u0000${baseName.toLocaleLowerCase("en-US")}`;
    const group = groups.get(key) ?? {
      key,
      baseName,
      section: row.section,
      sectionLabel: clubSupplySectionLabels[row.section],
      variants: [],
    };
    group.variants.push({ itemId: row.itemId, size, catalogNumber: row.catalogNumber });
    groups.set(key, group);
  }
  const sectionIndex = (section: string) => UNIFORM_SECTIONS.indexOf(section as UniformSection);
  return [...groups.values()]
    .map((group) => ({
      ...group,
      variants: [...group.variants].sort((a, b) =>
        sizeRank(a.size) - sizeRank(b.size) || a.size.localeCompare(b.size, "en-US", { numeric: true })),
    }))
    .sort((a, b) => sectionIndex(a.section) - sectionIndex(b.section) || a.baseName.localeCompare(b.baseName));
}

/** The label for a variant in the size picker. */
export function variantLabel(variant: UniformVariant) {
  return variant.size || "One size";
}

/** Where a uniform need stands, in the words a director uses (needed -> ordered -> received -> issued). */
export const uniformStatusLabels = {
  NEEDED: "Needed",
  ORDERED: "Ordered",
  RECEIVED: "Received",
  AWARDED: "Issued",
} as const;

/** Whether members x items is more than one bulk entry may record (the picker disables saving and says so). */
export function entryTooLarge(memberCount: number, itemCount: number) {
  return memberCount * itemCount > MAX_UNIFORM_NEEDS_PER_ENTRY;
}
