import { describe, expect, it } from "vitest";
import {
  PHONE_FIELD_MESSAGE,
  emailAddressSchema,
  emailToStore,
  isUnchangedEmail,
  inlinePhoneProblem,
  isUnchangedPhone,
  newPhoneSchema,
  phoneToStore,
  resolvePhoneChange,
} from "@/lib/field-validation";
import { billingContactActionSchema, billingContactInputSchema } from "@/modules/billing-responsibility/schemas";
import { directorContactPrefill } from "@/modules/club-registrations/contact-prefill";
import { yearEndFieldKeys } from "@/modules/club-reports/year-end-domain";
import { yearEndReportInputSchema } from "@/modules/club-reports/year-end-schemas";
import { typedAnswerProblem, type RegistrationFormDefinition, type RegistrationFormField } from "@/modules/forms/definition";
import { publicContactUpdateSchema } from "@/modules/public-access/domain";
import {
  attendeeInputSchema,
  attendeeSubstitutionInputSchema,
  registrationInputSchema,
  registrationTransferInputSchema,
  registrationUpdateSchema,
} from "@/modules/registrations/schemas";

/** #871: the remaining phone and email schemas on the shared validators. Synthetic data only. */

const OLD_BAD = "555-0100";
const VALID = "(515) 555-0134";
const requestId = "6999ad17-b589-4740-a41a-3dc082d35d66";

function messagesOf(result: { success: boolean; error?: { issues: Array<{ message: string }> } }) {
  return result.success ? [] : result.error!.issues.map((issue) => issue.message);
}

describe("isUnchangedPhone: the stored value decides", () => {
  it("counts the same number in a different format as unchanged", () => {
    expect(isUnchangedPhone("515.555.0134", VALID)).toBe(true);
    expect(isUnchangedPhone("+1 515 555 0134", VALID)).toBe(true);
    expect(isUnchangedPhone(" (515) 555-0134 ", "515-555-0134")).toBe(true);
  });

  it("counts a re-formatted old unusable number as unchanged", () => {
    expect(isUnchangedPhone("555 0100", OLD_BAD)).toBe(true);
    expect(isUnchangedPhone("(555) 0100", OLD_BAD)).toBe(true);
    expect(isUnchangedPhone("Call Mom", "call  mom")).toBe(true);
    expect(isUnchangedPhone("call dad", "call mom")).toBe(false);
  });

  it("counts a different number, or nothing stored, as changed", () => {
    expect(isUnchangedPhone("515-555-0199", VALID)).toBe(false);
    expect(isUnchangedPhone("555-0199", OLD_BAD)).toBe(false);
    expect(isUnchangedPhone(OLD_BAD, VALID)).toBe(false);
    expect(isUnchangedPhone(VALID, OLD_BAD)).toBe(false);
    expect(isUnchangedPhone(OLD_BAD, "")).toBe(false);
    expect(isUnchangedPhone(OLD_BAD, null)).toBe(false);
    expect(isUnchangedPhone(OLD_BAD, undefined)).toBe(false);
    expect(isUnchangedPhone("", OLD_BAD)).toBe(false);
  });
});

describe("resolvePhoneChange and phoneToStore", () => {
  it("stores a changed valid phone normalised, including international numbers", () => {
    expect(resolvePhoneChange("515-555-0134", OLD_BAD)).toEqual({ ok: true, value: VALID });
    expect(resolvePhoneChange("+52 55 1234 5678", "")).toEqual({ ok: true, value: "+52 55 1234 5678" });
    expect(resolvePhoneChange("515 555 0134 ext 7", null)).toEqual({ ok: true, value: "(515) 555-0134 x7" });
  });

  it("allows blank (an empty optional value)", () => {
    expect(resolvePhoneChange("   ", OLD_BAD)).toEqual({ ok: true, value: "" });
    expect(phoneToStore(["phone"], "", null)).toBe("");
  });

  it("rejects a changed invalid phone with a message that never has the value", () => {
    const result = resolvePhoneChange("idk 911", OLD_BAD);
    expect(result).toEqual({ ok: false, message: PHONE_FIELD_MESSAGE });
    expect(PHONE_FIELD_MESSAGE).not.toContain("911");
    expect(() => phoneToStore(["phone"], "idk 911", OLD_BAD)).toThrow();
    try {
      phoneToStore(["contact", "phone"], "idk 911", OLD_BAD);
    } catch (error) {
      expect(JSON.stringify((error as { issues: unknown }).issues)).not.toContain("idk");
      expect((error as { issues: Array<{ path: unknown }> }).issues[0]!.path).toEqual(["contact", "phone"]);
    }
  });

  it("keeps an unchanged old unusable phone exactly as stored", () => {
    expect(resolvePhoneChange(OLD_BAD, OLD_BAD)).toEqual({ ok: true, value: OLD_BAD });
    expect(resolvePhoneChange("555 0100", OLD_BAD)).toEqual({ ok: true, value: OLD_BAD });
  });
});

