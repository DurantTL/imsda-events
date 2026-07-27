import { describe, expect, it } from "vitest";
import {
  checkOperationalReadiness,
  isUndeliverableSenderAddress,
  operationalReadinessSummary,
  type OperationalReadinessFacts,
} from "@/modules/events/operational-readiness";

function facts(overrides: Partial<OperationalReadinessFacts> = {}): OperationalReadinessFacts {
  return {
    isPublished: true,
    hasPublishedFormVersion: true,
    messaging: {
      deliveryMode: "EXTERNAL_EMAIL",
      senderEmail: "notifications@imsda.org",
      replyToEmail: "registration@imsda.org",
    },
    templates: [
      { key: "REGISTRATION_CONFIRMATION_PAID", isEnabled: true, hasPublishedVersion: true },
      { key: "SHIRT_SIZE_REQUEST", isEnabled: true, hasPublishedVersion: true },
    ],
    requiredTemplateKeys: ["REGISTRATION_CONFIRMATION_PAID", "SHIRT_SIZE_REQUEST"],
    emailProvider: { deliveryConfigured: true, webhookConfigured: true },
    square: { paymentConfigured: true, webhookConfigured: true, environment: "sandbox", issue: null },
    registrationsMissingShirtSize: 0,
    registrationsWithBalanceDue: 0,
    ...overrides,
  };
}

function find(checks: ReturnType<typeof checkOperationalReadiness>, code: string) {
  return checks.find((check) => check.code === code);
}

