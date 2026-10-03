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
  queryRaw: vi.fn(),
  transactionOptions: vi.fn(),
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
  clubFormTemplateVersion: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null), createMany: vi.fn(async () => ({ count: 0 })) },
  $queryRaw: mocks.queryRaw,
  $transaction: (work: (tx: unknown) => unknown, options?: unknown) => {
    mocks.transactionOptions(options);
    return work(client);
  },
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
  getClubFormTemplateForStaff,
  getEnabledClubFormTemplate,
  listEnabledClubFormTemplates,
  setClubFormTemplateEnabled,
  syncClubFormTemplates,
  runClubFormTemplateSync,
  listClubFormTemplatesForAdmin,
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
  mocks.queryRaw.mockResolvedValue([]);
  mocks.templateUpsert.mockImplementation(async ({ create }: { create: { version: number } }) => ({ id: "created", version: create.version }));
  // The locked re-read of a template's keys: by default, what the earlier unlocked read returned.
  mocks.templateFindUnique.mockReset();
  mocks.templateFindUnique.mockImplementation(async ({ where }: { where: { id?: string } }) => {
    const rows = (await mocks.templateFindMany()) as Array<{ id?: string }> | undefined;
    return rows?.find((row) => row.id === where.id) ?? null;
  });
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

  const storedRows = (overrides: Record<string, { version?: number; sensitiveFieldKeys?: string[]; birthDateFieldKeys?: string[] }> = {}) => clubFormTemplateSeeds.map((seed) => ({
    id: `id-${seed.key}`,
    key: seed.key,
    version: seed.version - 1,
    sensitiveFieldKeys: seed.sensitiveFieldKeys,
    birthDateFieldKeys: seed.birthDateFieldKeys,
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

  it("locks the template row FOR UPDATE and gives the re-seal a timeout sized for thousands of rows", async () => {
    const stored = slip.sensitiveFieldKeys.filter((key) => key !== "physician_name");
    mocks.templateFindMany.mockResolvedValue(storedRows({ [slip.key]: { sensitiveFieldKeys: stored } }));
    mocks.submissionFindMany.mockResolvedValueOnce([]);
    await syncClubFormTemplates(client as never);
    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(mocks.queryRaw.mock.calls[0][0].join("?")).toMatch(/FOR UPDATE/);
    for (const [options] of mocks.transactionOptions.mock.calls) {
      expect(options.timeout).toBeGreaterThanOrEqual(60_000);
      expect(options.maxWait).toBeGreaterThanOrEqual(10_000);
    }
  });

  it("decides what to seal from the locked row, not from the earlier read", async () => {
    // The unlocked read says physician_name was already sensitive; a concurrent change made it plain before the lock.
    mocks.templateFindMany.mockResolvedValue(storedRows());
    const lockedStored = slip.sensitiveFieldKeys.filter((key) => key !== "physician_name");
    mocks.templateFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      version: 0,
      sensitiveFieldKeys: where.id === `id-${slip.key}` ? lockedStored : clubFormTemplateSeeds.find((seed) => `id-${seed.key}` === where.id)?.sensitiveFieldKeys,
      birthDateFieldKeys: clubFormTemplateSeeds.find((seed) => `id-${seed.key}` === where.id)?.birthDateFieldKeys,
    }));
    mocks.submissionFindMany.mockResolvedValueOnce([
      { id: "sub-1", answers: { physician_name: "Dr. Was Plain" }, sealedSensitiveAnswers: null },
    ]).mockResolvedValueOnce([]);
    await syncClubFormTemplates(client as never);
    expect(mocks.submissionUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports which templates were updated, created and unchanged", async () => {
    mocks.templateFindMany.mockResolvedValue(storedRows({ [slip.key]: { version: slip.version } }).filter((row) => row.key !== clubFormTemplateSeeds[0].key));
    const result = await syncClubFormTemplates(client as never);
    expect(result.unchanged.map((item) => item.key)).toContain(slip.key);
    expect(result.updated.some((item) => item.key === clubFormTemplateSeeds[0].key && item.created)).toBe(true);
    expect(result.updated.length + result.unchanged.length).toBe(clubFormTemplateSeeds.length);
  });

  it("the in-app Sync templates action reuses the sync, keeps its safety rules and audits counts only (#742)", async () => {
    const other = clubFormTemplateSeeds.find((seed) => seed.key !== slip.key)!;
    const third = clubFormTemplateSeeds.find((seed) => seed.key !== slip.key && seed.key !== other.key)!;
    const rows = storedRows({
      [slip.key]: { sensitiveFieldKeys: [...slip.sensitiveFieldKeys, "activity"] },
      [third.key]: { version: third.version },
    }).map((row) => (row.key === other.key ? { ...row, customizedAt: new Date("2026-10-01T00:00:00Z") } : row));
    mocks.templateFindMany.mockResolvedValue(rows);
    mocks.queryRaw.mockResolvedValue([{ locked: true }]);
    const report = (await runClubFormTemplateSync("admin-1")) as Exclude<Awaited<ReturnType<typeof runClubFormTemplateSync>>, { running: true }>;
    const status = (key: string) => report.results.find((item) => item.key === key)?.status;
    expect(status(slip.key)).toBe("REFUSED");
    expect(status(other.key)).toBe("SKIPPED");
    expect(status(third.key)).toBe("UNCHANGED");
    expect(report.results.some((item) => item.status === "UPDATED")).toBe(true);
    // A refused or customized template is never written over.
    const written = mocks.templateUpdate.mock.calls.map(([call]) => call.where.key);
    expect(written).not.toContain(slip.key);
    expect(written).not.toContain(other.key);
    const [entry] = mocks.writeAuditLog.mock.calls.at(-1)!;
    expect(entry).toMatchObject({ actorUserId: "admin-1", action: "CLUB_FORM_TEMPLATES_SYNCED" });
    expect(entry.metadata).toEqual({ ...report.counts, incomplete: false });
    expect(Object.values(entry.metadata).every((value) => typeof value === "number" || typeof value === "boolean")).toBe(true);
  });

  it("does nothing and writes no audit entry when another sync holds the lock (#742)", async () => {
    mocks.queryRaw.mockResolvedValue([{ locked: false }]);
    expect(await runClubFormTemplateSync("admin-1")).toEqual({ running: true });
    expect(mocks.templateFindMany).not.toHaveBeenCalled();
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("still writes a counts-only audit entry, marked incomplete, when a later template throws (#742)", async () => {
    const rows = clubFormTemplateSeeds.map((seed, index) => ({
      id: `id-${seed.key}`, key: seed.key, version: index === 0 ? seed.version : seed.version - 1,
      sensitiveFieldKeys: seed.sensitiveFieldKeys, birthDateFieldKeys: seed.birthDateFieldKeys,
    }));
    mocks.templateFindMany.mockResolvedValue(rows);
    mocks.queryRaw.mockResolvedValue([{ locked: true }]);
    let calls = 0;
    mocks.templateUpdate.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error("synthetic database failure");
    });
    await expect(runClubFormTemplateSync("admin-1")).rejects.toThrow("synthetic database failure");
    const [entry] = mocks.writeAuditLog.mock.calls.at(-1)!;
    expect(entry).toMatchObject({ actorUserId: "admin-1", action: "CLUB_FORM_TEMPLATES_SYNCED" });
    expect(entry.metadata).toMatchObject({ incomplete: true, updated: 1, unchanged: 1, refused: 0 });
    expect(JSON.stringify(entry)).not.toContain("synthetic database failure");
  });

  it("refuses a version that would stop a birth-date field being one (ADR 0005 Addendum A)", async () => {
    const member = clubFormTemplateSeeds.find((seed) => seed.birthDateFieldKeys.length > 0);
    if (!member) throw new Error("no seed with a birth-date field");
    mocks.templateFindMany.mockResolvedValue(storedRows({ [member.key]: { birthDateFieldKeys: [...member.birthDateFieldKeys, "extra_birth_date"], sensitiveFieldKeys: [...member.sensitiveFieldKeys, "extra_birth_date"] } }));
    await expect(syncClubFormTemplates(client as never)).rejects.toMatchObject({ code: "INVALID_TEMPLATE", message: expect.stringMatching(/reviewed change/) });
    expect(mocks.templateUpdate.mock.calls.map(([call]) => call.where.key)).not.toContain(member.key);
  });

  it("carries on past a refused form when asked, syncs the others, and reports every refusal", async () => {
    const other = clubFormTemplateSeeds.find((seed) => seed.key !== slip.key)!;
    mocks.templateFindMany.mockResolvedValue(storedRows({
      [slip.key]: { sensitiveFieldKeys: [...slip.sensitiveFieldKeys, "activity"] },
      [other.key]: { sensitiveFieldKeys: [...other.sensitiveFieldKeys, "extra_stored_only"] },
    }));
    const result = await syncClubFormTemplates(client as never, { continueOnRefusal: true });
    expect(result.refused.map((item) => item.key).sort()).toEqual([slip.key, other.key].sort());
    const updated = mocks.templateUpdate.mock.calls.map(([call]) => call.where.key);
    expect(updated).not.toContain(slip.key);
    expect(updated).not.toContain(other.key);
    expect(updated.length).toBe(clubFormTemplateSeeds.length - 2);
  });

  it("still stops at the first refusal by default", async () => {
    mocks.templateFindMany.mockResolvedValue(storedRows({ [slip.key]: { sensitiveFieldKeys: [...slip.sensitiveFieldKeys, "activity"] } }));
    await expect(syncClubFormTemplates(client as never)).rejects.toMatchObject({ code: "INVALID_TEMPLATE" });
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
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: false, version: slip.version });
    const now = new Date("2026-10-05T15:00:00Z");
    await setClubFormTemplateEnabled(slip.key, true, "admin-1", now);
    expect(mocks.templateUpdate).toHaveBeenCalledWith({ where: { id: "template-slip" }, data: { enabled: true, enabledAt: now, enabledByUserId: "admin-1" } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_FORM_TEMPLATE_ENABLED", actorUserId: "admin-1", metadata: { templateKey: slip.key, version: slip.version } }), client);

    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: true, version: slip.version });
    await setClubFormTemplateEnabled(slip.key, false, "admin-1", now);
    expect(mocks.templateUpdate).toHaveBeenLastCalledWith({ where: { id: "template-slip" }, data: { enabled: false, enabledAt: null, enabledByUserId: null } });
    expect(mocks.writeAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "CLUB_FORM_TEMPLATE_DISABLED" }), client);
  });

  it("changes and audits nothing when the switch is already where it was asked to be", async () => {
    mocks.templateFindMany.mockResolvedValue(clubFormTemplateSeeds.map((seed) => ({ key: seed.key, version: seed.version })));
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: true, version: slip.version });
    await setClubFormTemplateEnabled(slip.key, true, "admin-1");
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("lists templates for the admin page without syncing or re-sealing, and flags one that is behind", async () => {
    mocks.templateFindMany.mockResolvedValue([
      { key: slip.key, name: slip.name, description: slip.description, enabled: true, enabledAt: null, version: slip.version - 1, _count: { submissions: 3 } },
    ]);
    const listed = await listClubFormTemplatesForAdmin();
    expect(listed.find((row) => row.key === slip.key)).toMatchObject({ needsSync: true, submissionCount: 3 });
    // Seeded forms with no row yet are shown too, and need a sync as well.
    expect(listed.filter((row) => row.needsSync).length).toBe(clubFormTemplateSeeds.length);
    expect(mocks.templateUpsert).not.toHaveBeenCalled();
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.submissionFindMany).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("will not turn a form on while its stored version is behind the code, but will turn it off", async () => {
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: false, version: slip.version - 1 });
    await expect(setClubFormTemplateEnabled(slip.key, true, "admin-1")).rejects.toMatchObject({ code: "TEMPLATE_NEEDS_SYNC" });
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.templateUpsert).not.toHaveBeenCalled();
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", enabled: true, version: slip.version - 1 });
    await setClubFormTemplateEnabled(slip.key, false, "admin-1");
    expect(mocks.templateUpdate).toHaveBeenCalledTimes(1);
  });

  it("says a form that does not exist is not found", async () => {
    mocks.templateFindMany.mockResolvedValue(clubFormTemplateSeeds.map((seed) => ({ key: seed.key, version: seed.version })));
    mocks.templateFindUnique.mockResolvedValue(null);
    await expect(setClubFormTemplateEnabled("nope", true, "admin-1")).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });
});

