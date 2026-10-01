import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** In-memory stand-in for the organization table and audit log. */
type Row = Record<string, unknown> & { id: string; type: string; name: string; isActive: boolean; eadventistId: string | null; affiliatedOrganizationId: string | null; parentOrganizationId?: string | null };
const state = vi.hoisted(() => ({ rows: [] as unknown[], audit: [] as unknown[], identities: [] as Array<{ organizationId?: string; personId?: string; providerScope?: string; externalId: string }>, locations: [] as Array<Record<string, unknown> & { organizationId: string }>, results: [] as Array<{ organizationId: string; decision: string }>, locationWriteRaces: false, afterSnapshot: undefined as undefined | (() => void), next: 1 }));
const rows = () => state.rows as Row[];

const db = vi.hoisted(() => {
  const organization = {
    findMany: async () => rows().map((row) => ({
      ...row,
      externalIdentities: state.identities.filter((identity) => identity.organizationId === row.id && (identity.providerScope ?? "") === "").map((identity) => ({ externalId: identity.externalId })),
      churchLocation: state.locations.find((location) => location.organizationId === row.id) ?? null,
      _count: { childOrganizations: rows().filter((other) => other.parentOrganizationId === row.id).length, sponsoredPromoCodes: 0 },
      disbandedOn: (row.disbandedOn as Date | null) ?? null,
      affiliatedOrganization: rows().find((other) => other.id === row.affiliatedOrganizationId) ? { eadventistId: rows().find((other) => other.id === row.affiliatedOrganizationId)!.eadventistId } : null,
    })).filter((row) => row.eadventistId || row.type === "CHURCH" || row.externalIdentities.length > 0),
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (data.eadventistId && rows().some((row) => row.eadventistId === data.eadventistId)) throw Object.assign(new Error("dupe"), { code: "P2002" });
      const row = { affiliatedOrganizationId: null, disbandedOn: null, ...data, id: `org-${state.next++}` } as unknown as Row;
      rows().push(row);
      return { id: row.id };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      Object.assign(rows().find((row) => row.id === where.id)!, data);
      return {};
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => rows().find((row) => row.id === where.id)!,
    findUnique: async ({ where }: { where: { id: string } }) => rows().find((row) => row.id === where.id) ?? null,
    findFirst: async ({ where }: { where: { parentOrganizationId: string; type: string; isActive: boolean } }) =>
      rows().find((row) => row.parentOrganizationId === where.parentOrganizationId && row.type === where.type && row.isActive === where.isActive) ?? null,
    count: async ({ where }: { where: { parentOrganizationId: string } }) => rows().filter((row) => row.parentOrganizationId === where.parentOrganizationId).length,
  };
  // Lets a test change state after the plan has read the organizations (a write landing mid-import: it fires on the first organization update).
  const updateOrganization = organization.update;
  organization.update = async (args) => { state.afterSnapshot?.(); state.afterSnapshot = undefined; return updateOrganization(args); };
  const externalIdentity = {
    findMany: async () => state.identities.filter((identity) => identity.personId || (identity.providerScope ?? "") !== "").map((identity) => ({ externalId: identity.externalId, personId: identity.personId ?? null })),
    upsert: async ({ where, create, update }: { where: { organizationId_provider_providerScope: { organizationId: string } }; create: { organizationId: string; externalId: string }; update: { externalId: string } }) => {
      const existing = state.identities.find((identity) => identity.organizationId === where.organizationId_provider_providerScope.organizationId);
      if (existing) existing.externalId = update.externalId;
      else state.identities.push({ organizationId: create.organizationId, externalId: create.externalId });
      return {};
    },
  };
  const churchLocation = {
    createMany: async ({ data }: { data: Array<Record<string, unknown> & { organizationId: string }> }) => {
      let count = 0;
      for (const row of data) {
        if (state.locationWriteRaces || state.locations.some((location) => location.organizationId === row.organizationId)) continue;
        state.locations.push({ latitude: null, longitude: null, ...row });
        count += 1;
      }
      return { count };
    },
    updateMany: async ({ where, data }: { where: { organizationId: string; source: string | { not: string } }; data: Record<string, unknown> }) => {
      const row = state.locations.find((location) => location.organizationId === where.organizationId);
      if (!row) return { count: 0 };
      if (typeof where.source === "string") {
        if (row.source !== where.source) return { count: 0 };
      } else if (state.locationWriteRaces || row.source === where.source.not) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };
  const churchGeocodeResult = {
    deleteMany: async ({ where }: { where: { organizationId: string } }) => {
      const before = state.results.length;
      state.results = state.results.filter((row) => row.organizationId !== where.organizationId);
      return { count: before - state.results.length };
    },
  };
  const client = {
    organization,
    churchLocation,
    churchGeocodeResult,
    externalIdentity,
    auditLog: { create: async ({ data }: { data: unknown }) => { state.audit.push(data); return data; } },
    $transaction: async (callback: (tx: unknown) => unknown) => callback(client),
  };
  return client;
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => db }));

