/* eslint-disable @typescript-eslint/no-explicit-any -- the in-memory fake database receives loosely typed Prisma arguments */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #817: new club applications. Who may submit, see and decide; what an
 * approval creates and that it happens exactly once; what the emails and the
 * audit trail may contain. The fake database keeps rows in memory and the
 * outbox is the local capture: nothing leaves the process and no real person
 * exists. Synthetic data only.
 */

const storageDir = mkdtempSync(path.join(tmpdir(), "new-club-application-"));
process.env.ASSET_STORAGE_DIR = storageDir;

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  writeAuditLog: vi.fn(),
  getPlatformSettings: vi.fn(),
  isAccountEmailConfigured: vi.fn(),
  processAccountEmailQueue: vi.fn(),
  directorStates: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: () => ({ APP_BASE_URL: "https://events.imsda.test" }) }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/system-admin/platform-settings", () => ({ getPlatformSettings: mocks.getPlatformSettings }));
vi.mock("@/modules/communications/account-email", () => ({
  AccountEmailNotConfiguredError: class extends Error {},
  getAccountEmailSender: () => ({ name: "IMSDA Events", address: "events@imsda.test", replyTo: null }),
  isAccountEmailConfigured: mocks.isAccountEmailConfigured,
}));
vi.mock("@/modules/communications/email-delivery", () => ({ processAccountEmailQueue: mocks.processAccountEmailQueue }));
vi.mock("@/modules/background-checks/repository", () => ({ directorBackgroundStatesByEmail: mocks.directorStates }));

import { AccessDeniedError, type AuthenticatedUser } from "@/modules/access/authorization";
import { hashOpaqueToken } from "@/modules/access/tokens";
import { directorMatchKey } from "@/modules/background-checks/director-match";
import { newClubApplicationInputSchema } from "@/modules/club-applications/domain";
import {
  cancelNewClubInvite,
  checkApplicationAttachment,
  createNewClubInvite,
  decideNewClubApplication,
  getApplicationAttachment,
  listNewClubApplications,
  NewClubApplicationError,
  resolveNewClubInvite,
  submitNewClubApplication,
} from "@/modules/club-applications/repository";
import {
  NEW_CLUB_APPLICATION_LINK_SENTINEL,
  prepareNewClubInviteBodyForDelivery,
  submittedEmailContent,
} from "@/modules/club-applications/email";

const systemAdmin: AuthenticatedUser = { id: "user-admin", email: "admin@imsda-events.test", displayName: "Alex Admin", globalRole: "SYSTEM_ADMIN" } as AuthenticatedUser;
const eventAdmin: AuthenticatedUser = { id: "user-ea", email: "ea@imsda-events.test", displayName: "Eli EventAdmin", globalRole: null } as AuthenticatedUser;

const NOW = new Date("2026-10-08T15:00:00Z");
const OPENED = NOW.getTime() - 60_000;
const NOTIFY = "youth-assistant@imsda-events.test";

function input(overrides: Record<string, unknown> = {}) {
  return newClubApplicationInputSchema.parse({
    clubName: "Synthetic Trailblazers",
    clubType: "PATHFINDER",
    sponsoringChurchId: "church-1",
    pastorName: "Pat Pastor",
    directorName: "Dana Director",
    directorAddress: "100 Example Road, Sampletown, ZZ 00000",
    directorEmail: "dana.director@example.test",
    directorHomePhone: "555-0100",
    philosophyAgreed: true,
    pastorSignature: "Pat Pastor",
    headElderSignature: "Hal Elder",
    clerkSignature: "Cleo Clerk",
    directorSignature: "Dana Director",
    otherBoardMembers: ["Ben Board"],
    note: "We meet Tuesdays.",
    formOpenedAt: OPENED,
    ...overrides,
  });
}

const pdf = () => new File([new TextEncoder().encode("%PDF-1.4 synthetic")], "Signed page.pdf", { type: "application/pdf" });

