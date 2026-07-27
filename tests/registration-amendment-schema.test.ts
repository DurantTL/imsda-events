import { describe, expect, it } from "vitest";
import { registrationAmendmentInputSchema } from "@/modules/registrations/schemas";

const baseInput = {
  clientRequestId: "1616c563-e266-44b4-8c9a-d77e88ac3923",
  expectedUpdatedAt: "2026-07-27T18:00:00.000Z",
  reason: "",
  responses: { church: "Ames SDA Church" },
  attendees: [
    {
      attendeeId: "attendee-1",
      clientId: "existing-attendee-1",
      responses: { firstName: "Morgan", lastName: "Lee" },
    },
  ],
  previewOnly: true,
};

describe("registration amendment input schema", () => {
  it("allows a preview without a quote fingerprint", () => {
    expect(registrationAmendmentInputSchema.parse(baseInput)).toEqual(baseInput);
  });

  it("requires the reviewed quote before a commit", () => {
    const result = registrationAmendmentInputSchema.safeParse({
      ...baseInput,
      previewOnly: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        path: ["quoteFingerprint"],
        message: "Review the amendment quote before confirming it.",
      }),
    );
  });

  it("rejects duplicate existing attendees and duplicate client rows", () => {
    const result = registrationAmendmentInputSchema.safeParse({
      ...baseInput,
      attendees: [
        baseInput.attendees[0],
        {
          ...baseInput.attendees[0],
          responses: { firstName: "Duplicate", lastName: "Row" },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["attendees", 1, "clientId"] }),
        expect.objectContaining({ path: ["attendees", 1, "attendeeId"] }),
      ]),
    );
  });

  it("rejects unknown top-level and attendee properties", () => {
    const topLevel = registrationAmendmentInputSchema.safeParse({
      ...baseInput,
      totalAmountCents: 0,
    });
    const attendeeLevel = registrationAmendmentInputSchema.safeParse({
      ...baseInput,
      attendees: [
        {
          ...baseInput.attendees[0],
          firstName: "Override",
        },
      ],
    });

    expect(topLevel.success).toBe(false);
    expect(attendeeLevel.success).toBe(false);
  });
});
