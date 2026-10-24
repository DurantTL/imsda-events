import { beforeEach, describe, expect, it, vi } from "vitest";

/** #871: the year-end contact phones use the shared validator against the saved report. Synthetic data only. */
const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  orgFindUnique: vi.fn(),
  reportFindUnique: vi.fn(),
  reportCreate: vi.fn(),
  reportUpdate: vi.fn(),
}));

const client = {
  organization: { findUnique: mocks.orgFindUnique, findMany: vi.fn().mockResolvedValue([]) },
  clubYearEndReport: {
    findUnique: mocks.reportFindUnique,
    findMany: vi.fn().mockResolvedValue([]),
    create: mocks.reportCreate,
    update: mocks.reportUpdate,
  },
  clubRosterMember: { findMany: vi.fn().mockResolvedValue([]) },
  memberClassCompletion: { findMany: vi.fn().mockResolvedValue([]) },
  memberHonorEntry: { findMany: vi.fn().mockResolvedValue([]) },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/club-rosters/birth-dates", () => ({ openBirthDate: (sealed: string) => sealed }));

import { yearEndFieldKeys } from "@/modules/club-reports/year-end-domain";
import { saveYearEndReport } from "@/modules/club-reports/year-end-repository";
import { yearEndReportInputSchema } from "@/modules/club-reports/year-end-schemas";

const NOW = new Date("2026-09-29T17:00:00Z");
const actor = { accountId: "account-1" };
const values = Object.fromEntries(yearEndFieldKeys.map((key) => [key, 0]));
const input = (overrides: Record<string, unknown> = {}) => yearEndReportInputSchema.parse({
  contactName: "Pat Example",
  contactEmail: "pat@example.test",
  values,
  status: "DRAFT",
  ...overrides,
});
const savedRow = (data: Record<string, unknown>) => ({
  id: "report-1", organizationId: "club-1", reportYear: "2026-27",
  contactName: "", contactWorkPhone: "", contactHomePhone: "", contactCellPhone: "", contactEmail: "",
  prefill: {}, overrides: {}, manual: {}, submittedAt: null, firstSubmittedAt: null, updatedAt: NOW, ...data,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.orgFindUnique.mockResolvedValue({ type: "CLUB", name: "Test Pathfinders" });
  mocks.reportFindUnique.mockResolvedValue(null);
  mocks.reportCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(savedRow(data)));
  mocks.reportUpdate.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve(savedRow(data)));
});

describe("year-end report phones (#871)", () => {
  it("stores new phones normalised, and blank ones as empty", async () => {
    await saveYearEndReport("club-1", "2026-27", input({ contactWorkPhone: "515.555.0134", contactCellPhone: "+52 55 1234 5678" }), actor, NOW);
    expect(mocks.reportCreate.mock.calls[0]![0].data).toMatchObject({
      contactWorkPhone: "(515) 555-0134",
      contactHomePhone: "",
      contactCellPhone: "+52 55 1234 5678",
    });
  });

  it("refuses a new bad phone, names its field, never echoes it, and writes nothing", async () => {
    const error = await saveYearEndReport("club-1", "2026-27", input({ contactHomePhone: "idk 911" }), actor, NOW).catch((caught: unknown) => caught) as { issues: Array<{ path: string[] }>; message: string };
    expect(error.issues[0]!.path).toEqual(["contactHomePhone"]);
    expect(JSON.stringify(error.issues)).not.toContain("idk 911");
    expect(error.message).not.toContain("idk 911");
    expect(mocks.reportCreate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("lets a saved old unusable phone stay on a draft that did not touch it, even re-formatted", async () => {
    mocks.reportFindUnique.mockResolvedValue({
      id: "report-1", status: "DRAFT", firstSubmittedAt: null, submittedAt: null,
      contactWorkPhone: "555-0100", contactHomePhone: "", contactCellPhone: "",
    });
    await saveYearEndReport("club-1", "2026-27", input({ contactWorkPhone: "555 0100", contactName: "Pat Changed" }), actor, NOW);
    expect(mocks.reportUpdate.mock.calls[0]![0].data).toMatchObject({ contactWorkPhone: "555-0100", contactName: "Pat Changed" });
  });

  it("holds a changed phone to the check, and judges each phone against its own saved value", async () => {
    mocks.reportFindUnique.mockResolvedValue({
      id: "report-1", status: "DRAFT", firstSubmittedAt: null, submittedAt: null,
      contactWorkPhone: "555-0100", contactHomePhone: "", contactCellPhone: "",
    });
    await expect(saveYearEndReport("club-1", "2026-27", input({ contactWorkPhone: "555-0199" }), actor, NOW)).rejects.toThrow();
    // The work phone's saved number does not excuse the same text typed in the home phone.
    await expect(saveYearEndReport("club-1", "2026-27", input({ contactWorkPhone: "555-0100", contactHomePhone: "555-0100" }), actor, NOW)).rejects.toThrow();
    expect(mocks.reportUpdate).not.toHaveBeenCalled();
  });

  describe("the contact email", () => {
    const longEmail = `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.test`;
    const saved = (email: string) => mocks.reportFindUnique.mockResolvedValue({
      id: "report-1", status: "DRAFT", firstSubmittedAt: null, submittedAt: null,
      contactWorkPhone: "", contactHomePhone: "", contactCellPhone: "", contactEmail: email,
    });

    it("lets a saved email over the shared length cap stay on a resave", async () => {
      expect(longEmail.length).toBeGreaterThan(160);
      saved(longEmail);
      await saveYearEndReport("club-1", "2026-27", input({ contactEmail: longEmail, contactName: "Pat Changed" }), actor, NOW);
      expect(mocks.reportUpdate.mock.calls[0]![0].data).toMatchObject({ contactEmail: longEmail, contactName: "Pat Changed" });
    });

    it("holds a changed over-long email to the cap, without echoing it, and writes nothing", async () => {
      saved("pat@example.test");
      const error = await saveYearEndReport("club-1", "2026-27", input({ contactEmail: longEmail }), actor, NOW).catch((caught: unknown) => caught) as { issues: Array<{ path: string[] }>; message: string };
      expect(error.issues[0]!.path).toEqual(["contactEmail"]);
      expect(JSON.stringify(error.issues)).not.toContain("aaaaaaaaaa");
      expect(mocks.reportUpdate).not.toHaveBeenCalled();
    });

    it("still rejects a malformed email in the schema", () => {
      expect(() => input({ contactEmail: "not-an-email" })).toThrow(/valid email/i);
    });
  });
});
