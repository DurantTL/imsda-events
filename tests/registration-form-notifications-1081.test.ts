import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  logError: vi.fn(),
  writeAuditLog: vi.fn(),
  loadEventEmailSettings: vi.fn(),
  processQueued: vi.fn(),
  switchEnabled: vi.fn(),
  loadSource: vi.fn(),
  latestDocument: vi.fn(),
  versions: vi.fn(),
  render: vi.fn(),
  actualRender: null as unknown as (input: unknown) => Promise<Uint8Array>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/lib/logger", () => ({ logError: mocks.logError, logWarn: vi.fn(), logInfo: vi.fn() }));
vi.mock("@/modules/audit/audit-service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/communications/effective-delivery", () => ({ loadEventEmailSettings: mocks.loadEventEmailSettings }));
vi.mock("@/modules/communications/messaging-repository", () => ({ processQueuedMessageIdsAfterCommit: mocks.processQueued }));
vi.mock("@/modules/notifications/settings", () => ({ isNotificationEnabled: mocks.switchEnabled }));
vi.mock("@/modules/registration-pdf/repository", () => ({ loadRegistrationPdfSource: mocks.loadSource }));
vi.mock("@/modules/registration-pdf/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/registration-pdf/render")>();
  mocks.actualRender = actual.renderRegistrationPdf as never;
  return { ...actual, renderRegistrationPdf: mocks.render };
});

import { buildRegistrationPdfModel, registrationPdfContentHash, type RegistrationPdfSource } from "@/modules/registration-pdf/model";
import {
  CLUB_CONDITION_KEY,
  FORM_NOTIFICATIONS_MAX_PER_FORM,
  LOCATION_CONDITION_KEY,
  checkNotificationRecipients,
  clubConditionStillExists,
  conditionFieldChoices,
  isAllowedConditionKey,
  notificationApplies,
  notificationsPutSchema,
} from "@/modules/registration-form-notifications/domain";
import { queueFormNotificationsForSubmission } from "@/modules/registration-form-notifications/queue";
import {
  finishFormNotificationsAfterSubmit,
  notificationContentHash,
  notifyFormNotificationsAfterChange,
} from "@/modules/registration-form-notifications/after-commit";
import { FormNotificationError, replaceFormNotifications } from "@/modules/registration-form-notifications/repository";
import { springCamporeeDefinition, springCamporeeSource } from "./support/registration-pdf-fixture";

/**
 * Registration form notifications (#1081): routing by location or an answer, section filtering, re-send on change
 * (including a location change), a paused event, the switch, and the audit. Synthetic data only.
 */

const definition = springCamporeeDefinition();
const sectionId = (title: string) => definition.sections.find((section) => section.title === title)!.id;
const CAMPING = sectionId("Camping");
const CLUB = sectionId("Club & contact");
const ROSTER = sectionId("Club roster");

type Row = {
  id: string;
  name: string;
  recipients: string[];
  conditionFieldKey: string | null;
  conditionOperator: string | null;
  conditionValue: string | null;
  sectionIds: string[];
  createdAt: Date;
  deliveries: Array<{ contentHash: string; sectionSignature: string }>;
};

/** The synthetic club directory (#1097): the organization lookup finds only these, as the real one filters on type CLUB. */
const CLUB_IDS = new Set(["club-a", "club-b"]);
const organizationLookup = () => ({
  findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; type?: string } }) => [...CLUB_IDS].filter((id) => !where.id || where.id.in.includes(id)).map((id) => ({ id, name: `Club ${id}` }))),
});

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    name: `Notification ${overrides.id}`,
    recipients: [`${overrides.id}@example.test`],
    conditionFieldKey: null,
    conditionOperator: null,
    conditionValue: null,
    sectionIds: [],
    createdAt: new Date("2027-01-01T00:00:00Z"),
    deliveries: [],
    ...overrides,
  };
}

const normalSettings = { deliveryMode: "EXTERNAL_EMAIL", deliveryReason: "ON", senderName: "IMSDA Events", senderEmail: "events@example.test", replyToEmail: null };
const pausedSettings = { ...normalSettings, deliveryMode: "LOCAL_CAPTURE", deliveryReason: "PAUSED" };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations: put the real renderer back after a test that made it fail.
  mocks.render.mockImplementation(mocks.actualRender);
  mocks.switchEnabled.mockResolvedValue(true);
  mocks.processQueued.mockResolvedValue({});
  mocks.loadEventEmailSettings.mockResolvedValue(normalSettings);
  // The registration PDF (#1082) already stored for the whole registration.
  // Read only: the registration PDF (#1082) already stored for the whole registration, unmarked, saying what it says now.
  mocks.latestDocument.mockResolvedValue({ attachmentId: "registration-pdf", updated: false, contentHash: registrationPdfContentHash(buildRegistrationPdfModel(springCamporeeSource())) });
  mocks.versions.mockResolvedValue([]);
});

describe("routing: which notifications apply (#1081)", () => {
  it("sends an unconditioned notification every time and a conditioned one only on its answer", () => {
    expect(notificationApplies(null, {}, null)).toBe(true);
    const camping = { fieldKey: "partner_club", operator: "EQUALS" as const, value: "Oak Ridge Adventurers" };
    expect(notificationApplies(camping, { partner_club: "Oak Ridge Adventurers" }, null)).toBe(true);
    expect(notificationApplies(camping, { partner_club: "Someone else" }, null)).toBe(false);
    expect(notificationApplies({ ...camping, operator: "NOT_EQUALS" }, { partner_club: "Someone else" }, null)).toBe(true);
  });

  it("routes by the registration's location id", () => {
    const desMoines = { fieldKey: LOCATION_CONDITION_KEY, operator: "EQUALS" as const, value: "loc-des-moines" };
    expect(notificationApplies(desMoines, {}, "loc-des-moines")).toBe(true);
    expect(notificationApplies(desMoines, {}, "loc-ames")).toBe(false);
    expect(notificationApplies(desMoines, {}, null)).toBe(false);
    // An answer that happens to be named like the location key cannot spoof the routing.
    expect(notificationApplies(desMoines, { [LOCATION_CONDITION_KEY]: "loc-des-moines" }, "loc-ames")).toBe(false);
  });
});

