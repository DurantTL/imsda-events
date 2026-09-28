import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The staff driver exceptions queue (#544) is a Client Component rendered
 * from a Server Component page. Anything a server page passes to it crosses
 * the RSC boundary and must be serializable — a function prop throws at
 * render in Next.js. These tests render the pages with their data loaders
 * faked, walk the returned tree, and fail on any function prop given to a
 * component. They also render what a club and what staff see of one driver.
 */

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  clubPortalComplianceStatuses: vi.fn(),
  clubDriverEntries: vi.fn(),
  listRoster: vi.fn(),
  listClubHonorsPage: vi.fn(),
  getCurrentSession: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/background-checks/repository", () => ({ clubPortalComplianceStatuses: mocks.clubPortalComplianceStatuses }));
vi.mock("@/modules/driver-verification/repository", () => ({ clubDriverEntries: mocks.clubDriverEntries }));
vi.mock("@/modules/club-rosters/repository", () => ({ listRoster: mocks.listRoster }));
vi.mock("@/modules/honors/member-honor-repository", () => ({ listClubHonorsPage: mocks.listClubHonorsPage }));
vi.mock("@/modules/club-transfers/repository", () => ({ listTransferClubOptions: async () => [] }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));

import ClubRosterPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/roster/page";
import DriverVerificationPage from "@/app/(workspace)/admin/organizations/driver-verification/page";
import { ClubDriverList } from "@/components/club-driver-list";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { clearEndpointFor, DriverQueueRow, DriverVerificationQueue } from "@/components/driver-verification-queue";
import { deriveDriverClearance } from "@/modules/driver-verification/clearance";
import type { ClubDriverEntry, StaffDriverEntry } from "@/modules/driver-verification/repository";

type AnyProps = Record<string, unknown>;

/** Every component element in a rendered server tree, depth first. */
function componentElements(node: ReactNode, found: ReactElement<AnyProps>[] = []) {
  if (Array.isArray(node)) {
    for (const child of node) componentElements(child, found);
    return found;
  }
  if (!isValidElement<AnyProps>(node)) return found;
  if (typeof node.type === "function") found.push(node);
  componentElements(node.props.children as ReactNode, found);
  return found;
}

function functionProps(value: unknown, path: string, out: string[] = []) {
  if (typeof value === "function") out.push(path);
  else if (Array.isArray(value)) value.forEach((item, index) => functionProps(item, `${path}[${index}]`, out));
  else if (value && typeof value === "object" && !isValidElement(value) && !(value instanceof Date)) {
    for (const [key, item] of Object.entries(value)) functionProps(item, `${path}.${key}`, out);
  }
  return out;
}

function assertSerializable(tree: ReactNode) {
  const elements = componentElements(tree);
  const problems = elements.flatMap((element) => {
    const props = Object.fromEntries(Object.entries(element.props).filter(([key]) => key !== "children"));
    const name = (element.type as { name?: string }).name ?? "component";
    return functionProps(props, name);
  });
  expect(problems).toEqual([]);
  return elements;
}

const clubEntry = (overrides: Partial<ClubDriverEntry> = {}): ClubDriverEntry => ({
  rosterMemberId: "member-1",
  firstName: "Dana",
  lastName: "Driver",
  attendeeType: "STAFF",
  status: "CLEARED",
  label: "Cleared to drive",
  ...overrides,
});

const staffEntry = (overrides: Partial<StaffDriverEntry> = {}): StaffDriverEntry => ({
  personId: "person/1",
  rosterMemberId: "member-1",
  firstName: "Dana",
  lastName: "Driver",
  attendeeType: "STAFF",
  organizationId: "club-1",
  organizationName: "Test Pathfinders",
  clearance: deriveDriverClearance({ complianceStatus: "NOT_COMPLIANT", expiresOn: null, issuesNote: "BGC" }, "2026-10-01"),
  issuesText: "BGC",
  override: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRosterAccessStateForPage.mockResolvedValue({
    state: "OPEN",
    club: { organizationId: "club-1", name: "Test Pathfinders", role: "DIRECTOR", sponsoringChurch: null },
    capabilities: { roster: true, manageTeam: true, seeBirthDates: true },
    actor: { kind: "ATTENDEE", accountId: "director-1", sessionId: "session-1" },
  });
  mocks.clubPortalComplianceStatuses.mockResolvedValue(null);
  mocks.clubDriverEntries.mockResolvedValue([clubEntry()]);
  mocks.listRoster.mockResolvedValue([]);
  mocks.listClubHonorsPage.mockResolvedValue([]);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", globalRole: "SYSTEM_ADMIN" } });
});

describe("driver pages pass only serializable props (#544)", () => {
  it("the club roster page gives its driver list and roster plain data, and it renders", async () => {
    const tree = await ClubRosterPage({
      params: Promise.resolve({ organizationId: "club-1" }),
      searchParams: Promise.resolve({}),
    });
    const elements = assertSerializable(tree);
    const list = elements.find((element) => element.type === ClubDriverList);
    expect(list).toBeDefined();
    const roster = elements.find((element) => element.type === ClubRosterWorkspace);
    expect(roster!.props.driverClearances).toEqual({ "member-1": { status: "CLEARED", label: "Cleared to drive" } });
    expect(renderToStaticMarkup(createElement(ClubDriverList, list!.props as Parameters<typeof ClubDriverList>[0]))).toContain("Cleared to drive");
  });

  it("gives a registrar (no manageTeam) no driver list at all", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({
      state: "OPEN",
      club: { organizationId: "club-1", name: "Test Pathfinders", role: "REGISTRAR", sponsoringChurch: null },
      capabilities: { roster: true, manageTeam: false, seeBirthDates: false },
      actor: { kind: "ATTENDEE", accountId: "registrar-1", sessionId: "session-1" },
    });
    const tree = await ClubRosterPage({
      params: Promise.resolve({ organizationId: "club-1" }),
      searchParams: Promise.resolve({}),
    });
    expect(componentElements(tree).some((element) => element.type === ClubDriverList)).toBe(false);
    expect(mocks.clubDriverEntries).not.toHaveBeenCalled();
  });

  it("the admin page gives the queue plain strings, and it renders", async () => {
    const tree = await DriverVerificationPage();
    const elements = assertSerializable(tree);
    const queue = elements.find((element) => element.type === DriverVerificationQueue);
    expect(queue!.props).toEqual({
      clearEndpointBase: "/api/admin/driver-verification",
      listEndpoint: "/api/admin/driver-verification",
    });
    expect(renderToStaticMarkup(createElement(DriverVerificationQueue, queue!.props as Parameters<typeof DriverVerificationQueue>[0])))
      .toContain("Driver exceptions");
  });

  it("builds the per-person override endpoint in the client, encoding the id", () => {
    expect(clearEndpointFor("/api/admin/driver-verification", "person/1")).toBe("/api/admin/driver-verification/person%2F1");
  });
});