function fakeDatabase() {
  const organizations = new Map<string, any>([
    ["church-1", { id: "church-1", type: "CHURCH", name: "Synthetic Church", isActive: true, parentOrganizationId: null, normalizedName: "synthetic church" }],
    ["church-2", { id: "church-2", type: "CHURCH", name: "Second Synthetic Church", isActive: true, parentOrganizationId: null, normalizedName: "second synthetic church" }],
    ["company-1", { id: "company-1", type: "COMPANY", name: "Synthetic Company Congregation", isActive: true, parentOrganizationId: null, normalizedName: "synthetic company congregation" }],
    ["group-1", { id: "group-1", type: "GROUP", name: "Synthetic Group Congregation", isActive: true, parentOrganizationId: null, normalizedName: "synthetic group congregation" }],
    ["school-1", { id: "school-1", type: "SCHOOL", name: "Synthetic School", isActive: true, parentOrganizationId: null, normalizedName: "synthetic school" }],
  ]);
  const applications: any[] = [];
  const invites: any[] = [];
  const clubInvites: any[] = [];
  const outbox: any[] = [];
  let sequence = 0;
  const next = (prefix: string) => `${prefix}-${++sequence}`;

  const applicationShape = (row: any) => ({
    ...row,
    sponsoringChurch: row.sponsoringChurchId && organizations.get(row.sponsoringChurchId)
      ? { name: organizations.get(row.sponsoringChurchId).name, type: organizations.get(row.sponsoringChurchId).type, isActive: organizations.get(row.sponsoringChurchId).isActive }
      : null,
    decidedBy: row.decidedByUserId ? { displayName: "Alex Admin" } : null,
  });
  const matchesStatus = (row: any, status: any) => (status === undefined ? true : typeof status === "string" ? row.status === status : row.status !== status.not);

  const tx: any = {
    organization: {
      findFirst: vi.fn(async ({ where }: any) => [...organizations.values()].find((org) => org.id === where.id
        && (typeof where.type === "string" ? org.type === where.type : where.type.in.includes(org.type))
        && org.isActive === where.isActive) ?? null),
      findMany: vi.fn(async ({ where }: any) => [...organizations.values()].filter((org) => org.type === where.type && where.parentOrganizationId.in.includes(org.parentOrganizationId))),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: next("org"), ...data };
        organizations.set(row.id, row);
        return { id: row.id };
      }),
    },
    newClubApplication: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: next("app"), status: "PENDING", decidedByUserId: null, decidedAt: null, declineReason: null, createdOrganizationId: null, createdAt: new Date(NOW.getTime() + sequence * 1000), ...data };
        applications.push(row);
        return { id: row.id };
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const row = applications.find((candidate) => candidate.id === where.id);
        return row ? applicationShape(row) : null;
      }),
      findMany: vi.fn(async ({ where }: any) => applications
        .filter((row) => matchesStatus(row, where.status) && (!where.sponsoringChurchId || where.sponsoringChurchId.in.includes(row.sponsoringChurchId)))
        .map(applicationShape)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = applications.find((candidate) => candidate.id === where.id && candidate.status === where.status);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(applications.find((candidate) => candidate.id === where.id), data);
        return {};
      }),
      count: vi.fn(async () => applications.filter((row) => row.status === "PENDING").length),
    },
    newClubApplicationInvite: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: next("inv"), tokenHash: null, messageId: null, usedAt: null, cancelledAt: null, createdAt: NOW, ...data };
        invites.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(invites.find((candidate) => candidate.id === where.id), data);
        return {};
      }),
      findUnique: vi.fn(async ({ where }: any) => invites.find((row) => (where.tokenHash ? row.tokenHash === where.tokenHash : row.messageId === where.messageId)) ?? null),
      findMany: vi.fn(async () => [...invites]),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = invites.find((candidate) => candidate.id === where.id
          && (where.usedAt === undefined || candidate.usedAt === where.usedAt)
          && (where.cancelledAt === undefined || candidate.cancelledAt === where.cancelledAt)
          && (where.expiresAt === undefined || candidate.expiresAt > where.expiresAt.gt));
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    clubInvite: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: next("club-invite"), status: "PENDING", sentCount: 0, ...data };
        clubInvites.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        Object.assign(clubInvites.find((candidate) => candidate.id === where.id), data);
        return {};
      }),
    },
    messageOutbox: { create: vi.fn(async ({ data }: any) => { outbox.push(data); return { id: `msg-${outbox.length}` }; }) },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)) };
  return { prisma, organizations, applications, invites, clubInvites, outbox };
}

let db: ReturnType<typeof fakeDatabase>;

beforeEach(() => {
  vi.clearAllMocks();
  db = fakeDatabase();
  mocks.getPrisma.mockReturnValue(db.prisma);
  mocks.getPlatformSettings.mockResolvedValue({ newClubApplicationEmail: NOTIFY });
  mocks.isAccountEmailConfigured.mockReturnValue(true);
  mocks.processAccountEmailQueue.mockResolvedValue({});
  mocks.directorStates.mockResolvedValue(new Map());
  for (const entry of readdirSync(storageDir)) rmSync(path.join(storageDir, entry), { recursive: true, force: true });
});

afterAll(() => rmSync(storageDir, { recursive: true, force: true }));