describe("routing by club (#1097)", () => {
  const isA = { fieldKey: CLUB_CONDITION_KEY, operator: "EQUALS" as const, value: "club-a" };
  const isNotA = { ...isA, operator: "NOT_EQUALS" as const };

  it("matches the registration's organization id: is, and is not", () => {
    expect(notificationApplies(isA, {}, null, "club-a")).toBe(true);
    expect(notificationApplies(isA, {}, null, "club-b")).toBe(false);
    expect(notificationApplies(isNotA, {}, null, "club-b")).toBe(true);
    expect(notificationApplies(isNotA, {}, null, "club-a")).toBe(false);
  });

  it("never matches \"is\" for a registration with no club (a Group registration), and always matches \"is not\"", () => {
    expect(notificationApplies(isA, {}, null, null)).toBe(false);
    expect(notificationApplies(isA, {}, null)).toBe(false);
    expect(notificationApplies(isNotA, {}, null, null)).toBe(true);
  });

  it("cannot be spoofed by an answer named like the club key, and leaves the location and answer conditions alone", () => {
    expect(notificationApplies(isA, { [CLUB_CONDITION_KEY]: "club-a" }, null, "club-b")).toBe(false);
    const desMoines = { fieldKey: LOCATION_CONDITION_KEY, operator: "EQUALS" as const, value: "loc-des-moines" };
    expect(notificationApplies(desMoines, {}, "loc-des-moines", "club-b")).toBe(true);
  });

  it("is an allowed condition key, and a stored club that is gone from the directory is not still allowed", () => {
    expect(isAllowedConditionKey(definition, CLUB_CONDITION_KEY)).toBe(true);
    expect(clubConditionStillExists({ conditionFieldKey: CLUB_CONDITION_KEY, conditionValue: "club-a" }, CLUB_IDS)).toBe(true);
    expect(clubConditionStillExists({ conditionFieldKey: CLUB_CONDITION_KEY, conditionValue: "club-gone" }, CLUB_IDS)).toBe(false);
    expect(clubConditionStillExists({ conditionFieldKey: CLUB_CONDITION_KEY, conditionValue: null }, CLUB_IDS)).toBe(false);
    expect(clubConditionStillExists({ conditionFieldKey: LOCATION_CONDITION_KEY, conditionValue: "loc-1" }, new Set())).toBe(true);
    expect(clubConditionStillExists({ conditionFieldKey: null, conditionValue: null }, new Set())).toBe(true);
  });
});

describe("limits and what a condition may look at (#1081)", () => {
  it("allows 10 notifications per form and 10 addresses each (Caleb's decision), and at least one address", () => {
    const one = { name: "Camping coordinator", recipients: ["a@example.test"] };
    expect(notificationsPutSchema.safeParse({ notifications: Array.from({ length: 10 }, () => one) }).success).toBe(true);
    expect(notificationsPutSchema.safeParse({ notifications: Array.from({ length: 11 }, () => one) }).success).toBe(false);
    expect(FORM_NOTIFICATIONS_MAX_PER_FORM).toBe(10);
    const ten = Array.from({ length: 10 }, (_, index) => `person${index}@example.test`);
    expect(checkNotificationRecipients(ten)).toEqual({ ok: true, emails: ten });
    expect(checkNotificationRecipients([...ten, "extra@example.test"]).ok).toBe(false);
    expect(checkNotificationRecipients([]).ok).toBe(false);
    expect(checkNotificationRecipients(["not-an-address"]).ok).toBe(false);
    expect(checkNotificationRecipients(["A@Example.test", "a@example.test"])).toEqual({ ok: true, emails: ["a@example.test"] });
  });

  it("offers only registration-level answers that the PDF would print, never a sensitive or attendee one", () => {
    const keys = conditionFieldChoices(definition).map((choice) => choice.key);
    expect(keys).toContain("partner_club");
    expect(keys).not.toContain("medical_or_accessibility_need");
    expect(keys).not.toContain("attendee_age");
    expect(keys).not.toContain("promo_code");
    expect(isAllowedConditionKey(definition, LOCATION_CONDITION_KEY)).toBe(true);
    expect(isAllowedConditionKey(definition, "medical_or_accessibility_need")).toBe(false);
    expect(isAllowedConditionKey(definition, "not_a_field")).toBe(false);
  });
});

describe("section filtering: the PDF renders only the chosen sections (#1081)", () => {
  const source = springCamporeeSource();

  it("renders only the included sections, with no fees", () => {
    const camping = buildRegistrationPdfModel(source, { sectionIds: [CAMPING] });
    expect(camping.sections.map((section) => section.title)).toEqual(["Camping"]);
    expect(camping.sections[0]!.rows.map((entry) => entry.label)).toContain("Number of tents and sizes");
    expect(camping.fees).toBeNull();
    const whole = buildRegistrationPdfModel(source);
    expect(whole.sections.length).toBeGreaterThan(1);
    expect(whole.fees).not.toBeNull();
    expect(buildRegistrationPdfModel(source, { sectionIds: [] })).toEqual(whole);
  });

  it("keeps the PDF's exclusion rules: nothing sensitive, no birth date, no promo code, whichever sections are chosen", () => {
    const text = JSON.stringify(buildRegistrationPdfModel(source, { sectionIds: [CLUB, CAMPING, ROSTER] }));
    expect(text).not.toContain("medical or accessibility");
    expect(text).not.toContain("SYNTHETIC10");
    // The allowlisted dietary answer still prints in the roster.
    expect(text).toContain("Synthetic: no peanuts");
  });

  it("tells a change in the included sections from a change elsewhere, and ignores the header", () => {
    const hash = (changed: RegistrationPdfSource, sections: string[]) => notificationContentHash(buildRegistrationPdfModel(changed, { sectionIds: sections }));
    const campingChanged = { ...source, registrationResponses: { ...source.registrationResponses, tents: "Six tents" } };
    expect(hash(campingChanged, [CAMPING])).not.toBe(hash(source, [CAMPING]));
    expect(hash(campingChanged, [ROSTER])).toBe(hash(source, [ROSTER]));
    // A new location, or a renamed club, is not a change to a section.
    const moved = { ...source, eventLocation: "Another Camp", clubName: "Renamed Club", registrantName: "Someone Else" };
    expect(hash(moved, [CAMPING])).toBe(hash(source, [CAMPING]));
  });
});

