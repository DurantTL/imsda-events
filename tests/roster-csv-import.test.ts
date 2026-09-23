import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRosterAccess: vi.fn(),
  listRoster: vi.fn(),
  addRosterMember: vi.fn(),
  updateRosterMember: vi.fn(),
  writeAuditLog: vi.fn(),
  rejectCrossOriginRequest: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: mocks.rejectCrossOriginRequest }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/club-rosters/access", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/access")>("@/modules/club-rosters/access");
  return { ...actual, requireRosterAccess: mocks.requireRosterAccess };
});
vi.mock("@/modules/club-rosters/repository", async () => {
  const actual = await vi.importActual<typeof import("@/modules/club-rosters/repository")>("@/modules/club-rosters/repository");
  return { ...actual, listRoster: mocks.listRoster, addRosterMember: mocks.addRosterMember, updateRosterMember: mocks.updateRosterMember };
});

import { POST } from "@/app/api/attendee/clubs/[organizationId]/roster/import/route";
import { RosterAccessError } from "@/modules/club-rosters/access";
import { normalizeBirthDate, parseRosterCsv, planRosterImport, rosterCsvTemplate } from "@/modules/club-rosters/csv-import";
import { RosterOperationError } from "@/modules/club-rosters/repository";

// Synthetic people only.
const csv = [
  "First name,Last name,Birth date,Type,Class,Role,Gender",
  "Alex,Sample,5/20/2014,Pathfinder,Friend,,F",
  "Jordan,Example,,Staff,,Counselor,",
  "Casey,Tester,,,,,",
  "Riley,,2013-01-02,,,,",
  "Sam,Sample,not a date,,,,",
].join("\n");

const ctx = { params: Promise.resolve({ organizationId: "club-1" }) };
const request = (body: unknown) => new Request("https://events.imsda.test/api/attendee/clubs/club-1/roster/import", {
  method: "POST",
  headers: { origin: "https://events.imsda.test", "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rejectCrossOriginRequest.mockReturnValue(null);
  mocks.requireRosterAccess.mockResolvedValue({ state: "OPEN", accountId: "account-1" });
  mocks.listRoster.mockResolvedValue([{ id: "member-1", firstName: "Jordan", lastName: "Example" }]);
  mocks.addRosterMember.mockResolvedValue("member-new");
  mocks.updateRosterMember.mockResolvedValue(undefined);
});

describe("roster CSV (#384)", () => {
  it("offers a template with the roster's columns and nothing else", () => {
    expect(rosterCsvTemplate().trim()).toBe('"First name","Last name","Birth date","Type","Class","Role","Gender"');
  });

  it("reads Excel-style dates, names, and labels", () => {
    expect(normalizeBirthDate("4/7/2014")).toBe("2014-04-07");
    expect(normalizeBirthDate("2014-4-7")).toBe("2014-04-07");
    const [alex] = parseRosterCsv(csv);
    expect(alex).toMatchObject({ firstName: "Alex", lastName: "Sample", birthDate: "2014-05-20", attendeeType: "YOUTH", classLevel: "FRIEND", gender: "FEMALE" });
    expect(() => parseRosterCsv("Name,Age\nAlex,12")).toThrow(/First name and Last name/);
  });

  it("plans adds and updates by name, and skips what it can't do", () => {
    const plan = planRosterImport(parseRosterCsv(csv), [{ id: "member-1", firstName: "Jordan", lastName: "Example" }]);
    expect(plan.map((step) => [step.name, step.action])).toEqual([
      ["Alex Sample", "ADD"],
      ["Jordan Example", "UPDATE"],
      ["Casey Tester", "SKIP"],
      ["Riley", "SKIP"],
      ["Sam Sample", "SKIP"],
    ]);
    expect(plan[2].message).toMatch(/birth date/);
    expect(plan[4].message).toMatch(/isn't a date/);
  });

  it("refuses to guess between two people with the same name", () => {
    const plan = planRosterImport(parseRosterCsv("First name,Last name,Class\nAlex,Sample,Friend"), [
      { id: "a", firstName: "Alex", lastName: "Sample" },
      { id: "b", firstName: "alex", lastName: "sample" },
    ]);
    expect(plan[0]).toMatchObject({ action: "SKIP", memberId: null });
  });

  it("previews without saving anything", async () => {
    const response = await POST(request({ csv }), ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as { steps: Array<{ action: string }> };
    expect(body.steps.map((step) => step.action)).toEqual(["ADD", "UPDATE", "SKIP", "SKIP", "SKIP"]);
    expect(mocks.addRosterMember).not.toHaveBeenCalled();
    expect(mocks.updateRosterMember).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toContain("2014-05-20");
  });

  it("saves on confirm through the normal roster functions, audited with counts", async () => {
    const response = await POST(request({ csv, confirm: true }), ctx);
    expect(response.status).toBe(200);
    expect(mocks.addRosterMember).toHaveBeenCalledWith("club-1", expect.any(String), expect.objectContaining({
      firstName: "Alex", birthDate: "2014-05-20", attendeeType: "YOUTH", role: "Pathfinder", classLevel: "FRIEND",
    }), { accountId: "account-1" });
    expect(mocks.updateRosterMember).toHaveBeenCalledWith("club-1", "member-1", { attendeeType: "STAFF", role: "Counselor" }, { accountId: "account-1" });
    const audit = mocks.writeAuditLog.mock.calls[0][0];
    expect(audit).toMatchObject({ action: "CLUB_ROSTER_CSV_IMPORTED", metadata: { rows: 5, added: 1, updated: 1, skipped: 3 } });
    expect(JSON.stringify(audit)).not.toMatch(/Alex|Jordan|Sample/);
  });

  it("skips a row the roster refuses without stopping the rest", async () => {
    mocks.addRosterMember.mockRejectedValueOnce(new RosterOperationError("DUPLICATE_MEMBER", "Already on the roster."));
    const body = await (await POST(request({ csv, confirm: true }), ctx)).json() as { added: number; updated: number; steps: Array<{ action: string; message: string }> };
    expect(body.added).toBe(0);
    expect(body.updated).toBe(1);
    expect(body.steps[0]).toMatchObject({ action: "SKIP", message: "Already on the roster." });
  });

  it("needs roster access", async () => {
    mocks.requireRosterAccess.mockRejectedValueOnce(new RosterAccessError("ROLE_NOT_ALLOWED", 403, "No."));
    expect((await POST(request({ csv }), ctx)).status).toBe(403);
  });
});
