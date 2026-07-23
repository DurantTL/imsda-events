import { describe, expect, it } from "vitest";
import { manualPaymentSchema, refundInputSchema } from "@/modules/payments/schemas";

describe("financial input validation", () => {
  it("accepts supported offline payment methods", () => {
    expect(manualPaymentSchema.parse({ amountCents: 12500, method: "CHECK", reference: "TEST-42" })).toEqual({
      amountCents: 12500,
      method: "CHECK",
      reference: "TEST-42",
    });
  });

  it("rejects zero and negative payments", () => {
    expect(() => manualPaymentSchema.parse({ amountCents: 0, method: "CASH" })).toThrow();
    expect(() => manualPaymentSchema.parse({ amountCents: -100, method: "CASH" })).toThrow();
  });

  it("requires a reason for every refund", () => {
    expect(() => refundInputSchema.parse({ amountCents: 500, reason: "" })).toThrow();
    expect(refundInputSchema.parse({ amountCents: 500, reason: "Test correction" })).toEqual({ amountCents: 500, reason: "Test correction" });
  });
});