describe("what a club sees on its driver list (#427, #544)", () => {
  it("is the label only", () => {
    const markup = renderToStaticMarkup(createElement(ClubDriverList, {
      entries: [
        clubEntry(),
        clubEntry({ rosterMemberId: "member-2", lastName: "Blocked", status: "NOT_CLEARED", label: "Not cleared" }),
        clubEntry({ rosterMemberId: "member-3", lastName: "Soon", status: "EXPIRING", label: "Expiring (10/04/2026)" }),
        clubEntry({ rosterMemberId: "member-4", lastName: "Waiting", status: "NEEDS_REVIEW", label: "Pending" }),
      ],
    }));
    for (const label of ["Cleared to drive", "Not cleared", "Expiring (10/04/2026)", "Pending"]) expect(markup).toContain(label);
    expect(markup).not.toMatch(/non-driver|bgc|training/i);
  });
});

describe("a staff exception row (#544)", () => {
  const renderRow = (row: StaffDriverEntry) => renderToStaticMarkup(createElement("table", null,
    createElement("tbody", null, createElement(DriverQueueRow, { entry: row, onReview: () => undefined }))));

  it("names the person on its Override button and shows the issues text as written", () => {
    const markup = renderRow(staffEntry({ issuesText: "Training (10/04/26),  bgc" }));
    expect(markup).toContain('aria-label="Override Dana Driver"');
    expect(markup).toContain("Training (10/04/26),  bgc");
    expect(markup).toContain("Not cleared");
  });

  it("shows an expiring date with the warning window", () => {
    const clearance = deriveDriverClearance({ complianceStatus: "CLEAR", expiresOn: null, issuesNote: "BGC (10/20/26)" }, "2026-10-01");
    const markup = renderRow(staffEntry({ clearance, issuesText: "BGC (10/20/26)" }));
    expect(markup).toContain("Expiring (10/20/2026)");
    expect(markup).toContain("within 30 days");
  });

  it("shows an override with who, when, and why", () => {
    const markup = renderRow(staffEntry({
      override: { clearedToTransport: true, note: "Confirmed by phone.", reviewedAt: "2026-09-20T15:00:00.000Z", reviewerName: "Test Reviewer" },
    }));
    expect(markup).toContain("Override: cleared");
    expect(markup).toContain("Sep 20, 2026");
    expect(markup).toContain("Test Reviewer");
    expect(markup).toContain("Confirmed by phone.");
  });
});