describe("checkOperationalReadiness", () => {
  it("reports ready when everything is configured", () => {
    const summary = operationalReadinessSummary(checkOperationalReadiness(facts()));

    expect(summary).toEqual({ blockers: 0, warnings: 0, isReady: true });
  });

  it("blocks when messages only capture locally", () => {
    const checks = checkOperationalReadiness(facts({
      messaging: {
        deliveryMode: "LOCAL_CAPTURE",
        senderEmail: "notifications@imsda.org",
        replyToEmail: "registration@imsda.org",
      },
    }));

    expect(find(checks, "DELIVERY_MODE")?.severity).toBe("BLOCKER");
    expect(find(checks, "DELIVERY_MODE")?.detail).toContain("never reach a registrant");
  });

  it("blocks on the seeded placeholder sender domain", () => {
    const checks = checkOperationalReadiness(facts({
      messaging: {
        deliveryMode: "EXTERNAL_EMAIL",
        senderEmail: "notifications@imsda-events.test",
        replyToEmail: "registration@imsda-events.test",
      },
    }));

    expect(find(checks, "SENDER_ADDRESS")?.severity).toBe("BLOCKER");
    expect(find(checks, "REPLY_TO_ADDRESS")?.severity).toBe("BLOCKER");
  });

  it("blocks when the registration form has no published version", () => {
    const checks = checkOperationalReadiness(facts({ hasPublishedFormVersion: false }));

    expect(find(checks, "FORM_PUBLISHED")?.severity).toBe("BLOCKER");
    expect(find(checks, "FORM_PUBLISHED")?.detail).toContain("seminar choices");
  });

  it("names the templates that are unusable", () => {
    const checks = checkOperationalReadiness(facts({
      templates: [
        { key: "REGISTRATION_CONFIRMATION_PAID", isEnabled: true, hasPublishedVersion: true },
        { key: "SHIRT_SIZE_REQUEST", isEnabled: false, hasPublishedVersion: true },
      ],
    }));

    expect(find(checks, "TEMPLATES")?.severity).toBe("BLOCKER");
    expect(find(checks, "TEMPLATES")?.detail).toContain("SHIRT_SIZE_REQUEST");
  });

  it("treats a wholly missing required template as unusable", () => {
    const checks = checkOperationalReadiness(facts({ templates: [] }));

    expect(find(checks, "TEMPLATES")?.detail).toContain("REGISTRATION_CONFIRMATION_PAID");
  });

  it("escalates missing Square only when money is actually owed", () => {
    const withoutBalance = checkOperationalReadiness(facts({
      square: { paymentConfigured: false, webhookConfigured: false, environment: "sandbox", issue: "MISSING_PAYMENT_CREDENTIALS" },
    }));
    const withBalance = checkOperationalReadiness(facts({
      square: { paymentConfigured: false, webhookConfigured: false, environment: "sandbox", issue: "MISSING_PAYMENT_CREDENTIALS" },
      registrationsWithBalanceDue: 20,
    }));

    expect(find(withoutBalance, "SQUARE")?.severity).toBe("WARNING");
    expect(find(withBalance, "SQUARE")?.severity).toBe("BLOCKER");
    expect(find(withBalance, "SQUARE")?.detail).toContain("SQUARE_ACCESS_TOKEN");
  });

  it("warns when cards work but webhooks cannot be verified", () => {
    const checks = checkOperationalReadiness(facts({
      square: { paymentConfigured: true, webhookConfigured: false, environment: "production", issue: "MISSING_WEBHOOK_CONFIGURATION" },
    }));

    expect(find(checks, "SQUARE")?.severity).toBe("WARNING");
  });

  it("blocks live delivery when the provider holds no API key", () => {
    const checks = checkOperationalReadiness(facts({
      emailProvider: { deliveryConfigured: false, webhookConfigured: false },
    }));

    expect(find(checks, "DELIVERY_MODE")?.severity).toBe("BLOCKER");
    expect(find(checks, "DELIVERY_MODE")?.detail).toContain("EXTERNAL_EMAIL_NOT_CONFIGURED");
  });

  it("warns when the provider webhook cannot report bounces", () => {
    const checks = checkOperationalReadiness(facts({
      emailProvider: { deliveryConfigured: true, webhookConfigured: false },
    }));

    expect(find(checks, "EMAIL_WEBHOOK")?.severity).toBe("WARNING");
  });

  it("does not ask about the provider when delivery is not live", () => {
    const checks = checkOperationalReadiness(facts({
      messaging: { deliveryMode: "LOCAL_CAPTURE", senderEmail: "a@imsda.org", replyToEmail: "b@imsda.org" },
      emailProvider: { deliveryConfigured: false, webhookConfigured: false },
    }));

    expect(find(checks, "EMAIL_WEBHOOK")).toBeUndefined();
  });

  it("names a populated-but-rejected Square configuration", () => {
    // Every credential is set; production simply was not unlocked.
    const checks = checkOperationalReadiness(facts({
      square: { paymentConfigured: false, webhookConfigured: false, environment: "production", issue: "PRODUCTION_DISABLED" },
      registrationsWithBalanceDue: 5,
    }));

    expect(find(checks, "SQUARE")?.label).toContain("PRODUCTION_DISABLED");
    expect(find(checks, "SQUARE")?.detail).toContain("SQUARE_ENABLE_PRODUCTION");
  });

  it("surfaces outstanding shirt sizes as a warning, not a blocker", () => {
    const checks = checkOperationalReadiness(facts({ registrationsMissingShirtSize: 45 }));

    expect(find(checks, "SHIRT_SIZES")?.severity).toBe("WARNING");
    expect(operationalReadinessSummary(checks).isReady).toBe(true);
  });

  it("blocks when the event has no message settings at all", () => {
    const checks = checkOperationalReadiness(facts({ messaging: null }));

    expect(find(checks, "MESSAGE_SETTINGS")?.severity).toBe("BLOCKER");
  });
});

describe("isUndeliverableSenderAddress", () => {
  it.each([
    "notifications@imsda-events.test",
    "someone@example.com",
    "someone@sub.example.org",
    "dev@localhost",
    "a@thing.invalid",
  ])("rejects %s", (address) => {
    expect(isUndeliverableSenderAddress(address)).toBe(true);
  });

  it.each([
    "notifications@imsda.org",
    "communication@imsda.org",
    "no-reply@mail.imsda.org",
    // A real domain that merely contains a reserved word is deliverable.
    "hello@testimonial.org",
  ])("accepts %s", (address) => {
    expect(isUndeliverableSenderAddress(address)).toBe(false);
  });

  it("treats a missing address as not-a-placeholder", () => {
    expect(isUndeliverableSenderAddress(null)).toBe(false);
  });
});
