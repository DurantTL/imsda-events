import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  templateFindMany: vi.fn(),
  templateFindUnique: vi.fn(),
  templateFindFirst: vi.fn(),
  templateUpsert: vi.fn(),
  templateUpdate: vi.fn(),
  submissionFindMany: vi.fn(),
  submissionUpdate: vi.fn(),
}));

const client = {
  clubFormTemplate: {
    findMany: mocks.templateFindMany,
    findUnique: mocks.templateFindUnique,
    findFirst: mocks.templateFindFirst,
    upsert: mocks.templateUpsert,
    update: mocks.templateUpdate,
  },
  clubFormSubmission: { findMany: mocks.submissionFindMany, update: mocks.submissionUpdate },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-club-form-tests" }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { buildClubFormsCsv } from "@/modules/club-forms/csv";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import type { ClubFormsViewer } from "@/modules/club-forms/domain";
import { openSensitiveAnswers, sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import {
  getEnabledClubFormTemplate,
  listEnabledClubFormTemplates,
  setClubFormTemplateEnabled,
  syncClubFormTemplates,
} from "@/modules/club-forms/templates";

const staffPlain: ClubFormsViewer = { kind: "STAFF", userId: "staff-2", systemAdmin: false };
const staffSensitive: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", systemAdmin: true };
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };

const slip = clubFormTemplateSeeds.find((seed) => seed.key === "off_premises_permission_slip")!;
const slipRow = {
  id: "template-slip", key: slip.key, name: slip.name, description: slip.description, version: slip.version,
  definition: slip.definition, sectionNotes: slip.sectionNotes, sensitiveFieldKeys: slip.sensitiveFieldKeys,
  birthDateFieldKeys: slip.birthDateFieldKeys, staffOnlyFieldKeys: slip.staffOnlyFieldKeys, printLayout: slip.printLayout, enabled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
});

describe("club form templates are off until a system administrator turns them on (#610)", () => {
  it("creates every seeded template disabled, and leaves existing ones alone at the same version", async () => {
    mocks.templateFindMany.mockResolvedValue([{ key: slip.key, version: slip.version }]);
    await syncClubFormTemplates(client as never);
    const created = mocks.templateUpsert.mock.calls.map(([call]) => call);
    expect(created.map((call) => call.create.key).sort()).toEqual([
      "pathfinder_membership_application",
      "pathfinder_staff_service_information",
      "transportation_passenger_list",
    ]);
    for (const call of created) {
      expect(call.create.enabled).toBe(false);
      expect(call.update).toEqual({});
    }
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
  });

  const storedRows = (overrides: Record<string, { version?: number; sensitiveFieldKeys?: string[] }> = {}) => clubFormTemplateSeeds.map((seed) => ({
    id: `id-${seed.key}`,
    key: seed.key,
    version: seed.version - 1,
    sensitiveFieldKeys: seed.sensitiveFieldKeys,
    ...overrides[seed.key],
  }));

  it("updates a definition when the seed version is newer, and never touches the switch", async () => {
    mocks.templateFindMany.mockResolvedValue(storedRows());
    await syncClubFormTemplates(client as never);
    expect(mocks.templateUpdate).toHaveBeenCalledTimes(4);
    for (const [call] of mocks.templateUpdate.mock.calls) {
      expect(call.data).not.toHaveProperty("enabled");
      expect(call.data).toHaveProperty("birthDateFieldKeys");
    }
    expect(mocks.submissionFindMany).not.toHaveBeenCalled();
  });

  it("re-seals existing submissions, in the same transaction, when a version makes a field newly sensitive", async () => {
    // The stored template did not treat the physician's name as sensitive; the new version does.
    const stored = slip.sensitiveFieldKeys.filter((key) => key !== "physician_name");
    mocks.templateFindMany.mockResolvedValue(storedRows({ [slip.key]: { sensitiveFieldKeys: stored } }));
    const existingSealed = sealSensitiveAnswers("sub-1", { emergency_contact_phone: "555-0111" });
    mocks.submissionFindMany.mockResolvedValueOnce([
      { id: "sub-1", answers: { child_name: "Riley Sample", physician_name: "Dr. Was Plain" }, sealedSensitiveAnswers: existingSealed },
      { id: "sub-2", answers: { child_name: "No Physician Given" }, sealedSensitiveAnswers: null },
    ]).mockResolvedValueOnce([]);
    const order: string[] = [];
    mocks.submissionUpdate.mockImplementation(async () => { order.push("reseal"); });
    mocks.templateUpdate.mockImplementation(async ({ where }: { where: { key: string } }) => { order.push(`template:${where.key}`); });

    await syncClubFormTemplates(client as never);

    expect(mocks.submissionUpdate).toHaveBeenCalledTimes(1);
    const update = mocks.submissionUpdate.mock.calls[0][0];
    expect(update.where).toEqual({ id: "sub-1" });
    expect(update.data.answers).toEqual({ child_name: "Riley Sample" });
    expect(update.data.hasSensitiveAnswers).toBe(true);
    expect(JSON.stringify(update)).not.toContain("Dr. Was Plain");
    expect(openSensitiveAnswers("sub-1", update.data.sealedSensitiveAnswers)).toEqual({ emergency_contact_phone: "555-0111", physician_name: "Dr. Was Plain" });
    // The re-seal happens before the template row changes, so no window exists where the field is sensitive but unsealed.
    expect(order.indexOf("reseal")).toBeLessThan(order.indexOf(`template:${slip.key}`));
  });

  it("refuses a version that would make a sensitive field readable again", async () => {
    mocks.templateFindMany.mockResolvedValue(storedRows({ [slip.key]: { sensitiveFieldKeys: [...slip.sensitiveFieldKeys, "activity"] } }));
    await expect(syncClubFormTemplates(client as never)).rejects.toMatchObject({ code: "INVALID_TEMPLATE" });
    expect(mocks.templateUpdate.mock.calls.map(([call]) => call.where.key)).not.toContain(slip.key);
  });

  it("offers a club only enabled templates, by name and description", async () => {
    mocks.templateFindMany.mockResolvedValue([]);
    await listEnabledClubFormTemplates();
    expect(mocks.templateFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { enabled: true },
      select: { key: true, name: true, description: true },
    }));
  });

  it("treats a disabled template as not found", async () => {
    mocks.templateFindFirst.mockResolvedValue(null);
    await expect(getEnabledClubFormTemplate("off_premises_permission_slip")).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(mocks.templateFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "off_premises_permission_slip", enabled: true } }));
  });

  it("turns a template on and records who and when, then off again", async () => {
    mocks.templateFindMany.mockResolvedValue(clubFormTemplateSeeds.map((seed) => ({ key: seed.key, version: seed.version })));
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: false });
    const now = new Date("2026-10-05T15:00:00Z");
    await setClubFormTemplateEnabled(slip.key, true, "admin-1", now);
    expect(mocks.templateUpdate).toHaveBeenCalledWith({ where: { id: "template-slip" }, data: { enabled: true, enabledAt: now, enabledByUserId: "admin-1" } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_FORM_TEMPLATE_ENABLED", actorUserId: "admin-1", metadata: { templateKey: slip.key } }), client);

    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: true });
    await setClubFormTemplateEnabled(slip.key, false, "admin-1", now);
    expect(mocks.templateUpdate).toHaveBeenLastCalledWith({ where: { id: "template-slip" }, data: { enabled: false, enabledAt: null, enabledByUserId: null } });
    expect(mocks.writeAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "CLUB_FORM_TEMPLATE_DISABLED" }), client);
  });

  it("changes and audits nothing when the switch is already where it was asked to be", async () => {
    mocks.templateFindMany.mockResolvedValue(clubFormTemplateSeeds.map((seed) => ({ key: seed.key, version: seed.version })));
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: true });
    await setClubFormTemplateEnabled(slip.key, true, "admin-1");
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("says a form that does not exist is not found", async () => {
    mocks.templateFindMany.mockResolvedValue(clubFormTemplateSeeds.map((seed) => ({ key: seed.key, version: seed.version })));
    mocks.templateFindUnique.mockResolvedValue(null);
    await expect(setClubFormTemplateEnabled("nope", true, "admin-1")).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });
});