describe("queued held inside the submission's transaction (#1081)", () => {
  function fakeTx(rows: Row[]) {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      registrationFormNotification: { findMany: vi.fn().mockResolvedValue(rows) },
      adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
      messageOutbox: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `message-${created.length}`, status: data.status };
        }),
      },
    };
    return { tx, created };
  }

  const base = {
    eventId: "event-1",
    formId: "form-1",
    registrationId: "registration-1",
    correlationId: "correlation-1",
    definition,
    answers: { partner_club: "Oak Ridge Adventurers" } as Record<string, unknown>,
    locationId: "loc-des-moines" as string | null,
    locationName: "Des Moines",
    eventName: "Synthetic Camporee",
    registrantName: "Dana Sample",
    existingClubIds: new Set<string>() as ReadonlySet<string>,
  };

  it("queues only the notifications whose condition matches, one held message per address, with a retry-safe key", async () => {
    const { tx, created } = fakeTx([
      row({ id: "registration", recipients: ["staff@example.test", "second@example.test"] }),
      row({ id: "des-moines", conditionFieldKey: LOCATION_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "loc-des-moines" }),
      row({ id: "ames", conditionFieldKey: LOCATION_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "loc-ames" }),
      row({ id: "camping", sectionIds: [CAMPING], conditionFieldKey: "partner_club", conditionOperator: "EQUALS", conditionValue: "Oak Ridge Adventurers" }),
    ]);
    const before = Date.now();
    const result = await queueFormNotificationsForSubmission(tx as never, { ...base, enabled: true });
    expect(result.groups.map((group) => group.notificationId)).toEqual(["registration", "des-moines", "camping"]);
    expect(created.map((message) => message.idempotencyKey)).toEqual([
      "form-notification:registration:registration-1:initial:staff@example.test",
      "form-notification:registration:registration-1:initial:second@example.test",
      "form-notification:des-moines:registration-1:initial:des-moines@example.test",
      "form-notification:camping:registration-1:initial:camping@example.test",
    ]);
    for (const message of created) {
      expect(message.status).toBe("PENDING");
      expect(message.recipientKind).toBe("INTERNAL");
      // Held until the PDF is attached after the commit.
      expect((message.availableAt as Date).getTime()).toBeGreaterThan(before + 60_000);
      // A short summary: no answer is ever in the email.
      expect(String(message.bodyTextSnapshot)).not.toContain("Oak Ridge");
      expect(String(message.bodyTextSnapshot)).toContain("Dana Sample");
    }
    expect(String(created[3]!.bodyTextSnapshot)).toContain("Includes: Camping");
    expect(result.pendingMessageIds).toHaveLength(4);
  });

  it("routes by club at submission, skips a removed club, and gives a registration with no club only the \"is not\" ones (#1097)", async () => {
    const clubRows = () => [
      row({ id: "is-a", conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "club-a" }),
      row({ id: "is-b", conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "club-b" }),
      row({ id: "not-a", conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: "NOT_EQUALS", conditionValue: "club-a" }),
      row({ id: "removed", conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: "NOT_EQUALS", conditionValue: "club-gone" }),
    ];
    const run = async (organizationId: string | null) => {
      const { tx } = fakeTx(clubRows());
      // No organization table on the transaction's client: the existing clubs are read before it opens and passed in.
      const result = await queueFormNotificationsForSubmission(tx as never, { ...base, enabled: true, organizationId, existingClubIds: CLUB_IDS });
      expect(tx).not.toHaveProperty("organization");
      return result.groups.map((group) => group.notificationId);
    };
    // The removed club's notification is skipped even though "is not" would otherwise match everyone.
    expect(await run("club-a")).toEqual(["is-a"]);
    expect(await run("club-b")).toEqual(["is-b", "not-a"]);
    expect(await run(null)).toEqual(["not-a"]);
  });

  it("queues nothing, and reads nothing, when the platform switch is off", async () => {
    const { tx } = fakeTx([row({ id: "registration" })]);
    const result = await queueFormNotificationsForSubmission(tx as never, { ...base, enabled: false });
    expect(result.groups).toEqual([]);
    expect(tx.registrationFormNotification.findMany).not.toHaveBeenCalled();
    expect(tx.messageOutbox.create).not.toHaveBeenCalled();
  });

  it("records a paused event's messages as suppressed and never holds them", async () => {
    mocks.loadEventEmailSettings.mockResolvedValue(pausedSettings);
    const { tx, created } = fakeTx([row({ id: "registration" })]);
    const result = await queueFormNotificationsForSubmission(tx as never, { ...base, enabled: true });
    expect(created[0]!.status).toBe("SUPPRESSED");
    expect(created[0]!.availableAt).toBeUndefined();
    expect(String(created[0]!.lastError)).toContain("paused");
    expect(result.groups).toEqual([]);
    expect(result.pendingMessageIds).toEqual([]);
  });
});

