import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  templateFindFirst: vi.fn(),
  templateFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  submissionCreate: vi.fn(),
  submissionFindFirst: vi.fn(),
  submissionFindMany: vi.fn(),
  submissionUpdateMany: vi.fn(),
  organizationFindUnique: vi.fn(),
  rosterFindFirst: vi.fn(),
  rosterFindMany: vi.fn(),
  organizationFindMany: vi.fn(),
}));

const client = {
  clubFormTemplate: { findFirst: mocks.templateFindFirst, findUnique: mocks.templateFindUnique },
  $queryRaw: mocks.queryRaw,
  $executeRaw: mocks.executeRaw,
  clubFormSubmission: {
    create: mocks.submissionCreate,
    findFirst: mocks.submissionFindFirst,
    findMany: mocks.submissionFindMany,
    updateMany: mocks.submissionUpdateMany,
  },
  organization: { findUnique: mocks.organizationFindUnique, findMany: mocks.organizationFindMany },
  clubRosterMember: { findFirst: mocks.rosterFindFirst, findMany: mocks.rosterFindMany },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-club-form-tests", APP_BASE_URL: "https://events.imsda.test" }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import type { ClubFormsViewer } from "@/modules/club-forms/domain";
import { openSensitiveAnswers, sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import {
  getSubmissionForViewer,
  listSubmissionsForViewer,
  saveClubFormSubmission,
} from "@/modules/club-forms/submissions";

const now = new Date("2026-10-05T15:00:00Z");
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const otherDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-b", actor: { kind: "ATTENDEE", accountId: "acct-9" } };
const actingDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } };
const areaCoordinator: ClubFormsViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } };
// Conference staff: a system administrator, and an Event Admin of a current event.
const staffSensitive: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", systemAdmin: true };
const staffPlain: ClubFormsViewer = { kind: "STAFF", userId: "staff-2", systemAdmin: false };

const SECRET_PHYSICIAN = "Dr. Synthetic Physician";
const SECRET_PHONE = "555-0199";

function slipTemplateRow() {
  const seed = clubFormTemplateSeeds.find((template) => template.key === "off_premises_permission_slip");
  if (!seed) throw new Error("missing seed");
  return {
    id: "template-slip",
    key: seed.key,
    name: seed.name,
    description: seed.description,
    version: seed.version,
    definition: seed.definition,
    sectionNotes: seed.sectionNotes,
    sensitiveFieldKeys: seed.sensitiveFieldKeys,
    birthDateFieldKeys: seed.birthDateFieldKeys,
    staffOnlyFieldKeys: seed.staffOnlyFieldKeys,
    printLayout: seed.printLayout,
    enabled: true,
  };
}

const slipAnswers = {
  child_name: "Riley Sample",
  street: "6 Example Road",
  city: "Exampleville",
  state: "IA",
  zip: "50001",
  phone: "555-0110",
  activity: "Canoe trip",
  activity_date: "2026-11-07",
  ride_with: "Pat Sample",
  parent_signature: "Pat Sample",
  parent_signature_date: "2026-10-30",
  relationship: "Parent",
  physician_name: SECRET_PHYSICIAN,
  emergency_contact_phone: SECRET_PHONE,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.organizationFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Example Pathfinders" });
  mocks.templateFindFirst.mockResolvedValue(slipTemplateRow());
  mocks.templateFindUnique.mockReset();
  mocks.templateFindUnique.mockResolvedValue(slipTemplateRow());
  mocks.executeRaw.mockReset();
  mocks.executeRaw.mockResolvedValue(0);
  mocks.queryRaw.mockReset();
  mocks.queryRaw.mockResolvedValue([]);
  mocks.submissionCreate.mockResolvedValue({});
  mocks.submissionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.rosterFindFirst.mockResolvedValue({ id: "member-1", person: { firstName: "Riley", lastName: "Sample" } });
});

