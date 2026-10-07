import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { enqueuePublicRegistrationMessages, type RegistrationMessageInput } from "@/modules/communications/messaging-repository";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

/**
 * The confirmation email for a church-billed registration shows the per-person
 * price and no total; the internal team notice and self-pay emails keep totals
 * (#621). Synthetic data only.
 */

const definition = registrationFormDefinitionSchema.parse({
  title: "Synthetic camporee",
  description: "Synthetic form.",
  confirmationMessage: "Received.",
  attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Person", addButtonLabel: "Add" },
  sections: [{ id: "details", title: "Details", description: "", fields: [{ id: "note_field", key: "note", label: "Note", type: "TEXT", scope: "REGISTRATION", required: false, helpText: "", options: [] },
    { id: "first_field", key: "first_name", label: "First name", type: "TEXT", scope: "ATTENDEE", required: true, helpText: "", options: [] },
    { id: "last_field", key: "last_name", label: "Last name", type: "TEXT", scope: "ATTENDEE", required: true, helpText: "", options: [] },
  ] }],
});

function fixture() {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `message-${create.mock.calls.length}`, ...data }));
  const tx = {
    eventMessageSettings: {
      findUnique: vi.fn().mockResolvedValue({
        deliveryMode: "LOCAL_CAPTURE",
        senderName: "IMSDA Events",
        senderEmail: "events@example.test",
        replyToEmail: "office@example.test",
        internalNotificationEmails: ["team@example.test"],
      }),
    },
    eventMessageTemplate: { findMany: vi.fn().mockResolvedValue([]) },
    event: { findUnique: vi.fn().mockResolvedValue({ supportContact: "office@example.test", paymentInstructionVersions: [] }) },
    registrationAttendee: { findMany: vi.fn().mockResolvedValue([{ id: "attendee-1" }, { id: "attendee-2" }]) },
    messageOutbox: { create, findMany: vi.fn().mockResolvedValue([]) },
    // Message files (#824): a fake database with no files linked to any message.
    messageOutboxFile: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    messageTemplateVersionFile: { findMany: vi.fn().mockResolvedValue([]) },
    messageFile: { findMany: vi.fn().mockResolvedValue([]) },
  };
  return { tx, create };
}

function input(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE"): RegistrationMessageInput {
  const lineItem = (index: number) => ({ key: `attendees.${index}.fee`, label: `Fee — Person ${index + 1}`, amountCents: 2500, attendeeIndex: index, attendeeLabel: `Person ${index + 1}` });
  return {
    event: {
      id: "event-1",
      name: "Synthetic Camporee",
      slug: "synthetic-camporee",
      startsAt: new Date("2027-02-19T21:00:00.000Z"),
      endsAt: new Date("2027-02-21T17:00:00.000Z"),
      timezone: "America/Chicago",
      location: "Camp",
      billingMode,
    },
    registration: { id: "registration-1", confirmationCode: "REG-CLUB", attendeeType: "ATTENDEE" },
    formVersionId: "version-1",
    submissionIdempotencyKey: "2f0e3c1a-7a55-4c43-8e1c-2f6f6f4a9a10",
    identity: { firstName: "Pat", lastName: "Director", email: "pat@example.test" } as RegistrationMessageInput["identity"],
    definition,
    responses: {},
    calculation: { subtotalCents: 5000, processingFeeCents: 0, totalCents: 5000, lineItems: [lineItem(0), lineItem(1)] },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("church-billed confirmation email (#621)", () => {
  it("shows the registrant the per-person price and no total, subtotal or balance", async () => {
    const { tx, create } = fixture();
    await enqueuePublicRegistrationMessages(tx as never, input("DEFERRED_ORGANIZATION_INVOICE"));
    const registrant = create.mock.calls.map(([call]) => call.data).find((data) => data.recipientKind === "REGISTRANT");
    const body = String(registrant?.bodyTextSnapshot);
    expect(body).toContain("$25 per person. Your church is billed after the event.");
    expect(body).not.toContain("$50");
    expect(body).not.toContain("50.00");
    expect(body).not.toMatch(/balance due/i);
    expect(String(registrant?.bodyHtmlSnapshot)).not.toContain("$50");
  });

  it("keeps the amounts on the internal team notice", async () => {
    const { tx, create } = fixture();
    await enqueuePublicRegistrationMessages(tx as never, input("DEFERRED_ORGANIZATION_INVOICE"));
    const internal = create.mock.calls.map(([call]) => call.data).find((data) => data.recipientKind === "INTERNAL");
    expect(String(internal?.bodyTextSnapshot)).toContain("$50.00");
  });

  it("keeps the total in a self-pay confirmation email", async () => {
    const { tx, create } = fixture();
    await enqueuePublicRegistrationMessages(tx as never, input("ATTENDEE_PAY"));
    const registrant = create.mock.calls.map(([call]) => call.data).find((data) => data.recipientKind === "REGISTRANT");
    expect(String(registrant?.bodyTextSnapshot)).toContain("$50.00");
    expect(String(registrant?.bodyTextSnapshot)).not.toContain("Your church is billed after the event.");
  });
});
