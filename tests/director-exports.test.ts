import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  loadMasterAwardProgress: vi.fn(),
  requireHonorsAccess: vi.fn(),
  requireClubSupplyAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/earned-awards/order-source", () => ({ loadMasterAwardProgress: mocks.loadMasterAwardProgress }));
vi.mock("@/modules/honors/member-honor-access", () => ({ requireHonorsAccess: mocks.requireHonorsAccess }));
vi.mock("@/modules/club-supplies/access", () => ({ requireClubSupplyAccess: mocks.requireClubSupplyAccess }));

import { GET as CLASS_GET } from "@/app/api/attendee/clubs/[organizationId]/exports/class-tracking/route";
import { GET as HONORS_GET } from "@/app/api/attendee/clubs/[organizationId]/exports/honors/route";
import { RosterAccessError } from "@/modules/club-rosters/access";
import {
  CLASS_TRACKING_EXPORT_HEADERS,
  HONORS_EXPORT_HEADERS,
  classTrackingExportCsv,
  honorsExportCsv,
  honorsSummary,
  type HonorsExportRow,
} from "@/modules/reporting/director-exports";
import { loadClassTrackingExport, loadHonorsExport } from "@/modules/reporting/director-exports-repository";

/** Director exports (#655). Synthetic data only. */

const context = { clubName: "Sample Pathfinders", clubYear: "2026-27" };
const honor = (overrides: Partial<HonorsExportRow> = {}): HonorsExportRow => ({
  lastName: "Sample", firstName: "Alex", className: "Friend", honorName: "Basic Rescue", category: "Health and Science",
  status: "Completed", dateEarned: "2026-09-19", dateKind: "Completed", eventName: "Fall Camporee", ...overrides,
});

describe("honors export CSV", () => {
  it("carries the club, the year, the columns, the rows and a summary", () => {
    const csv = honorsExportCsv(context, [honor(), honor({ lastName: "Demo", firstName: "Casey" }), honor({ status: "In progress", dateKind: "Recorded", dateEarned: "2026-09-20", honorName: "Knots" })]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe('"Club","Sample Pathfinders"');
    expect(lines[1]).toBe('"Club year","2026-27"');
    expect(lines).toContain(HONORS_EXPORT_HEADERS.map((h) => `"${h}"`).join(","));
    expect(csv).toContain('"Sample","Alex","Friend","Basic Rescue","Health and Science","Completed","2026-09-19","Completed","Fall Camporee"');
    expect(csv).toContain('"Summary: completed honors","Count"');
    expect(csv).toContain('"Basic Rescue","2"');
    // In-progress work is not counted as earned.
    expect(csv).not.toContain('"Knots","1"');
  });

  it("neutralizes formula-looking names and honors", () => {
    const csv = honorsExportCsv(context, [honor({ lastName: "=HYPERLINK(1)", honorName: "+cmd", eventName: "@x" })]);
    expect(csv).toContain(`"'=HYPERLINK(1)"`);
    expect(csv).toContain(`"'+cmd"`);
    expect(csv).toContain(`"'@x"`);
  });

  it("has an empty state and no sensitive columns", () => {
    const csv = honorsExportCsv(context, []);
    expect(csv).toContain("No honors recorded for the chosen filters.");
    expect(csv).toContain("No completed honors.");
    for (const header of [...HONORS_EXPORT_HEADERS, ...CLASS_TRACKING_EXPORT_HEADERS]) expect(header).not.toMatch(/birth|age|medical|health|allerg|phone|email/i);
  });

  it("counts completed honors most first", () => {
    const rows = [honor(), honor({ lastName: "B" }), honor({ honorName: "Knots", lastName: "C" })];
    expect(honorsSummary(rows).map((r) => [r.honorName, r.count])).toEqual([["Basic Rescue", 2], ["Knots", 1]]);
  });
});

describe("class tracking export CSV", () => {
  it("lists each member with joined items and handles an empty roster", () => {
    const csv = classTrackingExportCsv(context, [{
      personId: "p1", lastName: "Sample", firstName: "Alex", className: "Friend",
      insignia: ["Friend Pin (awarded)"], eventPatches: ["Fall Camporee Patch (earned)"], conductAndTlt: ["Good Conduct Bar (earned)", "TLT Pin (ordered)"],
      masterAwards: ["Health Master Award: 5 of 7"],
    }]);
    expect(csv).toContain('"Club","Sample Pathfinders"');
    expect(csv).toContain('"Sample","Alex","Friend","Friend Pin (awarded)","Fall Camporee Patch (earned)","Good Conduct Bar (earned); TLT Pin (ordered)","Health Master Award: 5 of 7"');
    expect(classTrackingExportCsv(context, [])).toContain("No active roster members for this club year.");
  });
});

describe("export repository", () => {
  const prisma = {
    organization: { findUnique: vi.fn() },
    clubRosterMember: { findMany: vi.fn() },
    memberHonorEntry: { findMany: vi.fn() },
    clubOrderNeed: { findMany: vi.fn() },
  };
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getPrisma.mockReturnValue(prisma);
    prisma.organization.findUnique.mockResolvedValue({ name: "Sample Pathfinders" });
    prisma.clubRosterMember.findMany.mockResolvedValue([
      { id: "m1", classLevel: "FRIEND", person: { id: "p1", firstName: "Alex", lastName: "Sample" } },
      { id: "m2", classLevel: null, person: { id: "p2", firstName: "Casey", lastName: "Demo" } },
    ]);
  });

  it("returns the latest entry per honor, the event, and never selects birth or health fields", async () => {
    prisma.memberHonorEntry.findMany.mockResolvedValue([
      { personId: "p1", honorId: "h1", status: "COMPLETED", completionDate: "2026-09-19", createdAt: new Date("2026-09-20T00:00:00Z"), honor: { name: "Basic Rescue", category: "HEALTH_AND_SCIENCE" }, weekendCompletionLinks: [{ enrollment: { event: { name: "Fall Camporee" } } }] },
      { personId: "p1", honorId: "h1", status: "IN_PROGRESS", completionDate: "", createdAt: new Date("2026-09-01T00:00:00Z"), honor: { name: "Basic Rescue", category: "HEALTH_AND_SCIENCE" }, weekendCompletionLinks: [] },
    ]);
    const { clubName, rows } = await loadHonorsExport("club-1", "2026-27", { category: "HEALTH_AND_SCIENCE" });
    expect(clubName).toBe("Sample Pathfinders");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ honorName: "Basic Rescue", status: "Completed", dateEarned: "2026-09-19", eventName: "Fall Camporee", className: "Friend" });
    const query = JSON.stringify([prisma.clubRosterMember.findMany.mock.calls, prisma.memberHonorEntry.findMany.mock.calls]);
    expect(query).not.toMatch(/birth|medical|health(?!_)/i);
    expect(prisma.memberHonorEntry.findMany.mock.calls[0][0].where).toMatchObject({ void: null, honor: { category: "HEALTH_AND_SCIENCE" } });
  });

  it("returns no rows for an empty roster without querying entries", async () => {
    prisma.clubRosterMember.findMany.mockResolvedValue([]);
    expect((await loadHonorsExport("club-1", "2026-27")).rows).toEqual([]);
    expect(prisma.memberHonorEntry.findMany).not.toHaveBeenCalled();
    expect((await loadClassTrackingExport("club-1", "2026-27")).rows).toEqual([]);
  });

  it("groups earned items by origin and adds Master Award progress", async () => {
    prisma.clubOrderNeed.findMany.mockResolvedValue([
      { personId: "p1", sourceId: "class:p1:FRIEND:i1", status: "AWARDED", item: { name: "Friend Pin" } },
      { personId: "p1", sourceId: "event:e1:p1:i2", status: "NEEDED", item: { name: "Camporee Patch" } },
      { personId: "p1", sourceId: "award:abc", status: "ORDERED", item: { name: "Good Conduct Bar" } },
    ]);
    mocks.loadMasterAwardProgress.mockResolvedValue([{
      name: "Health Master Award", eligible: [{ personId: "p2" }], onOrder: [], givenElsewhere: [],
      closest: [{ personId: "p1", label: "5 of 7" }],
    }]);
    const { rows } = await loadClassTrackingExport("club-1", "2026-27");
    expect(rows.map((r) => r.lastName)).toEqual(["Demo", "Sample"]);
    expect(rows[1]).toMatchObject({
      insignia: ["Friend Pin (awarded)"], eventPatches: ["Camporee Patch (earned)"], conductAndTlt: ["Good Conduct Bar (ordered)"],
      masterAwards: ["Health Master Award: 5 of 7"],
    });
    expect(rows[0].masterAwards).toEqual(["Health Master Award: eligible"]);
  });
});