describe("the staff CSV leaves sensitive answers out entirely (#610)", () => {
  const submissions = [{
    clubYear: "2026-27",
    subjectName: "Riley Sample",
    status: "SUBMITTED",
    submittedAt: new Date("2026-10-30T12:00:00Z"),
    enteredVia: "LINK",
    answers: { child_name: "Riley Sample", activity: "=HYPERLINK(\"http://x\")", relationship: "Parent" },
    organization: { name: "Example Pathfinders" },
  }];

  beforeEach(() => {
    mocks.templateFindUnique.mockResolvedValue(slipRow);
    mocks.submissionFindMany.mockResolvedValue(submissions);
  });

  it("has no column for a sensitive field, even for staff who may read them", async () => {
    for (const viewer of [staffPlain, staffSensitive]) {
      const { csv } = await buildClubFormsCsv(viewer, { templateKey: slip.key });
      const header = csv.split("\r\n")[0];
      for (const label of ["Physician's name", "Physician's phone", "Clinic", "Clinic phone", "Emergency contact phone number"]) {
        expect(header, label).not.toContain(`"${label}"`);
      }
      expect(header).toContain("\"Child's name\"");
      expect(header).toContain("\"I hereby give my permission for my child to participate in the pre-planned activity of\"");
    }
  });

  it("never reads the sealed column or the sensitive keys", async () => {
    await buildClubFormsCsv(staffSensitive, { templateKey: slip.key });
    const select = mocks.submissionFindMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("sealedSensitiveAnswers");
    expect(select).toHaveProperty("answers");
    expect(mocks.submissionFindMany.mock.calls[0][0].where).toMatchObject({ templateId: "template-slip", status: "SUBMITTED" });
  });

  it("neutralizes spreadsheet formulas in answers", async () => {
    const { csv } = await buildClubFormsCsv(staffPlain, { templateKey: slip.key });
    expect(csv).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
  });

  it("filters to one club when asked, and audits the export by count, not content", async () => {
    await buildClubFormsCsv(staffPlain, { templateKey: slip.key, organizationId: "club-a" });
    expect(mocks.submissionFindMany.mock.calls[0][0].where).toMatchObject({ organizationId: "club-a" });
    const entry = mocks.writeAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({ action: "CLUB_FORMS_EXPORTED", actorUserId: "staff-2", metadata: { templateKey: slip.key, rowCount: 1, organizationId: "club-a" } });
    expect(JSON.stringify(entry)).not.toContain("Riley");
  });

  it("is for conference staff only", async () => {
    await expect(buildClubFormsCsv(director, { templateKey: slip.key })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(buildClubFormsCsv({ kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "a" } }, { templateKey: slip.key })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.submissionFindMany).not.toHaveBeenCalled();
  });
});