describe("an untouched valid phone is kept exactly as stored", () => {
  it("does not rewrite an unformatted stored number, so nothing records a change", () => {
    expect(resolvePhoneChange("515-555-0134", "515-555-0134")).toEqual({ ok: true, value: "515-555-0134" });
    expect(resolvePhoneChange("515.555.0134", "515-555-0134")).toEqual({ ok: true, value: "515-555-0134" });
    expect(phoneToStore(["phone"], "(515) 555-0134", "5155550134")).toBe("5155550134");
  });
});

describe("emailToStore: the stored email decides", () => {
  const longEmail = `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.test`;

  it("keeps an unchanged stored email as stored, even over the shared length cap", () => {
    expect(longEmail.length).toBeGreaterThan(160);
    expect(isUnchangedEmail(` ${longEmail.toUpperCase()} `, longEmail)).toBe(true);
    expect(emailToStore(["contactEmail"], longEmail, longEmail)).toBe(longEmail);
  });

  it("holds a changed email to the shared check, and the error never carries it", () => {
    expect(emailToStore(["contactEmail"], " New@Example.Test ", "old@example.test")).toBe("New@Example.Test");
    expect(emailToStore(["contactEmail"], "", "old@example.test")).toBe("");
    for (const bad of ["not-an-email", longEmail]) {
      try {
        emailToStore(["contactEmail"], bad, "old@example.test");
        throw new Error("should have thrown");
      } catch (error) {
        expect(JSON.stringify((error as { issues: unknown }).issues)).not.toContain(bad.slice(0, 20));
      }
    }
    expect(isUnchangedEmail("a@example.test", "")).toBe(false);
    expect(isUnchangedEmail("a@example.test", null)).toBe(false);
  });

  it("gives an over-long email a plain message that does not echo it", () => {
    const result = emailAddressSchema.safeParse(`${"a".repeat(170)}@example.test`);
    expect(messagesOf(result)).toEqual(["Email must be 160 characters or fewer."]);
    expect(JSON.stringify(result)).not.toContain("aaaaaaaaaa");
  });
});

describe("inlinePhoneProblem: the browser message", () => {
  it("is silent for a blank or valid phone", () => {
    expect(inlinePhoneProblem("Phone", "", OLD_BAD, true)).toEqual({ message: "", blocking: false });
    expect(inlinePhoneProblem("Phone", "515-555-0134", undefined, true)).toEqual({ message: "", blocking: false });
  });

  it("blocks a changed bad phone, but shows the message only once it is shown", () => {
    const hidden = inlinePhoneProblem("Phone", "idk 911", OLD_BAD, false);
    expect(hidden).toEqual({ message: "", blocking: true });
    const shown = inlinePhoneProblem("Phone", "idk 911", OLD_BAD, true);
    expect(shown.blocking).toBe(true);
    expect(shown.message).toMatch(/^Phone must be a 10-digit US number/);
    expect(shown.message).not.toContain("911");
  });

  it("flags an old bad phone left alone as needing correction without blocking, even when only its format changed", () => {
    for (const typed of [OLD_BAD, "555 0100"]) {
      const result = inlinePhoneProblem("Phone", typed, OLD_BAD, false);
      expect(result.blocking).toBe(false);
      expect(result.message).toMatch(/needs correcting/);
    }
  });
});

