import { describe, expect, it } from "vitest";
import { promoCodeBuilderModule } from "@/modules/forms/builder-modules";
import { registrationFormDefinitionSchema } from "@/modules/forms/definition";

describe("promo-code form-builder module", () => {
  it("adds the canonical public promo field without staff knowing its key", () => {
    expect(promoCodeBuilderModule).toMatchObject({
      key: "promo_code",
      category: "Common",
      name: "Promo code",
      fields: [{
        key: "promo_code",
        type: "TEXT",
        scope: "REGISTRATION",
        required: false,
      }],
    });
    expect(registrationFormDefinitionSchema.safeParse({
      title: "Builder promo module fixture",
      description: "",
      confirmationMessage: "Saved.",
      sections: [{
        id: "payment_section",
        title: "Payment",
        description: "",
        fields: promoCodeBuilderModule.fields.map((field) => ({
          ...field,
          id: "promo_field",
        })),
      }],
    }).success).toBe(true);
  });

  it("prevents a configured promo module from becoming required or attendee-scoped", () => {
    const promo = promoCodeBuilderModule.fields[0];
    expect(registrationFormDefinitionSchema.safeParse({
      title: "Invalid promo fixture",
      description: "",
      confirmationMessage: "Saved.",
      sections: [{
        id: "payment_section",
        title: "Payment",
        description: "",
        fields: [{
          ...promo,
          id: "promo_field",
          scope: "ATTENDEE",
          required: true,
        }],
      }],
    }).success).toBe(false);
  });
});
