import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The driver verification queue (#491) is a Client Component rendered from
 * two Server Component pages. Anything a server page passes to it crosses
 * the RSC boundary and must be serializable — a function prop throws at
 * render in Next.js. These tests render each server page with its data
 * loaders faked, walk the returned tree, and fail on any function prop given
 * to a component; then render the queue and one row with those same props.
 */

const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  clubPortalComplianceStatuses: vi.fn(),
  listRoster: vi.fn(),
  listClubHonorsPage: vi.fn(),
  getCurrentSession: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));
vi.mock("@/modules/background-checks/repository", () => ({ clubPortalComplianceStatuses: mocks.clubPortalComplianceStatuses }));
vi.mock("@/modules/club-rosters/repository", () => ({ listRoster: mocks.listRoster }));
vi.mock("@/modules/honors/member-honor-repository", () => ({ listClubHonorsPage: mocks.listClubHonorsPage }));
vi.mock("@/modules/access/current-session", () => ({ getCurrentSession: mocks.getCurrentSession }));

import ClubRosterPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/roster/page";
import DriverVerificationPage from "@/app/(workspace)/admin/organizations/driver-verification/page";
import {
  clearEndpointFor,
  DriverQueueRow,
  DriverVerificationQueue,
  needsReReview,
} from "@/components/driver-verification-queue";
import type { DriverQueueEntry } from "@/modules/driver-verification/repository";

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

function queueProps(tree: ReactNode) {
  const elements = componentElements(tree);
  const problems = elements.flatMap((element) => {
    const props = Object.fromEntries(Object.entries(element.props).filter(([key]) => key !== "children"));
    const name = (element.type as { name?: string }).name ?? "component";
    return functionProps(props, name);
  });
  expect(problems).toEqual([]);
  const queue = elements.find((element) => element.type === DriverVerificationQueue);
  expect(queue).toBeDefined();
  return queue!.props as Parameters<typeof DriverVerificationQueue>[0];
}

const entry = (overrides: Partial<DriverQueueEntry> = {}): DriverQueueEntry => ({
  personId: "person/1",
  rosterMemberId: "member-1",
  firstName: "Dana",
  lastName: "Driver",
  attendeeType: "STAFF",
  organizationId: "club-1",
  organizationName: "Test Pathfinders",
  backgroundCheck: { state: "CLEAR", note: null },
  verification: null,
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
  mocks.listRoster.mockResolvedValue([]);
  mocks.listClubHonorsPage.mockResolvedValue([]);
  mocks.getCurrentSession.mockResolvedValue({ user: { id: "admin-1", globalRole: "SYSTEM_ADMIN" } });
});

describe("driver verification pages pass only serializable props (#491)", () => {
  it("the club roster page gives the queue plain strings, and it renders", async () => {
    const tree = await ClubRosterPage({
      params: Promise.resolve({ organizationId: "club-1" }),
      searchParams: Promise.resolve({}),
    });
    const props = queueProps(tree);
    expect(props).toEqual({
      clearEndpointBase: "/api/attendee/clubs/club-1/driver-verification",
      listEndpoint: "/api/attendee/clubs/club-1/driver-verification",
    });
    expect(renderToStaticMarkup(createElement(DriverVerificationQueue, props))).toContain("Driver verification queue");
  });

  it("the admin page gives the queue plain strings and a boolean, and it renders", async () => {
    const tree = await DriverVerificationPage();
    const props = queueProps(tree);
    expect(props).toEqual({
      clearEndpointBase: "/api/admin/driver-verification",
      listEndpoint: "/api/admin/driver-verification",
      showClub: true,
    });
    expect(renderToStaticMarkup(createElement(DriverVerificationQueue, props))).toContain("Driver verification queue");
  });

  it("builds the per-person decision endpoint in the client, encoding the id", () => {
    expect(clearEndpointFor("/api/admin/driver-verification", "person/1")).toBe("/api/admin/driver-verification/person%2F1");
  });
});

describe("a driver verification queue row (#491)", () => {
  const renderRow = (row: DriverQueueEntry) => renderToStaticMarkup(createElement("table", null,
    createElement("tbody", null, createElement(DriverQueueRow, { entry: row, showClub: false, onReview: () => undefined }))));

  it("names the person on its Review button", () => {
    expect(renderRow(entry())).toContain('aria-label="Review Dana Driver"');
  });

  it("shows when and by whom a decision was made", () => {
    const markup = renderRow(entry({
      verification: { clearedToTransport: true, note: "", reviewedAt: "2026-09-20T15:00:00.000Z", reviewerName: "Test Reviewer" },
    }));
    expect(markup).toContain("Cleared");
    expect(markup).toContain("Sep 20, 2026");
    expect(markup).toContain("Test Reviewer");
    expect(markup).not.toContain("Needs re-review");
  });

  it("asks for a re-review when a cleared person's background check is no longer Clear", () => {
    const cleared = { clearedToTransport: true, note: "", reviewedAt: "2026-09-20T15:00:00.000Z", reviewerName: "Test Reviewer" };
    const lapsed = entry({ backgroundCheck: { state: "NOT_COMPLIANT", note: null }, verification: cleared });
    expect(needsReReview(lapsed)).toBe(true);
    expect(renderRow(lapsed)).toContain("Needs re-review");
    expect(needsReReview(entry({ verification: cleared }))).toBe(false);
    // A "not cleared" decision stays as it is; nothing to re-review.
    expect(needsReReview(entry({ backgroundCheck: { state: "NO_RECORD", note: null }, verification: { ...cleared, clearedToTransport: false } }))).toBe(false);
  });
});
