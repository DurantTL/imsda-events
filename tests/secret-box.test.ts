import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getServerEnv: vi.fn() }));

vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));

import {
  SecretBoxError,
  isSecretEncryptionConfigured,
  openSecret,
  sealSecret,
} from "@/lib/secret-box";

const key = "a-secret-encryption-key-of-adequate-length";

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: key });
});

describe("sealed secrets", () => {
  it("round-trips a value", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret");
    expect(openSecret(sealed, "mfa-totp-secret")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("stores no trace of the plaintext", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(sealed.startsWith("v1.")).toBe(true);
  });

  it("produces a different ciphertext every time", () => {
    // A fresh nonce per value: two accounts with the same secret must not have
    // the same row, or the column leaks equality.
    const first = sealSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret");
    const second = sealSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret");
    expect(first).not.toBe(second);
    expect(openSecret(second, "mfa-totp-secret")).toBe(openSecret(first, "mfa-totp-secret"));
  });

  it("refuses a value sealed for another purpose", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret");
    expect(() => openSecret(sealed, "some-other-purpose")).toThrowError(SecretBoxError);
  });

  it("refuses a tampered ciphertext", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret");
    const [format, nonce, tag, ciphertext] = sealed.split(".");
    const flipped = Buffer.from(ciphertext, "base64url");
    flipped[0] ^= 0x01;
    const tampered = [format, nonce, tag, flipped.toString("base64url")].join(".");

    expect(() => openSecret(tampered, "mfa-totp-secret")).toThrowError(/could not be decrypted/);
  });

  it("refuses a value sealed under a different key", () => {
    const sealed = sealSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret");
    dependencies.getServerEnv.mockReturnValue({
      SECRET_ENCRYPTION_KEY: "a-different-encryption-key-of-adequate-length",
    });

    expect(() => openSecret(sealed, "mfa-totp-secret")).toThrowError(/encryption key may have changed/);
  });

  it("says plainly when no key is configured", () => {
    dependencies.getServerEnv.mockReturnValue({ SECRET_ENCRYPTION_KEY: undefined });

    expect(isSecretEncryptionConfigured()).toBe(false);
    expect(() => sealSecret("value", "mfa-totp-secret")).toThrowError(/SECRET_ENCRYPTION_KEY/);
  });

  it("rejects a stored value that is not in the sealed format", () => {
    expect(() => openSecret("JBSWY3DPEHPK3PXP", "mfa-totp-secret"))
      .toThrowError(/expected sealed format/);
  });
});