describe("registration contact schemas (modules/registrations/schemas.ts)", () => {
  const base = { firstName: "Alicia", lastName: "Smith", email: "alicia@example.test", attendeeType: "ATTENDEE", status: "SUBMITTED", totalAmountCents: 100 };

  it("stores a new registration's phone normalised, and accepts an international one or none", () => {
    expect(registrationInputSchema.parse({ ...base, phone: " 515-555-0134 " }).phone).toBe(VALID);
    expect(registrationInputSchema.parse({ ...base, phone: "+44 20 7946 0958" }).phone).toBe("+44 20 7946 0958");
    expect(registrationInputSchema.parse(base).phone).toBe("");
    expect(registrationInputSchema.parse({ ...base, phone: "" }).email).toBe("alicia@example.test");
  });

  it("rejects a new registration's invalid phone, and the message does not echo it", () => {
    const result = registrationInputSchema.safeParse({ ...base, phone: "idk 911" });
    expect(messagesOf(result)).toEqual([PHONE_FIELD_MESSAGE]);
    expect(JSON.stringify(result)).not.toContain("idk 911");
    expect(registrationInputSchema.safeParse({ ...base, phone: OLD_BAD }).success).toBe(false);
  });

  it("checks the email with the shared check, and lower-cases it", () => {
    expect(registrationInputSchema.parse({ ...base, email: " ALICIA@EXAMPLE.TEST " }).email).toBe("alicia@example.test");
    const result = registrationInputSchema.safeParse({ ...base, email: "not-an-email" });
    expect(messagesOf(result)).toEqual(["Enter a valid email address."]);
    expect(JSON.stringify(result)).not.toContain("not-an-email");
  });

  it("leaves an edit's phone to be judged against the stored one, so an old number can pass the schema", () => {
    expect(registrationUpdateSchema.parse({ phone: ` ${OLD_BAD} ` })).toEqual({ phone: OLD_BAD });
    expect(registrationUpdateSchema.safeParse({ phone: "x".repeat(41) }).success).toBe(false);
  });

  it("checks an added attendee's phone and email as new values", () => {
    expect(attendeeInputSchema.parse({ firstName: "Avery", lastName: "Miller", phone: "515.555.0134" }).phone).toBe(VALID);
    expect(attendeeInputSchema.safeParse({ firstName: "Avery", lastName: "Miller", phone: OLD_BAD }).success).toBe(false);
    expect(attendeeInputSchema.safeParse({ firstName: "Avery", lastName: "Miller", email: "bad" }).success).toBe(false);
    expect(attendeeInputSchema.parse({ firstName: "Avery", lastName: "Miller" })).toMatchObject({ phone: "", email: "" });
  });

  it("checks a transfer's and a substitution's phone and email as new values", () => {
    const person = { firstName: "Casey", lastName: "Jones", clientRequestId: requestId };
    expect(registrationTransferInputSchema.parse({ ...person, email: " New@Example.Test ", phone: "515-555-0134" })).toMatchObject({ email: "new@example.test", phone: VALID });
    expect(registrationTransferInputSchema.safeParse({ ...person, email: "new@example.test", phone: OLD_BAD }).success).toBe(false);
    expect(messagesOf(registrationTransferInputSchema.safeParse({ ...person, email: "" }))).toContain("Enter the new contact's email address.");
    expect(attendeeSubstitutionInputSchema.parse({ ...person, phone: "515-555-0134" }).phone).toBe(VALID);
    expect(attendeeSubstitutionInputSchema.parse(person)).toMatchObject({ phone: "", email: "" });
    expect(attendeeSubstitutionInputSchema.safeParse({ ...person, phone: "idk" }).success).toBe(false);
  });
});

describe("public contact schema (modules/public-access/domain.ts)", () => {
  const contact = { firstName: "Caleb", lastName: "Durant", email: "Caleb@Example.Test", phone: OLD_BAD };

  it("requires an email, checks it with the shared check and lower-cases it", () => {
    expect(publicContactUpdateSchema.parse(contact).email).toBe("caleb@example.test");
    expect(messagesOf(publicContactUpdateSchema.safeParse({ ...contact, email: "" }))).toEqual(["Email is required."]);
    expect(messagesOf(publicContactUpdateSchema.safeParse({ ...contact, email: "nope" }))).toEqual(["Enter a valid email address."]);
  });

  it("leaves the phone to be judged against the stored one where the registration is loaded", () => {
    expect(publicContactUpdateSchema.parse(contact).phone).toBe(OLD_BAD);
  });
});

