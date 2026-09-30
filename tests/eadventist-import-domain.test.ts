import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  disbandedNotice,
  looseOrganizationKey,
  NEW_RECORD,
  parseActiveFlag,
  EADVENTIST_HEADER,
  EadventistImportError,
  isoDateFromUs,
  organizationKindFor,
  parseCsvRecords,
  parseEadventistCsv,
  planEadventistImport,
  safeWebsiteHref,
  type ExistingOrganization,
} from "@/modules/organizations/eadventist-import";

const fixture = readFileSync(join(__dirname, "fixtures", "eadventist-organizations-synthetic.csv"), "utf8");

function existingFrom(plan: ReturnType<typeof planEadventistImport>): ExistingOrganization[] {
  return plan.items.filter((item) => item.record).map((item, index) => ({
    id: `org-${index}`,
    type: item.record!.type,
    name: item.record!.name,
    normalizedName: item.record!.name.toLowerCase(),
    eadventistId: item.record!.eadventistId,
    identityEadventistId: item.record!.eadventistId,
    hasDependents: false,
    orgCode: item.record!.orgCode,
    sourceOrgType: item.record!.sourceOrgType,
    streetAddress: item.record!.streetAddress,
    city: item.record!.city,
    state: item.record!.state,
    postalCode: item.record!.postalCode,
    website: item.record!.website,
    officePhone: item.record!.officePhone,
    district: item.record!.district,
    language: item.record!.language,
    disbandedOn: item.record!.disbandedOn,
    affiliatedEadventistId: item.affiliatedEadventistId,
  }));
}

