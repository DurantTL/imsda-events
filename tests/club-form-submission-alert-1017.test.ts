import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #1017: a club form submission emails the addresses listed on that form. Both creation paths (a private link, and a
 * director or deputy in the club portal), one email per address, never twice for one submission, nothing when the list
 * is empty or the switch is off, and never an answer in the body. Synthetic data only.
 */

const mocks = vi.hoisted(() => ({
  writeAuditLog: vi.fn(),
  templateFindFirst: vi.fn(),
  templateFindUnique: vi.fn(),
  templateUpdate: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  linkUpdateMany: vi.fn(),
  linkFindUnique: vi.fn(),
  submissionCreate: vi.fn(),
  outboxCreate: vi.fn(),
  outboxFindMany: vi.fn(),
  organizationFindUnique: vi.fn(),
  rosterFindFirst: vi.fn(),
  accountFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  switchRead: vi.fn(),
  configured: vi.fn(),
  deliver: vi.fn(),
  logError: vi.fn(),
  senderFails: false,
  events: [] as string[],
}));

const client = {
  clubFormTemplate: { findFirst: mocks.templateFindFirst, findUnique: mocks.templateFindUnique, update: mocks.templateUpdate },
  clubFormTemplateVersion: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  $queryRaw: mocks.queryRaw,
  $executeRaw: mocks.executeRaw,
  clubFormLink: { updateMany: mocks.linkUpdateMany, findUnique: mocks.linkFindUnique },
  clubFormSubmission: { create: mocks.submissionCreate },
  adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
  messageOutbox: { create: mocks.outboxCreate, findMany: mocks.outboxFindMany },
  organization: { findUnique: mocks.organizationFindUnique, findMany: vi.fn(async () => []) },
  clubRosterMember: { findFirst: mocks.rosterFindFirst },
  attendeeAccount: { findUnique: mocks.accountFindUnique },
  user: { findUnique: mocks.userFindUnique },
  $transaction: (work: (tx: unknown) => unknown) => {
    mocks.events.push("transaction");
    return work(client);
  },
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => client }));
vi.mock("@/lib/env", () => ({
  getServerEnv: () => ({ SECRET_ENCRYPTION_KEY: "a-synthetic-encryption-key-for-club-form-tests", APP_BASE_URL: "https://events.imsda.test" }),
}));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/communications/account-email", () => ({
  AccountEmailNotConfiguredError: class extends Error {},
  isAccountEmailConfigured: mocks.configured,
  getAccountEmailSender: () => {
    if (mocks.senderFails) throw new Error("sender settings broken");
    return { name: "IMSDA Events", address: "events@example.test", replyTo: null };
  },
}));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError, logInfo: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/modules/communications/email-delivery", () => ({ processAccountEmailQueue: mocks.deliver }));
vi.mock("@/modules/notifications/settings", () => ({
  isNotificationEnabled: async (key: string) => {
    mocks.events.push(`switch:${key}`);
    return mocks.switchRead(key);
  },
}));

import { hashOpaqueToken } from "@/modules/access/tokens";
import { parseAlertRecipients } from "@/modules/club-forms/alert-recipients";
import { clubFormTemplateSeeds } from "@/modules/club-forms/definitions";
import type { ClubFormsViewer } from "@/modules/club-forms/domain";
import { submitClubFormViaLink } from "@/modules/club-forms/links";
import { clubFormSubmittedContent } from "@/modules/club-forms/submission-alert";
import { saveClubFormSubmission } from "@/modules/club-forms/submissions";
import { setClubFormAlertRecipients } from "@/modules/club-forms/templates";

const now = new Date("2026-10-05T15:00:00Z");
const TOKEN = "T".repeat(43);
const director: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "ATTENDEE", accountId: "acct-1" } };
const actingDirector: ClubFormsViewer = { kind: "CLUB_LEADER", organizationId: "club-a", actor: { kind: "STAFF_ACTING", userId: "admin-1", actAsId: "act-1" } };

const SECRET_HEALTH = "Synthetic health detail";
const SECRET_PHONE = "515-555-0111";
const ADDRESSES = ["office@imsda-events.test", "youth@imsda-events.test"];

const seed = clubFormTemplateSeeds.find((template) => template.key === "off_premises_permission_slip");
if (!seed) throw new Error("missing seed");

function templateRow(notify: string[] = ADDRESSES) {
  return {
    id: "template-slip",
    key: seed!.key,
    name: seed!.name,
    description: seed!.description,
    version: seed!.version,
    definition: seed!.definition,
    sectionNotes: seed!.sectionNotes,
    sensitiveFieldKeys: seed!.sensitiveFieldKeys,
    birthDateFieldKeys: seed!.birthDateFieldKeys,
    staffOnlyFieldKeys: seed!.staffOnlyFieldKeys,
    printLayout: seed!.printLayout,
    enabled: true,
    submissionNotifyEmails: notify,
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
  emergency_contact_phone: SECRET_PHONE,
  physician_name: SECRET_HEALTH,
};

function openLink() {
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
    template: templateRow(),
  };
}

