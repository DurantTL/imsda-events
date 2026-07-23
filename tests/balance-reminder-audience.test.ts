import { describe, expect, it } from "vitest";
import {
  computeBalanceReminderPreview,
  type BalanceReminderCandidate,
  type BalanceReminderPreviewContext,
} from "@/modules/communications/reminder-audience";

const context: BalanceReminderPreviewContext = {
  eventId: "event-1",
  deliveryMode: "LOCAL_CAPTURE",
  senderName: "IMSDA Events",
  senderEmail: "registration@example.test",
  replyToEmail: "help@example.test",
  templateEnabled: true,
  templateVersionId: "template-version-1",
  templateVersionNumber: 1,
  eventSnapshot: {
    name: "Women’s Retreat",
    startsAt: "2026-10-09T21:00:00.000Z",
    endsAt: "2026-10-11T17:00:00.000Z",
    timezone: "America/Chicago",
    location: "Camp Heritage",
  },
};

const candidates: BalanceReminderCandidate[] = [
  {
    registrationId: "registration-included",
    confirmationCode: "REG-INCLUDED",
    status: "CONFIRMED",
    recipientName: "Included Registrant",
    recipientEmail: " INCLUDED@EXAMPLE.TEST ",
    totalCents: 20_000,
    netPaidCents: 7_500,
  },
  {
    registrationId: "registration-paid",
    confirmationCode: "REG-PAID",
    status: "SUBMITTED",
    recipientName: "Paid Registrant",
    recipientEmail: "paid@example.test",
    totalCents: 20_000,
    netPaidCents: 20_000,
  },
  {
    registrationId: "registration-invalid-email",
    confirmationCode: "REG-NOEMAIL",
    status: "SUBMITTED",
    recipientName: "No Email",
    recipientEmail: "not-an-email",
    totalCents: 20_000,
    netPaidCents: 0,
  },
  {
    registrationId: "registration-waitlisted",
    confirmationCode: "REG-WAIT",
    status: "WAITLISTED",
    recipientName: "Waitlisted Registrant",
    recipientEmail: "waitlisted@example.test",
    totalCents: 20_000,
    netPaidCents: 0,
  },
];

describe("balance-reminder audience", () => {
  it("includes only active balance-due registrations with valid contact email", () => {
    const preview = computeBalanceReminderPreview(
      candidates,
      context,
      new Date("2026-07-23T12:00:00.000Z"),
    );

    expect(preview).toMatchObject({
      includedCount: 1,
      skippedCount: 3,
      totalBalanceCents: 12_500,
      deliveryMode: "LOCAL_CAPTURE",
      templateEnabled: true,
      generatedAt: "2026-07-23T12:00:00.000Z",
    });
    expect(preview.recipients).toEqual([{
      registrationId: "registration-included",
      confirmationCode: "REG-INCLUDED",
      recipientName: "Included Registrant",
      recipientEmail: "included@example.test",
      totalCents: 20_000,
      balanceCents: 12_500,
    }]);
    expect(preview.skipReasons).toEqual([
      {
        code: "INACTIVE_REGISTRATION",
        label: "Not submitted or confirmed",
        count: 1,
      },
      {
        code: "NO_BALANCE_DUE",
        label: "No balance is due",
        count: 1,
      },
      {
        code: "INVALID_CONTACT_EMAIL",
        label: "Missing or invalid contact email",
        count: 1,
      },
    ]);
  });

  it("keeps fingerprints stable across generation time and input order", () => {
    const first = computeBalanceReminderPreview(
      candidates,
      context,
      new Date("2026-07-23T12:00:00.000Z"),
    );
    const reordered = computeBalanceReminderPreview(
      [...candidates].reverse(),
      context,
      new Date("2026-07-23T13:00:00.000Z"),
    );
    expect(first.fingerprint).toBe(reordered.fingerprint);
  });

  it("changes the exact-preview fingerprint when a balance or sender mode changes", () => {
    const baseline = computeBalanceReminderPreview(candidates, context);
    const changedBalance = computeBalanceReminderPreview(
      candidates.map((candidate) => candidate.registrationId === "registration-included"
        ? { ...candidate, netPaidCents: 8_000 }
        : candidate),
      context,
    );
    const changedMode = computeBalanceReminderPreview(candidates, {
      ...context,
      deliveryMode: "EXTERNAL_EMAIL",
    });

    expect(changedBalance.fingerprint).not.toBe(baseline.fingerprint);
    expect(changedMode.fingerprint).not.toBe(baseline.fingerprint);
  });

  it("changes the exact-preview fingerprint with the effective reply-to destination", () => {
    const baseline = computeBalanceReminderPreview(candidates, context);
    const changedReplyTo = computeBalanceReminderPreview(candidates, {
      ...context,
      replyToEmail: "new-help@example.test",
    });

    expect(changedReplyTo.fingerprint).not.toBe(baseline.fingerprint);
  });
});
