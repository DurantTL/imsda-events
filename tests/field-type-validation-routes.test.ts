/* eslint-disable @typescript-eslint/no-explicit-any -- loose in-memory stand-ins for the Prisma client */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { preparePublicRegistration, publicRegistrationInputSchema } from "@/modules/forms/public-domain";
import { syntheticRecord } from "./health-records-fixtures";

/**
 * #855 and #854 part 2: the server rejects a bad phone, email or number on the
 * routes that save registration answers, a club member's health record and a
 * permission slip, and never puts the submitted value in its answer. Real
 * routes and real validators; only the database and the session are stand-ins.
 */

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  templateFindFirst: vi.fn(),
  templateFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  submissionCreate: vi.fn(),
  submissionFindFirst: vi.fn(),
  submissionUpdateMany: vi.fn(),
  organizationFindUnique: vi.fn(),
  rosterFindFirst: vi.fn(),
  requireClubLeaderViewer: vi.fn(),
  requireHealthViewerForClub: vi.fn(),
  healthRecordFindUnique: vi.fn(),
  healthRecordCreate: vi.fn(),
  healthRecordUpdate: vi.fn(),
  healthFieldDeleteMany: vi.fn(),
  healthFieldCreateMany: vi.fn(),
  logError: vi.fn(),
  logger: vi.fn(),
}));