/** The outbox as a table with a unique idempotency key, so a duplicate would be a visible failure. */
let outbox: Array<Record<string, unknown>> = [];

function useTemplate(notify: string[]) {
  mocks.templateFindFirst.mockResolvedValue(templateRow(notify));
  mocks.templateFindUnique.mockResolvedValue(templateRow(notify));
  mocks.linkFindUnique.mockResolvedValue({ ...openLink(), template: templateRow(notify) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.events.length = 0;
  outbox = [];
  mocks.writeAuditLog.mockResolvedValue({});
  mocks.configured.mockReturnValue(true);
  mocks.switchRead.mockReturnValue(true);
  mocks.organizationFindUnique.mockResolvedValue({ type: "CLUB", isActive: true, name: "Example Pathfinders" });
  mocks.accountFindUnique.mockResolvedValue({ displayName: "Dana Director" });
  mocks.userFindUnique.mockResolvedValue({ displayName: "Alex Admin" });
  mocks.executeRaw.mockResolvedValue(0);
  mocks.queryRaw.mockResolvedValue([]);
  mocks.submissionCreate.mockResolvedValue({});
  mocks.linkUpdateMany.mockResolvedValue({ count: 1 });
  mocks.rosterFindFirst.mockResolvedValue({ id: "member-1", person: { firstName: "Riley", lastName: "Sample" } });
  mocks.outboxFindMany.mockImplementation(async (args: { where: { idempotencyKey: { in: string[] } } }) =>
    outbox.filter((row) => args.where.idempotencyKey.in.includes(row.idempotencyKey as string)).map((row) => ({ idempotencyKey: row.idempotencyKey })));
  mocks.outboxCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    if (outbox.some((row) => row.idempotencyKey === args.data.idempotencyKey)) throw new Error("unique constraint on idempotencyKey");
    outbox.push(args.data);
    return { id: `message-${outbox.length}` };
  });
  useTemplate(ADDRESSES);
});

const viaLink = () => submitClubFormViaLink(TOKEN, slipAnswers, now);
const viaPortal = (viewer: ClubFormsViewer = director, submit = true) => saveClubFormSubmission(viewer, {
  organizationId: "club-a", templateKey: "off_premises_permission_slip", rosterMemberId: "member-1", answers: slipAnswers, submit,
}, now);

describe("recipients are validated (#1017)", () => {
  it("takes one address per line, lowercases and de-duplicates them", () => {
    expect(parseAlertRecipients("Office@IMSDA-Events.test\n\n youth@imsda-events.test \noffice@imsda-events.test"))
      .toEqual({ ok: true, emails: ["office@imsda-events.test", "youth@imsda-events.test"] });
    expect(parseAlertRecipients("")).toEqual({ ok: true, emails: [] });
  });

  it("refuses an invalid address and more than ten", () => {
    expect(parseAlertRecipients("not-an-address")).toMatchObject({ ok: false });
    expect(parseAlertRecipients("a@b.test\nbroken@")).toMatchObject({ ok: false });
    const eleven = Array.from({ length: 11 }, (_, index) => `person${index}@imsda-events.test`);
    expect(parseAlertRecipients(eleven.join("\n"))).toMatchObject({ ok: false, message: "Add at most 10 addresses." });
    expect(parseAlertRecipients(eleven.slice(0, 10).join("\n"))).toMatchObject({ ok: true });
  });
});