describe("billing contact schema (modules/billing-responsibility/schemas.ts)", () => {
  const contact = { name: "Pat Treasurer", email: "Pat@Example.Test", roleLabel: "Treasurer" };

  it("stores a new contact's phone normalised, null when blank, and lower-cases the email", () => {
    expect(billingContactInputSchema.parse({ ...contact, phone: "515-555-0134" })).toMatchObject({ phone: VALID, email: "pat@example.test" });
    expect(billingContactInputSchema.parse({ ...contact, phone: "" }).phone).toBeNull();
    expect(billingContactInputSchema.parse(contact).phone).toBeNull();
    expect(billingContactInputSchema.parse({ ...contact, phone: "+52 55 1234 5678" }).phone).toBe("+52 55 1234 5678");
  });

  it("rejects an invalid phone or email with messages that never carry them", () => {
    const badPhone = billingContactInputSchema.safeParse({ ...contact, phone: "idk 911" });
    expect(messagesOf(badPhone)).toEqual([PHONE_FIELD_MESSAGE]);
    expect(JSON.stringify(badPhone)).not.toContain("idk 911");
    const badEmail = billingContactInputSchema.safeParse({ ...contact, email: "nope" });
    expect(messagesOf(badEmail)).toEqual(["Enter a valid email address."]);
    expect(messagesOf(billingContactInputSchema.safeParse({ ...contact, email: "" }))).toEqual(["Enter the contact's email."]);
  });

  it("applies through the set action", () => {
    expect(billingContactActionSchema.safeParse({ action: "set", contact: { ...contact, phone: OLD_BAD } }).success).toBe(false);
    expect(billingContactActionSchema.safeParse({ action: "set", contact: { ...contact, phone: VALID } }).success).toBe(true);
  });
});

describe("year-end report schema (modules/club-reports/year-end-schemas.ts)", () => {
  const values = Object.fromEntries(yearEndFieldKeys.map((key) => [key, 0]));
  const report = { contactName: "Pat Example", contactEmail: "pat@example.test", values, status: "SUBMITTED" };

  it("checks the email with the shared check", () => {
    expect(yearEndReportInputSchema.safeParse(report).success).toBe(true);
    const bad = yearEndReportInputSchema.safeParse({ ...report, contactEmail: "nope" });
    expect(messagesOf(bad)).toEqual(["Enter a valid email address."]);
    expect(JSON.stringify(bad)).not.toContain("nope");
  });

  it("leaves the three phones to be judged against the saved report", () => {
    const parsed = yearEndReportInputSchema.parse({ ...report, contactWorkPhone: OLD_BAD, contactHomePhone: "", contactCellPhone: VALID });
    expect(parsed).toMatchObject({ contactWorkPhone: OLD_BAD, contactHomePhone: "", contactCellPhone: VALID });
  });
});

describe("shared schemas", () => {
  it("newPhoneSchema and emailAddressSchema treat blank as empty", () => {
    expect(newPhoneSchema.parse("  ")).toBe("");
    expect(emailAddressSchema.parse("  ")).toBe("");
    expect(newPhoneSchema.safeParse("x".repeat(41)).success).toBe(false);
    expect(emailAddressSchema.safeParse(`${"a".repeat(160)}@example.test`).success).toBe(false);
  });
});

describe("a legacy profile phone prefilled into a NEW registration is a new value", () => {
  const field = (key: string, label: string, type: RegistrationFormField["type"]) => (
    { id: key, key, label, type, required: false, scope: "REGISTRATION", options: [] } as unknown as RegistrationFormField
  );
  const phoneField = field("phone", "Mobile phone", "PHONE");
  const definition = {
    title: "Synthetic club event", description: "", confirmationMessage: "",
    attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Member", addButtonLabel: "Add" },
    sections: [{ id: "s1", title: "Club", description: "", fields: [phoneField] }],
  } as unknown as RegistrationFormDefinition;
  const director = { firstName: "Avery", lastName: "Director", email: "director@example.test", mobile: OLD_BAD };

  it("is prefilled as it is, and then fails the same check any new answer faces, with a fixable message", () => {
    const prefill = directorContactPrefill(definition, director);
    expect(prefill.phone).toBe(OLD_BAD);
    // A new registration has nothing stored, so the prefill is not grandfathered.
    const problem = typedAnswerProblem(phoneField, prefill.phone);
    expect(problem).toMatch(/^Mobile phone must be a 10-digit US number/);
    expect(problem).not.toContain(OLD_BAD);
  });

  it("passes once the person fixes it", () => {
    expect(typedAnswerProblem(phoneField, "515-555-0134")).toBeNull();
  });

  it("a cleaned profile prefills a valid, normalised phone", () => {
    const cleaned = resolvePhoneChange("515.555.0134", OLD_BAD);
    expect(cleaned.ok && directorContactPrefill(definition, { ...director, mobile: cleaned.value }).phone).toBe(VALID);
  });
});
