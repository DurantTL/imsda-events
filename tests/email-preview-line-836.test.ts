import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/modules/communications/effective-delivery", async () => (await import("./support/effective-delivery-double")).effectiveDeliveryDouble);

const mocks = vi.hoisted(() => ({
  prisma: {} as Record<string, unknown>,
  enqueue: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ getPrisma: () => mocks.prisma }));
vi.mock("@/modules/communications/email-preferences-repository", () => ({ loadAnnouncementOptOuts: vi.fn(async () => []) }));
vi.mock("@/modules/communications/seminar-preferences", () => ({ buildSeminarPreferencesBlocks: vi.fn(async () => new Map()) }));
vi.mock("@/modules/communications/messaging-repository", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/communications/messaging-repository")>()),
  // The send reads the event's defaults from the real database first; the review and the send below start after it.
  ensureEventMessagingDefaults: vi.fn(async () => undefined),
  processQueuedMessageIdsAfterCommit: vi.fn(async () => undefined),
}));
vi.mock("@/modules/communications/transactional-messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/communications/transactional-messages")>()),
  enqueueEventAnnouncementMessage: (...args: unknown[]) => mocks.enqueue(...args),
}));
vi.mock("@/modules/communications/message-files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/communications/message-files")>()),
  linkQueuedMessageFiles: vi.fn(async () => undefined),
}));

import {
  AnnouncementBroadcastError,
  broadcastPublishedAnnouncement,
  previewAnnouncementBroadcast,
} from "@/modules/communications/announcement-broadcast";
import { computeAnnouncementBroadcastPreview } from "@/modules/communications/announcement-broadcast-preview";
import { PREHEADER_MAX_LENGTH, renderEmailHtmlDocument, renderPreheaderHtml } from "@/modules/communications/email-html";
import { MessagingError } from "@/modules/communications/messaging-error";
import { publishMessageTemplateVersion } from "@/modules/communications/messaging-repository";
import { announcementPreheaderField, messageTemplateInputSchema } from "@/modules/communications/schemas";
import { runSendCheck } from "@/modules/communications/send-check";
import {
  SAMPLE_MESSAGE_TEMPLATE_CONTEXT,
  renderMessageTemplate,
  validateMessageTemplate,
} from "@/modules/communications/templates";

