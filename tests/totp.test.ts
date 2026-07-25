import { describe, expect, it } from "vitest";
import {
  TOTP_STEP_SECONDS,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  totpCodeForStep,
  totpStep,
  verifyTotp,
} from "@/modules/access/totp";

/**
 * The RFC 6238 appendix B vectors, which is the only way to know an
 * implementation agrees with the authenticator apps rather than merely with
 * itself. The published seed is the ASCII "12345678901234567890".
 */
const RFC_SECRET = encodeBase32(Buffer.from("12345678901234567890", "utf8"));

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    for (const sample of ["", "a", "ab", "abc", "abcd", "abcde", "hello world"]) {
      const bytes = Buffer.from(sample, "utf8");
      expect(decodeBase32(encodeBase32(bytes)).toString("utf8")).toBe(sample);
    }
  });

  it("accepts the spacing and padding an app may show", () => {
    const encoded = encodeBase32(Buffer.from("12345678901234567890", "utf8"));
    const spaced = encoded.match(/.{1,4}/g)!.join(" ");
    expect(decodeBase32(spaced)).toEqual(decodeBase32(encoded));
    expect(decodeBase32(`${encoded}======`)).toEqual(decodeBase32(encoded));
  });

  it("rejects a secret that is not base32", () => {
    expect(() => decodeBase32("not-valid-base32!")).toThrowError(/base32/);
  });
});

describe("RFC 6238 vectors", () => {
  it("agrees with the published SHA-1 codes", () => {
    // Time, then the six trailing digits of the published eight-digit value.
    const vectors: Array<[number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
    ];
    for (const [seconds, expected] of vectors) {
      expect(totpCode(RFC_SECRET, new Date(seconds * 1000))).toBe(expected);
    }
  });

  it("changes every thirty seconds and no faster", () => {
    const at = new Date("2026-07-24T12:00:00.000Z");
    const sameStep = new Date(at.getTime() + (TOTP_STEP_SECONDS - 1) * 1000);
    const nextStep = new Date(at.getTime() + TOTP_STEP_SECONDS * 1000);

    expect(totpCode(RFC_SECRET, sameStep)).toBe(totpCode(RFC_SECRET, at));
    expect(totpCode(RFC_SECRET, nextStep)).not.toBe(totpCode(RFC_SECRET, at));
  });
});

describe("verification", () => {
  const at = new Date("2026-07-24T12:00:00.000Z");
  const step = totpStep(at);

  it("accepts the current code and reports the step it matched", () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, at), { at }))
      .toEqual({ valid: true, step });
  });

  it("allows one step of drift either side, and no more", () => {
    for (const offset of [-1, 1]) {
      expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step + offset), { at }))
        .toEqual({ valid: true, step: step + offset });
    }
    for (const offset of [-2, 2]) {
      expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step + offset), { at }))
        .toEqual({ valid: false, reason: "MISMATCH" });
    }
  });

  it("spends a step, so a code cannot be replayed inside its own window", () => {
    const code = totpCode(RFC_SECRET, at);
    const first = verifyTotp(RFC_SECRET, code, { at });
    expect(first).toEqual({ valid: true, step });

    expect(verifyTotp(RFC_SECRET, code, { at, lastUsedStep: step }))
      .toEqual({ valid: false, reason: "ALREADY_USED" });
    // An earlier step is spent too, so drift cannot be used to rewind.
    expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step - 1), { at, lastUsedStep: step }))
      .toEqual({ valid: false, reason: "ALREADY_USED" });
    // The next code still works.
    expect(verifyTotp(RFC_SECRET, totpCodeForStep(RFC_SECRET, step + 1), { at, lastUsedStep: step }))
      .toEqual({ valid: true, step: step + 1 });
  });

  it("rejects anything that is not six digits before doing any work", () => {
    for (const presented of ["", "12345", "1234567", "abcdef", "12 34 56 78"]) {
      expect(verifyTotp(RFC_SECRET, presented, { at }))
        .toEqual({ valid: false, reason: "MALFORMED" });
    }
    // Spacing inside a six-digit code is tolerated, because apps show it that way.
    const code = totpCode(RFC_SECRET, at);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, { at }).valid).toBe(true);
  });
});

describe("enrolment material", () => {
  it("generates a 160-bit secret", () => {
    const secret = generateTotpSecret();
    expect(decodeBase32(secret)).toHaveLength(20);
    expect(secret).not.toBe(generateTotpSecret());
  });

  it("builds a URI an authenticator can read", () => {
    const uri = otpauthUri({
      secretBase32: "JBSWY3DPEHPK3PXP",
      accountName: "alex@imsda.org",
      issuer: "events.imsda.org",
    });

    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=events.imsda.org");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