describe("a stored template that lags the code restricts at least what the code restricts (#610)", () => {
  it("unions the seed's sensitive keys into what readers and the CSV see", async () => {
    mocks.templateFindUnique.mockResolvedValue({ ...slipRow, sensitiveFieldKeys: [], birthDateFieldKeys: [] });
    const template = await getClubFormTemplateForStaff(slip.key);
    expect(new Set(template.sensitiveFieldKeys)).toEqual(new Set(slip.sensitiveFieldKeys));
  });

  it("keeps a sensitive key out of the CSV even when the stored template lags", async () => {
    mocks.templateFindUnique.mockResolvedValue({ ...slipRow, sensitiveFieldKeys: [], birthDateFieldKeys: [] });
    mocks.submissionFindMany.mockResolvedValue([{
      clubYear: "2026-27", subjectName: "Riley Sample", status: "SUBMITTED", submittedAt: new Date("2026-10-30T12:00:00Z"), enteredVia: "LINK",
      answers: { child_name: "Riley Sample", physician_name: "Dr. Lagging Plain" }, organization: { name: "Example Pathfinders" },
    }]);
    const { csv } = await buildClubFormsCsv(staffSensitive, { templateKey: slip.key });
    expect(csv).not.toContain("Dr. Lagging Plain");
    expect(csv).not.toMatch(/physician/i);
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
