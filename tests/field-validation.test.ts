import { describe, expect, it } from "vitest";
import {
  inputAttributesFor,
  isUnchangedFromStored,
  normalizePhoneAnswer,
  problemMessage,
  validateByType,
  validateDate,
  validateEmail,
  validateNumber,
  validatePhone,
  validateUrl,
  validateZip,
} from "@/lib/field-validation";

describe("phone (#855)", () => {
  it.each([
    ["(515) 555-0134", "(515) 555-0134"],
    ["515-555-0134", "(515) 555-0134"],
    ["515.555.0134", "(515) 555-0134"],
    ["5155550134", "(515) 555-0134"],
    ["+1 515 555 0134", "(515) 555-0134"],
    ["1-515-555-0134", "(515) 555-0134"],
  ])("accepts %s and stores it as %s", (input, stored) => {
    expect(validatePhone(input)).toEqual({ ok: true, value: stored });
  });

  it.each(["Mine", "idk", "911? duh", "911", "555-0134", "515-555-013", "515-555-01345", "015-555-0134", "515-155-0134", "+44 20 7946 0958", "515-555-0134 ext 5", ""])(
    "rejects %j",
    (input) => {
      expect(validatePhone(input).ok).toBe(false);
    },
  );

  it("names the problem without echoing the value", () => {
    const result = validatePhone("secret idk");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(problemMessage("Physician's phone", result.problem)).toMatch(/^Physician's phone must be a valid US phone number/);
      expect(result.problem).not.toContain("secret");
    }
  });

  it("normalises only valid phones", () => {
    expect(normalizePhoneAnswer("515 555 0134")).toBe("(515) 555-0134");
    expect(normalizePhoneAnswer("idk")).toBe("idk");
    expect(normalizePhoneAnswer(7)).toBe(7);
  });
});

describe("email", () => {
  it("accepts a normal address and rejects text", () => {
    expect(validateEmail(" kid@example.test ")).toEqual({ ok: true, value: "kid@example.test" });
    expect(validateEmail("not an email").ok).toBe(false);
    expect(validateEmail("a@b").ok).toBe(false);
    expect(validateEmail(`${"a".repeat(170)}@example.test`).ok).toBe(false);
  });
});

describe("number", () => {
  it("accepts plain numbers inside the limits", () => {
    expect(validateNumber("12", { min: 0, max: 20 }).ok).toBe(true);
    expect(validateNumber(0, { min: 0 }).ok).toBe(true);
    expect(validateNumber("1.5").ok).toBe(true);
  });

  it.each(["abc", "1e3", "0x10", "1,000", "12 kids", "", "NaN", "Infinity"])("rejects %j", (input) => {
    expect(validateNumber(input).ok).toBe(false);
  });

  it("enforces min, max and whole numbers", () => {
    expect(validateNumber("21", { min: 0, max: 20 }).ok).toBe(false);
    expect(validateNumber("-1", { min: 0 }).ok).toBe(false);
    expect(validateNumber("1.5", { integer: true }).ok).toBe(false);
    const result = validateNumber("50", { min: 1, max: 10, integer: true });
    expect(result).toEqual({ ok: false, problem: "must be a whole number from 1 to 10" });
  });
});

describe("date, ZIP and URL", () => {
  it("accepts only real calendar dates in YYYY-MM-DD", () => {
    expect(validateDate("2026-02-28").ok).toBe(true);
    expect(validateDate("2026-02-30").ok).toBe(false);
    expect(validateDate("03/01/2024").ok).toBe(false);
    expect(validateDate("yesterday").ok).toBe(false);
  });

  it("accepts 5-digit and ZIP+4 codes", () => {
    expect(validateZip("50010").ok).toBe(true);
    expect(validateZip("50010-1234").ok).toBe(true);
    expect(validateZip("5001").ok).toBe(false);
    expect(validateZip("ABCDE").ok).toBe(false);
  });

  it("accepts http and https addresses only", () => {
    expect(validateUrl("https://example.test/path").ok).toBe(true);
    expect(validateUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateUrl("example").ok).toBe(false);
    expect(validateUrl("ftp://example.test").ok).toBe(false);
  });
});

describe("validateByType and unchanged answers", () => {
  it("treats blank as the caller's required rule", () => {
    expect(validateByType("phone", "  ")).toEqual({ ok: true, value: "" });
    expect(validateByType("number", "x").ok).toBe(false);
  });

  it("does not hold an unchanged old answer against the person", () => {
    expect(isUnchangedFromStored("idk", "idk")).toBe(true);
    expect(isUnchangedFromStored(" idk ", "idk")).toBe(true);
    expect(isUnchangedFromStored("idk 2", "idk")).toBe(false);
    expect(isUnchangedFromStored("idk", undefined)).toBe(false);
    expect(isUnchangedFromStored("idk", "")).toBe(false);
  });

  it("gives phones a phone keypad and autofill", () => {
    expect(inputAttributesFor("phone")).toMatchObject({ type: "tel", inputMode: "tel", autoComplete: "tel" });
    expect(inputAttributesFor("email")).toMatchObject({ type: "email", inputMode: "email", autoComplete: "email" });
    expect(inputAttributesFor("zip")).toMatchObject({ inputMode: "numeric", autoComplete: "postal-code" });
    expect(inputAttributesFor("number")).toMatchObject({ type: "number", inputMode: "numeric" });
  });
});