describe("submitting an application", () => {
  it("saves a waiting application and creates nothing else", async () => {
    await submitNewClubApplication(input(), { now: NOW });
    expect(db.applications).toHaveLength(1);
    expect(db.applications[0]).toMatchObject({
      status: "PENDING",
      source: "PUBLIC",
      clubName: "Synthetic Trailblazers",
      clubType: "PATHFINDER",
      sponsoringChurchId: "church-1",
      directorEmail: "dana.director@example.test",
      philosophyAgreed: true,
      otherBoardMembers: ["Ben Board"],
    });
    expect(db.applications[0].applicationDate.toISOString().slice(0, 10)).toBe("2026-10-08");
    // No club, no invite, no account.
    expect([...db.organizations.values()].filter((org) => org.type === "CLUB")).toHaveLength(0);
    expect(db.clubInvites).toHaveLength(0);
  });

  it("stamps the date itself and refuses a form sent too quickly", async () => {
    await expect(submitNewClubApplication(input({ formOpenedAt: NOW.getTime() - 500 }), { now: NOW })).rejects.toMatchObject({ code: "TOO_QUICK" });
    expect(db.applications).toHaveLength(0);
  });

  it("refuses a church that isn't an active church in the directory", async () => {
    await expect(submitNewClubApplication(input({ sponsoringChurchId: "club-nope" }), { now: NOW })).rejects.toMatchObject({ code: "INVALID_CHURCH" });
    db.organizations.get("church-2").isActive = false;
    await expect(submitNewClubApplication(input({ sponsoringChurchId: "church-2" }), { now: NOW })).rejects.toMatchObject({ code: "INVALID_CHURCH" });
  });

  it("accepts a company or group as the sponsor, and refuses a school (#822)", async () => {
    await submitNewClubApplication(input({ sponsoringChurchId: "company-1" }), { now: NOW });
    await submitNewClubApplication(input({ clubName: "Group Club", sponsoringChurchId: "group-1" }), { now: NOW });
    expect(db.applications.map((application) => application.sponsoringChurchId)).toEqual(["company-1", "group-1"]);
    await expect(submitNewClubApplication(input({ sponsoringChurchId: "school-1" }), { now: NOW })).rejects.toMatchObject({ code: "INVALID_CHURCH" });
    db.organizations.get("company-1").isActive = false;
    await expect(submitNewClubApplication(input({ sponsoringChurchId: "company-1" }), { now: NOW })).rejects.toMatchObject({ code: "INVALID_CHURCH" });
  });

  it("takes a church typed as Other", async () => {
    await submitNewClubApplication(input({ sponsoringChurchId: null, sponsoringChurchOther: "  Synthetic   Fellowship " }), { now: NOW });
    expect(db.applications[0]).toMatchObject({ sponsoringChurchId: null, sponsoringChurchOther: "Synthetic Fellowship" });
  });

  it("emails only the configured address, with the club, church and director names and a link", async () => {
    await submitNewClubApplication(input({ note: "Call my cell, 555-0199, secret note" }), { attachment: pdf(), now: NOW });
    expect(db.outbox).toHaveLength(1);
    const message = db.outbox[0];
    expect(message).toMatchObject({ templateKey: "NEW_CLUB_APPLICATION_SUBMITTED", recipientKind: "INTERNAL", recipientEmail: NOTIFY });
    const text = `${message.subjectSnapshot}\n${message.bodyTextSnapshot}`;
    expect(text).toContain("Synthetic Trailblazers");
    expect(text).toContain("Synthetic Church");
    expect(text).toContain("Dana Director");
    expect(text).toContain("https://events.imsda.test/admin/clubs/applications");
    // Nothing sensitive: no phone, address, email, note, signatures, board members or the attachment.
    for (const secret of ["555-0100", "555-0199", "100 Example Road", "dana.director@example.test", "secret note", "Hal Elder", "Cleo Clerk", "Ben Board", "Signed page", ".pdf", "attach"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(mocks.processAccountEmailQueue).toHaveBeenCalledWith({ messageIds: ["msg-1"] });
  });

  it("sends no email when no notification address is set, yet still saves the application", async () => {
    mocks.getPlatformSettings.mockResolvedValue({ newClubApplicationEmail: null });
    await submitNewClubApplication(input(), { now: NOW });
    expect(db.applications).toHaveLength(1);
    expect(db.outbox).toHaveLength(0);
  });

  it("never hard-codes the address: it is whatever the setting says", async () => {
    mocks.getPlatformSettings.mockResolvedValue({ newClubApplicationEmail: "someone.else@imsda-events.test" });
    await submitNewClubApplication(input(), { now: NOW });
    expect(db.outbox[0].recipientEmail).toBe("someone.else@imsda-events.test");
  });

  it("neutralizes template braces in what the notice quotes", () => {
    const content = submittedEmailContent({ applicationId: "a", clubName: "Club {{x}}", churchName: "Church", directorName: "Dir" });
    expect(content.bodyText).not.toContain("{{x}}");
  });

  it("audits ids and flags only, never what the applicant typed", async () => {
    await submitNewClubApplication(input({ note: "private note text" }), { attachment: pdf(), now: NOW });
    const entry = mocks.writeAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({ action: "NEW_CLUB_APPLICATION_SUBMITTED", entityType: "NewClubApplication", metadata: { source: "PUBLIC", hasAttachment: true, sponsoringChurchId: "church-1" } });
    expect(entry.actorUserId).toBeUndefined();
    const flat = JSON.stringify(entry);
    for (const secret of ["Dana", "dana.director", "555-0100", "Example Road", "private note text", "Trailblazers", "Hal Elder"]) expect(flat, secret).not.toContain(secret);
  });
});

describe("the attachment", () => {
  it("is stored privately under a generated name, with the verified type", async () => {
    await submitNewClubApplication(input(), { attachment: pdf(), now: NOW });
    const row = db.applications[0];
    expect(row).toMatchObject({ attachmentName: "Signed page.pdf", attachmentContentType: "application/pdf" });
    expect(row.attachmentStorageKey).toMatch(/^new-club-applications[\\/][0-9a-f-]+\.pdf$/);
    expect(readdirSync(path.join(storageDir, "new-club-applications"))).toHaveLength(1);
  });

  it("accepts images, and refuses other types, wrong content and oversized files", async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], "minutes.png", { type: "image/png" });
    await expect(checkApplicationAttachment(png)).resolves.toMatchObject({ type: "image/png" });
    await expect(checkApplicationAttachment(new File(["<svg/>"], "x.svg", { type: "image/svg+xml" }))).rejects.toMatchObject({ code: "ATTACHMENT_TYPE" });
    await expect(checkApplicationAttachment(new File(["MZ not a pdf"], "x.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ code: "ATTACHMENT_CONTENT" });
    await expect(checkApplicationAttachment(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" }))).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
  });

  it("leaves no file and no application behind when the save fails", async () => {
    await expect(submitNewClubApplication(input({ sponsoringChurchId: "club-nope" }), { attachment: pdf(), now: NOW })).rejects.toBeInstanceOf(NewClubApplicationError);
    expect(db.applications).toHaveLength(0);
    expect(readdirSync(storageDir)).toHaveLength(0);
    db.prisma.$transaction.mockRejectedValueOnce(new Error("database down"));
    await expect(submitNewClubApplication(input(), { attachment: pdf(), now: NOW })).rejects.toThrow("database down");
    expect(readdirSync(path.join(storageDir, "new-club-applications"))).toHaveLength(0);
  });
});

describe("who can see applications and the attachment", () => {
  beforeEach(async () => {
    await submitNewClubApplication(input(), { attachment: pdf(), now: NOW });
  });

  it("is a system administrator or an Area Coordinator, nobody else", async () => {
    await expect(listNewClubApplications(null)).rejects.toMatchObject({ status: 403 });
    await expect(listNewClubApplications(undefined)).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(getApplicationAttachment(null, db.applications[0].id)).rejects.toBeInstanceOf(AccessDeniedError);
    for (const viewer of ["SYSTEM_ADMIN", "AREA_COORDINATOR"] as const) {
      const [record] = await listNewClubApplications(viewer, NOW);
      expect(record).toMatchObject({ clubName: "Synthetic Trailblazers", director: { name: "Dana Director", email: "dana.director@example.test", homePhone: "555-0100" } });
      expect(record!.attachment).toMatchObject({ name: "Signed page.pdf", contentType: "application/pdf" });
      await expect(getApplicationAttachment(viewer, db.applications[0].id)).resolves.toMatchObject({ displayName: "Signed page.pdf", contentType: "application/pdf" });
    }
  });

  it("returns nothing for an application with no attachment", async () => {
    await submitNewClubApplication(input({ clubName: "No Attachment Club" }), { now: NOW });
    await expect(getApplicationAttachment("SYSTEM_ADMIN", db.applications[1].id)).resolves.toBeNull();
  });

  it("never lets an Area Coordinator, an event admin or a signed-out visitor decide", async () => {
    const id = db.applications[0].id;
    await expect(decideNewClubApplication(eventAdmin, id, { decision: "approve" })).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });
    await expect(decideNewClubApplication(null, id, { decision: "decline" })).rejects.toMatchObject({ status: 401 });
    expect(db.applications[0].status).toBe("PENDING");
    expect([...db.organizations.values()].filter((org) => org.type === "CLUB")).toHaveLength(0);
    expect(db.clubInvites).toHaveLength(0);
  });
});

describe("the review flags", () => {
  it("shows the director's Sterling Volunteers status, as a flag and never a block", async () => {
    await submitNewClubApplication(input(), { now: NOW });
    mocks.directorStates.mockResolvedValue(new Map([[directorMatchKey("dana.director@example.test", "Dana Director"), { state: "FLAGGED", ambiguous: false, nameMismatch: false }]]));
    const [record] = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(mocks.directorStates).toHaveBeenCalledWith([{ email: "dana.director@example.test", name: "Dana Director" }], NOW);
    expect(record!.sterling).toBe("FLAGGED");
    // Approval still goes through for a director who isn't clear.
    mocks.directorStates.mockResolvedValue(new Map([[directorMatchKey("dana.director@example.test", "Dana Director"), { state: "NOT_COMPLIANT", ambiguous: false, nameMismatch: false }]]));
    await expect(decideNewClubApplication(systemAdmin, record!.id, { decision: "approve" }, NOW)).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("carries the ambiguous and name-mismatch marks through to the queue", async () => {
    await submitNewClubApplication(input(), { now: NOW });
    mocks.directorStates.mockResolvedValue(new Map([[directorMatchKey("dana.director@example.test", "Dana Director"), { state: "NO_RECORD", ambiguous: true, nameMismatch: true }]]));
    const [record] = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(record).toMatchObject({ sterling: "NO_RECORD", sterlingAmbiguous: true, sterlingNameMismatch: true });
    mocks.directorStates.mockResolvedValue(new Map());
    const [plain] = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(plain).toMatchObject({ sterlingAmbiguous: false, sterlingNameMismatch: false });
  });

  it("says No record for a director matched to nobody", async () => {
    await submitNewClubApplication(input(), { now: NOW });
    const [record] = await listNewClubApplications("AREA_COORDINATOR", NOW);
    expect(record!.sterling).toBe("NO_RECORD");
  });

  it("flags the same name at the same church, a church that has a club, and a twin application", async () => {
    db.organizations.set("club-old", { id: "club-old", type: "CLUB", name: "Synthetic Trailblazers", normalizedName: "synthetic trailblazers", parentOrganizationId: "church-1", isActive: true });
    db.organizations.set("club-other", { id: "club-other", type: "CLUB", name: "Eagles", normalizedName: "eagles", parentOrganizationId: "church-2", isActive: true });
    await submitNewClubApplication(input(), { now: NOW });
    await submitNewClubApplication(input({ directorEmail: "second@example.test" }), { now: NOW });
    await submitNewClubApplication(input({ clubName: "Brand New Club", sponsoringChurchId: "church-2" }), { now: NOW });
    const records = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    const byName = (name: string) => records.filter((record) => record.clubName === name);
    for (const record of byName("Synthetic Trailblazers")) {
      expect(record.duplicates.map((flag) => flag.kind)).toEqual(["SAME_NAME_AND_CHURCH", "PENDING_SAME_NAME"]);
    }
    expect(byName("Brand New Club")[0]!.duplicates.map((flag) => flag.kind)).toEqual(["CHURCH_HAS_CLUB"]);
  });
});

describe("approving", () => {
  beforeEach(async () => {
    await submitNewClubApplication(input(), { now: NOW });
    db.outbox.length = 0;
    mocks.writeAuditLog.mockClear();
    mocks.processAccountEmailQueue.mockClear();
  });

  it("creates the club under its church and the director's club invite, once", async () => {
    const id = db.applications[0].id;
    const result = await decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW);
    expect(result.status).toBe("APPROVED");
    const clubs = [...db.organizations.values()].filter((org) => org.type === "CLUB");
    expect(clubs).toHaveLength(1);
    expect(clubs[0]).toMatchObject({ name: "Synthetic Trailblazers", parentOrganizationId: "church-1", isActive: true, sourceOrgType: "Pathfinder Club", normalizedName: "synthetic trailblazers" });
    expect(result.organizationId).toBe(clubs[0].id);
    expect(db.applications[0]).toMatchObject({ status: "APPROVED", decidedByUserId: "user-admin", createdOrganizationId: clubs[0].id });
    expect(db.clubInvites).toHaveLength(1);
    expect(db.clubInvites[0]).toMatchObject({ organizationId: clubs[0].id, email: "dana.director@example.test", role: "DIRECTOR", source: "APPLICATION", status: "SENT", createdByUserId: "user-admin" });
    expect(db.outbox).toHaveLength(1);
    expect(db.outbox[0]).toMatchObject({ templateKey: "CLUB_INVITE", recipientEmail: "dana.director@example.test" });
    expect(db.outbox[0].bodyTextSnapshot).toContain("approved your application");
    expect(mocks.processAccountEmailQueue).toHaveBeenCalledTimes(1);
  });

  it("approves a club under a company sponsor, and refuses a school chosen at approval (#822)", async () => {
    await submitNewClubApplication(input({ clubName: "Company Club", sponsoringChurchId: "company-1" }), { now: NOW });
    const record = (await listNewClubApplications("SYSTEM_ADMIN", NOW)).find((candidate) => candidate.clubName === "Company Club")!;
    expect(record.church).toMatchObject({ id: "company-1", name: "Synthetic Company Congregation", type: "COMPANY", unavailable: false, needsChoice: false });
    await decideNewClubApplication(systemAdmin, record.id, { decision: "approve" }, NOW);
    expect([...db.organizations.values()].find((org) => org.name === "Company Club")).toMatchObject({ type: "CLUB", parentOrganizationId: "company-1", isActive: true });

    await submitNewClubApplication(input({ clubName: "Typed Club", sponsoringChurchId: null, sponsoringChurchOther: "Somewhere Else" }), { now: NOW });
    const typed = db.applications.find((application) => application.clubName === "Typed Club");
    await expect(decideNewClubApplication(systemAdmin, typed.id, { decision: "approve", sponsoringChurchId: "school-1" }, NOW)).rejects.toMatchObject({ code: "INVALID_CHURCH" });
    await decideNewClubApplication(systemAdmin, typed.id, { decision: "approve", sponsoringChurchId: "group-1" }, NOW);
    expect([...db.organizations.values()].find((org) => org.name === "Typed Club")).toMatchObject({ parentOrganizationId: "group-1" });
  });

  it("makes an Adventurer application an Adventurer club", async () => {
    await submitNewClubApplication(input({ clubName: "Little Lambs", clubType: "ADVENTURER" }), { now: NOW });
    await decideNewClubApplication(systemAdmin, db.applications[1].id, { decision: "approve" }, NOW);
    expect([...db.organizations.values()].find((org) => org.name === "Little Lambs")).toMatchObject({ sourceOrgType: "Adventurer Club" });
  });

  it("refuses a second approval, a decline after it, and creates nothing twice", async () => {
    const id = db.applications[0].id;
    await decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW);
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "decline" }, NOW)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    expect([...db.organizations.values()].filter((org) => org.type === "CLUB")).toHaveLength(1);
    expect(db.clubInvites).toHaveLength(1);
    expect(db.outbox).toHaveLength(1);
  });

  it("lets only one of two simultaneous approvals through", async () => {
    const id = db.applications[0].id;
    const settled = await Promise.allSettled([
      decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW),
      decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW),
    ]);
    expect(settled.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect([...db.organizations.values()].filter((org) => org.type === "CLUB")).toHaveLength(1);
    expect(db.clubInvites).toHaveLength(1);
  });

  it("refuses an application that doesn't exist", async () => {
    await expect(decideNewClubApplication(systemAdmin, "nope", { decision: "approve" }, NOW)).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND" });
  });

  it("needs a directory church when the applicant typed one that isn't in it", async () => {
    await submitNewClubApplication(input({ clubName: "Fellowship Club", sponsoringChurchId: null, sponsoringChurchOther: "Synthetic Fellowship" }), { now: NOW });
    const id = db.applications[1].id;
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW)).rejects.toMatchObject({ code: "CHURCH_REQUIRED" });
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "approve", sponsoringChurchId: "club-nope" }, NOW)).rejects.toMatchObject({ code: "INVALID_CHURCH" });
    expect(db.applications[1].status).toBe("PENDING");
    await decideNewClubApplication(systemAdmin, id, { decision: "approve", sponsoringChurchId: "church-2" }, NOW);
    expect([...db.organizations.values()].find((org) => org.name === "Fellowship Club")).toMatchObject({ parentOrganizationId: "church-2" });
  });

  it("leaves the invite waiting to be sent when account email isn't set up, and still creates the club", async () => {
    mocks.isAccountEmailConfigured.mockReturnValue(false);
    await decideNewClubApplication(systemAdmin, db.applications[0].id, { decision: "approve" }, NOW);
    expect(db.clubInvites).toHaveLength(1);
    expect(db.clubInvites[0].status).toBe("PENDING");
    expect(db.outbox).toHaveLength(0);
    expect([...db.organizations.values()].filter((org) => org.type === "CLUB")).toHaveLength(1);
  });

  it("audits ids only", async () => {
    await decideNewClubApplication(systemAdmin, db.applications[0].id, { decision: "approve" }, NOW);
    const entries = mocks.writeAuditLog.mock.calls.map(([entry]) => entry);
    expect(entries.map((entry) => entry.action)).toEqual(["ORGANIZATION_CREATED", "NEW_CLUB_APPLICATION_APPROVED"]);
    for (const entry of entries) expect(entry.actorUserId).toBe("user-admin");
    expect(entries[1].metadata).toMatchObject({ applicationId: db.applications[0].id, sponsoringChurchId: "church-1" });
    const flat = JSON.stringify(entries);
    for (const secret of ["Dana", "dana.director", "555-0100", "Example Road", "Trailblazers", "We meet"]) expect(flat, secret).not.toContain(secret);
  });
});

