import { describe, expect, it } from "vitest";
import {
  type ClubHonorsRow,
  type MemberHonorEntryRecord,
  clubHonorsCsv,
  currentHonorsFromHistory,
  filterClubHonorsRows,
  honorSummaryByMemberId,
  memberHonorEntryProblem,
} from "@/modules/honors/member-honor-domain";

const entry = (overrides: Partial<MemberHonorEntryRecord>): MemberHonorEntryRecord => ({
  id: "entry-1",
  honorId: "honor-1",
  honorCode: "AR-011",
  honorName: "Basic Rescue",
  status: "IN_PROGRESS",
  completionDate: "",
  note: "",
  recordedByName: "A Director",
  recordedAtOrganizationName: "Test Club",
  createdAt: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("memberHonorEntryProblem", () => {
  it("requires a completion date for a completed honor", () => {
    expect(memberHonorEntryProblem({ status: "COMPLETED", completionDate: "" }, "2026-09-28"))
      .toMatch(/Enter the completion date/);
  });

  it("refuses a completion date in the future", () => {
    expect(memberHonorEntryProblem({ status: "COMPLETED", completionDate: "2026-10-01" }, "2026-09-28"))
      .toMatch(/can't be in the future/);
  });

  it("allows in-progress with no completion date", () => {
    expect(memberHonorEntryProblem({ status: "IN_PROGRESS", completionDate: "" }, "2026-09-28")).toBeNull();
  });

  it("allows a completed honor with a real past date", () => {
    expect(memberHonorEntryProblem({ status: "COMPLETED", completionDate: "2026-09-01" }, "2026-09-28")).toBeNull();
  });
});

describe("currentHonorsFromHistory", () => {
  it("keeps only the newest entry per honor, from newest-first history", () => {
    const history = [
      entry({ id: "e3", honorId: "h1", status: "COMPLETED", completionDate: "2026-09-20", createdAt: "2026-09-20" }),
      entry({ id: "e2", honorId: "h1", status: "IN_PROGRESS", createdAt: "2026-08-01" }),
      entry({ id: "e1", honorId: "h2", honorName: "Camping", status: "IN_PROGRESS", createdAt: "2026-07-01" }),
    ];
    const current = currentHonorsFromHistory(history);
    expect(current).toHaveLength(2);
    expect(current.find((row) => row.honorId === "h1")).toMatchObject({ status: "COMPLETED", completionDate: "2026-09-20" });
  });

  it("treats a later IN_PROGRESS entry as a correction that reopens a completed honor", () => {
    const history = [
      entry({ id: "e2", honorId: "h1", status: "IN_PROGRESS", completionDate: "", createdAt: "2026-09-25" }),
      entry({ id: "e1", honorId: "h1", status: "COMPLETED", completionDate: "2026-09-01", createdAt: "2026-09-01" }),
    ];
    const current = currentHonorsFromHistory(history);
    expect(current).toEqual([expect.objectContaining({ status: "IN_PROGRESS", completionDate: "" })]);
  });
});

describe("filterClubHonorsRows and clubHonorsCsv", () => {
  const rows: ClubHonorsRow[] = [
    {
      memberId: "m1", firstName: "Ada", lastName: "Lin", classLevel: "EXPLORER",
      honors: [
        { honorId: "h1", honorCode: "AR-011", honorName: "Basic Rescue", status: "COMPLETED", completionDate: "2026-09-01", createdAt: "2026-09-01" },
      ],
    },
    {
      memberId: "m2", firstName: "Ben", lastName: "Cruz", classLevel: "RANGER",
      honors: [
        { honorId: "h2", honorCode: "AR-020", honorName: "Camping", status: "IN_PROGRESS", completionDate: "", createdAt: "2026-08-01" },
      ],
    },
    { memberId: "m3", firstName: "Cy", lastName: "Diaz", classLevel: "EXPLORER", honors: [] },
  ];

  it("filters by unit (class level)", () => {
    const filtered = filterClubHonorsRows(rows, { classLevel: "EXPLORER" });
    expect(filtered.map((row) => row.memberId)).toEqual(["m1", "m3"]);
  });

  it("filters by honor and status, dropping members left with none", () => {
    const filtered = filterClubHonorsRows(rows, { status: "COMPLETED" });
    expect(filtered.map((row) => row.memberId)).toEqual(["m1"]);
  });

  it("keeps a member with no honors when no honor/status filter narrows the list", () => {
    const filtered = filterClubHonorsRows(rows, { classLevel: "EXPLORER" });
    expect(filtered.some((row) => row.memberId === "m3")).toBe(true);
  });

  it("exports names and honors only — no birth dates, ages, or medical fields", () => {
    const csv = clubHonorsCsv(rows);
    expect(csv).toContain("Lin");
    expect(csv).toContain("Basic Rescue");
    expect(csv).toContain("Completed");
    expect(csv).not.toMatch(/birth|dietary|allerg|medical|insurance/i);
  });

  it("maps current honors by roster member id for the roster card", () => {
    expect(honorSummaryByMemberId(rows)).toMatchObject({
      m1: [expect.objectContaining({ honorId: "h1" })],
      m2: [expect.objectContaining({ honorId: "h2" })],
      m3: [],
    });
  });
});