/** What `renderEmailHtmlDocument` produced for this exact input before the preview line existed (taken from origin/main). */
const PRE_836_DOCUMENT_SHA256 = "ad5b13dbf652dd94bb65053378bf55a8b6fb71a6f5044f0df8cd92ef901ee214";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe("the hidden preheader in the email document (#836)", () => {
  const base = { title: "Friday arrival information", bodyHtml: "<p>Hello</p>", footer: "IMSDA Events" };

  it("leaves the document exactly as it was when there is no preview line", () => {
    for (const preheader of [undefined, null, "", "   ", "\n"]) {
      expect(sha256(renderEmailHtmlDocument({ ...base, preheader })), JSON.stringify(preheader)).toBe(PRE_836_DOCUMENT_SHA256);
    }
    expect(renderPreheaderHtml(null)).toBe("");
  });

  it("puts the line first inside the body, hidden, and pads it so the body text does not fill the preview", () => {
    const html = renderEmailHtmlDocument({ ...base, preheader: "Doors open at four." });
    const bodyOpen = html.indexOf("<body");
    const hidden = html.indexOf("Doors open at four.");
    expect(hidden).toBeGreaterThan(bodyOpen);
    expect(hidden).toBeLessThan(html.indexOf("<table"));
    expect(html).toMatch(/<div style="display:none;[^"]*mso-hide:all;[^"]*">Doors open at four\.(&#847;&zwnj;&nbsp;)+<\/div>/);
    // Everything else is the old document.
    expect(html.replace(`${renderPreheaderHtml("Doors open at four.")}\n`, "")).toBe(renderEmailHtmlDocument(base));
  });

  it("escapes the line and never reads it as Markdown or markup", () => {
    const html = renderEmailHtmlDocument({ ...base, preheader: `<img src=x onerror="alert(1)"> **bold** [link](https://evil.example.test) & more` });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain('href="https://evil.example.test"');
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; **bold** [link](https://evil.example.test) &amp; more");
  });

  it("folds a stray line break into one line", () => {
    expect(renderPreheaderHtml("One\r\n\r\nTwo")).toContain(">One Two&#847;");
  });
});

describe("the preview line follows the subject's rules (#836)", () => {
  const template = { subject: "{{event_name}}", body: "Hello {{recipient_name}}, this is long enough." };

  it("renders allowed tokens as plain text, like the subject", () => {
    const rendered = renderMessageTemplate({ ...template, preheader: "For {{recipient_name}} at {{event_name}}" }, { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, recipient_name: "Avery", event_name: "Women's Retreat" });
    expect(rendered.preheader).toBe("For Avery at Women's Retreat");
    expect(rendered.isComplete).toBe(true);
  });

  it("is null when the template has none, and the rest of the render is unchanged", () => {
    const without = renderMessageTemplate(template, SAMPLE_MESSAGE_TEMPLATE_CONTEXT);
    expect(without.preheader).toBeNull();
    expect(renderMessageTemplate({ ...template, preheader: "  " }, SAMPLE_MESSAGE_TEMPLATE_CONTEXT).preheader).toBeNull();
    const withLine = renderMessageTemplate({ ...template, preheader: "Line" }, SAMPLE_MESSAGE_TEMPLATE_CONTEXT);
    expect({ ...withLine, preheader: null }).toEqual(without);
  });

  it("does not escape a registrant's text as Markdown in the plain line, and the document escapes it as HTML", () => {
    const name = "[Review your registration](https://malicious.example) <b>x</b>";
    const rendered = renderMessageTemplate({ ...template, preheader: "For {{recipient_name}}" }, { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, recipient_name: name });
    expect(rendered.preheader).toBe(`For ${name}`);
    const html = renderEmailHtmlDocument({ title: "x", bodyHtml: "", preheader: rendered.preheader });
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<a href");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("collapses a line break a token value brings", () => {
    const rendered = renderMessageTemplate({ ...template, preheader: "{{attendee_summary}}" }, { ...SAMPLE_MESSAGE_TEMPLATE_CONTEXT, attendee_summary: "1. Avery\n2. Blake" });
    expect(rendered.preheader).toBe("1. Avery 2. Blake");
  });

  it("is incomplete, like a subject, when a token has no value", () => {
    const rendered = renderMessageTemplate({ ...template, preheader: "{{nope}}" }, SAMPLE_MESSAGE_TEMPLATE_CONTEXT);
    expect(rendered.isComplete).toBe(false);
    expect(rendered.unresolvedTokens).toContain("nope");
  });

  it("is validated for line breaks and the token allow-list", () => {
    expect(validateMessageTemplate({ ...template, preheader: "One\nTwo" }).issues).toEqual([expect.objectContaining({ field: "preheader", code: "PREHEADER_LINE_BREAK" })]);
    expect(validateMessageTemplate({ ...template, preheader: "{{nope}}" }).issues).toEqual([expect.objectContaining({ field: "preheader", code: "UNKNOWN_TOKEN", token: "nope" })]);
    expect(validateMessageTemplate({ ...template, preheader: "At {{event_name}}" }).isValid).toBe(true);
    expect(validateMessageTemplate({ ...template }).isValid).toBe(true);
    expect(validateMessageTemplate({ ...template, preheader: "{{refund_amount}}", allowedTokens: new Set(["event_name", "recipient_name"]) }).isValid).toBe(false);
  });
});

describe("the request schemas (#836)", () => {
  const input = { subjectTemplate: "Subject", bodyTemplate: "A body that is long enough to publish.", isEnabled: true };

  it("accepts a template with no line, a blank one, or a trimmed one", () => {
    expect(messageTemplateInputSchema.parse(input).preheaderTemplate).toBeUndefined();
    expect(messageTemplateInputSchema.parse({ ...input, preheaderTemplate: "   " }).preheaderTemplate).toBeNull();
    expect(messageTemplateInputSchema.parse({ ...input, preheaderTemplate: null }).preheaderTemplate).toBeNull();
    expect(messageTemplateInputSchema.parse({ ...input, preheaderTemplate: "  Arrive at four.  " }).preheaderTemplate).toBe("Arrive at four.");
  });

  it("refuses a line that is too long, over two lines, or has an unknown token", () => {
    expect(messageTemplateInputSchema.safeParse({ ...input, preheaderTemplate: "x".repeat(PREHEADER_MAX_LENGTH + 1) }).success).toBe(false);
    const multiline = messageTemplateInputSchema.safeParse({ ...input, preheaderTemplate: "One\nTwo" });
    expect(multiline.success).toBe(false);
    expect(multiline.error?.issues[0]?.path).toEqual(["preheaderTemplate"]);
    expect(messageTemplateInputSchema.safeParse({ ...input, preheaderTemplate: "{{nope}}" }).success).toBe(false);
  });

  it("treats an announcement's line the same, leaving it alone when absent", () => {
    expect(announcementPreheaderField.parse(undefined)).toBeUndefined();
    expect(announcementPreheaderField.parse("  ")).toBeNull();
    expect(announcementPreheaderField.parse(" Hi {{event_name}} ")).toBe("Hi {{event_name}}");
    expect(announcementPreheaderField.safeParse("One\nTwo").success).toBe(false);
    expect(announcementPreheaderField.safeParse("{{nope}}").success).toBe(false);
  });
});

describe("the migration (#836)", () => {
  const sql = readFileSync(new URL("../prisma/migrations/20261128100000_email_preview_line/migration.sql", import.meta.url), "utf8")
    .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("only adds three nullable text columns, with no default, no backfill and nothing else", () => {
    const statements = sql.split(";").map((statement) => statement.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(statements).toEqual([
      'ALTER TABLE "Announcement" ADD COLUMN "preheader" TEXT',
      'ALTER TABLE "MessageTemplateVersion" ADD COLUMN "preheaderTemplate" TEXT',
      'ALTER TABLE "MessageOutbox" ADD COLUMN "preheaderSnapshot" TEXT',
    ]);
    expect(sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|DROP|NOT NULL|DEFAULT|INDEX)\b/i);
  });

  it("matches the Prisma schema", () => {
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    expect(schema).toMatch(/\n\s+preheader\s+String\?\n/);
    expect(schema).toMatch(/\n\s+preheaderTemplate\s+String\?\n/);
    expect(schema).toMatch(/\n\s+preheaderSnapshot\s+String\?\n/);
  });
});

function announcementTransaction(options: { versionPreheader?: string | null | undefined } = {}) {
  const upsert = vi.fn(async (args: { create: Record<string, unknown> }) => ({ id: "message-1", status: args.create.status }));
  const hasVersion = "versionPreheader" in options;
  const tx = {
    eventMessageSettings: {
      findUnique: vi.fn().mockResolvedValue({ deliveryMode: "LOCAL_CAPTURE", senderName: "IMSDA Events", senderEmail: "events@example.test", replyToEmail: "help@example.test" }),
    },
    eventMessageTemplate: {
      findUnique: vi.fn().mockResolvedValue(hasVersion
        ? {
            isEnabled: true,
            versions: [{
              id: "version-1",
              subjectTemplate: "{{announcement_title}}",
              ...(options.versionPreheader !== undefined ? { preheaderTemplate: options.versionPreheader } : {}),
              bodyTemplate: "{{announcement_body}}\n\n[Open my registration]({{portal_url}})",
              files: [],
            }],
          }
        : null),
    },
    registration: {
      findFirst: vi.fn().mockResolvedValue({
        id: "registration-1",
        confirmationCode: "REG-1234",
        status: "CONFIRMED",
        totalAmount: { toString: () => "0.00" },
        contactSnapshot: { firstName: "Avery", lastName: "Johnson", email: "avery@example.test" },
        accountHolderPerson: { firstName: "Avery", lastName: "Johnson", normalizedEmail: "avery@example.test" },
        event: { name: "Women's Retreat 2026", startsAt: new Date("2026-10-09T21:00:00.000Z"), endsAt: new Date("2026-10-11T17:00:00.000Z"), timezone: "America/Chicago", location: "Camp Heritage", supportContact: "registration@example.test" },
        attendees: [{ id: "attendee-1", profileSnapshot: { firstName: "Avery", lastName: "Johnson" }, formResponses: {}, person: { firstName: "Avery", lastName: "Johnson" } }],
        payments: [],
        waitlistEntry: null,
      }),
    },
    messageOutbox: { upsert },
  };
  return { tx, upsert };
}

async function enqueue(tx: unknown, extra: { announcementPreheader?: string | null } = {}) {
  const actual = await vi.importActual<typeof import("@/modules/communications/transactional-messages")>("@/modules/communications/transactional-messages");
  await actual.enqueueEventAnnouncementMessage(tx as never, {
    eventId: "event-1",
    registrationId: "registration-1",
    correlationId: "batch-1",
    transitionKey: "announcement-broadcast:announcement-1:batch-1",
    announcementTitle: "Friday arrival information",
    announcementBody: "Check-in opens at 4:00 PM in the main lodge.",
    ...extra,
  });
}

describe("the preview line on the outbox row (#836)", () => {
  it("snapshots the announcement's own line, tokens expanded, beside the subject", async () => {
    const { tx, upsert } = announcementTransaction({ versionPreheader: "From the template" });
    await enqueue(tx, { announcementPreheader: "Hello {{recipient_name}}: {{announcement_title}}" });
    const create = upsert.mock.calls[0][0].create;
    expect(create.preheaderSnapshot).toBe("Hello Avery Johnson: Friday arrival information");
    expect(create.subjectSnapshot).toBe("Friday arrival information");
  });

  it("falls back to the template version's line when the announcement has none", async () => {
    const { tx, upsert } = announcementTransaction({ versionPreheader: "At {{event_name}}" });
    await enqueue(tx, { announcementPreheader: "   " });
    expect(upsert.mock.calls[0][0].create.preheaderSnapshot).toBe("At Women's Retreat 2026");
  });

  it("writes no preheader column at all for a message with no line, so it is stored as before", async () => {
    for (const options of [{}, { versionPreheader: null }, { versionPreheader: undefined }]) {
      const { tx, upsert } = announcementTransaction(options);
      await enqueue(tx);
      const create = upsert.mock.calls[0][0].create;
      expect("preheaderSnapshot" in create).toBe(false);
      expect(create.bodyHtmlSnapshot).not.toContain("display:none");
    }
  });

  it("never lets the line change the stored body or subject", async () => {
    const plain = announcementTransaction({ versionPreheader: null });
    await enqueue(plain.tx);
    const withLine = announcementTransaction({ versionPreheader: null });
    await enqueue(withLine.tx, { announcementPreheader: "A line" });
    const [a, b] = [plain.upsert.mock.calls[0][0].create, withLine.upsert.mock.calls[0][0].create];
    expect({ ...b, preheaderSnapshot: undefined }).toEqual({ ...a, preheaderSnapshot: undefined });
  });
});

describe("publishing a template version runs the send check on the server (#836)", () => {
  const goodBody = "Hello {{recipient_name}}, your registration for {{event_name}} is saved.";

  function publishFixture() {
    const created: Array<Record<string, unknown>> = [];
    const stop = new Error("stop after the version is written");
    const tx = {
      eventMessageTemplate: {
        findFirst: vi.fn(async () => ({ id: "template-1", key: "EVENT_ANNOUNCEMENT", versions: [{ versionNumber: 1 }] })),
        update: vi.fn(),
      },
      messageTemplateVersion: {
        updateMany: vi.fn(),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: "version-2", ...data }; }),
      },
      messageFile: { findMany: vi.fn(async () => []) },
      messageTemplateVersionFile: { createMany: vi.fn(), findMany: vi.fn(async () => []) },
      auditLog: { create: vi.fn(async () => { throw stop; }) },
    };
    mocks.prisma = { $transaction: async (run: (client: unknown) => unknown) => run(tx) };
    return { tx, created, stop };
  }

  const publish = (overrides: Record<string, unknown>) => publishMessageTemplateVersion(
    "event-1",
    "template-1",
    { subjectTemplate: "Subject", bodyTemplate: goodBody, isEnabled: true, attachmentFileIds: [], ...overrides } as never,
    "user-1",
  );

  it.each([
    ["an empty subject", { subjectTemplate: "  " }, "SUBJECT_EMPTY"],
    ["an empty body", { bodyTemplate: " " }, "BODY_EMPTY"],
    ["a link that would render as text", { bodyTemplate: `${goodBody}\n\n[Read more](javascript:alert)` }, "LINK_SCHEME"],
    ["a picture from an insecure address", { bodyTemplate: `${goodBody}\n\n![Map](http://cdn.example.test/map.png)` }, "IMAGE_SOURCE"],
  ])("refuses %s and writes nothing", async (_name, overrides, code) => {
    const { tx, created } = publishFixture();
    const error = await publish(overrides).catch((caught) => caught);
    expect(error).toBeInstanceOf(MessagingError);
    expect(error.code).toBe("INVALID_TEMPLATE");
    expect(error.details.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    expect(tx.messageTemplateVersion.create).not.toHaveBeenCalled();
    expect(tx.messageTemplateVersion.updateMany).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("does not hold up a publish for warnings or suggestions, and stores the preview line on the immutable version", async () => {
    const { created, stop } = publishFixture();
    const error = await publish({ subjectTemplate: "x".repeat(90), bodyTemplate: `${goodBody}\n\n![](https://cdn.example.test/a.png)`, preheaderTemplate: "Hi {{event_name}}" }).catch((caught) => caught);
    expect(error).toBe(stop);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: "PUBLISHED", versionNumber: 2, preheaderTemplate: "Hi {{event_name}}" });
  });

  it("stores no line when none was given", async () => {
    const { created } = publishFixture();
    await publish({}).catch(() => undefined);
    expect(created[0].preheaderTemplate).toBeNull();
  });
});

describe("an announcement send runs the send check on the server (#836)", () => {
  const goodTemplate = { id: "version-1", subjectTemplate: "{{announcement_title}}", bodyTemplate: "{{announcement_body}}\n\n[Open my registration]({{portal_url}})", preheaderTemplate: null, files: [] };
  const goodAnnouncement = { id: "announcement-1", title: "Friday arrival information", body: "Check-in opens at 4:00 PM in the main lodge, with parking by the lake.", preheader: "Where to park.", status: "PUBLISHED", publishedAt: new Date("2026-10-08T12:00:00.000Z"), isEssential: false };

  let eventName = "Women's Retreat 2026";
  function useClient(announcement: Record<string, unknown>, version: Record<string, unknown> | null = goodTemplate) {
    const fake = {
      announcement: { findFirst: vi.fn(async () => announcement) },
      registration: { findMany: vi.fn(async () => [{ id: "registration-1", contactSnapshot: { email: "avery@example.test" }, accountHolderPerson: null }]) },
      eventMessageSettings: { findUnique: vi.fn(async () => ({ deliveryMode: "LOCAL_CAPTURE", senderName: "IMSDA Events", senderEmail: null, replyToEmail: null })) },
      eventMessageTemplate: { findUnique: vi.fn(async () => ({ isEnabled: true, versions: version ? [version] : [] })) },
      announcementFile: { findMany: vi.fn(async () => []) },
      messageFile: { findMany: vi.fn(async () => []) },
      event: { findUnique: vi.fn(async () => ({ name: eventName })) },
      auditLog: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async () => []),
    };
    mocks.prisma = { ...fake, $transaction: async (run: (tx: unknown) => unknown) => run(fake) };
    return fake;
  }
  const review = () => previewAnnouncementBroadcast({ eventId: "event-1", announcementId: "announcement-1" });
  const send = (fingerprint: string, extra: Record<string, unknown> = {}) => broadcastPublishedAnnouncement({
    eventId: "event-1", announcementId: "announcement-1", batchId: "batch-1", previewFingerprint: fingerprint, actorUserId: "user-1", ...extra,
  });

  beforeEach(() => {
    mocks.enqueue.mockReset();
    mocks.enqueue.mockResolvedValue({ messageIds: ["message-1"], pendingMessageIds: [], deliveryMode: "LOCAL_CAPTURE", skippedReason: null });
  });

  it("shows the review the line that will be used and a clean check, then sends it with the line", async () => {
    useClient(goodAnnouncement);
    const preview = await review();
    expect(preview.preheader).toBe("Where to park.");
    expect(preview.sendCheck).toMatchObject({ hasErrors: false, hasWarnings: false, errors: [], warnings: [], suggestions: [] });
    await send(preview.fingerprint);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({ announcementTitle: "Friday arrival information", announcementPreheader: "Where to park." });
  });

  it("uses the template's line, and suggests one when neither has it", async () => {
    useClient({ ...goodAnnouncement, preheader: null }, { ...goodTemplate, preheaderTemplate: "From the template" });
    expect((await review()).preheader).toBe("From the template");
    useClient({ ...goodAnnouncement, preheader: null });
    const none = await review();
    expect(none.preheader).toBeNull();
    expect(none.sendCheck.suggestions.map((finding) => finding.code)).toEqual(["PREHEADER_MISSING"]);
    expect(none.sendCheck.hasErrors || none.sendCheck.hasWarnings).toBe(false);
  });

  it("measures the subject with the event's real name", async () => {
    eventName = "N".repeat(80);
    useClient(goodAnnouncement, { ...goodTemplate, subjectTemplate: "{{event_name}}: {{announcement_title}}" });
    expect((await review()).sendCheck.warnings.map((finding) => finding.code)).toEqual(["SUBJECT_LONG"]);
    eventName = "Women's Retreat 2026";
  });

  it("checks the announcement text as the literal value it is: a token typed in it is never expanded", async () => {
    useClient({ ...goodAnnouncement, body: "Open [your pass]({{checkin_qr_url}}) at the lodge, and bring your {{favorite}} snack for everyone." });
    const preview = await review();
    // The link would send as plain text; the unknown token would just print its braces, so it is no error.
    expect(preview.sendCheck.errors.map((finding) => finding.code)).toEqual(["LINK_SCHEME"]);
    const error = await send(preview.fingerprint).catch((caught) => caught);
    expect(error.code).toBe("SEND_CHECK_FAILED");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("refuses to send an announcement whose text holds an error, and queues nothing", async () => {
    useClient({ ...goodAnnouncement, body: "Parking: [the map](javascript:alert(1)) is by the lodge, and check-in opens at four." });
    const preview = await review();
    expect(preview.sendCheck.errors.map((finding) => finding.code)).toEqual(["LINK_SCHEME"]);
    const error = await send(preview.fingerprint, { acknowledgedWarningIds: preview.sendCheck.warnings.map((finding) => finding.id) }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AnnouncementBroadcastError);
    expect(error.code).toBe("SEND_CHECK_FAILED");
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("needs every warning acknowledged before it sends, and only those the server still finds", async () => {
    useClient({ ...goodAnnouncement, title: "T".repeat(90) });
    const preview = await review();
    expect(preview.sendCheck.warnings.map((finding) => finding.id)).toEqual(["SUBJECT_LONG:0"]);

    for (const acknowledgedWarningIds of [undefined, [], ["IMAGE_NO_ALT:0"]]) {
      const error = await send(preview.fingerprint, { acknowledgedWarningIds }).catch((caught) => caught);
      expect(error).toBeInstanceOf(AnnouncementBroadcastError);
      expect(error.code).toBe("WARNINGS_NOT_ACKNOWLEDGED");
    }
    expect(mocks.enqueue).not.toHaveBeenCalled();

    const sent = await send(preview.fingerprint, { acknowledgedWarningIds: ["SUBJECT_LONG:0"] });
    expect(sent.messageCount).toBe(1);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("the review's own bookkeeping (#836)", () => {
  const context = { eventId: "event-1", announcement: { id: "announcement-1", title: "Friday arrival information", body: "Body text that is long enough." }, deliveryMode: "LOCAL_CAPTURE" as const, templateEnabled: true, templateVersionId: "version-1" };
  const candidates = [{ registrationId: "registration-1", contactSnapshot: { email: "avery@example.test" }, accountHolderNormalizedEmail: null }];

  it("fingerprints a review without a line exactly as before, and a line changes it", () => {
    const without = computeAnnouncementBroadcastPreview(candidates, context);
    expect(without.preheader).toBeNull();
    expect(without.sendCheck).toEqual({ errors: [], warnings: [], suggestions: [], hasErrors: false, hasWarnings: false });
    const same = computeAnnouncementBroadcastPreview(candidates, { ...context, preheader: null });
    expect(same.fingerprint).toBe(without.fingerprint);
    const withLine = computeAnnouncementBroadcastPreview(candidates, { ...context, preheader: "Where to park." });
    expect(withLine.fingerprint).not.toBe(without.fingerprint);
    expect(withLine.preheader).toBe("Where to park.");
  });

  it("carries the check through to the review", () => {
    const sendCheck = runSendCheck({ subject: "x".repeat(90), body: "Body text that is long enough to not be short." });
    const preview = computeAnnouncementBroadcastPreview(candidates, { ...context, sendCheck });
    expect(preview.sendCheck.warnings.map((finding) => finding.code)).toEqual(["SUBJECT_LONG"]);
  });

  it("has the error class the route maps to a 409", () => {
    expect(new AnnouncementBroadcastError("SEND_CHECK_FAILED", "x").code).toBe("SEND_CHECK_FAILED");
  });
});

describe("the errors-only check for scheduled and selected announcements (#836)", () => {
  function clientWith(version: Record<string, unknown> | null) {
    return { eventMessageTemplate: { findUnique: vi.fn(async () => ({ versions: version ? [version] : [] })) } } as never;
  }
  const template = { subjectTemplate: "{{announcement_title}}", bodyTemplate: "{{announcement_body}}", preheaderTemplate: null };

  it("accepts a clean announcement, and one with only warnings", async () => {
    const { assertAnnouncementTextSendable } = await import("@/modules/communications/announcement-send-check");
    await expect(assertAnnouncementTextSendable(clientWith(template), "event-1", { title: "Friday arrival", body: "Doors open at four on Friday, with parking by the lake." })).resolves.toBeUndefined();
    await expect(assertAnnouncementTextSendable(clientWith(null), "event-1", { title: "T".repeat(90), body: "Doors open at four on Friday, with parking by the lake." })).resolves.toBeUndefined();
  });

  it("refuses an announcement with a link that would render as text, and one whose link target is a token", async () => {
    const { assertAnnouncementTextSendable } = await import("@/modules/communications/announcement-send-check");
    for (const body of ["Read [the map](javascript:alert) before you come on Friday afternoon.", "Open [your pass]({{checkin_qr_url}}) before you come on Friday."]) {
      const error = await assertAnnouncementTextSendable(clientWith(template), "event-1", { title: "Arrival", body }).catch((caught) => caught);
      expect(error).toBeInstanceOf(MessagingError);
      expect(error.code).toBe("INVALID_TEMPLATE");
      expect(error.details.findings).toEqual([expect.objectContaining({ code: "LINK_SCHEME" })]);
    }
  });
});

describe("applying an event template runs the content errors (#836)", () => {
  it("refuses a default message with an unsendable link or picture, and keeps a clean one", async () => {
    const { templateMessageDefaultSchema } = await import("@/modules/event-templates/domain");
    const base = { key: "EVENT_ANNOUNCEMENT", subjectTemplate: "Hello", bodyTemplate: "Welcome to the retreat, we are glad you are coming." };
    expect(templateMessageDefaultSchema.safeParse(base).success).toBe(true);
    expect(templateMessageDefaultSchema.safeParse({ ...base, bodyTemplate: `${base.bodyTemplate} [Map](javascript:x)` }).success).toBe(false);
    expect(templateMessageDefaultSchema.safeParse({ ...base, bodyTemplate: `${base.bodyTemplate} ![Map](http://cdn.example.test/a.png)` }).success).toBe(false);
  });
});

describe("tokens that make no sense in a preview line (#836)", () => {
  it.each(["portal_url", "checkin_qr_url", "checkin_qr_image", "checkin_qr_images", "announcement_body", "seminar_preferences", "hotel_information", "payment_status_block", "checkin_block", "club_assignments_block"])("refuses {{%s}} in validation, the schemas and the send check", (token) => {
    const preheader = `Hi {{${token}}}`;
    expect(validateMessageTemplate({ subject: "S", body: "B", preheader }).issues).toEqual([expect.objectContaining({ field: "preheader", code: "UNKNOWN_TOKEN", token })]);
    expect(messageTemplateInputSchema.safeParse({ subjectTemplate: "S", bodyTemplate: "A body that is long enough.", isEnabled: true, preheaderTemplate: preheader }).success).toBe(false);
    expect(announcementPreheaderField.safeParse(preheader).success).toBe(false);
    expect(runSendCheck({ subject: "S", body: "A body that is long enough.", preheader }).errors).toEqual([expect.objectContaining({ code: "UNKNOWN_TOKEN", field: "preheader" })]);
  });

  it("still allows the same tokens in the body, and a name, date or place in the line", () => {
    expect(validateMessageTemplate({ subject: "S", body: "[Open]({{portal_url}})", preheader: "{{event_name}} on {{event_dates}} at {{event_location}}" }).isValid).toBe(true);
  });
});