describe("the church at approval", () => {
  beforeEach(async () => {
    await submitNewClubApplication(input(), { now: NOW });
  });

  it("is checked again: an inactive church needs another one picked", async () => {
    const id = db.applications[0].id;
    db.organizations.get("church-1").isActive = false;
    const [record] = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(record!.church).toMatchObject({ unavailable: true, needsChoice: true, name: "Synthetic Church" });
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW)).rejects.toMatchObject({ code: "CHURCH_REQUIRED" });
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "approve", sponsoringChurchId: "church-1" }, NOW)).rejects.toMatchObject({ code: "INVALID_CHURCH" });
    expect(db.applications[0].status).toBe("PENDING");
    await decideNewClubApplication(systemAdmin, id, { decision: "approve", sponsoringChurchId: "church-2" }, NOW);
    expect([...db.organizations.values()].find((org) => org.name === "Synthetic Trailblazers")).toMatchObject({ parentOrganizationId: "church-2" });
  });

  it("treats a church that is gone (the link cleared, nothing typed) as unavailable, not as an empty name", async () => {
    db.applications[0].sponsoringChurchId = null;
    const [record] = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(record!.church).toMatchObject({ id: null, name: "", isOther: false, unavailable: true, needsChoice: true });
    await expect(decideNewClubApplication(systemAdmin, db.applications[0].id, { decision: "approve" }, NOW)).rejects.toMatchObject({ code: "CHURCH_REQUIRED" });
  });

  it("still approves with no choice when the church is fine", async () => {
    const [record] = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(record!.church).toMatchObject({ unavailable: false, needsChoice: false });
    await expect(decideNewClubApplication(systemAdmin, db.applications[0].id, { decision: "approve" }, NOW)).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("neutralizes template braces a stranger typed into the club and director names in the invite email", async () => {
    await submitNewClubApplication(input({ clubName: "Club {{account_action_link}}", directorName: "Dana {{account_action_link}} Director" }), { now: NOW });
    db.outbox.length = 0;
    await decideNewClubApplication(systemAdmin, db.applications[1].id, { decision: "approve" }, NOW);
    const message = db.outbox.find((entry) => entry.templateKey === "CLUB_INVITE");
    expect(message).toBeDefined();
    const text = `${message!.subjectSnapshot}\n${message!.bodyTextSnapshot}`;
    expect(text).not.toContain("{{");
    expect(text).toContain("account_action_link");
  });
});

