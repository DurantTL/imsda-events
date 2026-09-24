import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGE_TEMPLATES } from "@/modules/communications/templates";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processExternalEmailQueue: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ getPrisma: mocks.getPrisma }));
vi.mock("@/integrations/email/resend", () => ({
  getResendEmailAvailability: () => ({ deliveryConfigured: false, webhookConfigured: false }),
}));
vi.mock("@/modules/communications/email-delivery", () => ({
  ExternalEmailDeliveryError: class ExternalEmailDeliveryError extends Error {},
  processExternalEmailQueue: mocks.processExternalEmailQueue,
}));

import {
  enqueueClubAssignmentBatch,
  getClubAssignmentMessagePreview,
} from "@/modules/communications/messaging-repository";
import { REGISTRATION_MANAGE_LINK_SENTINEL } from "@/modules/communications/manage-link";

const event = { id: "event-1", name: "Spring Camporee", supportContact: "help@example.test" };

const settings = {
  deliveryMode: "EXTERNAL_EMAIL" as const,
  senderName: "IMSDA Events",
  senderEmail: "registration@example.test",
  replyToEmail: "help@example.test",
  internalNotificationEmails: [],
};

type AssignmentRow = {
  campsiteLocation: string;
  campsiteNotes: string;
  dutyLabel: string;
  dutyDay: string;
  dutyTime: string;
  activityLabel: string;
  notes: string;
  version: number;
  lastEmailedVersion: number | null;
  lastEmailSentAt: Date | null;
};

function assignment(overrides: Partial<AssignmentRow> = {}): AssignmentRow {
  return {
    campsiteLocation: "Field C, site 12",
    campsiteNotes: "",
    dutyLabel: "Flag raising",
    dutyDay: "Friday",
    dutyTime: "morning",
    activityLabel: "Campfire singing",
    notes: "",
    version: 2,
    lastEmailedVersion: null,
    lastEmailSentAt: null,
    ...overrides,
  };
}

function club(id: string, name: string, row: AssignmentRow | null) {
  return {
    id: `cer-${id}`,
    organizationId: `org-${id}`,
    organization: { name },
    registration: {
      id: `registration-${id}`,
      confirmationCode: `SC26-${id.toUpperCase()}`,
      status: "CONFIRMED",
      contactSnapshot: { firstName: "Jordan", lastName: `Lee-${id}`, email: `DIRECTOR-${id}@EXAMPLE.TEST` },
      accountHolderPerson: { firstName: "Canonical", lastName: "Person", normalizedEmail: "canonical@example.test" },
    },
    assignment: row,
  };
}