describe("the PDFs are made after the commit and a failure never fails the registration (#1081)", () => {
  function database() {
    const attachments: Array<Record<string, unknown>> = [];
    const outbox = { updateMany: vi.fn().mockResolvedValue({ count: 1 }) };
    const deliveries = { upsert: vi.fn().mockResolvedValue({}) };
    const db = {
      registrationFormNotification: {
        findMany: vi.fn().mockResolvedValue([
          row({ id: "registration" }),
          row({ id: "camping", name: "Camping coordinator", sectionIds: [CAMPING] }),
        ]),
      },
      registration: { findFirst: vi.fn().mockResolvedValue({ status: "CONFIRMED", locationId: null, submittedAt: new Date("2027-02-01T00:00:00Z"), location: null, publicFormSubmission: { formVersion: { formId: "form-1" } } }) },
      messageAttachment: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          attachments.push(data);
          return { id: `attachment-${attachments.length}` };
        }),
      },
      adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
      messageOutbox: outbox,
      registrationNotificationDelivery: deliveries,
      registrationPdfDocument: { findFirst: mocks.latestDocument },
      registrationFormVersion: { findMany: mocks.versions },
    };
    mocks.getPrisma.mockReturnValue(db);
    return { db, attachments, outbox, deliveries };
  }

  const groups = [
    { notificationId: "registration", messageIds: ["m1"] },
    { notificationId: "camping", messageIds: ["m2", "m3"] },
  ];

  beforeEach(() => {
    mocks.loadSource.mockResolvedValue({
      source: springCamporeeSource(),
      timezone: "America/Chicago",
      eventName: "Synthetic Camporee",
      clubName: "Maple Grove Pathfinders",
      registrantName: "Dana Sample",
      formVersionId: "version-1",
    });
  });

  it("attaches a PDF per notification, filtered to its sections, records the baseline, and releases the hold", async () => {
    const { attachments, outbox, deliveries } = database();
    await finishFormNotificationsAfterSubmit({ eventId: "event-1", registrationId: "registration-1", groups });
    // The whole-registration notification reuses the #1082 PDF; only the camping copy is stored.
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.contentType).toBe("application/pdf");
    expect(Buffer.isBuffer(attachments[0]!.content)).toBe(true);
    expect(String(attachments[0]!.filename)).toContain("Camping-coordinator");
    const attachCalls = outbox.updateMany.mock.calls.filter(([call]) => (call as { data: Record<string, unknown> }).data.attachmentId);
    expect(attachCalls.map(([call]) => (call as { where: { id: { in: string[] } } }).where.id.in)).toEqual([["m1"], ["m2", "m3"]]);
    expect(attachCalls.map(([call]) => (call as { data: { attachmentId: string } }).data.attachmentId)).toEqual(["registration-pdf", "attachment-1"]);
    expect(String((attachCalls[1]![0] as { data: { bodyTextSnapshot: string } }).data.bodyTextSnapshot)).toContain("The details are in the attached PDF.");
    expect(deliveries.upsert).toHaveBeenCalledTimes(2);
    // The last call releases every held message.
    const release = outbox.updateMany.mock.calls.at(-1)![0] as { where: { id: { in: string[] } }; data: { availableAt: Date } };
    expect(release.where.id.in).toEqual(["m1", "m2", "m3"]);
    expect(release.data.availableAt).toBeInstanceOf(Date);
  });

  it("releases the held messages without a PDF when it cannot be made, and does not throw", async () => {
    const { outbox, attachments } = database();
    mocks.latestDocument.mockRejectedValue(new Error("synthetic failure"));
    mocks.render.mockRejectedValue(new Error("synthetic render failure"));
    await expect(finishFormNotificationsAfterSubmit({ eventId: "event-1", registrationId: "registration-1", groups })).resolves.toBeUndefined();
    expect(attachments).toHaveLength(0);
    const release = outbox.updateMany.mock.calls.at(-1)![0] as { where: { id: { in: string[] } } };
    expect(release.where.id.in).toEqual(["m1", "m2", "m3"]);
    expect(mocks.logError).toHaveBeenCalled();
  });

  it("releases them even when the registration cannot be loaded at all", async () => {
    const { outbox } = database();
    mocks.loadSource.mockRejectedValue(new Error("synthetic database failure"));
    await expect(finishFormNotificationsAfterSubmit({ eventId: "event-1", registrationId: "registration-1", groups })).resolves.toBeUndefined();
    expect(outbox.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe("re-send on a later change (#1081)", () => {
  const change = { eventId: "event-1", registrationId: "registration-1", changeKey: "amendment:op-1", correlationId: "correlation-1" };
  const sourceNow = springCamporeeSource();
  const hashOf = (source: RegistrationPdfSource, sections: string[]) => notificationContentHash(buildRegistrationPdfModel(source, { sectionIds: sections }));
  const delivered = (source: RegistrationPdfSource, sections: string[]) => ({ contentHash: hashOf(source, sections), sectionSignature: [...sections].sort().join(",") });

  function database(rows: Row[], facts: Partial<{ status: string; locationId: string | null; submittedAt: Date; clubRegistration: { organizationId: string } | null }> = {}) {
    const created: Array<Record<string, unknown>> = [];
    const deliveries = { upsert: vi.fn().mockResolvedValue({}) };
    const tx = {
      adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
      messageOutbox: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `message-${created.length}`, status: data.status };
        }),
      },
    };
    const db = {
      registrationFormNotification: { findMany: vi.fn().mockResolvedValue(rows) },
      registration: {
        findFirst: vi.fn().mockResolvedValue({
          status: "CONFIRMED",
          locationId: null,
          submittedAt: new Date("2027-02-01T00:00:00Z"),
          location: null,
          publicFormSubmission: { formVersion: { formId: "form-1" } },
          ...facts,
        }),
      },
      messageAttachment: { create: vi.fn(async () => ({ id: "attachment-1" })) },
      adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
      messageOutbox: { findMany: vi.fn().mockResolvedValue([]) },
      organization: organizationLookup(),
      registrationNotificationDelivery: deliveries,
      registrationPdfDocument: { findFirst: mocks.latestDocument },
      registrationFormVersion: { findMany: mocks.versions },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(tx)),
    };
    mocks.getPrisma.mockReturnValue(db);
    return { db, created, deliveries };
  }

  function currentSource(source: RegistrationPdfSource) {
    mocks.loadSource.mockResolvedValue({ source, timezone: "America/Chicago", eventName: "Synthetic Camporee", clubName: "Maple Grove Pathfinders", registrantName: "Dana Sample", formVersionId: "version-1" });
  }

  it("does nothing, and reads nothing, when the switch is off", async () => {
    mocks.switchEnabled.mockResolvedValue(false);
    const { db } = database([row({ id: "registration" })]);
    await notifyFormNotificationsAfterChange(change);
    expect(db.registration.findFirst).not.toHaveBeenCalled();
    expect(mocks.processQueued).toHaveBeenCalledWith([]);
  });

  it("re-sends only the notification whose included sections changed, marked Updated, with the new filtered PDF", async () => {
    const changed = { ...sourceNow, registrationResponses: { ...sourceNow.registrationResponses, tents: "Six tents, one 10x20 canopy" } };
    currentSource(changed);
    const { created, deliveries, db } = database([
      row({ id: "camping", sectionIds: [CAMPING], deliveries: [delivered(sourceNow, [CAMPING])] }),
      row({ id: "roster", sectionIds: [ROSTER], deliveries: [delivered(sourceNow, [ROSTER])] }),
      row({ id: "club", sectionIds: [CLUB], deliveries: [delivered(sourceNow, [CLUB])] }),
    ]);
    await notifyFormNotificationsAfterChange(change);
    expect(created).toHaveLength(1);
    expect(created[0]!.recipientEmail).toBe("camping@example.test");
    expect(String(created[0]!.subjectSnapshot)).toMatch(/^Updated: /);
    expect(created[0]!.attachmentId).toBe("attachment-1");
    expect(created[0]!.idempotencyKey).toBe("form-notification:camping:registration-1:amendment:op-1:camping@example.test");
    // No answer in the email body.
    expect(String(created[0]!.bodyTextSnapshot)).not.toContain("Six tents");
    expect(db.messageAttachment.create).toHaveBeenCalledTimes(1);
    expect(String((db.messageAttachment.create.mock.calls[0] as unknown as [{ data: { filename: string } }])[0].data.filename)).toMatch(/UPDATED\.pdf$/);
    expect(deliveries.upsert).toHaveBeenCalledTimes(1);
    expect(deliveries.upsert.mock.calls[0]![0].update.sendCount).toEqual({ increment: 1 });
    expect(mocks.processQueued).toHaveBeenCalledWith(["message-1"]);
  });

  it("sends nothing when nothing in any included section changed (a no-op save, or only the header moved)", async () => {
    currentSource({ ...sourceNow, eventLocation: "A different camp" });
    const { created } = database([
      row({ id: "whole", deliveries: [delivered(sourceNow, [])] }),
      row({ id: "camping", sectionIds: [CAMPING], deliveries: [delivered(sourceNow, [CAMPING])] }),
    ]);
    await notifyFormNotificationsAfterChange(change);
    expect(created).toEqual([]);
  });

  it("on a location change sends the new location's notification as a first one, and not the old location's", async () => {
    currentSource(sourceNow);
    const atDesMoines = { conditionFieldKey: LOCATION_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "loc-des-moines" };
    const atAmes = { conditionFieldKey: LOCATION_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "loc-ames" };
    // The registration moved from Des Moines to Ames; the Des Moines notification already sent for it.
    const { created } = database([
      row({ id: "des-moines", ...atDesMoines, deliveries: [delivered(sourceNow, [])] }),
      row({ id: "ames", ...atAmes }),
    ], { locationId: "loc-ames" });
    await notifyFormNotificationsAfterChange(change);
    expect(created.map((message) => message.recipientEmail)).toEqual(["ames@example.test"]);
    expect(String(created[0]!.subjectSnapshot)).not.toMatch(/^Updated/);
  });

  it("on a club change sends the new club's notification as a first one, and not the old club's; a removed club sends nothing (#1097)", async () => {
    currentSource(sourceNow);
    const forClub = (id: string, clubId: string, operator = "EQUALS") => ({ conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: operator, conditionValue: clubId, id });
    // The registration moved from club A to club B; club A's notification already sent for it.
    const { created } = database([
      row({ ...forClub("club-a", "club-a"), deliveries: [delivered(sourceNow, [])] }),
      row(forClub("club-b", "club-b")),
      row(forClub("club-gone", "club-gone", "NOT_EQUALS")),
    ], { clubRegistration: { organizationId: "club-b" } });
    await notifyFormNotificationsAfterChange(change);
    expect(created.map((message) => message.recipientEmail)).toEqual(["club-b@example.test"]);
    expect(String(created[0]!.subjectSnapshot)).not.toMatch(/^Updated/);
  });

  it("does not start a notification made after the registration, and starts a new baseline when its sections were edited", async () => {
    const changed = { ...sourceNow, registrationResponses: { ...sourceNow.registrationResponses, tents: "Seven tents" } };
    currentSource(changed);
    const { created, deliveries } = database([
      row({ id: "later", createdAt: new Date("2027-03-01T00:00:00Z") }),
      row({ id: "edited", sectionIds: [CAMPING], deliveries: [{ contentHash: "old", sectionSignature: "some-other-section" }] }),
    ]);
    await notifyFormNotificationsAfterChange(change);
    expect(created).toEqual([]);
    expect(deliveries.upsert).toHaveBeenCalledTimes(1);
    expect(deliveries.upsert.mock.calls[0]![0].update.sendCount).toBeUndefined();
  });

  it("says nothing for a waitlisted registration", async () => {
    currentSource(sourceNow);
    const { created } = database([row({ id: "registration" })], { status: "WAITLISTED" });
    await notifyFormNotificationsAfterChange(change);
    expect(created).toEqual([]);
  });

  it("on a paused event records suppressed messages, sends nothing, and keeps the baseline so a later change still tells them", async () => {
    mocks.loadEventEmailSettings.mockResolvedValue(pausedSettings);
    const changed = { ...sourceNow, registrationResponses: { ...sourceNow.registrationResponses, tents: "Eight tents" } };
    currentSource(changed);
    const { created, deliveries } = database([row({ id: "camping", sectionIds: [CAMPING], deliveries: [delivered(sourceNow, [CAMPING])] })]);
    await notifyFormNotificationsAfterChange(change);
    expect(created).toHaveLength(1);
    expect(created[0]!.status).toBe("SUPPRESSED");
    expect(deliveries.upsert).not.toHaveBeenCalled();
    expect(mocks.processQueued).toHaveBeenCalledWith([]);
  });

  it("never throws, and logs ids only, when something fails", async () => {
    mocks.getPrisma.mockImplementation(() => {
      throw new Error("synthetic database failure");
    });
    await expect(notifyFormNotificationsAfterChange(change)).resolves.toBeUndefined();
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), expect.any(Error), { registrationId: "registration-1" });
  });
});