const client: any = {
  clubFormTemplate: { findFirst: mocks.templateFindFirst, findUnique: mocks.templateFindUnique },
  clubFormTemplateVersion: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  $queryRaw: mocks.queryRaw,
  $executeRaw: mocks.executeRaw,
  clubFormSubmission: { create: mocks.submissionCreate, findFirst: mocks.submissionFindFirst, updateMany: mocks.submissionUpdateMany },
  organization: { findUnique: mocks.organizationFindUnique, findMany: vi.fn(async () => []) },
  clubRosterMember: { findFirst: mocks.rosterFindFirst, findMany: vi.fn(async () => []) },
  healthRecord: { findUnique: mocks.healthRecordFindUnique, findFirst: vi.fn(async () => null), create: mocks.healthRecordCreate, update: mocks.healthRecordUpdate },
  healthRecordField: { deleteMany: mocks.healthFieldDeleteMany, createMany: mocks.healthFieldCreateMany },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({
    HEALTH_RECORDS_ENABLED: true,
    SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-validation-tests",
    APP_BASE_URL: "https://events.imsda.test",
  }),
}));
vi.mock("@/lib/request-context", () => ({ withRequestContext: (handler: unknown) => handler }));
vi.mock("@/modules/access/request-security", () => ({ rejectCrossOriginRequest: () => null }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/club-forms/access", () => ({ requireClubLeaderViewer: mocks.requireClubLeaderViewer }));
vi.mock("@/modules/health-records/access", () => ({ requireHealthViewerForClub: mocks.requireHealthViewerForClub }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError, logInfo: mocks.logger, logWarn: mocks.logger }));

import { PUT as HEALTH_PUT } from "@/app/api/attendee/clubs/[organizationId]/health/[memberId]/route";
import { POST as SLIP_SAVE } from "@/app/api/attendee/clubs/[organizationId]/forms/submissions/route";
import { sealSensitiveAnswers } from "@/modules/club-forms/sealed-answers";
import { sealHealthField } from "@/modules/health-records/crypto";

const club = { params: Promise.resolve({ organizationId: "club-a" }) };
const healthCtx = { params: Promise.resolve({ organizationId: "club-a", memberId: "member-1" }) };

const json = (method: string, body: unknown) =>
  new Request("https://events.imsda.test/api/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------------------------------------------------------------------------
// Permission slip (a club form): #854 part 2

function slipRow(extraFields: unknown[] = []) {
  const seed = clubFormTemplateSeeds.find((template) => template.key === "off_premises_permission_slip");
  if (!seed) throw new Error("missing seed");
  const definition = structuredClone(seed.definition);
  definition.sections[0].fields.push(...(extraFields as never[]));
  return {
    id: "template-slip",
    key: seed.key,
    name: seed.name,
    description: seed.description,
    version: seed.version,
    definition,
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
  phone: "515-555-0110",
  activity: "Canoe trip",
  activity_date: "2026-11-07",
  ride_with: "Pat Sample",
  parent_signature: "Pat Sample",
  parent_signature_date: "2026-10-30",
  relationship: "Parent",
  physician_name: "Dr. Synthetic Physician",
  physician_phone: "515-555-0111",
  clinic_phone: "(515) 555-0112",
  emergency_contact_phone: "515-555-0113",
};

const saveSlip = (answers: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  SLIP_SAVE(json("POST", { templateKey: "off_premises_permission_slip", rosterMemberId: "member-1", answers, submit: true, ...extra }), club);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.requireClubLeaderViewer.mockResolvedValue({ kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } });
  mocks.requireHealthViewerForClub.mockResolvedValue({ kind: "CLUB_LEADER", organizationId: "club-a", accountId: "acct-1" });
  mocks.organizationFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Example Pathfinders" });
  mocks.templateFindFirst.mockResolvedValue(slipRow());
  mocks.templateFindUnique.mockResolvedValue(slipRow());
  mocks.executeRaw.mockResolvedValue(0);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.submissionCreate.mockResolvedValue({});
  mocks.submissionFindFirst.mockResolvedValue(null);
  mocks.submissionUpdateMany.mockResolvedValue({ count: 1 });
  mocks.rosterFindFirst.mockResolvedValue({
    id: "member-1",
    personId: "person-1",
    person: { firstName: "Riley", lastName: "Sample" },
    organization: { name: "Example Pathfinders", isActive: true, type: "CLUB", parentOrganization: null },
  });
  mocks.healthRecordFindUnique.mockResolvedValue(null);
  mocks.healthRecordCreate.mockResolvedValue({});
  mocks.healthRecordUpdate.mockResolvedValue({});
  mocks.healthFieldDeleteMany.mockResolvedValue({});
  mocks.healthFieldCreateMany.mockResolvedValue({});
});

describe("permission slip saves (#854, #855)", () => {
  it("saves a slip with valid phones and stores them in one form", async () => {
    const response = await saveSlip(slipAnswers);
    expect(response.status).toBe(201);
    const created = mocks.submissionCreate.mock.calls[0][0].data;
    expect(created.answers.phone).toBe("(515) 555-0110");
  });

  it.each([
    ["Physician's phone", { physician_phone: "Mine" }],
    ["Clinic phone", { clinic_phone: "idk" }],
    ["Emergency contact phone number", { emergency_contact_phone: "911? duh" }],
  ])("rejects free text in %s and echoes nothing", async (label, patch) => {
    const response = await saveSlip({ ...slipAnswers, ...patch });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain(label);
    for (const value of Object.values(patch)) expect(text).not.toContain(value);
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toMatch(/Mine|idk|911/);
  });

  it("rejects a bad email and a bad number on a slip with those fields", async () => {
    const extra = [
      { id: "f_email", key: "parent_email", label: "Parent email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: false, options: [] },
      { id: "f_count", key: "riders", label: "Riders", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
    ];
    mocks.templateFindFirst.mockResolvedValue(slipRow(extra));
    mocks.templateFindUnique.mockResolvedValue(slipRow(extra));
    const badEmail = await saveSlip({ ...slipAnswers, parent_email: "not-an-email" });
    expect(badEmail.status).toBe(400);
    expect(await badEmail.text()).toContain("Parent email must be a valid email address");
    const badNumber = await saveSlip({ ...slipAnswers, riders: "lots" });
    expect(badNumber.status).toBe(400);
    expect(await badNumber.text()).toContain("Riders must be a number");
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
  });

  it("keeps an old bad answer on a draft that is edited, and still rejects a changed one", async () => {
    const stored = { ...slipAnswers, clinic_phone: "idk", physician_phone: undefined, emergency_contact_phone: undefined };
    mocks.submissionFindFirst.mockResolvedValue({ id: "draft-1", status: "DRAFT", answers: stored, sealedSensitiveAnswers: null });
    const unchanged = await saveSlip({ ...slipAnswers, clinic_phone: "idk" }, { submissionId: "draft-1", submit: false });
    expect(unchanged.status).toBe(201);
    const changed = await saveSlip({ ...slipAnswers, clinic_phone: "idk 2" }, { submissionId: "draft-1", submit: false });
    expect(changed.status).toBe(400);
  });
});

describe("permission slip draft with sealed answers (#855)", () => {
  it("compares against sealed stored answers, so an unchanged old physician phone saves and a changed one does not", async () => {
    const sealed = sealSensitiveAnswers("draft-2", { physician_phone: "idk" });
    mocks.submissionFindFirst.mockResolvedValue({ id: "draft-2", status: "DRAFT", answers: {}, sealedSensitiveAnswers: sealed });
    const base = { ...slipAnswers, physician_phone: "idk" };
    const unchanged = await saveSlip(base, { submissionId: "draft-2", submit: false });
    expect(unchanged.status).toBe(201);
    const changed = await saveSlip({ ...base, physician_phone: "idk2" }, { submissionId: "draft-2", submit: false });
    expect(changed.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Club member health record

describe("club member health record saves (#855)", () => {
  const save = (patch: Record<string, unknown>) => HEALTH_PUT(json("PUT", { ...syntheticRecord, ...patch }), healthCtx);

  it("saves valid values and stores the phones normalised", async () => {
    const response = await save({});
    expect(response.status).toBe(200);
    expect(mocks.healthRecordCreate).toHaveBeenCalled();
  });

  it.each([
    ["phone", { phone: "Mine" }],
    ["guardianPhone", { guardianPhone: "idk" }],
    ["insurancePhone", { insurancePhone: "911? duh" }],
    ["email", { email: "not an email" }],
    ["guardianEmail", { guardianEmail: "nope" }],
    ["zip", { zip: "ABCDE" }],
    ["emergencyContacts", { emergencyContacts: [{ firstName: "Alex", lastName: "Sample", phone: "call mom", relationship: "Aunt" }] }],
  ])("rejects a bad %s with a field message and no value", async (field, patch) => {
    const response = await save(patch);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain(field);
    for (const value of Object.values(patch)) if (typeof value === "string") expect(text).not.toContain(value);
    expect(text).not.toContain("call mom");
    expect(mocks.healthRecordCreate).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toMatch(/Mine|idk|911|nope|call mom/);
  });

  it("opens nothing stored when the failure is not a typed field", async () => {
    mocks.healthRecordFindUnique.mockClear();
    const response = await save({ guardianFirstName: "" });
    expect(response.status).toBe(400);
    const typedAndPlain = await save({ guardianFirstName: "", guardianPhone: "idk" });
    expect(typedAndPlain.status).toBe(400);
    expect(mocks.healthRecordFindUnique).not.toHaveBeenCalled();
  });

  it("excuses an old bad contact phone only for that same contact, by position", async () => {
    const recordId = "record-2";
    const stored = [{ firstName: "Alex", lastName: "Sample", phone: "call mom", relationship: "Aunt" }];
    mocks.healthRecordFindUnique.mockResolvedValue({
      id: recordId,
      confirmedClubYear: "2025",
      hasHealthNote: false,
      lastEnteredVia: "DIRECTOR",
      fields: [{ fieldKey: "emergencyContacts", sealedValue: sealHealthField(recordId, "emergencyContacts", stored) }],
    });
    const second = { firstName: "Bo", lastName: "Sample", relationship: "Uncle" };
    const kept = await save({ emergencyContacts: [stored[0], { ...second, phone: "515-555-0150" }] });
    expect(kept.status).toBe(200);
    const copied = await save({ emergencyContacts: [stored[0], { ...second, phone: "call mom" }] });
    expect(copied.status).toBe(400);
  });

  it("does not fail on a stored old answer the person did not touch, but does on a changed one", async () => {
    const recordId = "record-1";
    mocks.healthRecordFindUnique.mockResolvedValue({
      id: recordId,
      confirmedClubYear: "2025",
      hasHealthNote: false,
      lastEnteredVia: "DIRECTOR",
      fields: [{ fieldKey: "guardianPhone", sealedValue: sealHealthField(recordId, "guardianPhone", "idk") }],
    });
    const untouched = await save({ guardianPhone: "idk" });
    expect(untouched.status).toBe(200);
    const edited = await save({ guardianPhone: "idk idk" });
    expect(edited.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Registration: the server function the registration route calls

describe("registration answers (#855)", () => {
  const definition = registrationFormDefinitionSchema.parse({
    title: "Validation fixture",
    description: "Fictitious.",
    confirmationMessage: "Done.",
    sections: [{
      id: "contact_section",
      title: "Contact",
      description: "",
      fields: [
        { id: "f_first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "f_last", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
        { id: "f_email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
        { id: "f_phone", key: "phone", label: "Phone", helpText: "", type: "PHONE", scope: "REGISTRATION", required: false, options: [] },
        { id: "f_party", key: "party_size", label: "Party size", helpText: "", type: "NUMBER", scope: "REGISTRATION", required: false, options: [] },
      ],
    }],
  });
  const prepare = (responses: Record<string, unknown>) => preparePublicRegistration(
    definition,
    publicRegistrationInputSchema.parse({ versionId: "v1", idempotencyKey: "2f1c5ce4-a9bc-4d15-8a6d-9879f25dbd3b", responses }),
    { timeZone: "America/Chicago" },
  );
  const good = { first_name: "Avery", last_name: "Tester", email: "avery@example.test", phone: "515 555 0134", party_size: "3" };

  it("accepts good answers and stores the phone normalised", () => {
    const prepared = prepare(good);
    expect(prepared.isValid).toBe(true);
    expect(prepared.responses.phone).toBe("(515) 555-0134");
  });

  it.each([
    ["email", { email: "avery at example" }, "Email must be a valid email address"],
    ["phone", { phone: "idk" }, "Phone must be a 10-digit US number"],
    ["number", { party_size: "a few" }, "Party size must be a number"],
  ])("rejects a bad %s without echoing it", (_name, patch, message) => {
    const prepared = prepare({ ...good, ...patch });
    expect(prepared.isValid).toBe(false);
    expect(prepared.issues.map((issue) => issue.message).join(" ")).toContain(message);
    for (const value of Object.values(patch)) expect(JSON.stringify(prepared.issues)).not.toContain(value);
  });
});