describe("export routes", () => {
  const prisma = {
    organization: { findUnique: vi.fn() },
    clubRosterMember: { findMany: vi.fn() },
    memberHonorEntry: { findMany: vi.fn() },
    clubOrderNeed: { findMany: vi.fn() },
  };
  const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };
  const request = (query = "") => new Request(`https://events.imsda.test/api/attendee/clubs/club-1/exports/x${query}`);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getPrisma.mockReturnValue(prisma);
    prisma.organization.findUnique.mockResolvedValue({ name: "Sample Pathfinders" });
    prisma.clubRosterMember.findMany.mockResolvedValue([]);
    mocks.loadMasterAwardProgress.mockResolvedValue([]);
  });

  it("downloads honors for an editor, and read-only for a registrar or Area Coordinator", async () => {
    mocks.requireHonorsAccess.mockResolvedValue({ mode: "READ", viewer: { accountId: "acct-reg" } });
    const response = await HONORS_GET(request("?year=2026-27&category=NATURE"), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/csv");
    expect(response.headers.get("Content-Disposition")).toContain("club-honors-2026-27.csv");
    expect(await response.text()).toContain("No honors recorded for the chosen filters.");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "CLUB_DIRECTOR_EXPORT_DOWNLOADED",
      metadata: expect.objectContaining({ report: "honors", readOnly: true, rowCount: 0 }),
    }));
  });

  it("downloads class tracking on the class tracking gate", async () => {
    mocks.requireClubSupplyAccess.mockResolvedValue({ mode: "EDIT", actor: { accountId: "acct-dir" } });
    const response = await CLASS_GET(request(), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toMatch(/club-class-tracking-\d{4}-\d{2}\.csv/);
    expect(await response.text()).toContain("No active roster members for this club year.");
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ report: "class-tracking", readOnly: false }) }));
  });

  it("refuses anyone without access and writes nothing", async () => {
    mocks.requireHonorsAccess.mockRejectedValue(new RosterAccessError("NOT_FOUND", 404, "That club could not be found."));
    mocks.requireClubSupplyAccess.mockRejectedValue(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "Your club role doesn't include this."));
    expect((await HONORS_GET(request(), ctx)).status).toBe(404);
    expect((await CLASS_GET(request(), ctx)).status).toBe(403);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    expect(prisma.clubRosterMember.findMany).not.toHaveBeenCalled();
  });
});