describe("review fixes (#1081)", () => {
  const change = { eventId: "event-1", registrationId: "registration-1", changeKey: "amendment:op-9", correlationId: "correlation-9" };
  const sourceNow = springCamporeeSource();

  function changeDatabase(rows: Row[], existingKeys = 0) {
    const created: Array<Record<string, unknown>> = [];
    const deliveries = { upsert: vi.fn().mockResolvedValue({}) };
    const tx = {
      adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
      messageOutbox: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `message-${created.length}`, status: data.status };
        }),
      },
    };
    const db = {
      registrationFormNotification: { findMany: vi.fn().mockResolvedValue(rows) },
      registration: { findFirst: vi.fn().mockResolvedValue({ status: "CONFIRMED", locationId: null, submittedAt: new Date("2027-02-01T00:00:00Z"), location: null, publicFormSubmission: { formVersion: { formId: "form-1" } } }) },
      messageAttachment: { create: vi.fn(async () => ({ id: "stored-attachment" })) },
      adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
      messageOutbox: { findMany: vi.fn().mockResolvedValue(Array.from({ length: existingKeys }, (_, index) => ({ id: `old-${index}` }))) },
      registrationNotificationDelivery: deliveries,
      registrationPdfDocument: { findFirst: mocks.latestDocument },
      registrationFormVersion: { findMany: mocks.versions },
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(tx)),
    };
    mocks.getPrisma.mockReturnValue(db);
    mocks.loadSource.mockResolvedValue({ source: sourceNow, timezone: "America/Chicago", eventName: "Synthetic Camporee", clubName: "Maple Grove Pathfinders", registrantName: "Dana Sample", formVersionId: "version-1" });
    return { db, created, deliveries, tx };
  }

  const never = (sections: string[] = []) => ({ createdAt: new Date("2027-01-01T00:00:00Z"), sectionIds: sections });

  it("skips a stored condition that is no longer allowed (a sensitive or removed question), at submit and on a change", async () => {
    const rows = [
      row({ id: "now-sensitive", conditionFieldKey: "medical_or_accessibility_need", conditionOperator: "NOT_EQUALS", conditionValue: "zzz" }),
      row({ id: "removed", conditionFieldKey: "gone_field", conditionOperator: "NOT_EQUALS", conditionValue: "zzz" }),
      row({ id: "fine" }),
    ];
    const tx = {
      registrationFormNotification: { findMany: vi.fn().mockResolvedValue(rows) },
      adminAlertFeedItem: { createMany: vi.fn(async () => ({ count: 1 })) },
      messageOutbox: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `m-${String(data.recipientEmail)}`, status: "PENDING" })) },
    };
    const submitted = await queueFormNotificationsForSubmission(tx as never, {
      enabled: true, eventId: "event-1", formId: "form-1", registrationId: "registration-1", correlationId: "c", definition,
      answers: {}, locationId: null, locationName: null, eventName: "Synthetic Camporee", registrantName: "Dana Sample", existingClubIds: new Set<string>(),
    });
    expect(submitted.groups.map((group) => group.notificationId)).toEqual(["fine"]);

    const { created } = changeDatabase(rows);
    await notifyFormNotificationsAfterChange(change);
    expect(created.map((message) => message.recipientEmail)).toEqual(["fine@example.test"]);
  });

  it("never widens: when none of the chosen sections are in the registration's version, it sends the summary with no PDF", async () => {
    const { created, db } = changeDatabase([row({ id: "stale", ...never(["section_from_a_draft"]) })]);
    await notifyFormNotificationsAfterChange(change);
    expect(created).toHaveLength(1);
    expect(created[0]!.attachmentId).toBeUndefined();
    expect(db.messageAttachment.create).not.toHaveBeenCalled();
    expect(mocks.latestDocument).not.toHaveBeenCalled();
    expect(String(created[0]!.bodyTextSnapshot)).toContain("None of the sections chosen for this notification were in this registration's form version, so there is no PDF");
    expect(String(created[0]!.bodyTextSnapshot)).not.toContain("The details are in the attached PDF");
  });

  it("skips a notification whose condition is sensitive in the form's latest published version, even for a registration on an older version", async () => {
    const stricter = {
      ...definition,
      sections: definition.sections.map((section) => ({
        ...section,
        fields: section.fields.map((field) => (field.key === "partner_club" ? { ...field, sensitive: true } : field)),
      })),
    };
    const rows = [row({ id: "routed", conditionFieldKey: "partner_club", conditionOperator: "EQUALS", conditionValue: "Oak Ridge Adventurers" }), row({ id: "plain" })];
    // Allowed in the registration's own version: sent.
    const before = changeDatabase(rows);
    await notifyFormNotificationsAfterChange(change);
    expect(before.created.map((message) => message.recipientEmail)).toEqual(["routed@example.test", "plain@example.test"]);
    // Sensitive in published v2: skipped.
    mocks.versions.mockResolvedValue([{ definition: stricter }]);
    const after = changeDatabase(rows);
    mocks.versions.mockResolvedValue([{ definition: stricter }]);
    await notifyFormNotificationsAfterChange(change);
    expect(after.created.map((message) => message.recipientEmail)).toEqual(["plain@example.test"]);
  });

  it("reuses the registration PDF only when its Updated mark matches, and otherwise renders its own copy", async () => {
    // The stored PDF is a first copy; an Updated send needs an UPDATED-marked one.
    const changed = { ...sourceNow, registrationResponses: { ...sourceNow.registrationResponses, tents: "Nine tents" } };
    const whole = notificationContentHash(buildRegistrationPdfModel(sourceNow));
    const { created, db } = changeDatabase([row({ id: "whole", deliveries: [{ contentHash: whole, sectionSignature: "" }] })]);
    mocks.loadSource.mockResolvedValue({ source: changed, timezone: "America/Chicago", eventName: "Synthetic Camporee", clubName: "Maple Grove Pathfinders", registrantName: "Dana Sample", formVersionId: "version-1" });
    mocks.latestDocument.mockResolvedValue({ attachmentId: "registration-pdf", updated: false, contentHash: registrationPdfContentHash(buildRegistrationPdfModel(changed)) });
    await notifyFormNotificationsAfterChange(change);
    expect(String(created[0]!.subjectSnapshot)).toMatch(/^Updated: /);
    expect(created[0]!.attachmentId).toBe("stored-attachment");
    expect((db.messageAttachment.create.mock.calls[0] as unknown as [{ data: { filename: string } }])[0].data.filename).toMatch(/UPDATED\.pdf$/);

    // A stored Updated copy that matches is reused, and nothing is stored.
    mocks.latestDocument.mockResolvedValue({ attachmentId: "registration-pdf", updated: true, contentHash: registrationPdfContentHash(buildRegistrationPdfModel(changed)) });
    const again = changeDatabase([row({ id: "whole", deliveries: [{ contentHash: whole, sectionSignature: "" }] })]);
    mocks.loadSource.mockResolvedValue({ source: changed, timezone: "America/Chicago", eventName: "Synthetic Camporee", clubName: "Maple Grove Pathfinders", registrantName: "Dana Sample", formVersionId: "version-1" });
    await notifyFormNotificationsAfterChange(change);
    expect(again.created[0]!.attachmentId).toBe("registration-pdf");
    expect(again.db.messageAttachment.create).not.toHaveBeenCalled();
  });

  it("does not advance the baseline when the rows found for the change were recorded as suppressed", async () => {
    const suppressed = changeDatabase([row({ id: "a", ...never([CAMPING]) })]);
    suppressed.db.messageOutbox.findMany.mockResolvedValue([{ id: "old-0", status: "SUPPRESSED" }]);
    await notifyFormNotificationsAfterChange(change);
    expect(suppressed.deliveries.upsert).not.toHaveBeenCalled();
    expect(suppressed.created).toEqual([]);
  });

  it("stores one PDF per distinct set of sections, and reuses the registration PDF for an unfiltered notification", async () => {
    const { created, db } = changeDatabase([
      row({ id: "a", ...never([CAMPING]) }),
      row({ id: "b", ...never([CAMPING]) }),
      row({ id: "c" }),
    ]);
    await notifyFormNotificationsAfterChange(change);
    expect(created).toHaveLength(3);
    expect(db.messageAttachment.create).toHaveBeenCalledTimes(1);
    expect(created.map((message) => message.attachmentId)).toEqual(["stored-attachment", "stored-attachment", "registration-pdf"]);
    expect(mocks.latestDocument).toHaveBeenCalledTimes(1);
  });

  it("stores no PDF for a paused event, and none again for a retry of the same change", async () => {
    mocks.loadEventEmailSettings.mockResolvedValue(pausedSettings);
    const paused = changeDatabase([row({ id: "a", ...never([CAMPING]) }), row({ id: "b" })]);
    await notifyFormNotificationsAfterChange(change);
    expect(paused.db.messageAttachment.create).not.toHaveBeenCalled();
    expect(mocks.latestDocument).not.toHaveBeenCalled();
    expect(paused.created.every((message) => message.status === "SUPPRESSED" && message.attachmentId === undefined)).toBe(true);

    mocks.loadEventEmailSettings.mockResolvedValue(normalSettings);
    const retry = changeDatabase([row({ id: "a", ...never([CAMPING]) })], 1);
    await notifyFormNotificationsAfterChange(change);
    expect(retry.db.messageAttachment.create).not.toHaveBeenCalled();
    expect(retry.created).toEqual([]);
  });

  it("records the notification as sent only when a new message was actually created", async () => {
    const raced = changeDatabase([row({ id: "a", ...never([CAMPING]) })]);
    raced.tx.messageOutbox.findUnique.mockResolvedValue({ id: "already-there", status: "PENDING" });
    await notifyFormNotificationsAfterChange(change);
    expect(raced.created).toEqual([]);
    expect(raced.deliveries.upsert).not.toHaveBeenCalled();
  });

  it("shows a warning on a notification whose condition is no longer allowed, or that exists only in a draft", async () => {
    const { getFormNotificationsPanel } = await import("@/modules/registration-form-notifications/repository");
    const draftOnly = { ...definition, sections: [...definition.sections, { ...definition.sections[0]!, id: "section_draft_only", title: "Draft only" }] };
    mocks.getPrisma.mockReturnValue({
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue({
          id: "form-1",
          versions: [{ definition: draftOnly, status: "DRAFT" }, { definition, status: "PUBLISHED" }],
          notifications: [
            row({ id: "sensitive", conditionFieldKey: "medical_or_accessibility_need", conditionOperator: "EQUALS", conditionValue: "Yes" }),
            row({ id: "draft", sectionIds: ["section_draft_only"] }),
            row({ id: "clean", sectionIds: [CAMPING] }),
          ],
        }),
      },
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ audience: "GENERAL" }) },
      organization: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const panel = await getFormNotificationsPanel("event-1", "form-1");
    const byId = new Map(panel.notifications.map((entry) => [entry.id, entry.warnings]));
    expect(byId.get("sensitive")![0]).toContain("not being sent");
    expect(byId.get("draft")![0]).toContain("only in the unpublished draft");
    expect(byId.get("clean")).toEqual([]);
  });

  it("says a condition that only the draft disallows will stop being sent once the draft is published", async () => {
    const { getFormNotificationsPanel } = await import("@/modules/registration-form-notifications/repository");
    const stricter = {
      ...definition,
      sections: definition.sections.map((section) => ({ ...section, fields: section.fields.map((field) => (field.key === "partner_club" ? { ...field, sensitive: true } : field)) })),
    };
    mocks.getPrisma.mockReturnValue({
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue({
          id: "form-1",
          versions: [{ definition: stricter, status: "DRAFT" }, { definition, status: "PUBLISHED" }],
          notifications: [row({ id: "routed", conditionFieldKey: "partner_club", conditionOperator: "EQUALS", conditionValue: "Oak Ridge Adventurers" })],
        }),
      },
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ audience: "GENERAL" }) },
      organization: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const panel = await getFormNotificationsPanel("event-1", "form-1");
    expect(panel.notifications[0]!.warnings[0]).toContain("will stop being sent once the draft is published");
  });
});