describe("a save that cannot get the template lock (#610)", () => {
  const save = () => saveClubFormSubmission(director, {
    organizationId: "club-a", templateKey: "off_premises_permission_slip", rosterMemberId: "member-1", answers: slipAnswers, submit: true,
  }, now);

  it("sets a lock timeout before it takes the share lock", async () => {
    await save();
    const order = [mocks.executeRaw.mock.invocationCallOrder[0], mocks.queryRaw.mock.invocationCallOrder[0]];
    expect(mocks.executeRaw.mock.calls[0][0].join("?")).toMatch(/SET LOCAL lock_timeout/);
    expect(order[0]).toBeLessThan(order[1]);
  });

  it.each([
    ["a Postgres lock timeout", { code: "P2010", meta: { code: "55P03" }, message: "Raw query failed. Code: `55P03`" }],
    ["a Prisma transaction error", { code: "P2028", message: "Transaction API error" }],
  ])("answers FORM_BUSY and writes nothing on %s", async (_name, failure) => {
    mocks.queryRaw.mockRejectedValue(failure);
    await expect(save()).rejects.toMatchObject({ code: "FORM_BUSY", message: "This form is being updated. Please try again in a minute." });
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("does not turn other database errors into FORM_BUSY", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(save()).rejects.toThrow("connection lost");
  });

  it("refuses when the template changed version while it waited (never validates against a stale definition)", async () => {
    mocks.templateFindUnique.mockResolvedValue({ ...slipTemplateRow(), version: slipTemplateRow().version + 1 });
    await expect(save()).rejects.toMatchObject({ code: "FORM_BUSY" });
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
  });

  it("refuses when the stored template is behind the code's version, before the first sync", async () => {
    const behind = { ...slipTemplateRow(), version: slipTemplateRow().version - 1 };
    mocks.templateFindFirst.mockResolvedValue(behind);
    mocks.templateFindUnique.mockResolvedValue(behind);
    await expect(save()).rejects.toMatchObject({ code: "FORM_BUSY" });
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
  });
});

describe("saving a club form (#610)", () => {
  it("takes a share lock on the template row and seals by the keys read under it", async () => {
    // Between the unlocked read and the lock, a re-seal made "activity" sensitive.
    mocks.templateFindUnique.mockResolvedValue({
      ...slipTemplateRow(),
      sensitiveFieldKeys: [...slipTemplateRow().sensitiveFieldKeys, "activity"],
    });
    const saved = await saveClubFormSubmission(director, {
      organizationId: "club-a",
      templateKey: "off_premises_permission_slip",
      rosterMemberId: "member-1",
      answers: slipAnswers,
      submit: true,
    }, now);
    expect(mocks.queryRaw.mock.calls[0][0].join("?")).toMatch(/FOR SHARE/);
    const stored = mocks.submissionCreate.mock.calls[0][0].data;
    expect(stored.answers).not.toHaveProperty("activity");
    expect(JSON.stringify(stored.answers)).not.toContain("Canoe trip");
    expect(openSensitiveAnswers(saved.id, stored.sealedSensitiveAnswers)).toMatchObject({ activity: "Canoe trip" });
  });

  it("seals sensitive answers and stores none of their text anywhere Prisma can see", async () => {
    const saved = await saveClubFormSubmission(director, {
      organizationId: "club-a",
      templateKey: "off_premises_permission_slip",
      rosterMemberId: "member-1",
      answers: slipAnswers,
      submit: true,
    }, now);
    expect(saved.status).toBe("SUBMITTED");

    const data = mocks.submissionCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      id: saved.id,
      organizationId: "club-a",
      templateId: "template-slip",
      clubYear: "2026-27",
      rosterMemberId: "member-1",
      subjectName: "Riley Sample",
      status: "SUBMITTED",
      hasSensitiveAnswers: true,
      enteredVia: "ATTENDEE",
      enteredByAccountId: "acct-1",
      enteredByUserId: null,
    });
    expect(data.sealedSensitiveAnswers).toMatch(/^v1\./);
    expect(data.answers).toMatchObject({ activity: "Canoe trip", child_name: "Riley Sample" });
    expect(data.answers).not.toHaveProperty("physician_name");
    expect(data.answers).not.toHaveProperty("emergency_contact_phone");

    // Nothing that reaches the database or the audit trail carries the plaintext.
    const everything = JSON.stringify([mocks.submissionCreate.mock.calls, mocks.writeAuditLog.mock.calls]);
    expect(everything).not.toContain(SECRET_PHYSICIAN);
    expect(everything).not.toContain(SECRET_PHONE);
    expect(openSensitiveAnswers(saved.id, data.sealedSensitiveAnswers)).toEqual({
      physician_name: SECRET_PHYSICIAN,
      emergency_contact_phone: SECRET_PHONE,
    });
  });

  it("binds the sealed value to its own submission", async () => {
    const sealed = sealSensitiveAnswers("submission-1", { physician_name: SECRET_PHYSICIAN });
    expect(() => openSensitiveAnswers("submission-2", sealed)).toThrowError(/could not be decrypted/);
  });

  it("records an act-as director against the staff user, never an attendee account", async () => {
    await saveClubFormSubmission(actingDirector, { organizationId: "club-a", templateKey: "off_premises_permission_slip", answers: slipAnswers, submit: true }, now);
    expect(mocks.submissionCreate.mock.calls[0][0].data).toMatchObject({ enteredVia: "STAFF_ACTING", enteredByAccountId: null, enteredByUserId: "admin-1" });
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "admin-1", metadata: expect.objectContaining({ actAsId: "act-1" }) });
  });

  it("audits the save without any answer text", async () => {
    await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", answers: slipAnswers, submit: false }, now);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "CLUB_FORM_SUBMISSION_SAVED", entityType: "ClubFormSubmission", metadata: expect.objectContaining({ hasSensitiveAnswers: true, templateKey: "off_premises_permission_slip" }) }),
      client,
    );
  });

  it("refuses every viewer that is not this club's director or deputy", async () => {
    for (const viewer of [otherDirector, areaCoordinator, staffSensitive, staffPlain]) {
      await expect(saveClubFormSubmission(viewer, { organizationId: "club-a", templateKey: "off_premises_permission_slip", answers: slipAnswers, submit: true }, now))
        .rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
  });

  it("does not offer a disabled or unknown form", async () => {
    mocks.templateFindFirst.mockResolvedValue(null);
    await expect(saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", answers: slipAnswers, submit: true }, now))
      .rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(mocks.templateFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { key: "off_premises_permission_slip", enabled: true } }));
  });

  it("treats another club's roster member as not found", async () => {
    mocks.rosterFindFirst.mockResolvedValue(null);
    await expect(saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", rosterMemberId: "member-of-club-b", answers: slipAnswers, submit: true }, now))
      .rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    expect(mocks.rosterFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: "club-a" }) }));
  });

  it("checks required answers on submit, by label only, but not on a draft", async () => {
    const { emergency_contact_phone: _phone, ...missing } = slipAnswers;
    void _phone;
    const error = await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", answers: missing, submit: true }, now).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", issues: [{ key: "emergency_contact_phone" }] });
    expect(JSON.stringify(error)).not.toContain(SECRET_PHYSICIAN);
    await expect(saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", answers: missing, submit: false }, now)).resolves.toMatchObject({ status: "DRAFT" });
  });

  it("never rewrites a submitted form", async () => {
    mocks.submissionFindFirst.mockResolvedValue({ id: "sub-1", status: "SUBMITTED" });
    await expect(saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", submissionId: "sub-1", answers: slipAnswers, submit: true }, now))
      .rejects.toMatchObject({ code: "ALREADY_SUBMITTED" });
    expect(mocks.submissionUpdateMany).not.toHaveBeenCalled();
  });

  it("guards a draft save against a submit that won the race", async () => {
    mocks.submissionFindFirst.mockResolvedValue({ id: "sub-1", status: "DRAFT" });
    mocks.submissionUpdateMany.mockResolvedValue({ count: 0 });
    await expect(saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", submissionId: "sub-1", answers: slipAnswers, submit: true }, now))
      .rejects.toMatchObject({ code: "ALREADY_SUBMITTED" });
    expect(mocks.submissionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sub-1", status: "DRAFT" } }));
  });

  it("scopes a draft edit to the club and the form", async () => {
    mocks.submissionFindFirst.mockResolvedValue({ id: "sub-1", status: "DRAFT" });
    await saveClubFormSubmission(director, { organizationId: "club-a", templateKey: "off_premises_permission_slip", submissionId: "sub-1", answers: slipAnswers, submit: false }, now);
    expect(mocks.submissionFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sub-1", organizationId: "club-a", templateId: "template-slip" } }));
  });
});

describe("listing submissions (#610)", () => {
  beforeEach(() => mocks.submissionFindMany.mockResolvedValue([]));

  it("limits a club's leader to their own club, drafts included, and keeps forms since switched off", async () => {
    await listSubmissionsForViewer(director, {});
    expect(mocks.submissionFindMany.mock.calls[0][0].where).toEqual({ organizationId: "club-a" });
  });

  it("does not let a leader ask for another club", async () => {
    await expect(listSubmissionsForViewer(director, { organizationId: "club-b" })).rejects.toMatchObject({ code: "CLUB_NOT_FOUND" });
    expect(mocks.submissionFindMany).not.toHaveBeenCalled();
  });

  it("gives an Area Coordinator submitted forms only", async () => {
    await listSubmissionsForViewer(areaCoordinator, { organizationId: "club-b" });
    expect(mocks.submissionFindMany.mock.calls[0][0].where).toEqual({ organizationId: "club-b", status: "SUBMITTED" });
  });

  it("gives conference staff every club's submitted forms", async () => {
    await listSubmissionsForViewer(staffPlain, {});
    expect(mocks.submissionFindMany.mock.calls[0][0].where).toEqual({ status: "SUBMITTED" });
  });

  it("never selects answers, sealed or plain", async () => {
    await listSubmissionsForViewer(staffSensitive, {});
    const select = mocks.submissionFindMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("answers");
    expect(select).not.toHaveProperty("sealedSensitiveAnswers");
  });
});

describe("opening a submission (#610)", () => {
  const submissionId = "sub-1";
  const sealed = () => sealSensitiveAnswers(submissionId, { physician_name: SECRET_PHYSICIAN, emergency_contact_phone: SECRET_PHONE });
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: submissionId,
    organizationId: "club-a",
    clubYear: "2026-27",
    rosterMemberId: "member-1",
    subjectName: "Riley Sample",
    status: "SUBMITTED",
    submittedAt: now,
    enteredVia: "ATTENDEE",
    answers: { child_name: "Riley Sample", activity: "Canoe trip" },
    sealedSensitiveAnswers: sealed(),
    hasSensitiveAnswers: true,
    organization: { name: "Example Pathfinders" },
    template: slipTemplateRow(),
    ...overrides,
  });

  beforeEach(() => {
    // A fake table that honors the organization filter, like the real query.
    mocks.submissionFindFirst.mockImplementation(async ({ where }: { where: { organizationId?: string } }) => {
      const found = row();
      return where.organizationId && where.organizationId !== found.organizationId ? null : found;
    });
  });

  it("shows the club's director the sensitive answers, and audits the view without them", async () => {
    const view = await getSubmissionForViewer(director, submissionId, "PRINT");
    expect(view.sensitiveRevealed).toBe(true);
    expect(view.answers).toMatchObject({ physician_name: SECRET_PHYSICIAN, emergency_contact_phone: SECRET_PHONE, activity: "Canoe trip" });
    expect(view.restrictedKeys).toEqual([]);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    const entry = mocks.writeAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({
      action: "CLUB_FORM_SUBMISSION_VIEWED",
      entityType: "ClubFormSubmission",
      entityId: submissionId,
      metadata: { viewerKind: "CLUB_LEADER", actorAttendeeAccountId: "acct-1", organizationId: "club-a", templateKey: "off_premises_permission_slip", purpose: "PRINT", sensitiveRevealed: true },
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain(SECRET_PHYSICIAN);
    expect(serialized).not.toContain(SECRET_PHONE);
    expect(serialized).not.toContain("Canoe trip");
  });

  it("shows an Area Coordinator Restricted for every sensitive field and no values, and still audits the view", async () => {
    const view = await getSubmissionForViewer(areaCoordinator, submissionId);
    expect(view.sensitiveRevealed).toBe(false);
    expect(view.restrictedKeys).toEqual(slipTemplateRow().sensitiveFieldKeys);
    expect(view.answers).not.toHaveProperty("physician_name");
    expect(view.answers).not.toHaveProperty("emergency_contact_phone");
    expect(JSON.stringify(view)).not.toContain(SECRET_PHYSICIAN);
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ metadata: expect.objectContaining({ viewerKind: "AREA_COORDINATOR", sensitiveRevealed: false }) });
  });

  it("audits the view when a sensitive answer is sitting in the plain column, even with the flag off", async () => {
    mocks.submissionFindFirst.mockImplementation(async () => row({
      hasSensitiveAnswers: false,
      sealedSensitiveAnswers: null,
      answers: { child_name: "Riley Sample", physician_name: "Dr. Plain Legacy" },
    }));
    await getSubmissionForViewer(director, submissionId);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls)).not.toContain("Dr. Plain Legacy");
  });

  it("does not audit a form with nothing sensitive in it", async () => {
    mocks.submissionFindFirst.mockImplementation(async () => row({
      hasSensitiveAnswers: false, sealedSensitiveAnswers: null, answers: { child_name: "Riley Sample" },
    }));
    await getSubmissionForViewer(director, submissionId);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("restricts what the code marks sensitive even when the stored template lags", async () => {
    mocks.submissionFindFirst.mockImplementation(async () => row({
      template: { ...slipTemplateRow(), sensitiveFieldKeys: [], birthDateFieldKeys: [] },
    }));
    const view = await getSubmissionForViewer(areaCoordinator, submissionId);
    expect(new Set(view.restrictedKeys)).toEqual(new Set(slipTemplateRow().sensitiveFieldKeys));
    expect(view.answers).not.toHaveProperty("physician_name");
  });

  it("drops a restricted key from the plain answers too, in case one was stored there", async () => {
    mocks.submissionFindFirst.mockImplementation(async () => row({
      answers: { child_name: "Riley Sample", physician_name: "Dr. Stored Plain By Mistake" },
    }));
    const view = await getSubmissionForViewer(areaCoordinator, submissionId);
    expect(view.answers).not.toHaveProperty("physician_name");
    expect(JSON.stringify(view)).not.toContain("Dr. Stored Plain By Mistake");
    expect(view.answers).toMatchObject({ child_name: "Riley Sample" });
  });

  it("gives an Event Admin and a system administrator the health, physician and emergency answers", async () => {
    for (const viewer of [staffPlain, staffSensitive]) {
      const view = await getSubmissionForViewer(viewer, submissionId);
      expect(view.sensitiveRevealed).toBe(true);
      expect(view.answers).toMatchObject({ physician_name: SECRET_PHYSICIAN, emergency_contact_phone: SECRET_PHONE });
      expect(view.restrictedKeys).toEqual([]);
    }
    expect(mocks.writeAuditLog.mock.calls.map(([entry]) => entry.actorUserId)).toEqual(["staff-2", "staff-1"]);
  });

  describe("birth dates (ADR 0005 Addendum A)", () => {
    const BIRTH = "2015-04-02";
    const staffRow = () => {
      const seed = clubFormTemplateSeeds.find((template) => template.key === "pathfinder_staff_service_information")!;
      return {
        id: "template-staff", key: seed.key, name: seed.name, description: seed.description, version: seed.version,
        definition: seed.definition, sectionNotes: seed.sectionNotes, sensitiveFieldKeys: seed.sensitiveFieldKeys,
        birthDateFieldKeys: seed.birthDateFieldKeys, staffOnlyFieldKeys: seed.staffOnlyFieldKeys, printLayout: seed.printLayout, enabled: true,
      };
    };
    beforeEach(() => {
      mocks.submissionFindFirst.mockResolvedValue(row({
        template: staffRow(),
        answers: { full_name: "Alex Sample" },
        sealedSensitiveAnswers: sealSensitiveAnswers(submissionId, { birth_date: BIRTH, child_1_birth_date: "2018-01-01", health_limitation: "Yes", health_limitation_how: SECRET_PHYSICIAN }),
      }));
    });

    it("shows them to the club's own director and to a system administrator", async () => {
      for (const viewer of [director, staffSensitive, actingDirector]) {
        const view = await getSubmissionForViewer(viewer, submissionId);
        expect(view.answers).toMatchObject({ birth_date: BIRTH, child_1_birth_date: "2018-01-01", health_limitation: "Yes" });
        expect(view.restrictedKeys).toEqual([]);
      }
    });

    it("shows an Event Admin the health answers but Restricted for every birth date", async () => {
      const view = await getSubmissionForViewer(staffPlain, submissionId);
      expect(view.answers).toMatchObject({ health_limitation: "Yes", health_limitation_how: SECRET_PHYSICIAN });
      expect(view.answers).not.toHaveProperty("birth_date");
      expect(view.answers).not.toHaveProperty("child_1_birth_date");
      expect(new Set(view.restrictedKeys)).toEqual(new Set(staffRow().birthDateFieldKeys));
      expect(JSON.stringify(view)).not.toContain(BIRTH);
      expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ metadata: expect.objectContaining({ sensitiveRevealed: true, birthDatesRevealed: false }) });
    });

    it("shows an Area Coordinator Restricted for birth dates and every other sensitive field", async () => {
      const view = await getSubmissionForViewer(areaCoordinator, submissionId);
      expect(view.answers).toEqual({ full_name: "Alex Sample" });
      expect(new Set(view.restrictedKeys)).toEqual(new Set(staffRow().sensitiveFieldKeys));
      expect(JSON.stringify(view)).not.toContain(BIRTH);
      expect(JSON.stringify(view)).not.toContain(SECRET_PHYSICIAN);
    });

    it("keeps birth dates out of the audit row", async () => {
      await getSubmissionForViewer(director, submissionId);
      expect(JSON.stringify(mocks.writeAuditLog.mock.calls)).not.toContain(BIRTH);
    });
  });

  it("attributes an act-as director's view to the staff user", async () => {
    await getSubmissionForViewer(actingDirector, submissionId);
    expect(mocks.writeAuditLog.mock.calls[0][0]).toMatchObject({ actorUserId: "admin-1", metadata: expect.objectContaining({ actAsId: "act-1" }) });
  });

  it("does not show another club's director the submission, and writes no audit row", async () => {
    await expect(getSubmissionForViewer(otherDirector, submissionId)).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("writes no audit row for a form with no sensitive answers", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({ hasSensitiveAnswers: false, sealedSensitiveAnswers: null }));
    const view = await getSubmissionForViewer(director, submissionId);
    expect(view.answers).toEqual({ child_name: "Riley Sample", activity: "Canoe trip" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("returns nothing when the audit row cannot be written, before anything is decrypted", async () => {
    mocks.writeAuditLog.mockRejectedValue(new Error("audit store unavailable"));
    // A value that cannot be decrypted proves the audit failure came first.
    mocks.submissionFindFirst.mockResolvedValue(row({ sealedSensitiveAnswers: "v1.not.a.value" }));
    await expect(getSubmissionForViewer(director, submissionId)).rejects.toThrowError("audit store unavailable");
  });

  it("says the answers are unreadable, not why, when the key has changed", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({ sealedSensitiveAnswers: sealSensitiveAnswers("another-submission", { physician_name: SECRET_PHYSICIAN }) }));
    await expect(getSubmissionForViewer(director, submissionId)).rejects.toMatchObject({ code: "SENSITIVE_UNREADABLE" });
  });

  it("keeps a switched-off form's past submissions readable to everyone who could read them, and says it is off", async () => {
    mocks.submissionFindFirst.mockResolvedValue(row({ template: { ...slipTemplateRow(), enabled: false } }));
    for (const viewer of [director, areaCoordinator, staffPlain]) {
      const view = await getSubmissionForViewer(viewer, submissionId);
      expect(view.template.enabled).toBe(false);
    }
    for (const [call] of mocks.submissionFindFirst.mock.calls) expect(call.where).not.toHaveProperty("template");
  });

  it("looks the form up inside the club named in the page's URL, before anything is audited", async () => {
    await getSubmissionForViewer(areaCoordinator, submissionId, "VIEW", "club-a");
    expect(mocks.submissionFindFirst.mock.calls[0][0].where).toMatchObject({ id: submissionId, organizationId: "club-a", status: "SUBMITTED" });
    mocks.writeAuditLog.mockClear();
    await expect(getSubmissionForViewer(areaCoordinator, submissionId, "VIEW", "club-b")).rejects.toMatchObject({ code: "SUBMISSION_NOT_FOUND" });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    await expect(getSubmissionForViewer(director, submissionId, "VIEW", "club-b")).rejects.toMatchObject({ code: "CLUB_NOT_FOUND" });
  });
});
