export const organizationTypeLabels = {
  CHURCH: "Church",
  CLUB: "Club",
} as const;

export const externalSystemLabels = {
  EADVENTIST: "eAdventist",
  ULTRACAMP: "UltraCamp",
  STERLING: "Sterling Volunteers",
  CMMS: "CMMS",
  WR26: "WR26",
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
