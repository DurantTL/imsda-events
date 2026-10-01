import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));

import { syncFieldValue } from "@/components/organization-search-controls";
import { listDirectoryOrganizations } from "@/modules/organizations/eadventist-import-repository";
import { listOrganizationsPage } from "@/modules/organizations/repository";
import {
  cleanSearchQuery,
  listSearchParams,
  ORGANIZATION_SEARCH_MAX_LENGTH,
  organizationSearchWhere,
  parsePageParam,
  searchTerms,
} from "@/modules/organizations/search";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrisma.mockReturnValue({ organization: { count: mocks.count, findMany: mocks.findMany } });
  mocks.count.mockResolvedValue(0);
  mocks.findMany.mockResolvedValue([]);
});

type Clause = Record<string, unknown>;

/** The OR clauses of the first search term. */
function clausesFor(query: string): Clause[] {
  const where = organizationSearchWhere(query) as { AND: Array<{ OR: Clause[] }> };
  return where.AND[0]!.OR;
}

describe("organization search matching (#723)", () => {
  it("returns no filter for a blank query", () => {
    expect(organizationSearchWhere("")).toBeNull();
    expect(organizationSearchWhere("   ")).toBeNull();
  });

  it("splits words and caps the term count and length", () => {
    expect(searchTerms("  Albia   school ")).toEqual(["Albia", "school"]);
    expect(searchTerms("a b c d e f g h")).toHaveLength(6);
    expect(cleanSearchQuery("x".repeat(200))).toHaveLength(ORGANIZATION_SEARCH_MAX_LENGTH);
  });

  it.each([
    ["name", { name: { contains: "sample", mode: "insensitive" } }],
    ["city", { city: { contains: "sample", mode: "insensitive" } }],
    ["state, as a whole word", { state: { equals: "sample", mode: "insensitive" } }],
    ["organization code", { orgCode: { contains: "sample", mode: "insensitive" } }],
    ["eAdventist id", { eadventistId: { contains: "sample", mode: "insensitive" } }],
    ["linked provider identifier", { externalIdentities: { some: { externalId: { contains: "sample", mode: "insensitive" } } } }],
    ["district", { district: { contains: "sample", mode: "insensitive" } }],
    ["a club's sponsoring church", { parentOrganization: { is: { name: { contains: "sample", mode: "insensitive" } } } }],
    ["a directory record's parent", { affiliatedOrganization: { is: { name: { contains: "sample", mode: "insensitive" } } } }],
  ])("matches on %s, case-insensitively", (_label, clause) => {
    expect(clausesFor("sample")).toContainEqual(clause);
  });

  it("requires every word to match somewhere", () => {
    const where = organizationSearchWhere("albia ia") as { AND: unknown[] };
    expect(where.AND).toHaveLength(2);
  });
});

describe("the Clubs and churches list query (#723)", () => {
  it("combines the search with the Kind and Status filters, in the database", async () => {
    await listOrganizationsPage({ query: "grace", kind: "CLUB", status: "INACTIVE", page: 1 });
    const where = mocks.count.mock.calls[0]![0].where;
    expect(where).toMatchObject({ type: "CLUB", isActive: false });
    expect(where.AND).toHaveLength(1);
    expect(mocks.findMany.mock.calls[0]![0].where).toEqual(where);
  });

  it("covers both kinds when no Kind is chosen and leaves Status open for Any", async () => {
    await listOrganizationsPage({ query: "", kind: null, status: "ALL" });
    const where = mocks.count.mock.calls[0]![0].where;
    expect(where).toEqual({ type: { in: ["CHURCH", "CLUB"] } });
  });

  it("pages on the server and clamps a page past the end", async () => {
    mocks.count.mockResolvedValue(50);
    const result = await listOrganizationsPage({ query: "", kind: null, status: "ALL", page: 99 });
    expect(result.page).toBe(3);
    expect(mocks.findMany.mock.calls[0]![0]).toMatchObject({ skip: 48, take: 24 });
  });

  it("loads each club's sponsoring church so a hit keeps its church as context", async () => {
    await listOrganizationsPage({ query: "pathfinders", kind: null, status: "ALL" });
    expect(mocks.findMany.mock.calls[0]![0].include.parentOrganization).toBeTruthy();
  });
});