describe("a private link's invited address", () => {
  it("is kept on the application, and flagged when the director's email differs", async () => {
    await createNewClubInvite(systemAdmin, { email: "invited@example.test", name: "Ivy" }, NOW);
    const message = db.outbox.find((entry) => entry.templateKey === "NEW_CLUB_APPLICATION_INVITE");
    const prepared = await prepareNewClubInviteBodyForDelivery({ messageId: db.invites[0].messageId, bodyText: message.bodyTextSnapshot, now: NOW });
    const token = /\/clubs\/register\/([A-Za-z0-9_-]+)/.exec(prepared.bodyText)![1]!;
    await submitNewClubApplication(input({ directorEmail: "someone.else@example.test" }), { inviteToken: token, now: NOW });
    expect(db.applications[0].invitedEmail).toBe("invited@example.test");
    const [record] = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(record).toMatchObject({ source: "INVITE", invitedEmail: "invited@example.test", invitedEmailDiffers: true });
    // Never a hard rejection: the application was saved and can be decided.
    expect(db.applications).toHaveLength(1);
  });

  it("isn't flagged when the addresses agree, and is empty for a public application", async () => {
    await createNewClubInvite(systemAdmin, { email: "dana.director@example.test" }, NOW);
    const message = db.outbox.find((entry) => entry.templateKey === "NEW_CLUB_APPLICATION_INVITE");
    const prepared = await prepareNewClubInviteBodyForDelivery({ messageId: db.invites[0].messageId, bodyText: message.bodyTextSnapshot, now: NOW });
    const token = /\/clubs\/register\/([A-Za-z0-9_-]+)/.exec(prepared.bodyText)![1]!;
    await submitNewClubApplication(input(), { inviteToken: token, now: NOW });
    await submitNewClubApplication(input({ clubName: "Public Club" }), { now: NOW });
    const records = await listNewClubApplications("SYSTEM_ADMIN", NOW);
    expect(records.find((record) => record.source === "INVITE")).toMatchObject({ invitedEmailDiffers: false });
    expect(records.find((record) => record.source === "PUBLIC")).toMatchObject({ invitedEmail: null, invitedEmailDiffers: false });
  });
});

