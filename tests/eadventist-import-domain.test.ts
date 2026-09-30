import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  disbandedNotice,
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
      cols({ OrganizationID: "2", OrgName: "Sample Bad Date", OrgType: "Church", DisbandedOn: "13/45/2024" }),
      cols({ OrganizationID: "3", OrgName: "", OrgType: "Church" }),
      cols({ OrganizationID: "4", OrgName: "Sample Good", OrgType: "Church" }),
      cols({ OrganizationID: "4", OrgName: "Sample Repeat", OrgType: "Church" }),
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
      id: "church-1", type: "CHURCH", name: "Sample Hills SDA Church", normalizedName: "sample hills sda church", eadventistId: null, orgCode: null, sourceOrgType: null,
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

    it("never matches by name once the stored church carries an eAdventist id, nor a non-church kind", () => {
      const linked = planEadventistImport(parseEadventistCsv(fixture), [stored({ eadventistId: "5555" })]);
      expect(linked.items.find((entry) => entry.name === "Sample Hills SDA Church")).toMatchObject({ action: "NEW", matchedBy: null });
      const club = planEadventistImport(parseEadventistCsv(fixture), [stored({ type: "CLUB" })]);
      expect(club.items.find((entry) => entry.name === "Sample Hills SDA Church")!.action).toBe("NEW");
    });
  });

  it("only links http(s) websites", () => {
    expect(safeWebsiteHref("www.example.test")).toBe("https://www.example.test/");
    expect(safeWebsiteHref("http://example.test/a")).toBe("http://example.test/a");
    expect(safeWebsiteHref("javascript:alert(1)")).toBeNull();
    expect(safeWebsiteHref(null)).toBeNull();
  });
});