import { commitEadventistImport, previewEadventistImport, setDirectoryOrganizationActive } from "@/modules/organizations/eadventist-import-repository";
import { EadventistImportError } from "@/modules/organizations/eadventist-import";
import { OrganizationOperationError } from "@/modules/organizations/repository";

const fixture = readFileSync(join(__dirname, "fixtures", "eadventist-organizations-synthetic.csv"), "utf8");
const byName = (name: string) => rows().find((row) => row.name === name)!;

beforeEach(() => {
  state.rows = [];
  state.audit = [];
  state.identities = [];
  state.locations = [];
  state.results = [];
  state.locationWriteRaces = false;
  state.next = 1;
});

describe("eAdventist import storage (#649)", () => {
  it("previews without writing anything", async () => {
    const preview = await previewEadventistImport(fixture);
    expect(preview.counts).toMatchObject({ new: 12, flagged: 1 });
    expect(rows()).toHaveLength(0);
    expect(state.audit).toHaveLength(0);
  });

  it("creates every record with its kind, resolves parents, and audits counts only", async () => {
    const result = await commitEadventistImport(fixture, "admin-1");
    expect(result).toMatchObject({ committed: true, counts: { new: 12, flagged: 1 } });
    expect(rows()).toHaveLength(12);
    expect(new Set(rows().map((row) => row.type))).toEqual(new Set(["CONFERENCE", "CHURCH", "COMPANY", "GROUP", "SCHOOL", "EARLY_CHILDHOOD", "BOOKSTORE", "COMMUNITY_CENTER", "CAMP", "ASSOCIATION"]));
    expect(byName("Sample Creek Company").affiliatedOrganizationId).toBe(byName("Sample Hills SDA Church").id);
    expect(byName("Sample Hills SDA Church").affiliatedOrganizationId).toBeNull();
    expect(byName("Sample Ridge Group")).toMatchObject({ isActive: true, disbandedOn: new Date("2024-03-01T00:00:00.000Z") });
    expect(byName("Sample Hills SDA Church")).toMatchObject({ normalizedName: "sample hills sda church", streetAddress: "10 Sample Road", eadventistId: "9002", sourceOrgType: "Church" });
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]).toMatchObject({ actorUserId: "admin-1", action: "ORGANIZATIONS_EADVENTIST_IMPORTED", entityType: "OrganizationImport" });
    expect(JSON.stringify(state.audit)).not.toContain("Sample Hills");
  });

  it("is idempotent: a second upload adds nothing and changes nothing", async () => {
    await commitEadventistImport(fixture, "admin-1");
    const snapshot = JSON.stringify(rows());
    const again = await commitEadventistImport(fixture, "admin-1");
    expect(again.counts).toMatchObject({ new: 0, updated: 0, unchanged: 12 });
    expect(rows()).toHaveLength(12);
    expect(JSON.stringify(rows())).toBe(snapshot);
  });

  it("keeps a staff decision to deactivate a record across a re-upload", async () => {
    await commitEadventistImport(fixture, "admin-1");
    await setDirectoryOrganizationActive(byName("Sample Ridge Group").id, false, "admin-1");
    expect(byName("Sample Ridge Group").isActive).toBe(false);
    const changed = fixture.replace("Sample Junior Academy", "Sample Junior Academy East");
    const result = await commitEadventistImport(changed, "admin-1");
    expect(result.counts).toMatchObject({ new: 0, updated: 1 });
    expect(byName("Sample Ridge Group").isActive).toBe(false);
    expect(rows().some((row) => row.name === "Sample Junior Academy East")).toBe(true);
    expect(rows()).toHaveLength(12);
  });

  it("links an existing church by name once, keeping its id and active flag", async () => {
    rows().push({ id: "church-old", type: "CHURCH", name: "Sample Hills SDA Church", normalizedName: "sample hills sda church", isActive: false, eadventistId: null, affiliatedOrganizationId: null } as Row);
    const preview = await previewEadventistImport(fixture);
    expect(preview.items.find((item) => item.name === "Sample Hills SDA Church")).toMatchObject({ action: "UPDATED", matchedBy: "NAME" });
    await commitEadventistImport(fixture, "admin-1");
    expect(rows()).toHaveLength(12);
    expect(rows().find((row) => row.id === "church-old")).toMatchObject({ eadventistId: "9002", isActive: false, city: "Sample Hills" });
    const again = await previewEadventistImport(fixture);
    expect(again.counts).toMatchObject({ new: 0, updated: 0, unchanged: 12 });
  });

  it("keeps a church that sponsors clubs as a church even if the export retypes it, and a re-upload is then a no-op", async () => {
    await commitEadventistImport(fixture, "admin-1");
    rows().push({ id: "club-1", type: "CLUB", name: "Sample Club", isActive: true, eadventistId: null, affiliatedOrganizationId: null, parentOrganizationId: byName("Sample Hills SDA Church").id } as Row);
    const retyped = fixture.replace("Sample Hills SDA Church,Church,", "Sample Hills SDA Church,Company,");
    const preview = await previewEadventistImport(retyped);
    expect(preview.items.find((item) => item.name === "Sample Hills SDA Church")!.notes.join(" ")).toContain("Kept as a church");
    await commitEadventistImport(retyped, "admin-1");
    expect(byName("Sample Hills SDA Church").type).toBe("CHURCH");
    expect((await previewEadventistImport(retyped)).counts).toMatchObject({ new: 0, updated: 0, unchanged: 12 });
  });

  it("writes the EADVENTIST external identity alongside the column, for new and linked records", async () => {
    rows().push({ id: "church-old", type: "CHURCH", name: "Sample Hills SDA Church", normalizedName: "sample hills sda church", isActive: true, eadventistId: null, affiliatedOrganizationId: null } as Row);
    await commitEadventistImport(fixture, "admin-1");
    expect(state.identities).toHaveLength(12);
    expect(state.identities.find((identity) => identity.organizationId === "church-old")).toMatchObject({ externalId: "9002" });
    expect(rows().every((row) => state.identities.some((identity) => identity.organizationId === row.id && identity.externalId === row.eadventistId))).toBe(true);
  });

  it("matches a church that only has an EADVENTIST identity by that id, and fills in the column", async () => {
    rows().push({ id: "church-old", type: "CHURCH", name: "Renamed Elsewhere", normalizedName: "renamed elsewhere", isActive: true, eadventistId: null, affiliatedOrganizationId: null } as Row);
    state.identities.push({ organizationId: "church-old", externalId: "9002" });
    await commitEadventistImport(fixture, "admin-1");
    expect(rows()).toHaveLength(12);
    expect(rows().find((row) => row.id === "church-old")).toMatchObject({ eadventistId: "9002", name: "Sample Hills SDA Church" });
    expect(state.identities.filter((identity) => identity.organizationId === "church-old")).toHaveLength(1);
  });

  it("refuses to save while a possible match has no choice, then applies the choices", async () => {
    const loose = () => rows().push({ id: "church-old", type: "CHURCH", name: "Sample Hills Seventh-day Adventist Church", normalizedName: "sample hills seventh-day adventist church", isActive: true, eadventistId: null, affiliatedOrganizationId: null } as Row);
    loose();
    const preview = await previewEadventistImport(fixture);
    expect(preview.needsChoice).toBe(1);
    expect(preview.items.find((item) => item.eadventistId === "9002")).toMatchObject({ needsChoice: true, selectedMatch: null });
    await expect(commitEadventistImport(fixture, "admin-1")).rejects.toMatchObject({ code: "NEEDS_CHOICES" });
    await expect(commitEadventistImport(fixture, "admin-1")).rejects.toBeInstanceOf(EadventistImportError);
    expect(rows()).toHaveLength(1);
    expect(state.audit).toHaveLength(0);

    await commitEadventistImport(fixture, "admin-1", { "9002": "church-old" });
    expect(rows()).toHaveLength(12);
    expect(rows().find((row) => row.id === "church-old")).toMatchObject({ eadventistId: "9002", name: "Sample Hills SDA Church" });

    state.rows = [];
    state.identities = [];
    loose();
    const chosen = await commitEadventistImport(fixture, "admin-1", { "9002": "NEW" });
    expect(chosen.items.find((item) => item.eadventistId === "9002")).toMatchObject({ action: "NEW", selectedMatch: "NEW" });
    expect(rows()).toHaveLength(13);
    expect(rows().find((row) => row.id === "church-old")).toMatchObject({ eadventistId: null, name: "Sample Hills Seventh-day Adventist Church" });
  });

  it("asks again for a row with a stale choice instead of linking another church", async () => {
    rows().push({ id: "church-old", type: "CHURCH", name: "Sample Hills Seventh-day Adventist Church", normalizedName: "sample hills seventh-day adventist church", isActive: true, eadventistId: null, affiliatedOrganizationId: null } as Row);
    await expect(commitEadventistImport(fixture, "admin-1", { "9002": "church-gone" })).rejects.toMatchObject({ code: "NEEDS_CHOICES" });
    const preview = await previewEadventistImport(fixture, { "9002": "church-gone" });
    expect(preview.items.find((item) => item.eadventistId === "9002")).toMatchObject({ needsChoice: true, possibleMatches: [{ id: "church-old" }], selectedMatch: null });
    expect(rows()).toHaveLength(1);
  });

  it("skips rows whose id a club, a person, or another scope holds, and imports the rest", async () => {
    rows().push({ id: "club-1", type: "CLUB", name: "Sample Club", isActive: true, eadventistId: "9003", affiliatedOrganizationId: null } as Row);
    state.identities.push({ personId: "person-1", externalId: "9004" });
    state.identities.push({ organizationId: "church-z", providerScope: "other", externalId: "9005" });
    const result = await commitEadventistImport(fixture, "admin-1");
    const skipped = result.items.filter((item) => item.action === "SKIPPED").map((item) => item.eadventistId).sort();
    expect(skipped).toEqual(["9003", "9004", "9005"]);
    expect(rows().find((row) => row.id === "club-1")).toMatchObject({ name: "Sample Club", type: "CLUB" });
    expect(rows()).toHaveLength(1 + 9);
  });

  it("does not store a Group's street address or phone", async () => {
    await commitEadventistImport(fixture, "admin-1");
    expect(byName("Sample Ridge Group")).toMatchObject({ streetAddress: null, officePhone: null, city: "Sample Ridge", postalCode: "00004" });
  });

  it("writes nothing for a conflicting or skipped row", async () => {
    rows().push({ id: "church-x", type: "CHURCH", name: "Whatever", normalizedName: "whatever", isActive: true, eadventistId: "9002", affiliatedOrganizationId: null } as Row);
    state.identities.push({ organizationId: "church-x", externalId: "1111" });
    const result = await commitEadventistImport(fixture, "admin-1");
    expect(result.items.find((item) => item.eadventistId === "9002")!.action).toBe("SKIPPED");
    expect(rows().find((row) => row.id === "church-x")!.name).toBe("Whatever");
    expect(byName("Sample Creek Company").affiliatedOrganizationId).toBeNull();
  });

  it("refuses to switch a church off while it has an active club, and never touches clubs", async () => {
    await commitEadventistImport(fixture, "admin-1");
    const church = byName("Sample Hills SDA Church");
    rows().push({ id: "club-1", type: "CLUB", name: "Sample Club", isActive: true, eadventistId: null, affiliatedOrganizationId: null, parentOrganizationId: church.id } as Row);
    await expect(setDirectoryOrganizationActive(church.id, false, "admin-1")).rejects.toMatchObject({ code: "ORGANIZATION_HAS_ACTIVE_CLUBS" });
    await expect(setDirectoryOrganizationActive("club-1", false, "admin-1")).rejects.toBeInstanceOf(OrganizationOperationError);
    await expect(setDirectoryOrganizationActive("missing", true, "admin-1")).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
  });

  it("audits each status change", async () => {
    await commitEadventistImport(fixture, "admin-1");
    await setDirectoryOrganizationActive(byName("Sample Pines Camp").id, false, "admin-2");
    await setDirectoryOrganizationActive(byName("Sample Pines Camp").id, true, "admin-2");
    expect(state.audit.slice(1)).toMatchObject([
      { actorUserId: "admin-2", action: "ORGANIZATION_MARKED_INACTIVE" },
      { actorUserId: "admin-2", action: "ORGANIZATION_MARKED_ACTIVE" },
    ]);
  });
});

