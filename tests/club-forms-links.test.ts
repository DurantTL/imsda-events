import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  templateFindFirst: vi.fn(),
  linkCreate: vi.fn(),
  linkUpdate: vi.fn(),
  linkUpdateMany: vi.fn(),
  linkFindUnique: vi.fn(),
  linkFindFirst: vi.fn(),
  linkFindMany: vi.fn(),
  submissionCreate: vi.fn(),
  outboxCreate: vi.fn(),
  organizationFindUnique: vi.fn(),
  organizationFindMany: vi.fn(),
  rosterFindFirst: vi.fn(),
  configured: vi.fn(),
}));

const client = {
  clubFormTemplate: { findFirst: mocks.templateFindFirst },
  clubFormLink: {
    create: mocks.linkCreate,
    update: mocks.linkUpdate,
    updateMany: mocks.linkUpdateMany,
    findUnique: mocks.linkFindUnique,
    findFirst: mocks.linkFindFirst,
    findMany: mocks.linkFindMany,
  },
  clubFormSubmission: { create: mocks.submissionCreate },
  messageOutbox: { create: mocks.outboxCreate },
  organization: { findUnique: mocks.organizationFindUnique, findMany: mocks.organizationFindMany },
  clubRosterMember: { findFirst: mocks.rosterFindFirst },
  $transaction: (work: (tx: unknown) => unknown) => work(client),
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-club-form-tests", APP_BASE_URL: "https://events.imsda.test" }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/communications/account-email", () => ({
  isAccountEmailConfigured: mocks.configured,
  getAccountEmailSender: () => ({ name: "IMSDA Events", address: "events@example.test", replyTo: null }),
}));

import { hashOpaqueToken } from "@/modules/access/tokens";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import type { ClubFormsViewer } from "@/modules/club-forms/domain";
import { CLUB_FORM_LINK_SENTINEL, prepareClubFormLinkBodyForDelivery } from "@/modules/club-forms/link-email";
import {
  createClubFormLink,
  listClubFormLinks,
  resolveClubFormLinkForFill,
  revokeClubFormLink,
  submitClubFormViaLink,
} from "@/modules/club-forms/links";
import { openSensitiveAnswers } from "@/modules/club-forms/sealed-answers";

const now = new Date("2026-10-05T15:00:00Z");
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const otherDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-b", actor: { kind: "ATTENDEE", accountId: "acct-9" } };
const areaCoordinator: ClubFormsViewer = { kind: "AREA_COORDINATOR", actor: { kind: "ATTENDEE", accountId: "acct-2" } };
const staff: ClubFormsViewer = { kind: "STAFF", userId: "staff-1", canViewSensitive: true };

const TOKEN = "T".repeat(43);
const SECRET_HEALTH = "Synthetic health detail";

function templateRow(key: string) {
  const seed = clubFormTemplateSeeds.find((template) => template.key === key);
  if (!seed) throw new Error("missing seed");
  return {
    id: `template-${key}`,
    key,
    name: seed.name,
    description: seed.description,
    version: seed.version,
    definition: seed.definition,
    sectionNotes: seed.sectionNotes,
    sensitiveFieldKeys: seed.sensitiveFieldKeys,
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
  emergency_contact_phone: "555-0111",
  physician_name: SECRET_HEALTH,
};

function openLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    status: "OPEN",
    expiresAt: new Date("2026-10-19T15:00:00Z"),
    tokenHash: hashOpaqueToken(TOKEN),
    organizationId: "club-a",
    rosterMemberId: "member-1",
    subjectName: "Riley Sample",
    clubYear: "2026-27",
    organization: { name: "Example Pathfinders", isActive: true, type: "CLUB" },
    template: templateRow("off_premises_permission_slip"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.configured.mockReturnValue(true);
  mocks.organizationFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Example Pathfinders" });
  mocks.organizationFindMany.mockResolvedValue([]);
  mocks.templateFindFirst.mockResolvedValue(templateRow("off_premises_permission_slip"));
  mocks.linkCreate.mockResolvedValue({ id: "link-1" });
  mocks.linkUpdate.mockResolvedValue({});
  mocks.linkUpdateMany.mockResolvedValue({ count: 1 });
  mocks.outboxCreate.mockResolvedValue({ id: "message-1" });
  mocks.submissionCreate.mockResolvedValue({});
  mocks.rosterFindFirst.mockResolvedValue({ id: "member-1", person: { firstName: "Riley", lastName: "Sample" } });
  mocks.linkFindUnique.mockResolvedValue(openLink());
});

