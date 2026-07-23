import { describe, expect, it } from "vitest";
import { hashPassword, validatePassword, verifyPassword } from "@/modules/access/passwords";

describe("staff passwords", () => {
  it("stores a salted scrypt hash and verifies without plaintext", async () => {
    const password = "A long local passphrase!";
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword("A different passphrase!", hash)).resolves.toBe(false);
  });

  it("enforces length and blocks known weak choices without composition rules", () => {
    expect(validatePassword("too short")).toMatch(/12/);
    expect(validatePassword("password1234")).toMatch(/common/);
    expect(validatePassword("correct horse battery staple")).toBeNull();
  });
});
