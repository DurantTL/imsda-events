import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { collectEventReadinessReport } from "@/modules/events/event-readiness-report";

const readyEnv = {
  RESEND_API_KEY: "synthetic-provider-key",
  RESEND_WEBHOOK_SECRET: "synthetic-webhook-key",
  SQUARE_ENVIRONMENT: "sandbox",
  SQUARE_APPLICATION_ID: "sandbox-synthetic-app",
  SQUARE_ACCESS_TOKEN: "synthetic-access-token",
  SQUARE_LOCATION_ID: "synthetic-location",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "synthetic-signature",
  SQUARE_WEBHOOK_NOTIFICATION_URL: "https://synthetic.invalid/api/webhooks/square",
};

function dataSource(overrides: {
  event?: Record<string, unknown> | null;
  publishedFormCount?: number;
  settings?: Record<string, unknown> | null;
  templates?: ReadonlyArray<Record<string, unknown>>;
  registrations?: ReadonlyArray<Record<string, unknown>>;
} = {}) {
  const event = overrides.event === null ? null : {
    id: "event_synthetic",
    name: "Synthetic Retreat",
    slug: "synthetic-retreat",
    startsAt: new Date("2026-09-01T00:00:00Z"),
    endsAt: new Date("2026-09-03T00:00:00Z"),
    timezone: "America/Chicago",
    location: "Synthetic Conference Center",
    publicInfoUrl: "https://www.imsda.org/synthetic-retreat",
    supportContact: "Registration team",
    isPublished: true,
    ...overrides.event,
  };
  const templates = overrides.templates ?? [
    "REGISTRATION_CONFIRMATION_PAID",
    "REGISTRATION_CONFIRMATION_UNPAID",
    "PAYMENT_RECEIPT",
    "BALANCE_REMINDER",
    "SHIRT_SIZE_REQUEST",
  ].map((key) => ({ key, isEnabled: true, versions: [{ id: `version_${key}` }] }));
  const reads = {
    event: { findUnique: vi.fn().mockResolvedValue(event) },
    registrationFormVersion: { count: vi.fn().mockResolvedValue(overrides.publishedFormCount ?? 1) },
    eventMessageSettings: { findFirst: vi.fn().mockResolvedValue(overrides.settings === null ? null : overrides.settings ?? { deliveryMode: "EXTERNAL_EMAIL", senderEmail: "notifications@imsda.org", replyToEmail: "registration@imsda.org" }) },
    eventMessageTemplate: { findMany: vi.fn().mockResolvedValue(templates) },
    registration: { findMany: vi.fn().mockResolvedValue(overrides.registrations ?? [{ totalAmount: 0, attendees: [{ formResponses: { shirt_size: "Adult M" } }], payments: [] }]) },
  };
  return { prisma: reads as unknown as PrismaClient, reads };
}

function check(report: Awaited<ReturnType<typeof collectEventReadinessReport>>, code: string) {
  return report?.checks.find((item) => item.code === code);
}

describe("collectEventReadinessReport", () => {
  it("returns a fully ready, aggregate-only fixture through read methods", async () => {
    const { prisma, reads } = dataSource();
    const report = await collectEventReadinessReport(prisma, "synthetic-retreat", readyEnv);

    expect(report?.summary).toEqual({ blockers: 0, warnings: 0, isReady: true });
    expect(report?.activeRegistrationCount).toBe(1);
    expect(report?.checks.map((item) => item.code)).toEqual(expect.arrayContaining([
      "PUBLISH_BASICS", "PUBLISH_LOCATION", "PUBLISH_PUBLIC_INFO", "PUBLISH_SUPPORT", "PUBLISH_REGISTRATION_FORM",
      "EVENT_PUBLISHED", "DELIVERY_MODE", "SENDER_ADDRESS", "REPLY_TO_ADDRESS", "TEMPLATES", "SQUARE",
    ]));
    for (const delegate of Object.values(reads)) {
      expect(Object.keys(delegate).every((method) => ["findUnique", "findFirst", "findMany", "count"].includes(method))).toBe(true);
    }
  });

  it.each([
    ["publish basics", { event: { name: "" } }, "PUBLISH_BASICS"],
    ["publish location", { event: { location: null } }, "PUBLISH_LOCATION"],
    ["public info", { event: { publicInfoUrl: "not-a-url" } }, "PUBLISH_PUBLIC_INFO"],
    ["support", { event: { supportContact: null } }, "PUBLISH_SUPPORT"],
    ["published form", { publishedFormCount: 0 }, "PUBLISH_REGISTRATION_FORM"],
    ["event publication", { event: { isPublished: false } }, "EVENT_PUBLISHED"],
    ["placeholder sender", { settings: { deliveryMode: "EXTERNAL_EMAIL", senderEmail: "sender@example.invalid", replyToEmail: "reply@imsda.org" } }, "SENDER_ADDRESS"],
    ["required templates", { templates: [] }, "TEMPLATES"],
    ["balance without card path", { registrations: [{ totalAmount: 25, attendees: [{ formResponses: { shirt_size: "Adult M" } }], payments: [] }] }, "SQUARE"],
  ] as const)("blocks for %s", async (_name, overrides, code) => {
    const { prisma } = dataSource(overrides);
    const env = code === "SQUARE" ? {} : readyEnv;
    expect(check(await collectEventReadinessReport(prisma, "synthetic-retreat", env), code)?.severity).toBe("BLOCKER");
  });

  it("blocks for a missing provider key and an invalid Square configuration", async () => {
    const { prisma } = dataSource();
    const report = await collectEventReadinessReport(prisma, "synthetic-retreat", {
      ...readyEnv,
      RESEND_API_KEY: "",
      SQUARE_ENVIRONMENT: "production",
      SQUARE_ENABLE_PRODUCTION: "false",
    });
    expect(check(report, "DELIVERY_MODE")?.severity).toBe("BLOCKER");
    expect(check(report, "SQUARE")?.label).toContain("PRODUCTION_DISABLED");
  });

  it("returns null after only the event lookup for an unknown slug", async () => {
    const { prisma, reads } = dataSource({ event: null });
    expect(await collectEventReadinessReport(prisma, "unknown", readyEnv)).toBeNull();
    expect(reads.registration.findMany).not.toHaveBeenCalled();
  });
});