describe("the panel's clubs (#1097)", () => {
  it("offers the directory's active clubs on a club event, flags a stored club that no longer exists, and never exposes an id as a name", async () => {
    const { getFormNotificationsPanel } = await import("@/modules/registration-form-notifications/repository");
    mocks.getPrisma.mockReturnValue({
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue({
          id: "form-1",
          versions: [{ definition, status: "PUBLISHED" }],
          notifications: [
            row({ id: "kept", conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "club-a" }),
            row({ id: "gone", conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "club-gone" }),
          ],
        }),
      },
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ audience: "CLUB" }) },
      organization: {
        findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] }; isActive?: boolean } }) => (where.id
          ? where.id.in.filter((id) => CLUB_IDS.has(id)).map((id) => ({ id, name: `Club ${id}` }))
          : [{ id: "club-a", name: "Club club-a" }, { id: "club-b", name: "Club club-b" }])),
      },
    });
    const panel = await getFormNotificationsPanel("event-1", "form-1");
    expect(panel.clubs.map((club) => club.name)).toEqual(["Club club-a", "Club club-b"]);
    const byId = new Map(panel.notifications.map((entry) => [entry.id, entry]));
    expect(byId.get("kept")!.clubRemoved).toBe(false);
    expect(byId.get("gone")!.clubRemoved).toBe(true);
    expect(byId.get("gone")!.warnings.join(" ")).toContain("club was removed");
  });

  it("offers no clubs on an event whose registrations carry none", async () => {
    const { getFormNotificationsPanel } = await import("@/modules/registration-form-notifications/repository");
    const organization = { findMany: vi.fn().mockResolvedValue([]) };
    mocks.getPrisma.mockReturnValue({
      registrationForm: { findFirst: vi.fn().mockResolvedValue({ id: "form-1", versions: [{ definition, status: "PUBLISHED" }], notifications: [] }) },
      eventLocation: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ audience: "GENERAL" }) },
      organization,
    });
    expect((await getFormNotificationsPanel("event-1", "form-1")).clubs).toEqual([]);
    expect(organization.findMany).not.toHaveBeenCalled();
  });
});