describe("the synthetic eAdventist export (#649)", () => {
  it("uses the exact export header", () => {
    expect(fixture.split("\n")[0]).toBe(EADVENTIST_HEADER.join(","));
  });

  it("reads every row, mapping every OrgType to a kind and keeping the source type", () => {
    const { records, rejected } = parseEadventistCsv(fixture);
    expect(rejected).toEqual([]);
    expect(records).toHaveLength(12);
    const kinds = Object.fromEntries(records.map((record) => [record.sourceOrgType, record.type]));
    expect(kinds).toEqual({
      "Conference": "CONFERENCE",
      "Church": "CHURCH",
      "Company": "COMPANY",
      "Group": "GROUP",
      "PK-08 School": "SCHOOL",
      "PK-10 School": "SCHOOL",
      "9-12 School": "SCHOOL",
      "Early Childhood Program (ECP)": "EARLY_CHILDHOOD",
      "Bookstore": "BOOKSTORE",
      "Community Center": "COMMUNITY_CENTER",
      "Camp/Conf center": "CAMP",
      "Association": "ASSOCIATION",
    });
  });

  it("survives a quoted multi-line field with commas and doubled quotes, and keeps only the wanted fields", () => {
    const church = parseEadventistCsv(fixture).records.find((record) => record.eadventistId === "9002")!;
    expect(church).toMatchObject({
      name: "Sample Hills SDA Church", orgCode: "SC002", streetAddress: "10 Sample Road", city: "Sample Hills", state: "ZZ",
      postalCode: "00002", officePhone: "555-0101", district: "North District", language: "English", website: "www.samplehills.example.test",
    });
    // Driving directions, email, and the rest are never carried.
    expect(JSON.stringify(church)).not.toContain("Exit 5");
    expect(Object.keys(church)).not.toContain("email");
    expect(parseCsvRecords(fixture)).toHaveLength(13);
  });

  it("reads a Windows export with a byte-order mark and CRLF line endings", () => {
    const crlf = `﻿${fixture.replace(/\n/g, "\r\n")}`;
    expect(parseEadventistCsv(crlf).records).toHaveLength(12);
  });

  it("rejects a file that is not the export, and reports bad rows one by one", () => {
    expect(() => parseEadventistCsv("Name,Email\nA,b@example.test\n")).toThrow(EadventistImportError);
    expect(() => parseEadventistCsv("")).toThrow(EadventistImportError);
    expect(() => parseCsvRecords("a,\"b")).toThrow(EadventistImportError);
    const header = EADVENTIST_HEADER.join(",");
    const blank = ",".repeat(EADVENTIST_HEADER.length - 1);
    const cols = (values: Record<string, string>) => EADVENTIST_HEADER.map((name) => values[name] ?? "").join(",");
    const csv = [
      header,
      cols({ OrganizationID: "1", OrgName: "Sample Odd Kind", OrgType: "Spaceport", IsActive: "Y" }),
      cols({ OrganizationID: "2", OrgName: "Sample Bad Date", OrgType: "Church", IsActive: "Y", DisbandedOn: "13/45/2024" }),
      cols({ OrganizationID: "3", OrgName: "", OrgType: "Church", IsActive: "Y" }),
      cols({ OrganizationID: "4", OrgName: "Sample Good", OrgType: "Church", IsActive: "Y" }),
      cols({ OrganizationID: "4", OrgName: "Sample Repeat", OrgType: "Church", IsActive: "Y" }),
      blank,
    ].join("\n");
    const { records, rejected } = parseEadventistCsv(csv);
    expect(records.map((record) => record.name)).toEqual(["Sample Good"]);
    expect(rejected.map((row) => row.reason)).toEqual([
      "Unknown organization type \"Spaceport\".",
      "The disbanded date isn't a valid MM/DD/YYYY date.",
      "No organization name.",
      "The same OrganizationID appears earlier in the file.",
    ]);
  });

  it("does not store a Group's street address or phone, only its town", () => {
    const group = parseEadventistCsv(fixture).records.find((record) => record.type === "GROUP")!;
    expect(group).toMatchObject({ streetAddress: null, officePhone: null, city: "Sample Ridge", state: "ZZ", postalCode: "00004" });
    const church = parseEadventistCsv(fixture).records.find((record) => record.type === "CHURCH")!;
    expect(church.streetAddress).toBe("10 Sample Road");
  });

  it("accepts Y/N, TRUE/FALSE and 1/0 in any case for IsActive, and rejects anything else", () => {
    for (const yes of ["Y", "y", "TRUE", "true", "1"]) expect(parseActiveFlag(yes)).toBe(true);
    for (const no of ["N", "n", "FALSE", "False", "0"]) expect(parseActiveFlag(no)).toBe(false);
    for (const other of ["", "maybe", "Yes", "2"]) expect(parseActiveFlag(other)).toBeNull();
    const line = (id: string, active: string) => EADVENTIST_HEADER.map((name) => ({ OrganizationID: id, OrgName: `Sample ${id}`, OrgType: "Church", IsActive: active } as Record<string, string>)[name] ?? "").join(",");
    const { records, rejected } = parseEadventistCsv([EADVENTIST_HEADER.join(","), line("1", "y"), line("2", "FALSE"), line("3", "0"), line("4", "maybe")].join("\n"));
    expect(records.map((record) => record.isActive)).toEqual([true, false, false]);
    expect(rejected).toEqual([{ line: 5, name: "Sample 4", reason: "IsActive must be Y, N, TRUE, FALSE, 1 or 0 (found \"maybe\")." }]);
  });

  it("maps kinds and converts dates", () => {
    expect(organizationKindFor("  pk-08   school ")).toBe("SCHOOL");
    expect(organizationKindFor("Unknown")).toBeNull();
    expect(isoDateFromUs("03/01/2024")).toBe("2024-03-01");
    expect(isoDateFromUs("02/30/2024")).toBeNull();
    expect(isoDateFromUs("2024-03-01")).toBeNull();
  });

  it("flags the disbanded row and words the notice", () => {
    const plan = planEadventistImport(parseEadventistCsv(fixture), []);
    expect(plan.counts).toEqual({ new: 12, updated: 0, unchanged: 0, skipped: 0, flagged: 1 });
    const group = plan.items.find((item) => item.name === "Sample Ridge Group")!;
    expect(group).toMatchObject({ action: "NEW", disbandedOn: "2024-03-01" });
    expect(disbandedNotice(group.disbandedOn, true)).toBe("Disbanded 03/01/2024 on file — review");
    expect(disbandedNotice(group.disbandedOn, false)).toBe("Disbanded 03/01/2024 on file");
    expect(disbandedNotice(null, true)).toBeNull();
  });

  it("resolves SubOrgOf to another imported row, ignoring the conference and unknown names", () => {
    const plan = planEadventistImport(parseEadventistCsv(fixture), []);
    const parentOf = (name: string) => plan.items.find((item) => item.name === name)!.affiliatedEadventistId;
    expect(parentOf("Sample Creek Company")).toBe("9002");
    expect(parentOf("Sample Little Learners")).toBe("9005");
    expect(parentOf("Sample Hills SDA Church")).toBeNull(); // names the conference
    expect(plan.items.find((item) => item.name === "Sample Regional Association")!.notes[0]).toContain("isn't in this file");
  });

  it("ignores a parent that names a conference missing from the file", () => {
    const csv = fixture.split("\n").filter((line) => !line.startsWith("9001,")).join("\n");
    const plan = planEadventistImport(parseEadventistCsv(csv), []);
    const church = plan.items.find((item) => item.name === "Sample Hills SDA Church")!;
    expect(church.affiliatedEadventistId).toBeNull();
    expect(church.notes).toEqual([]);
  });

  it("is idempotent: planning the same file against what it created changes nothing", () => {
    const parsed = parseEadventistCsv(fixture);
    const first = planEadventistImport(parsed, []);
    const second = planEadventistImport(parsed, existingFrom(first));
    expect(second.counts).toEqual({ new: 0, updated: 0, unchanged: 12, skipped: 0, flagged: 1 });
  });

  it("updates a matched record when the export changed, without duplicating it", () => {
    const parsed = parseEadventistCsv(fixture);
    const stored = existingFrom(planEadventistImport(parsed, []));
    const changed = { ...parsed, records: parsed.records.map((record) => (record.eadventistId === "9006" ? { ...record, name: "Sample Junior Academy North", city: "Elsewhere" } : record)) };
    const plan = planEadventistImport(changed, stored);
    expect(plan.counts).toMatchObject({ new: 0, updated: 1, unchanged: 11 });
    expect(plan.items.find((item) => item.action === "UPDATED")).toMatchObject({ matchedBy: "EADVENTIST_ID", existingId: stored.find((org) => org.eadventistId === "9006")!.id });
  });

  describe("matching existing churches by name, once", () => {
    const stored = (overrides: Partial<ExistingOrganization>): ExistingOrganization => ({
      id: "church-1", type: "CHURCH", name: "Sample Hills SDA Church", normalizedName: "sample hills sda church", eadventistId: null, identityEadventistId: null, hasDependents: false, orgCode: null, sourceOrgType: null,
      streetAddress: null, city: null, state: null, postalCode: null, website: null, officePhone: null, district: null, language: null, disbandedOn: null, affiliatedEadventistId: null,
      ...overrides,
    });

    it("proposes the match in the preview and links it to the eAdventist id", () => {
      const plan = planEadventistImport(parseEadventistCsv(fixture), [stored({})]);
      const item = plan.items.find((entry) => entry.name === "Sample Hills SDA Church")!;
      expect(item).toMatchObject({ action: "UPDATED", matchedBy: "NAME", existingId: "church-1" });
      expect(item.notes[0]).toContain("Matches the existing church");
      expect(plan.counts.new).toBe(11);
    });

    it("does not guess between two churches with the same name", () => {
      const plan = planEadventistImport(parseEadventistCsv(fixture), [stored({}), stored({ id: "church-2" })]);
      expect(plan.items.find((entry) => entry.name === "Sample Hills SDA Church")).toMatchObject({ action: "SKIPPED", existingId: null });
      expect(plan.counts.skipped).toBe(1);
    });

    it("lets a Company or Group row match an existing church by exact name", () => {
      const parsed = parseEadventistCsv(fixture);
      const asCompany = { ...parsed, records: parsed.records.map((record) => (record.eadventistId === "9002" ? { ...record, type: "COMPANY" as const } : record)) };
      const plan = planEadventistImport(asCompany, [stored({})]);
      expect(plan.items.find((entry) => entry.eadventistId === "9002")).toMatchObject({ action: "UPDATED", matchedBy: "NAME", kind: "COMPANY", existingId: "church-1" });
    });

    it("keeps a linked church a church when it has dependents, says so, and is then a no-op on re-upload", () => {
      const parsed = parseEadventistCsv(fixture);
      const asGroup = { ...parsed, records: parsed.records.map((record) => (record.eadventistId === "9002" ? { ...record, type: "GROUP" as const, streetAddress: null, officePhone: null } : record)) };
      const first = planEadventistImport(asGroup, [stored({ hasDependents: true })]);
      const item = first.items.find((entry) => entry.eadventistId === "9002")!;
      expect(item.kind).toBe("CHURCH");
      expect(item.notes.join(" ")).toContain("Kept as a church");
      // What the commit writes, stored: the same file plans as unchanged.
      const record = item.record!;
      const after = stored({ ...record, eadventistId: "9002", identityEadventistId: "9002", type: "CHURCH", hasDependents: true, affiliatedEadventistId: item.affiliatedEadventistId });
      const others = existingFrom(first).filter((org) => org.eadventistId !== "9002");
      const second = planEadventistImport(asGroup, [after, ...others]);
      expect(second.items.find((entry) => entry.eadventistId === "9002")!.action).toBe("UNCHANGED");
      // Without dependents it is retyped.
      const free = planEadventistImport(asGroup, [stored({})]).items.find((entry) => entry.eadventistId === "9002")!;
      expect(free.kind).toBe("GROUP");
    });

    it("never matches by name once the stored church carries an eAdventist id, nor a non-church kind", () => {
      const linked = planEadventistImport(parseEadventistCsv(fixture), [stored({ eadventistId: "5555" })]);
      expect(linked.items.find((entry) => entry.name === "Sample Hills SDA Church")).toMatchObject({ action: "NEW", matchedBy: null });
      const club = planEadventistImport(parseEadventistCsv(fixture), [stored({ type: "CLUB" })]);
      expect(club.items.find((entry) => entry.name === "Sample Hills SDA Church")!.action).toBe("NEW");
    });
  });

  describe("eAdventist ids held by an ExternalIdentity", () => {
    const base = (overrides: Partial<ExistingOrganization>): ExistingOrganization => ({
      id: "church-1", type: "CHURCH", name: "Some Other Name", normalizedName: "some other name", eadventistId: null, identityEadventistId: null, hasDependents: false, orgCode: null, sourceOrgType: null,
      streetAddress: null, city: null, state: null, postalCode: null, website: null, officePhone: null, district: null, language: null, disbandedOn: null, affiliatedEadventistId: null,
      ...overrides,
    });

    it("matches by the identity ahead of any name match, and plans the column to be filled in", () => {
      const plan = planEadventistImport(parseEadventistCsv(fixture), [base({ identityEadventistId: "9002" }), base({ id: "church-2", name: "Sample Hills SDA Church", normalizedName: "sample hills sda church" })]);
      expect(plan.items.find((item) => item.eadventistId === "9002")).toMatchObject({ action: "UPDATED", matchedBy: "EADVENTIST_ID", existingId: "church-1" });
      // The same-named church is not claimed by the name match.
      expect(plan.counts.new).toBe(11);
    });

    it("shows a conflict when the column and the identity disagree, or two organizations claim the id", () => {
      const disagree = planEadventistImport(parseEadventistCsv(fixture), [base({ eadventistId: "9002", identityEadventistId: "1234" })]);
      expect(disagree.items.find((item) => item.eadventistId === "9002")).toMatchObject({ action: "SKIPPED" });
      expect(disagree.items.find((item) => item.eadventistId === "9002")!.notes[0]).toContain("disagree");
      const twice = planEadventistImport(parseEadventistCsv(fixture), [base({ eadventistId: "9002" }), base({ id: "church-2", identityEadventistId: "9002" })]);
      expect(twice.items.find((item) => item.eadventistId === "9002")!.notes[0]).toContain("Two stored organizations");
    });

    it("plans an update when only one of the two places holds the id", () => {
      const parsed = parseEadventistCsv(fixture);
      const stored = existingFrom(planEadventistImport(parsed, []));
      const halfway = stored.map((org) => (org.eadventistId === "9006" ? { ...org, identityEadventistId: null } : org));
      expect(planEadventistImport(parsed, halfway).counts).toMatchObject({ updated: 1, unchanged: 11 });
    });
  });

  describe("possible matches", () => {
    const church = (overrides: Partial<ExistingOrganization>): ExistingOrganization => ({
      id: "church-1", type: "CHURCH", name: "Sample Hills Seventh-day Adventist Church", normalizedName: "sample hills seventh-day adventist church", eadventistId: null, identityEadventistId: null, hasDependents: false,
      orgCode: null, sourceOrgType: null, streetAddress: null, city: null, state: null, postalCode: null, website: null, officePhone: null, district: null, language: null, disbandedOn: null, affiliatedEadventistId: null,
      ...overrides,
    });

    it("builds a loose key that ignores case, punctuation and filler words", () => {
      expect(looseOrganizationKey("Sample Hills SDA Church")).toBe("sample hills");
      expect(looseOrganizationKey("SAMPLE HILLS Seventh-day Adventist Church")).toBe("sample hills");
      expect(looseOrganizationKey("Sample Hills Company")).toBe("sample hills");
      expect(looseOrganizationKey("Sample-Hills, Group")).toBe("sample hills");
      expect(looseOrganizationKey("SDA Church")).toBe("");
    });

    it("offers a possible match, linking by default and creating a new record on request", () => {
      const parsed = parseEadventistCsv(fixture);
      const plan = planEadventistImport(parsed, [church({})]);
      const item = plan.items.find((entry) => entry.eadventistId === "9002")!;
      expect(item).toMatchObject({ action: "UPDATED", matchedBy: "POSSIBLE", existingId: "church-1", possibleMatches: [{ id: "church-1", name: "Sample Hills Seventh-day Adventist Church" }] });
      expect(item.notes[0]).toContain("Possible match");
      const created = planEadventistImport(parsed, [church({})], { "9002": NEW_RECORD }).items.find((entry) => entry.eadventistId === "9002")!;
      expect(created).toMatchObject({ action: "NEW", existingId: null });
      expect(created.possibleMatches).toHaveLength(1);
      const other = planEadventistImport(parsed, [church({}), church({ id: "church-2", name: "Sample Hills SDA" })], { "9002": "church-2" }).items.find((entry) => entry.eadventistId === "9002")!;
      expect(other.existingId).toBe("church-2");
      // A stale or invented choice falls back to the default.
      expect(planEadventistImport(parsed, [church({})], { "9002": "nope" }).items.find((entry) => entry.eadventistId === "9002")!.existingId).toBe("church-1");
    });

    it("links one stored church to at most one row", () => {
      const parsed = parseEadventistCsv(fixture);
      const twoRows = { ...parsed, records: [...parsed.records, { ...parsed.records.find((record) => record.eadventistId === "9002")!, eadventistId: "9099", line: 99 }] };
      const plan = planEadventistImport(twoRows, [church({})]);
      expect(plan.items.filter((entry) => entry.existingId === "church-1")).toHaveLength(1);
    });
  });

  it("gives a row whose parent was skipped no parent, so the re-upload is a no-op", () => {
    const parsed = parseEadventistCsv(fixture);
    const dupes = ["a", "b"].map((id) => ({ id: `c-${id}`, type: "CHURCH" as const, name: "Sample Hills SDA Church", normalizedName: "sample hills sda church", eadventistId: null, identityEadventistId: null, hasDependents: false, orgCode: null, sourceOrgType: null, streetAddress: null, city: null, state: null, postalCode: null, website: null, officePhone: null, district: null, language: null, disbandedOn: null, affiliatedEadventistId: null }));
    const plan = planEadventistImport(parsed, dupes);
    expect(plan.items.find((item) => item.name === "Sample Hills SDA Church")!.action).toBe("SKIPPED");
    const company = plan.items.find((item) => item.name === "Sample Creek Company")!;
    expect(company.affiliatedEadventistId).toBeNull();
    expect(company.notes.join(" ")).toContain("was skipped");
  });

  it("only links http(s) websites", () => {
    expect(safeWebsiteHref("www.example.test")).toBe("https://www.example.test/");
    expect(safeWebsiteHref("http://example.test/a")).toBe("http://example.test/a");
    expect(safeWebsiteHref("javascript:alert(1)")).toBeNull();
    expect(safeWebsiteHref(null)).toBeNull();
  });
});
