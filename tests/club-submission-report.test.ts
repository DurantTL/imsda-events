import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";
import { publicRegistrationInputSchema } from "@/modules/forms/public-domain";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  processQueuedMessageIdsAfterCommit: vi.fn(),
  enqueuePublicRegistrationMessages: vi.fn(),
  enqueueWaitlistJoinedMessage: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/modules/communications/messaging-repository", () => ({
  processQueuedMessageIdsAfterCommit: dependencies.processQueuedMessageIdsAfterCommit,
  enqueuePublicRegistrationMessages: dependencies.enqueuePublicRegistrationMessages,
}));
vi.mock("@/modules/communications/transactional-messages", () => ({
  enqueueWaitlistJoinedMessage: dependencies.enqueueWaitlistJoinedMessage,
}));

import { submitPublicRegistration, type ClubSubmissionContext } from "@/modules/forms/public-repository";

const definition = registrationFormDefinitionSchema.parse({
  title: "Club report verification",
  description: "",
  confirmationMessage: "Registration saved.",
  sections: [{
    id: "registration",
    title: "Registration",
    description: "",
    fields: [
      { id: "name", key: "full_name", label: "Full name", helpText: "", type: "TEXT", scope: "REGISTRATION", required: true, options: [] },
      { id: "email", key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: true, options: [] },
    ],
  }],
});

const input = publicRegistrationInputSchema.parse({
  versionId: "version_1",
  idempotencyKey: "9c7d44b0-52a1-4f0a-a5f0-1d6d0d0f7a11",
  responses: { full_name: "Report Tester", email: "report@example.test" },
  website: "",
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const requestHash = () => createHash("sha256").update(stableJson({ versionId: input.versionId, responses: input.responses })).digest("hex");

function club(report: ClubSubmissionContext["report"]): ClubSubmissionContext {
  return {
    organizationId: "club-1",
    submittedByAccountId: "director-1",
    report,
    prepareAttendees: async (_tx, args) => ({ input: args.input, attendees: new Map() }),
  };
}

/** A club submission that was already committed once under this idempotency key. */
function replayTransaction(status: "SUBMITTED" | "WAITLISTED") {
  const tx = {
    registrationForm: {
      findFirst: vi.fn().mockResolvedValue({
        id: "form_1", slug: "clubs", eventId: "event_1",
        event: {
          id: "event_1", name: "Synthetic Club Event", slug: "club-event",
          startsAt: new Date("2026-09-01T14:00:00.000Z"), endsAt: new Date("2026-09-03T18:00:00.000Z"),
          timezone: "America/Chicago", location: "Camp", capacity: null, isPublished: true,
          registrationOpensOn: "2026-06-01", registrationClosesOn: "2026-08-31", waitlistEnabled: true,
          audience: "CLUB", billingMode: "DEFERRED_ORGANIZATION_INVOICE",
        },
        versions: [{ id: "version_1", versionNumber: 1, definition, publishedAt: new Date("2026-06-01T12:00:00.000Z") }],
      }),
    },
    publicRegistrationSubmission: {
      findUnique: vi.fn().mockResolvedValue({
        registrationId: "registration_1",
        requestHash: requestHash(),
        responses: input.responses,
        attendeeResponses: [],
        pricingSnapshot: {
          currency: "USD", formVersionId: "version_1", eventTimeZone: "America/Chicago", pricingDate: "2026-07-23",
          lineItems: [], subtotalCents: 0, processingFeeCents: 0, totalCents: 0, cardSelected: false, paymentCollected: false,
        },
        registration: { confirmationCode: "REG-CLUB", status, waitlistEntry: status === "WAITLISTED" ? { position: 2 } : null },
      }),
    },
    messageOutbox: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return {
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.processQueuedMessageIdsAfterCommit.mockResolvedValue({
    capturedIds: [], sentIds: [], failedIds: [], rescheduledIds: [], skippedIds: [],
  });
});

const now = new Date("2026-07-23T12:00:00.000Z");

describe("the club submission report (#618)", () => {
  it("reports a real replay of an earlier submission", async () => {
    dependencies.getPrisma.mockReturnValue(replayTransaction("SUBMITTED"));
    const report = vi.fn();
    await submitPublicRegistration("club-event", "clubs", input, now, club(report));
    expect(report).toHaveBeenCalledExactlyOnceWith({ replayed: true, waitlisted: false });
  });

  it("reports a replay of a waitlisted registration as both", async () => {
    dependencies.getPrisma.mockReturnValue(replayTransaction("WAITLISTED"));
    const report = vi.fn();
    await submitPublicRegistration("club-event", "clubs", input, now, club(report));
    expect(report).toHaveBeenCalledExactlyOnceWith({ replayed: true, waitlisted: true });
  });

  it("reports a fresh waitlisted commit as waitlisted and not replayed", async () => {
    dependencies.getPrisma.mockReturnValue({
      $transaction: vi.fn().mockResolvedValue({
        confirmation: { confirmationCode: "REG-NEW", registrationStatus: "WAITLISTED", notificationStatus: "DISABLED" },
        pendingMessageIds: [], registrantMessageIds: [], registrationId: "registration_2", replayed: false,
      }),
    });
    const report = vi.fn();
    await submitPublicRegistration("club-event", "clubs", input, now, club(report));
    expect(report).toHaveBeenCalledExactlyOnceWith({ replayed: false, waitlisted: true });
  });

  it("does not call it at all when the transaction fails", async () => {
    dependencies.getPrisma.mockReturnValue({ $transaction: vi.fn().mockRejectedValue(new Error("Synthetic failure")) });
    const report = vi.fn();
    await expect(submitPublicRegistration("club-event", "clubs", input, now, club(report))).rejects.toThrow("Synthetic failure");
    expect(report).not.toHaveBeenCalled();
  });
});