describe("saving the list (#1017)", () => {
  it("stores the cleaned list and audits the counts, not the addresses", async () => {
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", submissionNotifyEmails: [] });
    const saved = await setClubFormAlertRecipients("off_premises_permission_slip", ["Office@IMSDA-Events.test", "office@imsda-events.test"], "admin-1");
    expect(saved.emails).toEqual(["office@imsda-events.test"]);
    expect(mocks.templateUpdate).toHaveBeenCalledWith({ where: { id: "template-slip" }, data: { submissionNotifyEmails: ["office@imsda-events.test"] } });
    const audit = mocks.writeAuditLog.mock.calls[0][0];
    expect(audit).toMatchObject({ actorUserId: "admin-1", action: "CLUB_FORM_ALERT_RECIPIENTS_CHANGED", metadata: { previousCount: 0, newCount: 1 } });
    expect(JSON.stringify(audit)).not.toContain("imsda-events.test");
  });

  it("refuses a bad list and writes nothing, and writes nothing when nothing changed", async () => {
    // A bad address is judged against the stored list (#1193), so the form is read, but nothing is written.
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", submissionNotifyEmails: [] });
    await expect(setClubFormAlertRecipients("off_premises_permission_slip", ["nope"], "admin-1")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
    mocks.templateFindUnique.mockResolvedValue({ id: "template-slip", submissionNotifyEmails: ["a@imsda-events.test"] });
    await setClubFormAlertRecipients("off_premises_permission_slip", ["a@imsda-events.test"], "admin-1");
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("refuses eleven addresses with a 400-class validation error and writes nothing", async () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `person${index}@imsda-events.test`);
    const error = await setClubFormAlertRecipients("off_premises_permission_slip", eleven, "admin-1").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", message: "Add at most 10 addresses." });
    const { clubFormApiError } = await import("@/modules/club-forms/api-errors");
    expect(clubFormApiError(error, "test").status).toBe(400);
    expect(mocks.templateFindUnique).not.toHaveBeenCalled();
    expect(mocks.templateUpdate).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("says not found for a form that does not exist", async () => {
    mocks.templateFindUnique.mockResolvedValue(null);
    await expect(setClubFormAlertRecipients("missing", [], "admin-1")).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });
});

describe("a submission queues one email per recipient (#1017)", () => {
  it("through a private link", async () => {
    await viaLink();
    expect(outbox.map((row) => row.recipientEmail)).toEqual(ADDRESSES);
    expect(outbox.every((row) => row.templateKey === "CLUB_FORM_SUBMITTED" && row.recipientKind === "INTERNAL" && row.status === "PENDING")).toBe(true);
    expect(outbox.map((row) => row.idempotencyKey)).toEqual(ADDRESSES.map((email) => expect.stringMatching(new RegExp(`^club-form-submitted:[^:]+:${email}$`))));
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0][0].messageIds).toHaveLength(2);
    // The link path does not know who filled it in.
    expect(String(outbox[0].bodyTextSnapshot)).toContain("someone with the club's private link");
  });

  it("when a director or deputy submits in the club portal, naming them", async () => {
    await viaPortal();
    expect(outbox.map((row) => row.recipientEmail)).toEqual(ADDRESSES);
    const body = String(outbox[0].bodyTextSnapshot);
    expect(body).toContain("Submitted by: Dana Director");
    expect(body).toContain("Club: Example Pathfinders");
    expect(body).toContain(`Form: ${seed!.name}`);
    expect(body).toContain("https://events.imsda.test/more/club-forms/");
  });

  it("a link submission's email holds no answer and not the link's subject name", async () => {
    await viaLink();
    expect(outbox).toHaveLength(2);
    for (const row of outbox) {
      const text = `${row.subjectSnapshot}\n${row.bodyTextSnapshot}\n${JSON.stringify(row.metadata)}`;
      expect(text).not.toContain(openLink().subjectName);
      for (const value of Object.values(slipAnswers)) expect(text, `must not contain "${value}"`).not.toContain(value);
    }
  });

  it("names the staff member when a system administrator submits as a director", async () => {
    await viaPortal(actingDirector);
    expect(String(outbox[0].bodyTextSnapshot)).toContain("Submitted by: Alex Admin");
  });

  it("does not email for a draft save", async () => {
    await viaPortal(director, false);
    expect(outbox).toEqual([]);
    expect(mocks.switchRead).not.toHaveBeenCalled();
  });
});

describe("a failure to queue the alert never undoes or refuses the submission (#1017)", () => {
  const failures: Array<[string, () => void]> = [
    ["the outbox insert fails", () => mocks.outboxCreate.mockRejectedValue(new Error("outbox down"))],
    ["the idempotency lookup fails", () => mocks.outboxFindMany.mockRejectedValue(new Error("lookup down"))],
    ["the organization lookup fails", () => mocks.organizationFindUnique.mockRejectedValue(new Error("organization lookup down"))],
  ];

  for (const [name, fail] of failures) {
    it(`${name}: a link submission still succeeds and the error is logged without addresses`, async () => {
      // The alert is queued after the transaction, so the submission is already saved when the failure happens.
      let committed = false;
      mocks.submissionCreate.mockImplementation(async () => { committed = true; return {}; });
      fail();
      const result = await viaLink();
      expect(committed).toBe(true);
      expect(result).toMatchObject({ submissionId: expect.any(String) });
      expect(mocks.logError).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(mocks.logError.mock.calls[0].slice(2));
      expect(logged).toContain("submissionId");
      expect(logged).not.toContain("imsda-events.test");
      expect(outbox).toEqual([]);
    });
  }

  it("a portal submission still succeeds when the outbox insert fails", async () => {
    mocks.outboxCreate.mockRejectedValue(new Error("outbox down"));
    await expect(viaPortal()).resolves.toMatchObject({ status: "SUBMITTED" });
    expect(mocks.logError).toHaveBeenCalledTimes(1);
  });

  it("a failing sender lookup is logged, not thrown", async () => {
    mocks.senderFails = true;
    try {
      await expect(viaLink()).resolves.toMatchObject({ submissionId: expect.any(String) });
      await expect(viaPortal()).resolves.toMatchObject({ status: "SUBMITTED" });
    } finally {
      mocks.senderFails = false;
    }
    expect(mocks.logError).toHaveBeenCalledTimes(2);
    expect(outbox).toEqual([]);
  });

  it("queues nothing and logs nothing when the switch is off", async () => {
    mocks.switchRead.mockReturnValue(false);
    await viaLink();
    expect(mocks.logError).not.toHaveBeenCalled();
    expect(outbox).toEqual([]);
  });
});

describe("a retry does not duplicate (#1017)", () => {
  it("keys each email on the submission and the address, and adds nothing the second time", async () => {
    const { queueClubFormSubmittedEmails } = await import("@/modules/club-forms/submission-alert");
    const input = { submissionId: "sub-1", templateId: "template-slip", organizationId: "club-a", actor: null, submittedAt: now };
    const first = await queueClubFormSubmittedEmails(client as never, input, true);
    const again = await queueClubFormSubmittedEmails(client as never, input, true);
    expect(first).toHaveLength(2);
    expect(again).toEqual([]);
    expect(outbox.map((row) => row.idempotencyKey)).toEqual([
      "club-form-submitted:sub-1:office@imsda-events.test",
      "club-form-submitted:sub-1:youth@imsda-events.test",
    ]);
  });

  it("adds only the address that is new when the list grew between attempts", async () => {
    const { queueClubFormSubmittedEmails } = await import("@/modules/club-forms/submission-alert");
    const input = { submissionId: "sub-2", templateId: "template-slip", organizationId: "club-a", actor: null, submittedAt: now };
    await queueClubFormSubmittedEmails(client as never, input, true);
    useTemplate([...ADDRESSES, "third@imsda-events.test"]);
    const added = await queueClubFormSubmittedEmails(client as never, input, true);
    expect(added).toHaveLength(1);
    expect(outbox).toHaveLength(3);
  });
});

describe("nothing is sent when it should not be (#1017)", () => {
  it("an empty list sends nothing, on both paths, and the submission still saves", async () => {
    useTemplate([]);
    await viaLink();
    await viaPortal();
    expect(outbox).toEqual([]);
    expect(mocks.submissionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("the switch off sends nothing, on both paths, and the submission still saves", async () => {
    mocks.switchRead.mockReturnValue(false);
    await viaLink();
    await viaPortal();
    expect(outbox).toEqual([]);
    expect(mocks.submissionCreate).toHaveBeenCalledTimes(2);
    expect(mocks.switchRead).toHaveBeenCalledWith("CLUB_FORM_SUBMITTED");
  });

  it("reads the switch before the transaction opens, on both paths", async () => {
    await viaLink();
    expect(mocks.events.indexOf("switch:CLUB_FORM_SUBMITTED")).toBeGreaterThanOrEqual(0);
    expect(mocks.events.indexOf("switch:CLUB_FORM_SUBMITTED")).toBeLessThan(mocks.events.indexOf("transaction"));
    mocks.events.length = 0;
    await viaPortal();
    expect(mocks.events.indexOf("switch:CLUB_FORM_SUBMITTED")).toBeLessThan(mocks.events.indexOf("transaction"));
  });
});

describe("the email never holds an answer (#1017)", () => {
  it("has the form, club, submitter, time and staff link, and none of the answers", async () => {
    await viaPortal();
    for (const row of outbox) {
      const text = `${row.subjectSnapshot}\n${row.bodyTextSnapshot}\n${JSON.stringify(row.metadata)}`;
      for (const value of Object.values(slipAnswers)) {
        expect(text, `must not contain "${value}"`).not.toContain(value);
      }
      expect(text).not.toContain(SECRET_HEALTH);
      expect(text).not.toContain(SECRET_PHONE);
      expect(text).not.toContain("Canoe trip");
      expect(text).not.toContain("Riley Sample");
      expect(String(row.bodyTextSnapshot)).toContain("The answers are not in this email.");
    }
  });

  it("is built from names and a time only, and keeps stray template markers out", () => {
    const content = clubFormSubmittedContent({
      formName: "Form {{club_form_link}}",
      clubName: "Example Pathfinders",
      submitterName: "Dana Director",
      submittedAt: now,
      submissionId: "sub-9",
    });
    expect(content.bodyText).not.toContain("{{");
    expect(content.bodyText).toContain("October 5, 2026");
    expect(content.bodyText).toContain("https://events.imsda.test/more/club-forms/sub-9");
  });
});
