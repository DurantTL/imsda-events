import type { OrganizationType } from "@prisma/client";
import { isSponsorOrganizationType, normalizeOrganizationName, organizationTypeLabels } from "@/modules/organizations/domain";

/**
 * The eAdventist organizations export (#649). Pure: parses the CSV, maps each
 * row to an organization record, and plans what a commit would do against the
 * organizations already stored. Nothing here reads or writes the database, so
 * the preview and the commit share one plan.
 *
 * Only the fields the directory needs are kept. Driving directions, service
 * times, social and streaming links, attendance, ethnicity, coordinates, and
 * the "c/o" lines are never read past the parser.
 */

export const EADVENTIST_MAX_BYTES = 5_000_000;
export const EADVENTIST_MAX_ROWS = 2_000;

export const EADVENTIST_HEADER = [
  "OrganizationID", "OrgCode", "OrgName", "OrgType", "GroupStartedOn", "CompanyOrganizedOn", "ChurchOrganizedOn", "DisbandedOn",
  "IsActive", "IsOnline", "SubOrgOf", "DrivingDirections", "SabbathSchool", "Church", "Church2nd", "PrayerMeeting", "WebSite", "Email",
  "AverageAttendance", "County", "District", "Ethnicity", "Language", "StreetOptional", "StreetAddress", "StreetCity", "StreetState",
  "StreetPostal", "StreetCountry", "MailOptional", "MailAddress", "MailCity", "MailState", "MailPostal", "MailCountry", "OfficePhone",
  "Fax", "Latitude", "Longitude", "CountyName", "CountyFIPS", "FacebookUrl", "InstagramUrl", "TwitterUrl", "StreamingUrl", "StreamingTime",
] as const;

/** The columns the import reads. The rest of the header only has to be tolerated. */
const REQUIRED_COLUMNS = [
  "OrganizationID", "OrgCode", "OrgName", "OrgType", "DisbandedOn", "IsActive", "SubOrgOf", "WebSite", "District", "Language",
  "StreetAddress", "StreetCity", "StreetState", "StreetPostal", "OfficePhone",
] as const;

export class EadventistImportError extends Error {
  constructor(public readonly code: "INVALID_CSV" | "MISSING_COLUMNS" | "TOO_LARGE" | "TOO_MANY_ROWS" | "NEEDS_CHOICES", message: string) {
    super(message);
    this.name = "EadventistImportError";
  }
}

const kindByOrgType: Record<string, OrganizationType> = {
  "church": "CHURCH",
  "company": "COMPANY",
  "group": "GROUP",
  "pk-08 school": "SCHOOL",
  "pk-10 school": "SCHOOL",
  "9-12 school": "SCHOOL",
  "early childhood program (ecp)": "EARLY_CHILDHOOD",
  "bookstore": "BOOKSTORE",
  "community center": "COMMUNITY_CENTER",
  "camp/conf center": "CAMP",
  "conference": "CONFERENCE",
  "association": "ASSOCIATION",
};

export const organizationKindLabels: Record<OrganizationType, string> = organizationTypeLabels;

export function organizationKindFor(orgType: string): OrganizationType | null {
  return kindByOrgType[orgType.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US")] ?? null;
}

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes, and line breaks. */
export function parseCsvRecords(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawContent = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (inQuotes) {
      if (char === "\"") {
        if (text[i + 1] === "\"") { field += "\""; i += 1; } else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === "\"" && field === "") { inQuotes = true; sawContent = true; continue; }
    if (char === ",") { record.push(field); field = ""; sawContent = true; continue; }
    if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      if (sawContent || field !== "") { record.push(field); records.push(record); }
      record = []; field = ""; sawContent = false;
      continue;
    }
    field += char;
    sawContent = true;
  }
  if (inQuotes) throw new EadventistImportError("INVALID_CSV", "The file ends inside a quoted field. Export it again from eAdventist.");
  if (sawContent || field !== "") { record.push(field); records.push(record); }
  return records;
}

