import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** A member's class history (#791): the data shown and the existing class-tracking gate. Synthetic data only. */
const mocks = vi.hoisted(() => ({
  getRosterAccessStateForPage: vi.fn(),
  rosterFindMany: vi.fn(),
  completionFindMany: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    clubRosterMember: { findMany: mocks.rosterFindMany },
    memberClassCompletion: { findMany: mocks.completionFindMany },
  }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: vi.fn() }));
vi.mock("@/modules/club-rosters/access", () => ({ getRosterAccessStateForPage: mocks.getRosterAccessStateForPage }));

import MemberClassHistoryPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/class-tracking/[personId]/page";
import ClassTrackingPage from "@/app/(public)/account/(portal)/clubs/[organizationId]/class-tracking/page";
import { buildClassHistory } from "@/modules/earned-awards/domain";
import { loadMemberClassHistory } from "@/modules/earned-awards/order-source";

const now = new Date("2026-10-05T12:00:00Z");

describe("buildClassHistory", () => {
  it("lists completions in class order, then adds the current class when it is not completed", () => {
    const entries = buildClassHistory(
      [{ classLevel: "COMPANION", completedOn: "2025-06-01" }, { classLevel: "FRIEND", completedOn: "2024-05-20" }],
      "EXPLORER",
    );
    expect(entries.map((e) => [e.classLabel, e.status, e.completedOn])).toEqual([
      ["Friend", "COMPLETED", "2024-05-20"],
      ["Companion", "COMPLETED", "2025-06-01"],
      ["Explorer", "IN_PROGRESS", null],
    ]);
  });

  it("does not repeat a current class that is already completed, and handles no data", () => {
    expect(buildClassHistory([{ classLevel: "FRIEND", completedOn: "2024-05-20" }], "FRIEND")).toHaveLength(1);
    expect(buildClassHistory([], null)).toEqual([]);
  });
});

describe("loadMemberClassHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rosterFindMany.mockResolvedValue([
      { clubYear: "2026-27", classLevel: "COMPANION", status: "ACTIVE", person: { firstName: "Test", lastName: "Pathfinder" } },
    ]);
    mocks.completionFindMany.mockResolvedValue([{ classLevel: "FRIEND", completedOn: "2025-05-20" }]);
  });

  it("returns completions and the in-progress class, scoped to this club and person", async () => {
    const history = await loadMemberClassHistory("club-1", "person-1", now);
    expect(history?.entries.map((e) => `${e.classLabel}:${e.status}`)).toEqual(["Friend:COMPLETED", "Companion:IN_PROGRESS"]);
    expect(history).toMatchObject({ firstName: "Test", lastName: "Pathfinder" });
    expect(mocks.rosterFindMany.mock.calls[0]![0].where).toMatchObject({ organizationId: "club-1", personId: "person-1" });
    expect(mocks.completionFindMany.mock.calls[0]![0].where).toEqual({ organizationId: "club-1", personId: "person-1" });
  });

  it("ignores removed roster rows, so a removed-only person gives null", async () => {
    mocks.rosterFindMany.mockResolvedValue([]);
    await expect(loadMemberClassHistory("club-1", "person-1", now)).resolves.toBeNull();
    expect(mocks.rosterFindMany.mock.calls[0]![0].where).toMatchObject({ status: { not: "REMOVED" } });
  });

  it("returns null for someone never on this club's roster", async () => {
    mocks.rosterFindMany.mockResolvedValue([]);
    await expect(loadMemberClassHistory("club-1", "someone-else", now)).resolves.toBeNull();
  });
});

describe("class history page access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rosterFindMany.mockResolvedValue([
      { clubYear: "2026-27", classLevel: "FRIEND", status: "ACTIVE", person: { firstName: "Test", lastName: "Pathfinder" } },
    ]);
    mocks.completionFindMany.mockResolvedValue([]);
  });
  const props = { params: Promise.resolve({ organizationId: "club-1", personId: "person-1" }) };

  it("uses the same roster gate as the class-tracking page and loads nothing when it is closed", async () => {
    for (const state of ["SIGN_IN", "NOT_FOUND", "NO_ROSTER", "MFA_UNLOCK", "OWN_SESSION_REQUIRED"]) {
      mocks.getRosterAccessStateForPage.mockResolvedValue({ state });
      await expect(MemberClassHistoryPage(props)).resolves.toBeNull();
    }
    expect(mocks.rosterFindMany).not.toHaveBeenCalled();
    expect(mocks.getRosterAccessStateForPage).toHaveBeenCalledWith("club-1");
    // The class-tracking page itself checks the same helper.
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "SIGN_IN" });
    await expect(ClassTrackingPage({ params: Promise.resolve({ organizationId: "club-1" }) })).resolves.toBeNull();
  });

  it("shows the history for an open gate, and not found for a person off the roster", async () => {
    mocks.getRosterAccessStateForPage.mockResolvedValue({ state: "OPEN", capabilities: { manageTeam: false } });
    const out = renderToStaticMarkup(await MemberClassHistoryPage(props) as ReactElement);
    expect(out).toContain("Class history");
    expect(out).toContain("Test Pathfinder");
    expect(out).toContain("Friend");
    expect(out).toContain("In progress");
    mocks.rosterFindMany.mockResolvedValue([]);
    await expect(MemberClassHistoryPage(props)).rejects.toThrow("NOT_FOUND");
  });
});