describe("declining", () => {
  beforeEach(async () => {
    await submitNewClubApplication(input(), { now: NOW });
    db.outbox.length = 0;
    mocks.writeAuditLog.mockClear();
    mocks.processAccountEmailQueue.mockClear();
  });

  it("emails the applicant the reason and creates nothing", async () => {
    const result = await decideNewClubApplication(systemAdmin, db.applications[0].id, { decision: "decline", declineReason: "  The church already sponsors a club.  " }, NOW);
    expect(result).toEqual({ status: "DECLINED", organizationId: null });
    expect(db.applications[0]).toMatchObject({ status: "DECLINED", declineReason: "The church already sponsors a club.", decidedByUserId: "user-admin" });
    expect([...db.organizations.values()].filter((org) => org.type === "CLUB")).toHaveLength(0);
    expect(db.clubInvites).toHaveLength(0);
    expect(db.outbox).toHaveLength(1);
    expect(db.outbox[0]).toMatchObject({ templateKey: "NEW_CLUB_APPLICATION_DECLINED", recipientEmail: "dana.director@example.test" });
    expect(db.outbox[0].bodyTextSnapshot).toContain("The church already sponsors a club.");
  });

  it("declines without a reason, and says nothing about one", async () => {
    await decideNewClubApplication(systemAdmin, db.applications[0].id, { decision: "decline" }, NOW);
    expect(db.outbox[0].bodyTextSnapshot).not.toContain("Reason:");
    expect(db.applications[0].declineReason).toBeNull();
  });

  it("audits ids and whether a reason was given, never the reason", async () => {
    await decideNewClubApplication(systemAdmin, db.applications[0].id, { decision: "decline", declineReason: "A private reason" }, NOW);
    const entry = mocks.writeAuditLog.mock.calls[0]![0];
    expect(entry).toMatchObject({ action: "NEW_CLUB_APPLICATION_DECLINED", actorUserId: "user-admin", metadata: { applicationId: db.applications[0].id, hasReason: true } });
    expect(JSON.stringify(entry)).not.toContain("A private reason");
  });

  it("refuses a second decision", async () => {
    const id = db.applications[0].id;
    await decideNewClubApplication(systemAdmin, id, { decision: "decline" }, NOW);
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "approve" }, NOW)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    await expect(decideNewClubApplication(systemAdmin, id, { decision: "decline" }, NOW)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    expect(db.outbox).toHaveLength(1);
  });
});