describe("sending a private link (#610)", () => {
  const input = { organizationId: "club-a", templateKey: "off_premises_permission_slip", recipientEmail: "Parent@Example.test" };

  it("queues one transactional email with a sentinel and no token, tied to the club and form", async () => {
    const result = await createClubFormLink(director, input, now);
    expect(result).toMatchObject({ linkId: "link-1", messageId: "message-1" });
    expect(result.expiresAt).toEqual(new Date("2026-10-19T15:00:00Z"));

    const link = mocks.linkCreate.mock.calls[0][0].data;
    expect(link).toMatchObject({
      templateId: "template-off_premises_permission_slip",
      organizationId: "club-a",
      clubYear: "2026-27",
      recipientEmail: "parent@example.test",
      createdByAccountId: "acct-1",
    });
    expect(link).not.toHaveProperty("tokenHash");

    const message = mocks.outboxCreate.mock.calls[0][0].data;
    expect(message).toMatchObject({ templateKey: "CLUB_FORM_LINK", recipientEmail: "parent@example.test", eventId: null, status: "PENDING" });
    expect(message.bodyTextSnapshot).toContain(CLUB_FORM_LINK_SENTINEL);
    expect(message.bodyTextSnapshot).toContain("works once");
    expect(message.bodyTextSnapshot).toContain("expires in 14 days");
    expect(message.bodyTextSnapshot).not.toMatch(/club-forms\//);
    expect(mocks.linkUpdate).toHaveBeenCalledWith({ where: { id: "link-1" }, data: { messageId: "message-1" } });
  });

  it("puts no address and no token in the audit row", async () => {
    await createClubFormLink(director, input, now);
    const entry = mocks.writeAuditLog.mock.calls[0][0];
    expect(entry).toMatchObject({ action: "CLUB_FORM_LINK_CREATED", entityType: "ClubFormLink", entityId: "link-1" });
    expect(JSON.stringify(entry)).not.toContain("example.test");
  });

  it("honors a chosen lifetime within 1 to 30 days", async () => {
    const result = await createClubFormLink(director, { ...input, expiresInDays: 3 }, now);
    expect(result.expiresAt).toEqual(new Date("2026-10-08T15:00:00Z"));
    const capped = await createClubFormLink(director, { ...input, expiresInDays: 400 }, now);
    expect(capped.expiresAt).toEqual(new Date("2026-11-04T15:00:00Z"));
  });

  it("is refused for anyone but this club's director or deputy", async () => {
    for (const viewer of [otherDirector, areaCoordinator, staff]) {
      await expect(createClubFormLink(viewer, input, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(mocks.linkCreate).not.toHaveBeenCalled();
    expect(mocks.outboxCreate).not.toHaveBeenCalled();
  });

  it("needs a form that is on, a roster member of this club, and working email", async () => {
    mocks.templateFindFirst.mockResolvedValue(null);
    await expect(createClubFormLink(director, input, now)).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    mocks.templateFindFirst.mockResolvedValue(templateRow("off_premises_permission_slip"));
    mocks.rosterFindFirst.mockResolvedValue(null);
    await expect(createClubFormLink(director, { ...input, rosterMemberId: "member-of-club-b" }, now)).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });
    mocks.configured.mockReturnValue(false);
    await expect(createClubFormLink(director, input, now)).rejects.toMatchObject({ code: "EMAIL_NOT_CONFIGURED" });
    expect(mocks.linkCreate).not.toHaveBeenCalled();
  });
});

describe("delivering the link (#610)", () => {
  const body = `Open it:\n\n${CLUB_FORM_LINK_SENTINEL}\n`;

  it("mints the token at delivery, stores only its hash, and swaps the sentinel for the URL", async () => {
    mocks.linkFindUnique.mockResolvedValue({ id: "link-1", status: "OPEN", expiresAt: new Date("2026-10-19T15:00:00Z") });
    const prepared = await prepareClubFormLinkBodyForDelivery({ messageId: "message-1", bodyText: body, now });
    const url = /https:\/\/events\.imsda\.test\/club-forms\/([A-Za-z0-9_-]+)/.exec(prepared.bodyText);
    expect(url).not.toBeNull();
    expect(prepared.bodyText).not.toContain(CLUB_FORM_LINK_SENTINEL);
    const token = url![1];
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect(mocks.linkUpdateMany).toHaveBeenCalledWith({
      where: { id: "link-1", status: "OPEN", expiresAt: { gt: now } },
      data: { tokenHash: hashOpaqueToken(token) },
    });
    expect(JSON.stringify(mocks.linkUpdateMany.mock.calls)).not.toContain(token);
  });

  it("gives a retry a fresh token, so an earlier undelivered one is dead", async () => {
    mocks.linkFindUnique.mockResolvedValue({ id: "link-1", status: "OPEN", expiresAt: new Date("2026-10-19T15:00:00Z") });
    const first = await prepareClubFormLinkBodyForDelivery({ messageId: "message-1", bodyText: body, now });
    const second = await prepareClubFormLinkBodyForDelivery({ messageId: "message-1", bodyText: body, now });
    expect(first.bodyText).not.toBe(second.bodyText);
  });

  it("retires the link after a definitive delivery failure", async () => {
    mocks.linkFindUnique.mockResolvedValue({ id: "link-1", status: "OPEN", expiresAt: new Date("2026-10-19T15:00:00Z") });
    const prepared = await prepareClubFormLinkBodyForDelivery({ messageId: "message-1", bodyText: body, now });
    mocks.linkUpdateMany.mockClear();
    await prepared.revokeOnDefinitiveFailure?.();
    expect(mocks.linkUpdateMany).toHaveBeenCalledWith({
      where: { id: "link-1", status: "OPEN" },
      data: { status: "REVOKED", revokedAt: now, tokenHash: null },
    });
  });

  it("refuses to deliver a link that was withdrawn, used or has expired", async () => {
    for (const link of [
      { id: "link-1", status: "REVOKED", expiresAt: new Date("2026-10-19T15:00:00Z") },
      { id: "link-1", status: "USED", expiresAt: new Date("2026-10-19T15:00:00Z") },
      { id: "link-1", status: "OPEN", expiresAt: new Date("2026-10-01T00:00:00Z") },
      null,
    ]) {
      mocks.linkFindUnique.mockResolvedValue(link);
      await expect(prepareClubFormLinkBodyForDelivery({ messageId: "message-1", bodyText: body, now })).rejects.toThrowError(/can't be delivered/);
    }
  });

  it("leaves a body with no sentinel alone", async () => {
    expect(await prepareClubFormLinkBodyForDelivery({ messageId: "message-1", bodyText: "Hello", now })).toEqual({ bodyText: "Hello" });
  });
});

describe("opening a private link (#610)", () => {
  it("finds the link by the hash of the token, never the token", async () => {
    await resolveClubFormLinkForFill(TOKEN, now);
    expect(mocks.linkFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: hashOpaqueToken(TOKEN) } }));
    expect(JSON.stringify(mocks.linkFindUnique.mock.calls)).not.toContain(TOKEN);
  });

  it("shows the club's name and the form and nothing else about the club", async () => {
    const view = await resolveClubFormLinkForFill(TOKEN, now);
    expect(view.clubName).toBe("Example Pathfinders");
    expect(view.form.name).toBe("Off-Premises Permission Slip");
    const serialized = JSON.stringify(view);
    for (const leaked of ["Riley", "member-1", "club-a", "link-1", "subjectName", "recipientEmail", "acct-1"]) {
      expect(serialized, leaked).not.toContain(leaked);
    }
  });

  it("hides the office-use fields of the staff form from the person with the link", async () => {
    mocks.linkFindUnique.mockResolvedValue(openLink({ template: templateRow("pathfinder_staff_service_information") }));
    const view = await resolveClubFormLinkForFill(TOKEN, now);
    const keys = view.form.definition.sections.flatMap((section) => section.fields.map((field) => field.key));
    expect(keys).not.toContain("office_signature");
    expect(keys).toContain("full_name");
    expect(Object.keys(view.form.sectionNotes)).not.toContain("sec_office");
  });

  it("answers the same for every unusable link", async () => {
    const cases = [
      null,
      openLink({ status: "USED" }),
      openLink({ status: "REVOKED" }),
      openLink({ expiresAt: new Date("2026-10-05T15:00:00Z") }),
      openLink({ expiresAt: new Date("2026-10-01T00:00:00Z") }),
      openLink({ template: { ...templateRow("off_premises_permission_slip"), enabled: false } }),
      openLink({ organization: { name: "Example Pathfinders", isActive: false, type: "CLUB" } }),
    ];
    const messages = new Set<string>();
    for (const found of cases) {
      mocks.linkFindUnique.mockResolvedValue(found);
      const error = await resolveClubFormLinkForFill(TOKEN, now).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "LINK_UNAVAILABLE" });
      messages.add((error as Error).message);
    }
    expect(messages.size).toBe(1);
  });

  it("does not even look up a token of the wrong shape", async () => {
    for (const token of ["", "short", "has spaces in it and is long enough to pass", `${"a".repeat(200)}`]) {
      await expect(resolveClubFormLinkForFill(token, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    }
    expect(mocks.linkFindUnique).not.toHaveBeenCalled();
  });
});

