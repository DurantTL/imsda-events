import type { RegistrationFormField } from "@/modules/forms/definition";

export const promoCodeBuilderModule = {
  key: "promo_code",
  category: "Common" as const,
  name: "Promo code",
  description: "Apply an event discount with a clear Apply / Remove control",
  fields: [{
    key: "promo_code",
    label: "Promo code",
    helpText: "Enter a code supplied by the event team, then select Apply.",
    placeholder: "Enter code",
    type: "TEXT" as const,
    scope: "REGISTRATION" as const,
    required: false,
    options: [],
  }],
} satisfies {
  key: string;
  category: "Common";
  name: string;
  description: string;
  fields: Array<Omit<RegistrationFormField, "id">>;
};

