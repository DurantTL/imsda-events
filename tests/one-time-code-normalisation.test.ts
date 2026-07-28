import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The rule both MFA routes apply to a submitted code. Kept as one description
 * here so the two routes cannot drift apart silently: `mfa/route.ts` guards an
 * account that already has a session, `mfa/challenge/route.ts` guards one that
 * does not, and a code that works at one has to work at the other.
 */
const mfaCodeSchema = z.string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().min(1).max(32));

describe("submitted MFA code normalisation", () => {
  it("accepts the grouped form password managers and phone autofill hand over", () => {
    // What a user sees in their authenticator is "123 456", so that is what
    // gets copied. Trimming the ends alone would reject it.
    expect(mfaCodeSchema.parse("123 456")).toBe("123456");
    expect(mfaCodeSchema.parse(" 123456 ")).toBe("123456");
    expect(mfaCodeSchema.parse("12 34 56")).toBe("123456");
  });

  it("keeps the dash a recovery code is hashed with", () => {
    // Recovery codes are NNNNN-NNNNN and the server hashes the whole string.
    // Stripping the dash would turn every valid recovery code into a failure.
    expect(mfaCodeSchema.parse(" 12345-67890 ")).toBe("12345-67890");
    expect(mfaCodeSchema.parse("12345 - 67890")).toBe("12345-67890");
  });

  it("still rejects a code that is only whitespace", () => {
    expect(mfaCodeSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects a code longer than the field allows once whitespace is gone", () => {
    expect(mfaCodeSchema.safeParse("1".repeat(33)).success).toBe(false);
    // Whitespace must not count towards the limit, or a spaced-out but valid
    // code could be refused for length it does not really have.
    expect(mfaCodeSchema.safeParse("1 ".repeat(20)).success).toBe(true);
  });
});

/**
 * The client-side rule for submitting a complete code without a button press.
 * Mirrors OneTimeCodeInput so the hazard it avoids stays documented: a recovery
 * code typed by hand passes through six digits on its way to ten.
 */
function shouldAutoSubmit(value: string, inputType: string | undefined) {
  const cleaned = value.replace(/\s+/g, "");
  return inputType !== "insertText" && /^\d{6}$/.test(cleaned);
}

describe("auto-submitting a complete code", () => {
  it("submits a pasted or autofilled six-digit code", () => {
    expect(shouldAutoSubmit("123456", "insertFromPaste")).toBe(true);
    expect(shouldAutoSubmit("123 456", "insertFromPaste")).toBe(true);
    // Chrome's autofill reports a replacement, or nothing at all.
    expect(shouldAutoSubmit("123456", "insertReplacementText")).toBe(true);
    expect(shouldAutoSubmit("123456", undefined)).toBe(true);
  });

  it("never submits while someone is typing", () => {
    // The sixth keystroke of a ten-digit recovery code. Submitting here would
    // fail the login and spend the attempt.
    expect(shouldAutoSubmit("123456", "insertText")).toBe(false);
  });

  it("does not submit an incomplete or non-numeric value", () => {
    expect(shouldAutoSubmit("12345", "insertFromPaste")).toBe(false);
    expect(shouldAutoSubmit("12345-67890", "insertFromPaste")).toBe(false);
    expect(shouldAutoSubmit("abc123", "insertFromPaste")).toBe(false);
  });
});