describe("the private invite link", () => {
  async function sendInvite() {
    await createNewClubInvite(systemAdmin, { email: "New.Director@Example.test", name: "Nia Newdirector" }, NOW);
    return db.invites[0];
  }

  /** What delivery does: mints the token and puts its link in the body. Returns the raw token. */
  async function deliver() {
    const invite = db.invites[0];
    const message = db.outbox.find((entry) => entry.templateKey === "NEW_CLUB_APPLICATION_INVITE");
    const prepared = await prepareNewClubInviteBodyForDelivery({ messageId: invite.messageId, bodyText: message.bodyTextSnapshot, now: NOW });
    const token = /\/clubs\/register\/([A-Za-z0-9_-]+)/.exec(prepared.bodyText)![1]!;
    return { token, body: prepared.bodyText };
  }

  it("is for system administrators only", async () => {
    await expect(createNewClubInvite(eventAdmin, { email: "a@example.test" }, NOW)).rejects.toMatchObject({ status: 403 });
    await expect(createNewClubInvite(null, { email: "a@example.test" }, NOW)).rejects.toMatchObject({ status: 401 });
    await expect(cancelNewClubInvite(eventAdmin, "x", NOW)).rejects.toMatchObject({ status: 403 });
    expect(db.invites).toHaveLength(0);
  });

  it("queues an email whose body holds a sentinel and no token, and the link appears only at delivery", async () => {
    const invite = await sendInvite();
    expect(invite).toMatchObject({ email: "new.director@example.test", name: "Nia Newdirector", tokenHash: null });
    const message = db.outbox[0];
    expect(message.bodyTextSnapshot).toContain(NEW_CLUB_APPLICATION_LINK_SENTINEL);
    expect(message.bodyTextSnapshot).not.toContain("/clubs/register/");
    const { token, body } = await deliver();
    expect(body).toContain(`https://events.imsda.test/clubs/register/${token}`);
    expect(db.invites[0].tokenHash).toBe(hashOpaqueToken(token));
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls)).not.toContain(token);
  });

  it("opens the same form prefilled with the invited email, and is used up by submitting", async () => {
    await sendInvite();
    const { token } = await deliver();
    await expect(resolveNewClubInvite(token, NOW)).resolves.toEqual({ email: "new.director@example.test", name: "Nia Newdirector" });
    await submitNewClubApplication(input({ directorEmail: "new.director@example.test" }), { inviteToken: token, now: NOW });
    expect(db.applications[0]).toMatchObject({ source: "INVITE", inviteId: db.invites[0].id });
    expect(db.invites[0].usedAt).toEqual(NOW);
    await expect(resolveNewClubInvite(token, NOW)).resolves.toBeNull();
    await expect(submitNewClubApplication(input(), { inviteToken: token, now: NOW })).rejects.toMatchObject({ code: "INVITE_UNAVAILABLE" });
    expect(db.applications).toHaveLength(1);
  });

  it("answers the same for an unknown, withdrawn or expired link", async () => {
    await sendInvite();
    const { token } = await deliver();
    await expect(resolveNewClubInvite("not-a-real-token", NOW)).resolves.toBeNull();
    await expect(submitNewClubApplication(input(), { inviteToken: "not-a-real-token", now: NOW })).rejects.toMatchObject({ code: "INVITE_UNAVAILABLE" });
    const later = new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000);
    await expect(resolveNewClubInvite(token, later)).resolves.toBeNull();
    await cancelNewClubInvite(systemAdmin, db.invites[0].id, NOW);
    await expect(resolveNewClubInvite(token, NOW)).resolves.toBeNull();
    await expect(cancelNewClubInvite(systemAdmin, db.invites[0].id, NOW)).rejects.toMatchObject({ code: "INVITE_NOT_FOUND" });
  });

  it("won't mint a link for a message whose invite was used or withdrawn", async () => {
    await sendInvite();
    const message = db.outbox[0];
    db.invites[0].cancelledAt = NOW;
    await expect(prepareNewClubInviteBodyForDelivery({ messageId: db.invites[0].messageId, bodyText: message.bodyTextSnapshot, now: NOW })).rejects.toThrow();
  });

  it("can't be sent when account email isn't set up", async () => {
    mocks.isAccountEmailConfigured.mockReturnValue(false);
    await expect(createNewClubInvite(systemAdmin, { email: "a@example.test" }, NOW)).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
    expect(db.invites).toHaveLength(0);
  });
});