function baseTransaction(clubs = [club("a", "Pathfinder Pioneers", assignment())]) {
  let outboxCount = 0;
  const tx = {
    platformSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    eventMessageSettings: {
      upsert: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue(settings),
    },
    eventMessageTemplate: {
      upsert: vi.fn().mockResolvedValue({ id: "template-existing", versions: [{ id: "version-existing" }] }),
      findUnique: vi.fn().mockResolvedValue({
        id: "template-club",
        key: "CLUB_ASSIGNMENTS",
        isEnabled: true,
        versions: [{
          id: "version-club-1",
          versionNumber: 1,
          subjectTemplate: DEFAULT_MESSAGE_TEMPLATES.CLUB_ASSIGNMENTS.subject,
          bodyTemplate: DEFAULT_MESSAGE_TEMPLATES.CLUB_ASSIGNMENTS.body,
        }],
      }),
    },
    messageTemplateVersion: { create: vi.fn() },
    event: { findUnique: vi.fn().mockResolvedValue(event) },
    clubEventRegistration: { findMany: vi.fn(async () => clubs) },
    clubEventAssignment: {
      // Writes land on the in-memory rows, so a later preview sees them.
      update: vi.fn(async ({ where, data }: { where: { clubEventRegistrationId: string }; data: Partial<AssignmentRow> }) => {
        const target = clubs.find((entry) => entry.id === where.clubEventRegistrationId);
        if (target?.assignment) Object.assign(target.assignment, data);
        return target?.assignment;
      }),
    },
    auditLog: {
      findFirst: vi.fn().mockResolvedValue(null),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    messageOutbox: {
      upsert: vi.fn(async () => {
        outboxCount += 1;
        return { id: `message-${outboxCount}`, status: "PENDING" };
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  return { tx, clubs };
}

function prismaFor(tx: ReturnType<typeof baseTransaction>["tx"]) {
  return {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
}

const batchA = "7d27bacc-90c3-4e74-884e-8aa36c673492";
const batchB = "1f9f4e07-0d43-4b57-9d0f-3a3d6a2c4b11";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("club assignment batch repository", () => {
  it("queues one message per included club, stamps it as sent, and does not send", async () => {
    const { tx, clubs } = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getClubAssignmentMessagePreview("event-1", { scope: "ALL_SET" });

    expect(preview.includedCount).toBe(1);
    expect(preview.sample).toMatchObject({ organizationId: "org-a" });
    expect(preview.sample?.subject).toBe("Your club's assignments for Spring Camporee");
    expect(preview.sample?.body).toContain("Campfire singing");
    expect(preview.sample?.body).not.toContain(REGISTRATION_MANAGE_LINK_SENTINEL);

    const result = await enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: batchA,
      scope: "ALL_SET",
    }, "staff-1");

    expect(result).toMatchObject({ includedCount: 1, queuedCount: 1, suppressedCount: 0, replayed: false });
    const calls = tx.messageOutbox.upsert.mock.calls as unknown as Array<[{ where: unknown; create: { bodyTextSnapshot: string; recipientEmail: string } }]>;
    const upsert = calls[0][0];
    expect(upsert.where).toEqual({ idempotencyKey: `club-assignments:event-1:${batchA}:org-a` });
    expect(upsert.create.recipientEmail).toBe("director-a@example.test");
    // The link is the club's portal page (sign-in required), never a private
    // registration link that opens the roster without signing in.
    expect(upsert.create.bodyTextSnapshot).not.toContain(REGISTRATION_MANAGE_LINK_SENTINEL);
    expect(upsert.create.bodyTextSnapshot).toContain("/account/clubs/org-a/events/event-1");
    expect(tx.clubEventAssignment.update).toHaveBeenCalledWith({
      where: { clubEventRegistrationId: "cer-a" },
      data: { lastEmailSentAt: expect.any(Date), lastEmailedVersion: 2 },
    });
    expect(clubs[0].assignment?.lastEmailedVersion).toBe(2);
    expect(mocks.processExternalEmailQueue).not.toHaveBeenCalled();
  });

  it("refuses a batch built from a preview that no longer matches", async () => {
    const { tx } = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: "c".repeat(64),
      batchId: batchA,
      scope: "ALL_SET",
    }, "staff-1")).rejects.toMatchObject({
      code: "PREVIEW_CHANGED",
      details: { clubAssignmentPreview: expect.objectContaining({ includedCount: 1 }) },
    });
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
    expect(tx.clubEventAssignment.update).not.toHaveBeenCalled();
  });

  it("replays the same batch ID instead of recomputing, and rejects it with another fingerprint", async () => {
    const { tx } = baseTransaction();
    tx.auditLog.findFirst.mockResolvedValue({
      metadata: {
        previewFingerprint: "a".repeat(64),
        includedCount: 1,
        deliveryMode: "EXTERNAL_EMAIL",
        initialQueuedCount: 1,
        initialSuppressedCount: 0,
      },
    });
    tx.messageOutbox.findMany.mockResolvedValue([{ id: "message-existing", status: "PENDING" }]);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));

    await expect(enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: "a".repeat(64),
      batchId: batchA,
      scope: "ALL_SET",
    }, "staff-1")).resolves.toMatchObject({ messageIds: ["message-existing"], replayed: true });
    expect(tx.clubEventRegistration.findMany).not.toHaveBeenCalled();
    expect(tx.messageOutbox.upsert).not.toHaveBeenCalled();
    expect(tx.clubEventAssignment.update).not.toHaveBeenCalled();

    await expect(enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: "b".repeat(64),
      batchId: batchA,
      scope: "ALL_SET",
    }, "staff-1")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("stamps only included clubs, never a skipped one", async () => {
    const { tx } = baseTransaction([
      club("a", "Pathfinder Pioneers", assignment()),
      club("b", "Trail Blazers", assignment({ activityLabel: "" })),
    ]);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getClubAssignmentMessagePreview("event-1", { scope: "ALL_SET" });
    expect(preview.skipped).toEqual([expect.objectContaining({ organizationId: "org-b", code: "NOT_FULLY_ASSIGNED" })]);

    await enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: batchA,
      scope: "ALL_SET",
    }, "staff-1");

    expect(tx.clubEventAssignment.update).toHaveBeenCalledTimes(1);
    expect(tx.clubEventAssignment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { clubEventRegistrationId: "cer-a" } }));
  });

  it("does not count a suppressed row as sent", async () => {
    const { tx, clubs } = baseTransaction();
    tx.eventMessageSettings.findUnique.mockResolvedValue({ ...settings, deliveryMode: "DISABLED" });
    tx.messageOutbox.upsert.mockResolvedValue({ id: "message-1", status: "SUPPRESSED" });
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getClubAssignmentMessagePreview("event-1", { scope: "ALL_SET" });

    const result = await enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: batchA,
      scope: "ALL_SET",
    }, "staff-1");

    expect(result).toMatchObject({ queuedCount: 0, suppressedCount: 1 });
    expect(tx.clubEventAssignment.update).not.toHaveBeenCalled();
    expect(clubs[0].assignment?.lastEmailedVersion).toBeNull();
  });

  it("skips a club already sent this version, and includes it again after an edit", async () => {
    const { tx, clubs } = baseTransaction();
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const first = await getClubAssignmentMessagePreview("event-1", { scope: "ALL_SET" });
    await enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: first.fingerprint,
      batchId: batchA,
      scope: "ALL_SET",
    }, "staff-1");

    // A second "every fully assigned club" batch must not email the same
    // version again, even from a fresh preview and a new batch ID.
    const second = await getClubAssignmentMessagePreview("event-1", { scope: "ALL_SET" });
    expect(second.includedCount).toBe(0);
    expect(second.skipped).toEqual([expect.objectContaining({ organizationId: "org-a", code: "ALREADY_SENT" })]);
    await expect(enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: second.fingerprint,
      batchId: batchB,
      scope: "ALL_SET",
    }, "staff-1")).rejects.toMatchObject({ code: "EMPTY_AUDIENCE" });

    // The stale first preview can't be reused under a new batch ID either:
    // the send changed the fingerprint.
    await expect(enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: first.fingerprint,
      batchId: batchB,
      scope: "ALL_SET",
    }, "staff-1")).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });

    // Staff edit the assignment (upsertClubAssignment bumps the version).
    Object.assign(clubs[0].assignment!, { activityLabel: "Oregon Trail", version: 3 });
    const afterEdit = await getClubAssignmentMessagePreview("event-1", { scope: "ALL_SET" });
    expect(afterEdit.includedCount).toBe(1);
    expect(afterEdit.recipients[0]).toMatchObject({ organizationId: "org-a", alreadySentThisVersion: false });
  });

  it("lets staff explicitly resend one club that already has this version, flagged in the preview", async () => {
    const { tx } = baseTransaction([club("a", "Pathfinder Pioneers", assignment({ lastEmailedVersion: 2 }))]);
    mocks.getPrisma.mockReturnValue(prismaFor(tx));
    const preview = await getClubAssignmentMessagePreview("event-1", { scope: "ONE", organizationId: "org-a" });

    expect(preview.includedCount).toBe(1);
    expect(preview.recipients[0].alreadySentThisVersion).toBe(true);
    await expect(enqueueClubAssignmentBatch("event-1", {
      previewFingerprint: preview.fingerprint,
      batchId: batchA,
      scope: "ONE",
      organizationId: "org-a",
    }, "staff-1")).resolves.toMatchObject({ includedCount: 1, queuedCount: 1 });
  });
});
