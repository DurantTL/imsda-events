/** CHURCH and CLUB are the original kinds; the rest arrive with the eAdventist import (#649). */
export const organizationTypeLabels = {
  CHURCH: "Church",
  CLUB: "Club",
  COMPANY: "Company",
  GROUP: "Group",
  SCHOOL: "School",
  EARLY_CHILDHOOD: "Early childhood program",
  BOOKSTORE: "Bookstore",
  COMMUNITY_CENTER: "Community center",
  CAMP: "Camp or conference center",
  CONFERENCE: "Conference",
  ASSOCIATION: "Association",
} as const;

export const externalSystemLabels = {
  EADVENTIST: "eAdventist",
  ULTRACAMP: "UltraCamp",
  STERLING: "Sterling Volunteers",
  CMMS: "CMMS",
  WR26: "WR26",
  FLUENT_FORMS: "Old website form",
  ROSTER_IMPORT: "Background check roster import",
} as const;

export function normalizeOrganizationName(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function normalizeProviderScope(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function normalizeExternalId(value: string) {
  return value.normalize("NFKC").trim();
}