describe("saving a form's notifications (#1081)", () => {
  function database(options: { existing?: Row[] } = {}) {
    const tx = {
      registrationFormNotification: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockResolvedValue({ id: "created-1" }),
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const db = {
      registrationForm: {
        findFirst: vi.fn().mockResolvedValue({ id: "form-1", versions: [{ definition }], notifications: options.existing ?? [row({ id: "existing-1" })] }),
      },
      eventLocation: { findMany: vi.fn().mockResolvedValue([{ id: "loc-des-moines", name: "Des Moines" }]) },
      event: { findUnique: vi.fn().mockResolvedValue({ audience: "CLUB" }) },
      organization: organizationLookup(),
      $transaction: vi.fn(async (callback: (client: unknown) => unknown) => callback(tx)),
    };
    mocks.getPrisma.mockReturnValue(db);
    return { db, tx };
  }

  const valid = { name: "Camping coordinator", recipients: ["camping@example.test", "second@example.test"], condition: null, sectionIds: [CAMPING] };

  async function fails(notification: unknown, text: RegExp) {
    database();
    await expect(replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [notification] })).rejects.toThrow(text);
  }

  it("lets an old saved recipient through on a re-save, but not the same text on another notification or a new bad one (#1193)", async () => {
    const { tx } = database({ existing: [row({ id: "existing-1", recipients: ["old@odd-domain"] })] });
    await replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [{ ...valid, id: "existing-1", recipients: ["old@odd-domain", "new@example.test"] }] });
    expect(tx.registrationFormNotification.update).toHaveBeenCalledTimes(1);
    for (const notification of [{ ...valid, recipients: ["old@odd-domain"] }, { ...valid, id: "existing-1", recipients: ["not an email"] }]) {
      database({ existing: [row({ id: "existing-1", recipients: ["old@odd-domain"] })] });
      const error = await replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [notification] }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FormNotificationError);
      expect((error as Error).message).toMatch(/Address 1: Enter a valid email address/);
      expect((error as Error).message).not.toMatch(/odd-domain|not an email/);
    }
  });

  it("saves, keeps ids, and audits ids and counts only", async () => {
    const { tx } = database();
    await replaceFormNotifications("event-1", "form-1", "user-1", {
      notifications: [
        { ...valid, id: "existing-1", condition: { fieldKey: LOCATION_CONDITION_KEY, operator: "EQUALS", value: "loc-des-moines" } },
        { name: "Registration staff", recipients: ["staff@example.test"], condition: null, sectionIds: [] },
      ],
    });
    expect(tx.registrationFormNotification.update).toHaveBeenCalledTimes(1);
    expect(tx.registrationFormNotification.create).toHaveBeenCalledTimes(1);
    expect(tx.registrationFormNotification.deleteMany).toHaveBeenCalledWith({ where: { formId: "form-1", id: { notIn: ["existing-1"] } } });
    const [entry] = mocks.writeAuditLog.mock.calls[0] as [{ action: string; metadata: Record<string, unknown>; actorUserId: string }];
    expect(entry.action).toBe("REGISTRATION_FORM_NOTIFICATIONS_CHANGED");
    expect(entry.actorUserId).toBe("user-1");
    expect(entry.metadata).toEqual({
      formId: "form-1",
      notificationIds: ["existing-1", "created-1"],
      notificationCount: 2,
      removedCount: 1,
      recipientCount: 3,
      conditionCount: 1,
      sectionFilterCount: 1,
    });
    const logged = JSON.stringify(mocks.writeAuditLog.mock.calls);
    expect(logged).not.toContain("example.test");
    expect(logged).not.toContain("Camping coordinator");
    expect(logged).not.toContain("loc-des-moines");
  });

  it("checks everything on the server: addresses, limits, the condition, locations and sections", async () => {
    await fails({ ...valid, recipients: [] }, /at least one email/);
    await fails({ ...valid, recipients: ["nope"] }, /Enter a valid email address/);
    await fails({ ...valid, recipients: Array.from({ length: 11 }, (_, index) => `p${index}@example.test`) }, /at most 10/);
    await fails({ ...valid, condition: { fieldKey: "medical_or_accessibility_need", operator: "EQUALS", value: "Yes" } }, /choose a question from the list/);
    await fails({ ...valid, condition: { fieldKey: LOCATION_CONDITION_KEY, operator: "EQUALS", value: "loc-elsewhere" } }, /event's locations/);
    await fails({ ...valid, sectionIds: ["section_not_in_this_form"] }, /not in this form/);
    await fails({ ...valid, id: "someone-elses-notification" }, /no longer exists/);
    database();
    await expect(replaceFormNotifications("event-1", "form-1", "user-1", { notifications: Array.from({ length: 11 }, () => valid) })).rejects.toBeInstanceOf(FormNotificationError);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it("checks a Club condition's value against the real club organizations, never the client (#1097)", async () => {
    const club = (value: string) => ({ ...valid, condition: { fieldKey: CLUB_CONDITION_KEY, operator: "EQUALS", value } });
    // Not an organization at all, and an organization that is not a club (the lookup filters on type CLUB, so it is not found).
    await fails(club("organization-that-does-not-exist"), /clubs in the directory/);
    await fails(club("church-1"), /clubs in the directory/);
    const { db, tx } = database();
    await replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [club("club-a")] });
    expect(db.organization.findMany).toHaveBeenCalledWith({ where: { id: { in: ["club-a"] }, type: "CLUB" }, select: { id: true } });
    expect(tx.registrationFormNotification.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ conditionFieldKey: CLUB_CONDITION_KEY, conditionValue: "club-a" }) }));
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls)).not.toContain("club-a");
  });

  it("refuses a NEW Club condition on an event whose registrations carry no club, but lets a stored one be re-saved (#1097)", async () => {
    const club = { ...valid, condition: { fieldKey: CLUB_CONDITION_KEY, operator: "EQUALS", value: "club-a" } };
    const general = (existing: Row[]) => {
      const { db } = database({ existing });
      db.event.findUnique.mockResolvedValue({ audience: "GENERAL" });
    };
    general([row({ id: "existing-1" })]);
    await expect(replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [club] })).rejects.toThrow(/do not have a club/);
    // A stored notification that already routes on a club (the event changed since) is not locked out of saving.
    general([row({ id: "existing-1", conditionFieldKey: CLUB_CONDITION_KEY, conditionOperator: "EQUALS", conditionValue: "club-a" })]);
    await expect(replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [{ ...club, id: "existing-1" }] })).resolves.toBeDefined();
    // An id naming a notification that is NOT a stored club one does not slip past.
    general([row({ id: "existing-1" })]);
    await expect(replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [{ ...club, id: "existing-1" }] })).rejects.toThrow(/do not have a club/);
  });

  it("refuses a notification listed twice, and reports one deleted since the load as a handled error, not a crash", async () => {
    database();
    await expect(replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [{ ...valid, id: "existing-1" }, { ...valid, id: "existing-1" }] })).rejects.toThrow(/listed twice/);
    const { Prisma } = await import("@prisma/client");
    const { tx } = database();
    tx.registrationFormNotification.update.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("missing", { code: "P2025", clientVersion: "test" }));
    await expect(replaceFormNotifications("event-1", "form-1", "user-1", { notifications: [{ ...valid, id: "existing-1" }] })).rejects.toBeInstanceOf(FormNotificationError);
  });
});

describe("wiring (#1081)", () => {
  const root = path.resolve(__dirname, "..");
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");

  it("queues inside the submission transaction, builds PDFs after the commit, and reads the switch before it", () => {
    const source = read("modules/forms/public-repository.ts");
    expect(source).toMatch(/isNotificationEnabled\(\s*"REGISTRATION_FORM_NOTIFICATIONS"\s*\)/);
    expect(source.indexOf("queueFormNotificationsForSubmission(tx")).toBeGreaterThan(source.indexOf("async function createPublicRegistrationTransaction"));
    expect(source.indexOf("finishFormNotificationsAfterSubmit(")).toBeGreaterThan(source.indexOf("await prisma.$transaction("));
  });

  it("announces a change through the registration PDF's after-commit step", () => {
    expect(read("modules/registration-pdf/after-commit.ts")).toContain("notifyFormNotificationsAfterChange(");
  });

  it("never reads a switch or builds a PDF inside the queueing code that runs in a transaction", () => {
    const queue = read("modules/registration-form-notifications/queue.ts");
    expect(queue).not.toContain("isNotificationEnabled(");
    expect(queue).not.toContain("renderRegistrationPdf");
  });
});
