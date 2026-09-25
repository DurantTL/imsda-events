import { describe, expect, it } from "vitest";
import { hashPassword, validatePassword, verifyPassword } from "@/modules/access/passwords";
import {
  checkPasswordRequirements,
  MIN_PASSWORD_LENGTH,
  passwordCandidates,
  repeatingUnit,
  validatePasswordShape,
} from "@/modules/access/password-policy";

describe("staff passwords", () => {
  it("stores a salted scrypt hash and verifies without plaintext", async () => {
    const password = "A long local passphrase!";
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword("A different passphrase!", hash)).resolves.toBe(false);
  });

  it("accepts an ordinary passphrase without composition rules", () => {
    expect(validatePassword("correct horse battery staple")).toBeNull();
    expect(validatePassword("the wednesday rehearsal ran late")).toBeNull();
  });
});

describe("password policy", () => {
  it("holds a floor high enough to matter", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(14);
    expect(validatePasswordShape("Sh0rt!Passw0r")).toMatch(/at least 14/);
    expect(validatePasswordShape("q".repeat(129))).toMatch(/no more than 128/);
  });

  it("counts characters, not UTF-16 units", () => {
    // Seven code points that occupy fourteen units. Length has to mean what a
    // person would count, or an emoji password passes a rule it fails.
    expect(validatePasswordShape("🎭🎪🎨🎬🎯🎲🃏")).toMatch(/at least 14/);
  });

  it("sees through the padding that a length floor alone invites", () => {
    // Each of these clears fourteen characters and is a top-corpus word.
    expect(validatePasswordShape("P@ssw0rd1234!!")).toMatch(/less common/);
    expect(validatePasswordShape("Sunshine!!!!!!!!")).toMatch(/less common/);
    expect(validatePasswordShape("letmein-letmein-letmein")).toMatch(/less common/);
    expect(validatePasswordShape("qwertyuiop123456")).toMatch(/less common/);
    expect(validatePasswordShape("imsda-events-2026")).toMatch(/less common/);
  });

  it("rejects repetition and straight runs", () => {
    expect(validatePasswordShape("abababababababab")).toMatch(/repetitive/);
    expect(validatePasswordShape("wwwwwwwwwwwwwwww")).toMatch(/repetitive/);
    expect(validatePasswordShape("klmnopqrstuvwxyz")).toMatch(/keyboard or the alphabet/);
  });

  it("rejects a password built from its owner's own details", () => {
    const owner = { email: "alex.morgan@imsda.org", displayName: "Alex Morgan" };
    expect(validatePasswordShape("alex.morgan rides again", owner)).toMatch(/your name or email/);
    expect(validatePasswordShape("mornings with MORGAN!", owner)).toMatch(/your name or email/);
    // The same passphrase is fine for somebody else.
    expect(validatePasswordShape("mornings with MORGAN!", {
      email: "sam@imsda.org",
      displayName: "Sam Lee",
    })).toBeNull();
  });

  it("rejects control characters and accepts spaces and punctuation", () => {
    expect(validatePasswordShape("a good phrase\there")).toMatch(/control characters/);
    expect(validatePasswordShape("a good phrase — with punctuation")).toBeNull();
  });

  it("never echoes the password it rejected", () => {
    const password = "P@ssw0rd1234!!";
    expect(validatePasswordShape(password)).not.toContain(password);
  });

  it("strips padding before undoing substitutions, not after", () => {
    // Undoing substitutions first turns the trailing 1234 into letters and
    // buries the word this is meant to expose.
    expect(passwordCandidates("P@ssw0rd-1234!")).toContain("password");
    expect(passwordCandidates("letmeinletmeinletmein")).toContain("letmein");
    expect(repeatingUnit("abcabcabc")).toBe("abc");
    expect(repeatingUnit("abcdef")).toBe("abcdef");
  });
});

describe("the shared password requirements checklist (#434)", () => {
  // The list a client ticks off live, and the server's accept/reject
  // decision, are driven off the exact same PASSWORD_REQUIREMENTS array —
  // so an input the checklist shows as fully met is exactly one
  // validatePasswordShape accepts, and one it rejects always leaves at least
  // one requirement unmet.
  const owner = { email: "alex.morgan@imsda.org", displayName: "Alex Morgan" };
  const samples = [
    "a good long phrase with plenty of words",
    "Sh0rt!Passw0r",
    "q".repeat(129),
    "P@ssw0rd1234!!",
    "abababababababab",
    "klmnopqrstuvwxyz",
    "alex.morgan rides again",
    "mornings with MORGAN!",
    "a good phrase\there",
    "",
    "correct horse battery staple, said nobody at imsda",
  ];

  it.each(samples)("agrees with validatePasswordShape for %j", (password) => {
    const serverAccepted = validatePasswordShape(password, owner) === null;
    const requirements = checkPasswordRequirements(password, owner);
    const clientAccepted = requirements.every((requirement) => requirement.met);
    expect(clientAccepted).toBe(serverAccepted);
  });

  it("ticks off every requirement for a password that clears the bar", () => {
    const requirements = checkPasswordRequirements("a good long phrase with plenty of words", owner);
    expect(requirements.length).toBeGreaterThan(0);
    expect(requirements.every((requirement) => requirement.met)).toBe(true);
  });

  it("leaves the length requirement unmet, and nothing else required to be met, for an empty password", () => {
    const requirements = checkPasswordRequirements("", owner);
    const length = requirements.find((requirement) => requirement.id === "length");
    expect(length?.met).toBe(false);
  });
});
