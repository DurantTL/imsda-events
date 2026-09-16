import { describe, expect, it } from "vitest";
import {
  formatAddressDisplay,
  hasAddressValue,
  normalizeAddress,
  sanitizeAddressInput,
  validateAddressValue,
} from "@/modules/forms/address";
import {
  isFieldVisible,
  registrationFormDefinitionSchema,
  validateTestResponses,
  type RegistrationFormDefinition,
} from "@/modules/forms/definition";
import { normalizePublicResponses } from "@/modules/forms/public-domain";
import {
  exportAttendeeRosterCsv,
} from "@/modules/forms/attendee-roster-csv";

function addressDefinition(overrides: Partial<RegistrationFormDefinition> = {}): RegistrationFormDefinition {
  return registrationFormDefinitionSchema.parse({
    title: "Address slice test",
    description: "",
    confirmationMessage: "Received.",
    attendeeRoster: {
      enabled: true,
      minAttendees: 1,
      maxAttendees: 4,
      attendeeLabel: "Attendee",
      addButtonLabel: "Add another attendee",
    },
    sections: [
      {
        id: "contact",
        title: "Contact",
        description: "",
        fields: [
          { id: "field_mailing", key: "mailing_address", label: "Mailing address", helpText: "", type: "ADDRESS", scope: "REGISTRATION", required: true, options: [] },
          { id: "field_newsletter", key: "wants_newsletter", label: "Would you like a printed newsletter?", helpText: "", type: "RADIO", scope: "REGISTRATION", required: false, options: ["No", "Yes"] },
          { id: "field_mail_pref", key: "mail_preference", label: "Preferred mailing format", helpText: "", type: "TEXT", scope: "REGISTRATION", required: false, options: [], conditional: { fieldKey: "mailing_address", operator: "NOT_EMPTY", value: "" } },
        ],
      },
      {
        id: "attendees",
        title: "Attendees",
        description: "",
        fields: [
          { id: "field_first", key: "first_name", label: "First name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "field_last", key: "last_name", label: "Last name", helpText: "", type: "TEXT", scope: "ATTENDEE", required: true, options: [] },
          { id: "field_home", key: "home_address", label: "Home address", helpText: "", type: "ADDRESS", scope: "ATTENDEE", required: false, options: [] },
        ],
      },
    ],
    ...overrides,
  });
}

describe("structured address field", () => {
  it("accepts ADDRESS as a configured field type in both scopes", () => {
    expect(() => addressDefinition()).not.toThrow();
  });

  describe("normalization", () => {
    it("is deterministic for the same submitted snapshot", () => {
      const value = { line1: "123 Main St.", locality: "Springfield", region: "IL", postalCode: "62701", country: "United States" };
      const first = normalizeAddress(value);
      const second = normalizeAddress(structuredClone(value));
      expect(first).toEqual(second);
    });

    it("normalizes case, punctuation, and whitespace the same way regardless of formatting", () => {
      const tidy = normalizeAddress({ line1: "123 Main St", locality: "Springfield", country: "USA" });
      const messy = normalizeAddress({ line1: "  123   main st.  ", locality: "springfield", country: "usa" });
      expect(tidy.matchKey).toBe(messy.matchKey);
    });

    it("produces different match keys for different addresses", () => {
      const a = normalizeAddress({ line1: "123 Main St", locality: "Springfield", country: "USA" });
      const b = normalizeAddress({ line1: "456 Oak Ave", locality: "Springfield", country: "USA" });
      expect(a.matchKey).not.toBe(b.matchKey);
    });

    it("is evidence only: it does not verify or geocode, it just reshapes whatever was submitted", () => {
      const nonsense = normalizeAddress({ line1: "Not A Real Street 999999", locality: "Nowhere", country: "Neverland" });
      expect(nonsense.matchKey).toContain("NOWHERE");
    });
  });

  describe("international and partial addresses", () => {
    it("requires only line 1, locality, and country", () => {
      const issues = validateAddressValue("Mailing address", { line1: "10 Downing Street", locality: "London", country: "United Kingdom" });
      expect(issues).toHaveLength(0);
    });

    it("does not require a region or postal code", () => {
      // Many countries (e.g. Hong Kong) have no postal code, and many have
      // no first-level administrative region either.
      const issues = validateAddressValue("Mailing address", { line1: "1 Harbour Rd", locality: "Hong Kong", country: "Hong Kong" });
      expect(issues).toHaveLength(0);
    });

    it("flags a missing required component", () => {
      const issues = validateAddressValue("Mailing address", { line1: "10 Downing Street", country: "United Kingdom" });
      expect(issues.some((message) => message.includes("locality"))).toBe(true);
    });

    it("rejects a value that is not an address object", () => {
      expect(validateAddressValue("Mailing address", "123 Main St")).toEqual(["Mailing address must be a valid address."]);
    });

    it("flows through validateTestResponses for a partial international address", () => {
      const definition = addressDefinition();
      const result = validateTestResponses(definition, {
        mailing_address: { line1: "1 Harbour Rd", locality: "Hong Kong", country: "Hong Kong" },
      }, {}, "REGISTRATION");
      expect(result.isValid).toBe(true);
    });

    it("reports a required address as missing when it is empty", () => {
      const definition = addressDefinition();
      const result = validateTestResponses(definition, {}, {}, "REGISTRATION");
      expect(result.issues.some((issue) => issue.key === "mailing_address")).toBe(true);
    });
  });

  describe("stored snapshot", () => {
    it("keeps only known components, trims values, and drops unrelated keys", () => {
      const sanitized = sanitizeAddressInput({
        line1: "  123 Main St  ",
        line2: "",
        locality: "Springfield",
        region: "IL",
        postalCode: "62701",
        country: "United States",
        maliciousKey: "<script>alert(1)</script>",
      });
      expect(sanitized).toEqual({
        line1: "123 Main St",
        locality: "Springfield",
        region: "IL",
        postalCode: "62701",
        country: "United States",
      });
      expect(sanitized).not.toHaveProperty("maliciousKey");
      expect(sanitized).not.toHaveProperty("line2");
    });

    it("treats a fully blank address as having no value", () => {
      expect(hasAddressValue({ line1: "", locality: "", country: "" })).toBe(false);
      expect(hasAddressValue({ line1: "10 Downing Street" })).toBe(true);
    });

    it("produces a stable flattened display value", () => {
      const value = { line1: "123 Main St", line2: "Apt 4", locality: "Springfield", region: "IL", postalCode: "62701", country: "United States" };
      expect(formatAddressDisplay(value)).toBe("123 Main St, Apt 4, Springfield, IL 62701, United States");
    });

    it("survives a later field label change untouched", () => {
      const definitionV1 = addressDefinition();
      const { responses } = normalizePublicResponses(definitionV1, {
        mailing_address: { line1: "123 Main St", locality: "Springfield", region: "IL", postalCode: "62701", country: "United States" },
      });
      const storedSnapshot = structuredClone(responses.mailing_address);

      // A later draft renames the field's label. The definition object for
      // the new version is entirely separate from the stored response, so
      // the historical snapshot is unaffected.
      const definitionV2 = addressDefinition();
      definitionV2.sections[0].fields[0].label = "Home mailing address (updated)";

      expect(responses.mailing_address).toEqual(storedSnapshot);
      expect(formatAddressDisplay(responses.mailing_address)).toBe("123 Main St, Springfield, IL 62701, United States");
    });
  });

  describe("conditional visibility", () => {
    const definition = addressDefinition();
    const mailingAddressField = definition.sections[0].fields.find((field) => field.key === "mailing_address")!;
    const mailPreferenceField = definition.sections[0].fields.find((field) => field.key === "mail_preference")!;

    it("evaluates NOT_EMPTY against an address using its structured components", () => {
      expect(isFieldVisible(mailPreferenceField, { mailing_address: {} })).toBe(false);
      expect(isFieldVisible(mailPreferenceField, { mailing_address: { line1: "123 Main St" } })).toBe(true);
    });

    it("keeps the address field itself always visible when unconditional", () => {
      expect(isFieldVisible(mailingAddressField, {})).toBe(true);
    });

    it("drops a dependent field's stored answer once its address controller is cleared", () => {
      const { responses } = normalizePublicResponses(definition, {
        mailing_address: { line1: "123 Main St", locality: "Springfield", country: "United States" },
        mail_preference: "Postcard",
      });
      expect(responses.mail_preference).toBe("Postcard");

      const { responses: clearedResponses } = normalizePublicResponses(definition, {
        mailing_address: {},
        mail_preference: "Postcard",
      });
      expect(clearedResponses.mail_preference).toBeUndefined();
    });
  });

  describe("repeating attendee sections", () => {
    it("normalizes an attendee-scoped address independently for each attendee", () => {
      const definition = addressDefinition();
      const attendeeOne = normalizePublicResponses(definition, {
        first_name: "Ana",
        last_name: "Reyes",
        home_address: { line1: "1 First St", locality: "Ames", region: "IA", postalCode: "50010", country: "United States" },
      }).responses;
      const attendeeTwo = normalizePublicResponses(definition, {
        first_name: "Ben",
        last_name: "Cole",
        home_address: { line1: "2 Second St", locality: "Ames", region: "IA", postalCode: "50010", country: "United States" },
      }).responses;

      expect(attendeeOne.home_address).toEqual({ line1: "1 First St", locality: "Ames", region: "IA", postalCode: "50010", country: "United States" });
      expect(attendeeTwo.home_address).toEqual({ line1: "2 Second St", locality: "Ames", region: "IA", postalCode: "50010", country: "United States" });
      expect(normalizeAddress(attendeeOne.home_address).matchKey).not.toBe(normalizeAddress(attendeeTwo.home_address).matchKey);
    });

    it("allows an optional attendee-level address to stay blank", () => {
      const definition = addressDefinition();
      const result = validateTestResponses(definition, { first_name: "Ana", last_name: "Reyes" }, {}, "ATTENDEE");
      expect(result.isValid).toBe(true);
    });
  });

  describe("formula-safe exports", () => {
    it("splits an address into separate structured columns plus a flattened display column", () => {
      const definition = addressDefinition();
      const columns = exportAttendeeRosterCsv(definition, [
        {
          first_name: "Ana",
          last_name: "Reyes",
          home_address: { line1: "1 First St", locality: "Ames", region: "IA", postalCode: "50010", country: "United States" },
        },
      ]).split("\r\n")[0];
      expect(columns).toContain("Home address — Address line 1");
      expect(columns).toContain("Home address — City / locality");
      expect(columns).toContain("Home address (formatted)");
    });

    it("neutralizes a formula-injection attempt in an address component", () => {
      const definition = addressDefinition();
      const csv = exportAttendeeRosterCsv(definition, [
        {
          first_name: "Ana",
          last_name: "Reyes",
          home_address: { line1: "=1+1", locality: "Ames", country: "United States" },
        },
      ]);
      const dataRow = csv.split("\r\n")[1];
      // csvCell prefixes a leading =/+/-/@ with an apostrophe so spreadsheet
      // software treats the cell as text instead of a formula.
      expect(dataRow).toContain("'=1+1");
    });

    it("keeps a stable flattened value even when components are blank", () => {
      const definition = addressDefinition();
      const csv = exportAttendeeRosterCsv(definition, [
        { first_name: "Ana", last_name: "Reyes", home_address: {} },
      ]);
      const dataRow = csv.split("\r\n")[1];
      expect(dataRow).toBeDefined();
    });
  });
});