describe("church map locations from the import (#724)", () => {
  const church = () => byName("Sample Hills SDA Church");
  const locationOf = (id: string) => state.locations.find((location) => location.organizationId === id);

  it("previews and creates a location for each active church, with town, state and ZIP only", async () => {
    const preview = await previewEadventistImport(fixture);
    expect(preview.locationCounts).toEqual({ created: 1, updated: 0 });
    expect(preview.items.find((item) => item.name === "Sample Hills SDA Church")).toMatchObject({ locationAction: "CREATE" });
    expect(state.locations).toHaveLength(0);

    const result = await commitEadventistImport(fixture, "admin-1");
    expect(result.locationCounts).toEqual({ created: 1, updated: 0 });
    expect(state.locations).toHaveLength(1);
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", city: "Sample Hills", latitude: null, longitude: null });
    expect(Object.keys(locationOf(church().id)!).sort()).toEqual(["city", "latitude", "longitude", "organizationId", "source", "state", "zip"]);
    // Counts only in the audit entry.
    expect(state.audit[0]).toMatchObject({ metadata: { locationsCreated: 1, locationsUpdated: 0 } });
    expect(JSON.stringify(state.audit)).not.toContain("Sample Hills");
  });

  it("is idempotent, then updates an imported location when the town changes", async () => {
    await commitEadventistImport(fixture, "admin-1");
    expect((await previewEadventistImport(fixture)).locationCounts).toEqual({ created: 0, updated: 0 });
    const moved = fixture.replace(/(9002,SC002,Sample Hills SDA Church,[\s\S]*?),Sample Hills,/, "$1,Sample Vale,");
    expect(moved).not.toBe(fixture);
    const result = await commitEadventistImport(moved, "admin-1");
    expect(result.locationCounts).toEqual({ created: 0, updated: 1 });
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", city: "Sample Vale" });
  });

  it("never overwrites a location set by hand", async () => {
    rows().push({ id: "church-old", type: "CHURCH", name: "Sample Hills SDA Church", normalizedName: "sample hills sda church", isActive: true, eadventistId: null, affiliatedOrganizationId: null } as Row);
    state.locations.push({ organizationId: "church-old", source: "MANUAL", city: "Typed Town", state: "ZZ", zip: "", latitude: 41.5, longitude: -93.6 });
    const preview = await previewEadventistImport(fixture);
    expect(preview.locationCounts).toEqual({ created: 0, updated: 0 });
    await commitEadventistImport(fixture, "admin-1");
    expect(locationOf("church-old")).toEqual({ organizationId: "church-old", source: "MANUAL", city: "Typed Town", state: "ZZ", zip: "", latitude: 41.5, longitude: -93.6 });
  });

  it("drops a geocoded point when the address it was found for changes", async () => {
    await commitEadventistImport(fixture, "admin-1");
    Object.assign(locationOf(church().id)!, { source: "GEOCODED", latitude: 41.5, longitude: -93.6 });
    expect((await previewEadventistImport(fixture)).locationCounts).toEqual({ created: 0, updated: 0 });
    const moved = fixture.replace("10 Sample Road", "99 Sample Road");
    const result = await commitEadventistImport(moved, "admin-1");
    expect(result.locationCounts).toEqual({ created: 0, updated: 1 });
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", latitude: null, longitude: null });
  });

  it("gives no location to groups, companies, schools, or churches staff switched off", async () => {
    await commitEadventistImport(fixture, "admin-1");
    expect(state.locations.map((location) => location.organizationId)).toEqual([church().id]);
    state.locations = [];
    church().isActive = false;
    expect((await previewEadventistImport(fixture)).locationCounts).toEqual({ created: 0, updated: 0 });
  });

  it("discards saved geocode results (even a skip) for a church whose address changed, and keeps the rest", async () => {
    await commitEadventistImport(fixture, "admin-1");
    state.results = [{ organizationId: church().id, decision: "SKIPPED" }, { organizationId: "other-church", decision: "PENDING" }];
    await commitEadventistImport(fixture, "admin-1");
    expect(state.results).toHaveLength(2);
    await commitEadventistImport(fixture.replace("10 Sample Road", "99 Sample Road"), "admin-1");
    expect(state.results).toEqual([{ organizationId: "other-church", decision: "PENDING" }]);
  });

  it("never overwrites a location saved by hand after the plan was made, for create and update", async () => {
    state.locationWriteRaces = true;
    const created = await commitEadventistImport(fixture, "admin-1");
    // Counts report what was written, not what was planned.
    expect(created.locationCounts).toEqual({ created: 0, updated: 0 });
    expect(state.audit.at(-1)).toMatchObject({ metadata: { locationsCreated: 0, locationsUpdated: 0 } });
    expect(state.locations).toHaveLength(0);
    state.locationWriteRaces = false;
    await commitEadventistImport(fixture, "admin-1");
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", city: "Sample Hills" });
    state.locationWriteRaces = true;
    await commitEadventistImport(fixture.replace(/(9002,SC002,Sample Hills SDA Church,[\s\S]*?),Sample Hills,/, "$1,Sample Vale,"), "admin-1");
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", city: "Sample Hills" });
  });

  it("clears a point accepted after the import's snapshot when the address changes, and counts what it wrote", async () => {
    await commitEadventistImport(fixture, "admin-1");
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", latitude: null });
    // The plan reads an IMPORT location with no point; an Accept then commits before the import writes.
    state.results.push({ organizationId: church().id, decision: "PENDING" });
    state.afterSnapshot = () => Object.assign(locationOf(church().id)!, { source: "GEOCODED", latitude: 41.5, longitude: -93.6 });
    const result = await commitEadventistImport(fixture.replace("10 Sample Road", "99 Sample Road"), "admin-1");
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", latitude: null, longitude: null });
    expect(state.results).toEqual([]);
    expect(result.locationCounts).toEqual({ created: 0, updated: 0 });
  });

  it("reports the locations it wrote in the result and the audit entry", async () => {
    const result = await commitEadventistImport(fixture, "admin-1");
    expect(result.locationCounts).toEqual({ created: 1, updated: 0 });
    expect(state.audit[0]).toMatchObject({ metadata: { locationsCreated: 1, locationsUpdated: 0 } });
    expect(String((state.audit[0] as { summary: string }).summary)).toContain("1 church locations created, 0 updated");
  });

  it("clears a geocoded point when the record stops being a church or loses its street address", async () => {
    await commitEadventistImport(fixture, "admin-1");
    // Becomes a group: groups keep the town only, so the street is dropped and so is the point.
    Object.assign(locationOf(church().id)!, { source: "GEOCODED", latitude: 41.5, longitude: -93.6 });
    const asGroup = fixture.replace("Sample Hills SDA Church,Church,", "Sample Hills SDA Church,Group,");
    const preview = await previewEadventistImport(asGroup);
    expect(preview.locationCounts.updated).toBe(1);
    await commitEadventistImport(asGroup, "admin-1");
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", latitude: null, longitude: null, city: "Sample Hills" });
  });

  it("clears a geocoded point when the church's street address is removed", async () => {
    await commitEadventistImport(fixture, "admin-1");
    Object.assign(locationOf(church().id)!, { source: "GEOCODED", latitude: 41.5, longitude: -93.6 });
    await commitEadventistImport(fixture.replace("10 Sample Road", ""), "admin-1");
    expect(locationOf(church().id)).toMatchObject({ source: "IMPORT", latitude: null, longitude: null });
  });
});