describe("the organization directory query (#723)", () => {
  it("searches fields beyond the name, together with kind and status, and pages", async () => {
    mocks.count.mockResolvedValue(120);
    const result = await listDirectoryOrganizations({ kind: "SCHOOL", status: "ACTIVE", query: "albia", page: 3 });
    const where = mocks.count.mock.calls[0]![0].where;
    expect(where).toMatchObject({ type: "SCHOOL", isActive: true });
    expect(JSON.stringify(where.AND)).toContain("district");
    expect(JSON.stringify(where.AND)).toContain("orgCode");
    expect(result.page).toBe(3);
    expect(mocks.findMany.mock.calls[0]![0]).toMatchObject({ skip: 100, take: 50 });
  });
});

describe("the query stays in the URL (#723)", () => {
  it("round-trips search, filters and page, and drops defaults", () => {
    expect(listSearchParams({ q: "albia ia", kind: "SCHOOL", status: "ACTIVE", page: 2 }).toString())
      .toBe("q=albia+ia&kind=SCHOOL&status=ACTIVE&page=2");
    expect(listSearchParams({ q: "", kind: "", status: "ALL", page: 1 }).toString()).toBe("");
  });

  it("normalises the query with NFKC before splitting it", () => {
    expect(searchTerms("\uFF21lbia\u3000school")).toEqual(["Albia", "school"]);
    expect(searchTerms("a b c d e f g")).toHaveLength(6);
  });

  it("syncs a field to the URL unless it is being typed in", () => {
    const stale = { value: "albia" };
    syncFieldValue(stale, "", null);
    expect(stale.value).toBe("");
    const typing = { value: "alb" };
    syncFieldValue(typing, "", typing);
    expect(typing.value).toBe("alb");
    expect(() => syncFieldValue(null, "x", null)).not.toThrow();
    const source = read("components/organization-search-controls.tsx");
    expect(source).toContain("[state.q, state.kind, state.status]");
  });

  it("reads a page number defensively", () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("-4")).toBe(1);
    expect(parsePageParam("7")).toBe(7);
  });

  it("the filter bar writes the query to the URL and submits on Enter", () => {
    const source = read("components/organization-search-controls.tsx");
    expect(source).toContain("router.replace(next");
    expect(source).toContain('method="get"');
    expect(source).toContain("event.preventDefault();\n        apply();");
    expect(source).toContain("SEARCH_DEBOUNCE_MS");
    expect(source).toContain('name="q"');
  });
});

describe("directory layout (#723)", () => {
  const page = read("app/(workspace)/admin/organizations/directory/page.tsx");
  const css = read("app/globals.css");

  it("stacks two-line cells with the org-cell classes, not the negative-margin help text", () => {
    expect(page).toContain('className="org-cell-sub"');
    expect(page).toContain("District: {organization.district}");
    expect(page).not.toContain("field-help");
    const sub = /\.org-cell-sub \{( margin-top[^}]*)\}/.exec(css)?.[1] ?? "";
    expect(sub).toMatch(/margin-top: 3px/);
    expect(sub).toMatch(/line-height: 1\.35/);
    expect(sub).not.toMatch(/margin[^;]*-\d/);
  });

  it("uses the filter bar, page heading and summary line", () => {
    expect(page).toContain("OrganizationSearchControls");
    expect(page).toContain('className="page-intro"');
    expect(page).toContain("org-result-summary");
    expect(css).toMatch(/\.org-filter-bar \{[^}]*flex-wrap: wrap/);
    expect(css).toMatch(/\.org-filter-field input,\s*\.org-filter-field select \{[^}]*border: 1px solid/);
  });

  it("uses card cells up to 1100px and a non-wrapping 44px actions control", () => {
    expect(page).toContain('table-cards table-cards-wide');
    expect(page).toContain('cardCell("Place")');
    expect(css).toMatch(/@media screen and \(max-width: 1100px\) \{\s*\.report-table-wrap:has\(> table\.table-cards-wide\)/);
    expect(css).toMatch(/\.org-status-button \{[^}]*white-space: nowrap/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.org-status-button \{ min-height: 44px; \}/);
    expect(css).toMatch(/\.org-directory-table td\.org-cell-actions \{[^}]*text-align: right/);
  });
});
