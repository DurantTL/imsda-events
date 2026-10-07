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
  ROSTER_IMPORT: "Sterling Volunteers (roster import)",
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

/**
 * The organization kinds that may sponsor a club (#822). A Pathfinder club can
 * be sponsored by a company or group (a congregation not yet organized as a
 * church) as well as by a church. This is the one rule for "who can be a club's
 * sponsoring organization": use it wherever a sponsor is chosen or checked.
 * The sponsor is stored in `parentOrganizationId`; `affiliatedOrganizationId`
 * (#649) keeps its own meaning.
 */
export const SPONSOR_ORGANIZATION_TYPES = ["CHURCH", "COMPANY", "GROUP"] as const;

export type SponsorOrganizationType = (typeof SPONSOR_ORGANIZATION_TYPES)[number];

/** True for a kind that may sponsor a club. */
export function isSponsorOrganizationType(type: string | null | undefined): type is SponsorOrganizationType {
  return type != null && (SPONSOR_ORGANIZATION_TYPES as readonly string[]).includes(type);
}

/** True for an active organization of a sponsor kind: the check a club's sponsor must pass. */
export function canSponsorClub(organization: { type: string; isActive: boolean } | null | undefined): boolean {
  return !!organization && organization.isActive && isSponsorOrganizationType(organization.type);
}

/** Picker label: the name, then the kind for anything that is not a church ("New Change for Youth (Company)"). */
export function sponsorOptionLabel(option: { name: string; type: string }): string {
  if (option.type === "CHURCH") return option.name;
  const label = organizationTypeLabels[option.type as keyof typeof organizationTypeLabels];
  return label ? `${option.name} (${label})` : option.name;
}
