import { type HonorCategory, honorCategoryLabels, normalizeHonorCategoryText } from "@/modules/honors/domain";

/**
 * Club supply catalog (#531): AdventSource items (insignia, event patches,
 * uniform apparel, honor patches, master awards) with their catalog numbers.
 * Pure rules shared by the CSV import, the repository, and the screens.
 *
 * Every row is a `ClubSupplyItem`, honors included. An item's identity is its
 * section plus its normalized name; catalog numbers repeat in the real data
 * (the Good Conduct Stars, two belt sizes, and every "X - Advanced" honor,
 * which carries the Advanced Honor Star's number) and are never identity.
 */

const nonHonorSectionLabels = {
  INVESTITURE: "Investiture",
  CAMPOREES: "Camporees",
  PATHFINDER_BIBLE_EXPERIENCE: "Pathfinder Bible Experience",
  TEEN_LEADERSHIP_TRAINING: "Teen Leadership Training",
  MISCELLANEOUS: "Miscellaneous",
  CLASS_A_DRESS_APPAREL: "Class A Dress Apparel",
  CLASS_A_UNIFORM_ACCESSORIES: "Class A Uniform Accessories",
  OTHER_APPAREL: "Other Apparel",
} as const;

/** Every catalog section in display order: supplies first, then the honor categories. */
export const clubSupplySectionLabels = { ...nonHonorSectionLabels, ...honorCategoryLabels } as const;

export type ClubSupplySection = keyof typeof clubSupplySectionLabels;

export const clubSupplySections = Object.keys(clubSupplySectionLabels) as ClubSupplySection[];

const honorSections = new Set<string>(Object.keys(honorCategoryLabels));

/** The honor category a section stands for, or null for a non-honor section. */
export function honorCategoryForSection(section: ClubSupplySection): HonorCategory | null {
  return honorSections.has(section) ? (section as HonorCategory) : null;
}

const sectionByText = new Map(
  (Object.entries(clubSupplySectionLabels) as Array<[ClubSupplySection, string]>)
    .flatMap(([section, label]) => [
      [normalizeHonorCategoryText(label), section] as const,
      [normalizeHonorCategoryText(section.replace(/_/g, " ")), section] as const,
    ]),
);

/** A section from a CSV cell ("Reacreation", "Arts, Crafts, And Hobbies", "CLASS_A_DRESS_APPAREL"), or null. */
export function resolveClubSupplySection(text: string): ClubSupplySection | null {
  return sectionByText.get(normalizeHonorCategoryText(text)) ?? null;
}

const ADVANCED_SUFFIX = /\s*[-,–—]\s*advanced$/;
const GC_SUFFIX = /\s*\(gc\)$/;

/**
 * The name an item (or an honor it may link to) is matched by: trimmed,
 * whitespace collapsed, lower-cased, "&" read as "and", a trailing "(GC)"
 * dropped, and "X - Advanced" read the same as "X, Advanced".
 */
export function normalizeClubSupplyName(value: string) {
  let name = value
    .normalize("NFKC")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
  const advanced = ADVANCED_SUFFIX.test(name);
  if (advanced) name = name.replace(ADVANCED_SUFFIX, "");
  name = name.replace(GC_SUFFIX, "").trim();
  return advanced ? `${name}, advanced` : name;
}

/** Whether a name is an "X - Advanced" (or "X, Advanced") honor. */
export function isAdvancedHonorName(value: string) {
  return normalizeClubSupplyName(value).endsWith(", advanced");
}

/** Every "X - Advanced" honor is ordered as the Advanced Honor Star. */
export const ADVANCED_HONOR_STAR_CATALOG_NUMBER = "007400";

const BARE_SIZE_TOKEN = /^(XXXXL|XXXL|XXL|XL|X-?LARGE|XX-?LARGE|L|LARGE|M|MEDIUM|S|SMALL|XS|X-?SMALL|[0-9]+(\.[0-9]+)?)$/i;
const SIZE_PHRASE = /\bSize\s+([A-Za-z0-9/.-]+)/i;
const TRAILING_SIZE_WORD = /\b((?:X{1,4}-?\s?)?(?:Small|Medium|Large))$/i;

/**
 * The item's size for display, or null when the name doesn't reliably parse
 * into one. AdventSource gives each size its own catalog number, so each
 * size is already its own row; this label never decides identity.
 *
 * Tried in order: a trailing "(...)" with an explicit "Size ..." phrase
 * ("Boys' Short Sleeve Shirt (S, Size 8)" gives "Size 8"); a trailing "(...)"
 * whose first part is a bare size ("Club Field Uniform (XL)" gives "XL"); a
 * size word ending the name ("Crew sweatshirt X-Large"). A typo that breaks
 * the pattern ("Sweatshirt Hoodie largee") is left blank rather than guessed.
 */
export function extractSizeLabel(itemName: string): string | null {
  const trailingParen = /\(([^()]*)\)\s*$/.exec(itemName);
  if (trailingParen) {
    const content = trailingParen[1].trim();
    const sizePhrase = SIZE_PHRASE.exec(content);
    if (sizePhrase) return `Size ${sizePhrase[1]}`;
    const firstToken = content.split(",")[0]?.trim() ?? "";
    return BARE_SIZE_TOKEN.test(firstToken) ? firstToken : null;
  }
  const trailingWord = TRAILING_SIZE_WORD.exec(itemName.trim());
  return trailingWord ? trailingWord[1] : null;
}