const clean = (value: string | undefined, max: number) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max);

/** MM/DD/YYYY (as exported) to YYYY-MM-DD, or null when it isn't a real date. */
export function isoDateFromUs(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function displayUsDate(iso: string) {
  const [year, month, day] = iso.split("-");
  return `${month}/${day}/${year}`;
}

/** Y/N, TRUE/FALSE, 1/0, any case. Anything else (including blank) is not a usable value. */
export function parseActiveFlag(value: string): boolean | null {
  const flag = value.trim().toLocaleUpperCase("en-US");
  if (flag === "Y" || flag === "TRUE" || flag === "1") return true;
  if (flag === "N" || flag === "FALSE" || flag === "0") return false;
  return null;
}

export type EadventistRecord = {
  eadventistId: string;
  orgCode: string | null;
  name: string;
  type: OrganizationType;
  sourceOrgType: string;
  isActive: boolean;
  disbandedOn: string | null;
  subOrgOf: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  website: string | null;
  officePhone: string | null;
  district: string | null;
  language: string | null;
};

export type EadventistParseResult = {
  records: Array<EadventistRecord & { line: number }>;
  /** Rows that could not be used, with why. Never includes field values beyond the name. */
  rejected: Array<{ line: number; name: string; reason: string }>;
};

/**
 * Reads the export. The header must include every column the import uses;
 * extra columns are ignored. A bad row is rejected on its own with a reason.
 */
export function parseEadventistCsv(csv: string): EadventistParseResult {
  if (csv.length > EADVENTIST_MAX_BYTES) throw new EadventistImportError("TOO_LARGE", "That file is larger than 5 MB.");
  const table = parseCsvRecords(csv);
  if (table.length === 0) throw new EadventistImportError("INVALID_CSV", "The file is empty.");
  const header = table[0]!.map((cell) => cell.trim());
  const index = new Map(header.map((name, position) => [name, position]));
  const missing = REQUIRED_COLUMNS.filter((name) => !index.has(name));
  if (missing.length > 0) {
    throw new EadventistImportError("MISSING_COLUMNS", `This doesn't look like the eAdventist organizations export. Missing columns: ${missing.join(", ")}.`);
  }
  if (table.length - 1 > EADVENTIST_MAX_ROWS) throw new EadventistImportError("TOO_MANY_ROWS", `The file has more than ${EADVENTIST_MAX_ROWS} rows.`);
  const cell = (row: string[], name: string) => row[index.get(name)!] ?? "";

  const records: EadventistParseResult["records"] = [];
  const rejected: EadventistParseResult["rejected"] = [];
  const seen = new Set<string>();
  // Line numbers count spreadsheet rows: the header is line 1.
  table.slice(1).forEach((row, offset) => {
    const line = offset + 2;
    if (row.every((value) => !value.trim())) return;
    const name = clean(cell(row, "OrgName"), 200);
    const eadventistId = clean(cell(row, "OrganizationID"), 40);
    if (!eadventistId) return void rejected.push({ line, name, reason: "No OrganizationID." });
    if (!name) return void rejected.push({ line, name, reason: "No organization name." });
    if (seen.has(eadventistId)) return void rejected.push({ line, name, reason: "The same OrganizationID appears earlier in the file." });
    const sourceOrgType = clean(cell(row, "OrgType"), 60);
    const type = organizationKindFor(sourceOrgType);
    if (!type) return void rejected.push({ line, name, reason: `Unknown organization type "${sourceOrgType}".` });
    const disbandedText = clean(cell(row, "DisbandedOn"), 20);
    const disbandedOn = disbandedText ? isoDateFromUs(disbandedText) : null;
    if (disbandedText && !disbandedOn) return void rejected.push({ line, name, reason: "The disbanded date isn't a valid MM/DD/YYYY date." });
    const activeText = clean(cell(row, "IsActive"), 10);
    const isActive = parseActiveFlag(activeText);
    if (isActive === null) return void rejected.push({ line, name, reason: `IsActive must be Y, N, TRUE, FALSE, 1 or 0 (found "${activeText}").` });
    seen.add(eadventistId);
    // Groups often meet in homes: keep the town only, never the street or phone.
    const home = type === "GROUP";
    records.push({
      line,
      eadventistId,
      orgCode: clean(cell(row, "OrgCode"), 40) || null,
      name,
      type,
      sourceOrgType,
      isActive,
      disbandedOn,
      subOrgOf: clean(cell(row, "SubOrgOf"), 200) || null,
      streetAddress: home ? null : clean(cell(row, "StreetAddress"), 200) || null,
      city: clean(cell(row, "StreetCity"), 100) || null,
      state: clean(cell(row, "StreetState"), 40) || null,
      postalCode: clean(cell(row, "StreetPostal"), 20) || null,
      website: clean(cell(row, "WebSite"), 300) || null,
      officePhone: home ? null : clean(cell(row, "OfficePhone"), 40) || null,
      district: clean(cell(row, "District"), 100) || null,
      language: clean(cell(row, "Language"), 60) || null,
    });
  });
  return { records, rejected };
}

/** What the plan needs to know about an organization already stored. */
export type ExistingOrganization = {
  id: string;
  type: OrganizationType;
  name: string;
  normalizedName: string;
  /** `Organization.eadventistId`. */
  eadventistId: string | null;
  /** The externalId of this organization's EADVENTIST `ExternalIdentity`, when it has one. */
  identityEadventistId: string | null;
  /** Sponsors clubs, sponsors promo codes, or has a church location: it must stay a church. */
  hasDependents: boolean;
  orgCode: string | null;
  sourceOrgType: string | null;
  streetAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  website: string | null;
  officePhone: string | null;
  district: string | null;
  language: string | null;
  /** ISO date (YYYY-MM-DD). */
  disbandedOn: string | null;
  /** The eAdventist id of the affiliated organization, when it has one. */
  affiliatedEadventistId: string | null;
  /** Stored active switch; staff own it once a record exists. Treated as active when absent. */
  isActive?: boolean;
  /** The stored ChurchLocation (#724), or null. Treated as null when absent. */
  location?: ExistingLocation | null;
};

/** What the plan needs to know about a stored church location. */
export type ExistingLocation = {
  source: "IMPORT" | "MANUAL" | "GEOCODED";
  city: string;
  state: string;
  zip: string;
  hasCoordinates: boolean;
};

export type PlanAction = "NEW" | "UPDATED" | "UNCHANGED" | "SKIPPED";

export type PossibleMatch = { id: string; name: string };

export type PlanItem = {
  line: number;
  eadventistId: string;
  name: string;
  /** The kind the record will have after the commit (a church with dependents keeps CHURCH). */
  kind: OrganizationType;
  action: PlanAction;
  /** How the stored record was found. */
  matchedBy: "EADVENTIST_ID" | "NAME" | "POSSIBLE" | null;
  existingId: string | null;
  /** Human-readable notes: the proposed name match, an unresolved parent, and so on. */
  notes: string[];
  /** Has a DisbandedOn date on file; shown "Disbanded {date} on file — review". */
  disbandedOn: string | null;
  /** Stored churches this row loosely resembles; staff choose to link one or create a new record. */
  possibleMatches: PossibleMatch[];
  /** A possible match with no choice yet: nothing can be saved until staff choose. */
  needsChoice: boolean;
  record: EadventistRecord | null;
  /** The eAdventist id of the resolved parent inside this file, or null. */
  affiliatedEadventistId: string | null;
  /** What the commit does to the church's map location (#724), or null when nothing. */
  location: LocationPlan | null;
  /** The stored street, town, state or ZIP differs from the file: any saved geocode result is stale. */
  addressChanged: boolean;
};

/**
 * City, state and ZIP for a church's ChurchLocation (#724). Never a street
 * address and never coordinates: the import does not geocode. `clearPoint`
 * drops coordinates that came from a geocode of an address that has changed.
 */
export type LocationPlan = {
  action: "CREATE" | "UPDATE";
  city: string;
  state: string;
  zip: string;
  clearPoint: boolean;
};

export type ImportPlan = {
  items: PlanItem[];
  counts: { new: number; updated: number; unchanged: number; skipped: number; flagged: number };
  /** Church locations the commit creates or updates (#724). */
  locationCounts: { created: number; updated: number };
  /** Rows still waiting for a "Possible match" choice. */
  needsChoice: number;
  rejected: EadventistParseResult["rejected"];
};

/** Staff choices for "Possible match" rows: eAdventist id to a stored organization id, or `NEW_RECORD`. */
export const NEW_RECORD = "NEW";
export type LinkChoices = Record<string, string>;

const conferenceNamePattern = /\bconference\b/i;

/** A 5-digit ZIP or ZIP+4 (as ChurchLocation holds them), or blank when the export's value isn't one. */
export function locationZip(postalCode: string | null) {
  const digits = (postalCode ?? "").replace(/\D/g, "");
  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  return "";
}

/**
 * A comparable form of a church's public address (#724): whitespace and case
 * folded, the ZIP normalized. A geocode result is only good for the address it
 * was found for.
 */
export function churchAddressKey(address: { street: string | null; city: string | null; state: string | null; zip: string | null }) {
  const fold = (value: string | null) => (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
  return [fold(address.street), fold(address.city), fold(address.state), locationZip(address.zip)].join("|");
}

/**
 * The map location a church row yields (#724): only an active church with a
 * town gets one, and only when no person set the stored location by hand. Home
 * meeting groups never do (the public map plots churches, and a group's home
 * must never be a point). Schools, companies and camps are not plotted by the
 * public club map, so they get none either.
 */
function planLocation(record: EadventistRecord, kind: OrganizationType, stored: ExistingOrganization | null): LocationPlan | null {
  const current = stored?.location ?? null;
  // A geocoded point belongs to a church's street address: once the record is no
  // longer a church, or has no street address, the point is dropped.
  if (current?.source === "GEOCODED" && current.hasCoordinates && (kind !== "CHURCH" || record.type !== "CHURCH" || !record.streetAddress)) {
    return { action: "UPDATE", city: current.city, state: current.state, zip: current.zip, clearPoint: true };
  }
  if (kind !== "CHURCH" || record.type !== "CHURCH") return null;
  const active = stored ? stored.isActive ?? true : record.isActive;
  if (!active || !record.city) return null;
  const next = { city: record.city, state: record.state ?? "", zip: locationZip(record.postalCode) };
  if (!current) return { action: "CREATE", ...next, clearPoint: false };
  if (current.source === "MANUAL") return null;
  const placeChanged = current.city !== next.city || current.state !== next.state || current.zip !== next.zip;
  // A geocoded point belongs to the address it was found for.
  const addressChanged = current.source === "GEOCODED" && current.hasCoordinates && (placeChanged || (stored?.streetAddress ?? null) !== record.streetAddress);
  if (!placeChanged && !addressChanged) return null;
  return { action: "UPDATE", ...next, clearPoint: addressChanged };
}

const FIELDS = ["orgCode", "sourceOrgType", "streetAddress", "city", "state", "postalCode", "website", "officePhone", "district", "language"] as const;

/**
 * A looser name key for finding a church the eAdventist export names a little
 * differently: case, punctuation, and the words SDA, Seventh-day Adventist,
 * Church, Company and Group are ignored. Empty when nothing is left.
 */
export function looseOrganizationKey(name: string) {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\bseventh day adventist\b/g, " ")
    .replace(/\b(sda|church|company|group)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function differs(record: EadventistRecord, kind: OrganizationType, existing: ExistingOrganization, affiliatedEadventistId: string | null) {
  return existing.name !== record.name
    || existing.type !== kind
    || existing.disbandedOn !== record.disbandedOn
    || existing.affiliatedEadventistId !== affiliatedEadventistId
    // Both places that hold the id must agree (ExternalIdentity and the column).
    || existing.eadventistId !== record.eadventistId
    || existing.identityEadventistId !== record.eadventistId
    || FIELDS.some((field) => (existing[field] ?? null) !== record[field]);
}

type Matched = {
  record: EadventistParseResult["records"][number];
  existing: ExistingOrganization | null;
  matchedBy: PlanItem["matchedBy"];
  notes: string[];
  skipped: boolean;
  needsChoice: boolean;
  possibleMatches: PossibleMatch[];
};

/**
 * Plans a commit. Matching runs in separate passes over the whole file, so an
 * early row can never take a church a later row matches more exactly:
 * 1. by eAdventist OrganizationID, from `Organization.eadventistId` or the
 *    organization's EADVENTIST ExternalIdentity. A club is never an import
 *    target: a row whose id a club holds is skipped. If the column and the
 *    identity disagree, two organizations claim the id, or `blocked` says a
 *    person or another scope holds it, the row is a skipped conflict;
 * 2. a Church, Company or Group row against exactly one unclaimed stored CHURCH
 *    without an eAdventist id, by normalized name (shown in the preview);
 * 3. a stored church that matches only loosely (see `looseOrganizationKey`) is a
 *    "Possible match" with no default: the row needs an explicit choice in
 *    `choices` (a candidate's id, or `NEW_RECORD`) before anything can be saved.
 *    Explicit choices are applied first; a choice that is not a current
 *    candidate skips the row and never falls back to another church.
 *
 * `isActive` is never part of an update: staff own that switch once a record
 * exists. A stored church keeps its CHURCH kind when it sponsors clubs or promo
 * codes or has a location. The plan records exactly what the commit writes,
 * so planning the same file again after a commit reports nothing to do.
 */
export function planEadventistImport(
  parsed: EadventistParseResult,
  existing: ExistingOrganization[],
  choices: LinkChoices = {},
  blocked: ReadonlyMap<string, string> = new Map(),
): ImportPlan {
  const byId = new Map<string, Set<ExistingOrganization>>();
  for (const org of existing) {
    for (const id of new Set([org.eadventistId, org.identityEadventistId])) {
      if (id) byId.set(id, (byId.get(id) ?? new Set()).add(org));
    }
  }
  const unlinked = existing.filter((org) => org.type === "CHURCH" && !org.eadventistId && !org.identityEadventistId);
  const congregation = (type: OrganizationType) => type === "CHURCH" || type === "COMPANY" || type === "GROUP";
  const records = parsed.records;
  const results: Array<Matched | undefined> = records.map(() => undefined);
  const claimed = new Set<string>();

  const skip = (index: number, note: string, notes: string[] = []) => {
    results[index] = { record: records[index]!, existing: null, matchedBy: null, notes: [...notes, note], skipped: true, needsChoice: false, possibleMatches: [] };
  };
  const plain = (index: number, notes: string[] = [], possibleMatches: PossibleMatch[] = []) => {
    results[index] = { record: records[index]!, existing: null, matchedBy: null, notes, skipped: false, needsChoice: false, possibleMatches };
  };

  // Pass 1: ids.
  records.forEach((record, index) => {
    const blockedNote = blocked.get(record.eadventistId);
    if (blockedNote) return skip(index, blockedNote);
    const holders = byId.get(record.eadventistId);
    if (!holders) return;
    if ([...holders].some((org) => org.type === "CLUB")) return skip(index, "This eAdventist id belongs to a club; not imported");
    if (holders.size > 1) return skip(index, "Two stored organizations already claim this eAdventist id, so this row was skipped. Resolve the duplicate and upload again.");
    const [only] = [...holders];
    if (only!.eadventistId && only!.identityEadventistId && only!.eadventistId !== only!.identityEadventistId) {
      return skip(index, "The stored organization's eAdventist id and its eAdventist external identity disagree, so this row was skipped. Correct one of them and upload again.");
    }
    claimed.add(only!.id);
    results[index] = { record, existing: only!, matchedBy: "EADVENTIST_ID", notes: [], skipped: false, needsChoice: false, possibleMatches: [] };
  });

  // Pass 2: exact normalized names, among what is still unclaimed.
  records.forEach((record, index) => {
    if (results[index] || !congregation(record.type)) return;
    const key = normalizeOrganizationName(record.name);
    const exact = unlinked.filter((org) => !claimed.has(org.id) && (org.normalizedName || normalizeOrganizationName(org.name)) === key);
    if (exact.length === 1) {
      claimed.add(exact[0]!.id);
      results[index] = {
        record, existing: exact[0]!, matchedBy: "NAME", skipped: false, needsChoice: false, possibleMatches: [],
        notes: [`Matches the existing church "${exact[0]!.name}" by name. It will be linked to this eAdventist record.`],
      };
    } else if (exact.length > 1) {
      skip(index, "More than one existing church has this name, so it wasn't matched. Rename or deactivate the duplicates and upload again.");
    }
  });

  // Pass 3: loose matches. Explicit choices first, then rows still waiting for one.
  const candidatesFor = (record: EadventistRecord) => {
    const key = looseOrganizationKey(record.name);
    if (!key) return [];
    return unlinked
      .filter((org) => !claimed.has(org.id) && looseOrganizationKey(org.name) === key)
      .map((org) => ({ id: org.id, name: org.name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };
  const open = records.map((_, index) => index).filter((index) => !results[index] && congregation(records[index]!.type));
  for (const index of open.filter((i) => choices[records[i]!.eadventistId] !== undefined)) {
    const record = records[index]!;
    const choice = choices[record.eadventistId]!;
    const candidates = candidatesFor(record);
    if (choice === NEW_RECORD) {
      plain(index, candidates.length > 0 ? ["Possible match found; a new record will be created instead."] : [], candidates);
      continue;
    }
    const chosen = candidates.find((candidate) => candidate.id === choice);
    if (!chosen) {
      // Stale or crafted: never fall back to another church. Keep the current candidates and ask again.
      results[index] = {
        record, existing: null, matchedBy: null, skipped: false, needsChoice: true, possibleMatches: candidates,
        notes: ["Your choice is no longer available — choose again"],
      };
      continue;
    }
    claimed.add(chosen.id);
    results[index] = {
      record, existing: unlinked.find((org) => org.id === chosen.id)!, matchedBy: "POSSIBLE", skipped: false, needsChoice: false, possibleMatches: candidates,
      notes: [`Linked to "${chosen.name}" by your choice.`],
    };
  }
  for (const index of open.filter((i) => !results[i])) {
    const candidates = candidatesFor(records[index]!);
    if (candidates.length === 0) continue;
    results[index] = {
      record: records[index]!, existing: null, matchedBy: null, skipped: false, needsChoice: true, possibleMatches: candidates,
      notes: ["Possible match — choose: link to an existing church or create a new record."],
    };
  }
  records.forEach((_, index) => { if (!results[index]) plain(index); });
  const matched = results as Matched[];

  const skippedIds = new Set(matched.filter((entry) => entry.skipped).map((entry) => entry.record.eadventistId));
  const rowsByName = new Map<string, Array<EadventistParseResult["records"][number]>>();
  for (const record of parsed.records) {
    const key = normalizeOrganizationName(record.name);
    rowsByName.set(key, [...(rowsByName.get(key) ?? []), record]);
  }
  const conferenceNames = new Set(parsed.records.filter((record) => record.type === "CONFERENCE").map((record) => normalizeOrganizationName(record.name)));

  const items: PlanItem[] = matched.map((entry) => {
    const { record, existing: stored, matchedBy, skipped, possibleMatches, needsChoice } = entry;
    const notes = [...entry.notes];
    const base = { line: record.line, eadventistId: record.eadventistId, name: record.name, disbandedOn: record.disbandedOn, possibleMatches, needsChoice };
    if (skipped) {
      return { ...base, kind: record.type, action: "SKIPPED" as const, matchedBy: null, existingId: null, notes, record: null, affiliatedEadventistId: null, location: null, addressChanged: false };
    }

    // SubOrgOf: resolve by name to another imported row; ignore the conference itself.
    let affiliatedEadventistId: string | null = null;
    if (record.subOrgOf) {
      const parentKey = normalizeOrganizationName(record.subOrgOf);
      const candidates = rowsByName.get(parentKey) ?? [];
      if (conferenceNames.has(parentKey) || (candidates.length === 0 && conferenceNamePattern.test(record.subOrgOf))) {
        // The conference itself: not a parent worth recording.
      } else if (candidates.length === 1 && candidates[0]!.eadventistId !== record.eadventistId) {
        if (skippedIds.has(candidates[0]!.eadventistId)) notes.push(`Parent "${record.subOrgOf}" was skipped, so no parent was set.`);
        else affiliatedEadventistId = candidates[0]!.eadventistId;
      } else if (candidates.length > 1) {
        notes.push(`Parent "${record.subOrgOf}" matches more than one row, so no parent was set.`);
      } else if (candidates.length === 0) {
        notes.push(`Parent "${record.subOrgOf}" isn't in this file, so no parent was set.`);
      }
    }

    // A church that sponsors clubs or promo codes, or has a location, stays a church.
    let kind = record.type;
    if (stored && stored.type === "CHURCH" && record.type !== "CHURCH" && stored.hasDependents) {
      kind = "CHURCH";
      notes.push(`Kept as a church: it sponsors clubs or promo codes or has a location, so it was not changed to ${organizationTypeLabels[record.type].toLocaleLowerCase("en-US")}.`);
    } else if (stored && isSponsorOrganizationType(stored.type) && !isSponsorOrganizationType(record.type) && stored.hasDependents) {
      // A company or group (or church) that sponsors clubs or promo codes must stay a kind that can sponsor (#822); the preview says so.
      kind = stored.type;
      notes.push(`Kept as a ${organizationTypeLabels[stored.type].toLocaleLowerCase("en-US")}: it sponsors clubs or promo codes, so it was not changed to ${organizationTypeLabels[record.type].toLocaleLowerCase("en-US")}. Review it.`);
    }

    const action: PlanAction = !stored ? "NEW" : differs(record, kind, stored, affiliatedEadventistId) ? "UPDATED" : "UNCHANGED";
    return { ...base, kind, action, matchedBy, existingId: stored?.id ?? null, notes, record, affiliatedEadventistId, location: planLocation(record, kind, stored),
      addressChanged: !!stored && churchAddressKey({ street: stored.streetAddress, city: stored.city, state: stored.state, zip: stored.postalCode })
        !== churchAddressKey({ street: record.streetAddress, city: record.city, state: record.state, zip: record.postalCode }) };
  });

  const counts = { new: 0, updated: 0, unchanged: 0, skipped: 0, flagged: 0 };
  for (const item of items) {
    counts[item.action.toLowerCase() as "new" | "updated" | "unchanged" | "skipped"] += 1;
    if (item.disbandedOn && item.action !== "SKIPPED") counts.flagged += 1;
  }
  const locationCounts = {
    created: items.filter((item) => item.location?.action === "CREATE").length,
    updated: items.filter((item) => item.location?.action === "UPDATE").length,
  };
  return { items, counts, locationCounts, needsChoice: items.filter((item) => item.needsChoice).length, rejected: parsed.rejected };
}

/** "Disbanded 03/01/2024 on file — review" (#649): shown wherever a record with a date is active. */
export function disbandedNotice(disbandedOn: string | null, isActive: boolean) {
  if (!disbandedOn) return null;
  return isActive ? `Disbanded ${displayUsDate(disbandedOn)} on file — review` : `Disbanded ${displayUsDate(disbandedOn)} on file`;
}

/** Only http(s) links are rendered as links. */
export function safeWebsiteHref(website: string | null) {
  if (!website) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(website) ? website : `https://${website}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