describe("submitting through a private link (#610)", () => {
  it("spends the link and stores the submission in that link's club, sealing sensitive answers", async () => {
    const result = await submitClubFormViaLink(TOKEN, slipAnswers, now);
    expect(result.confirmationMessage).toContain("permission slip");

    expect(mocks.linkUpdateMany).toHaveBeenCalledWith({
      where: { id: "link-1", tokenHash: hashOpaqueToken(TOKEN), status: "OPEN", expiresAt: { gt: now } },
      data: { status: "USED", usedAt: now },
    });
    const data = mocks.submissionCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      organizationId: "club-a",
      templateId: "template-off_premises_permission_slip",
      rosterMemberId: "member-1",
      subjectName: "Riley Sample",
      status: "SUBMITTED",
      enteredVia: "LINK",
      linkId: "link-1",
      hasSensitiveAnswers: true,
    });
    // Nobody signed in: no account or staff user is credited.
    expect(data).not.toHaveProperty("enteredByAccountId");
    expect(data).not.toHaveProperty("enteredByUserId");
    expect(data.answers).not.toHaveProperty("physician_name");
    expect(openSensitiveAnswers(result.submissionId, data.sealedSensitiveAnswers)).toMatchObject({ physician_name: SECRET_HEALTH });
    expect(JSON.stringify([mocks.submissionCreate.mock.calls, mocks.writeAuditLog.mock.calls])).not.toContain(SECRET_HEALTH);
  });

  it("cannot write into another club, whatever the request says", async () => {
    await submitClubFormViaLink(TOKEN, { ...slipAnswers, organizationId: "club-b", clubYear: "1999-00", linkId: "other" }, now);
    const data = mocks.submissionCreate.mock.calls[0][0].data;
    expect(data.organizationId).toBe("club-a");
    expect(data.clubYear).toBe("2026-27");
    expect(data.linkId).toBe("link-1");
    expect(data.answers).not.toHaveProperty("organizationId");
  });

  it("rolls back and reports the link dead when another request spent it first", async () => {
    mocks.linkUpdateMany.mockResolvedValue({ count: 0 });
    await expect(submitClubFormViaLink(TOKEN, slipAnswers, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
  });

  it("does not spend the link on an incomplete form", async () => {
    const { emergency_contact_phone: _phone, ...missing } = slipAnswers;
    void _phone;
    await expect(submitClubFormViaLink(TOKEN, missing, now)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.linkUpdateMany).not.toHaveBeenCalled();
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
  });

  it("refuses an expired, used, withdrawn or wrong link before touching anything", async () => {
    for (const found of [null, openLink({ status: "USED" }), openLink({ status: "REVOKED" }), openLink({ expiresAt: new Date("2026-10-04T00:00:00Z") })]) {
      mocks.linkFindUnique.mockResolvedValue(found);
      await expect(submitClubFormViaLink(TOKEN, slipAnswers, now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
    }
    expect(mocks.submissionCreate).not.toHaveBeenCalled();
  });

  it("ignores office-use answers sent by hand", async () => {
    mocks.linkFindUnique.mockResolvedValue(openLink({ template: templateRow("pathfinder_staff_service_information") }));
    mocks.organizationFindMany.mockResolvedValue([{ name: "Example Church", normalizedName: "example church" }]);
    const answers = {
      full_name: "Alex Volunteer", birth_date: "1985-06-15", street: "2 Example Road", city: "Exampleville", state: "MO", zip: "64000",
      email: "alex@example.test", church: "Example Church", club: "Example Church", health_limitation: "No", conduct_accused: "No",
      reference_1_name: "A", reference_1_address: "B", reference_1_phone: "C",
      reference_2_name: "A", reference_2_address: "B", reference_2_phone: "C",
      reference_3_name: "A", reference_3_address: "B", reference_3_phone: "C",
      signature: "Alex Volunteer", signature_date: "2026-10-02", signature_acknowledgment: true,
      office_signature: "Forged office signature", office_recommendation: "Recommended",
    };
    await submitClubFormViaLink(TOKEN, answers, now);
    const stored = JSON.stringify(mocks.submissionCreate.mock.calls[0][0].data.answers);
    expect(stored).not.toContain("Forged office signature");
    expect(stored).not.toContain("office_recommendation");
  });
});

describe("a club's own links (#610)", () => {
  it("lists only the club's links, with state and no token", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { id: "l1", recipientEmail: "a@example.test", subjectName: "", status: "OPEN", expiresAt: new Date("2026-10-19T00:00:00Z"), usedAt: null, createdAt: now, template: { key: "k", name: "Form" }, submission: null },
      { id: "l2", recipientEmail: "b@example.test", subjectName: "", status: "OPEN", expiresAt: new Date("2026-10-01T00:00:00Z"), usedAt: null, createdAt: now, template: { key: "k", name: "Form" }, submission: null },
      { id: "l3", recipientEmail: "c@example.test", subjectName: "", status: "USED", expiresAt: new Date("2026-10-19T00:00:00Z"), usedAt: now, createdAt: now, template: { key: "k", name: "Form" }, submission: { id: "s1" } },
    ]);
    const rows = await listClubFormLinks(director, "club-a", now);
    expect(rows.map((row) => row.state)).toEqual(["OPEN", "EXPIRED", "USED"]);
    expect(rows[2].submissionId).toBe("s1");
    expect(mocks.linkFindMany.mock.calls[0][0].where).toMatchObject({ organizationId: "club-a" });
    expect(JSON.stringify(rows)).not.toContain("tokenHash");
    await expect(listClubFormLinks(otherDirector, "club-a", now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("withdraws an open link of its own club and audits it", async () => {
    mocks.linkFindFirst.mockResolvedValue({ id: "link-1", status: "OPEN", template: { key: "off_premises_permission_slip" } });
    await revokeClubFormLink(director, "club-a", "link-1", now);
    expect(mocks.linkFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "link-1", organizationId: "club-a" } }));
    expect(mocks.linkUpdateMany).toHaveBeenCalledWith({ where: { id: "link-1", status: "OPEN" }, data: { status: "REVOKED", revokedAt: now } });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "CLUB_FORM_LINK_REVOKED" }), client);
  });

  it("treats another club's link as not found, and a spent link as unavailable", async () => {
    mocks.linkFindFirst.mockResolvedValue(null);
    await expect(revokeClubFormLink(director, "club-a", "link-of-club-b", now)).rejects.toMatchObject({ code: "LINK_NOT_FOUND" });
    await expect(revokeClubFormLink(otherDirector, "club-a", "link-1", now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    mocks.linkFindFirst.mockResolvedValue({ id: "link-1", status: "USED", template: { key: "k" } });
    mocks.linkUpdateMany.mockResolvedValue({ count: 0 });
    await expect(revokeClubFormLink(director, "club-a", "link-1", now)).rejects.toMatchObject({ code: "LINK_UNAVAILABLE" });
  });
});
