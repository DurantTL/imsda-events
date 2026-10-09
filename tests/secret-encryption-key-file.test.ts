import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertServerEnvAtStartup,
  getEncryptionKeyStatus,
  resolveEncryptionKey,
  validateServerEnv,
} from "@/lib/env";
import { fillBlankSyntheticEnv } from "../scripts/support/synthetic-env";

const longSecret = "a-secret-that-is-at-least-thirty-two-characters";
const syntheticKey = "synthetic-file-key-0123456789-abcdefghijklmnop";

const productionEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://imsda:imsda@db:5432/imsda_events?schema=public",
  APP_BASE_URL: "https://events.imsda.org",
  MANAGE_LINK_DERIVATION_SECRET: longSecret,
  ATTENDEE_PASS_SIGNING_SECRET: longSecret,
  RATE_LIMIT_HASH_SECRET: longSecret,
  OUTBOX_SWEEP_TOKEN: longSecret,
  RESEND_API_KEY: "re_a_production_key",
  ACCOUNT_EMAIL_SENDER_ADDRESS: "events@imsda.org",
};

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "imsda-key-test-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function keyFile(contents: string) {
  const file = path.join(directory, "secret-encryption-key");
  writeFileSync(file, contents, { mode: 0o400 });
  return file;
}

describe("SECRET_ENCRYPTION_KEY_FILE", () => {
  it("loads and trims the key from the file", () => {
    const result = validateServerEnv({
      ...productionEnv,
      SECRET_ENCRYPTION_KEY_FILE: keyFile(`${syntheticKey}\n`),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.SECRET_ENCRYPTION_KEY).toBe(syntheticKey);
  });

  it("keeps the plain variable working", () => {
    const result = validateServerEnv({ ...productionEnv, SECRET_ENCRYPTION_KEY: syntheticKey });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.SECRET_ENCRYPTION_KEY).toBe(syntheticKey);
  });

  it("refuses to start when both are set, without printing either value", () => {
    const file = keyFile(syntheticKey);
    const result = validateServerEnv({
      ...productionEnv,
      SECRET_ENCRYPTION_KEY: "another-synthetic-plain-key-0123456789abcdef",
      SECRET_ENCRYPTION_KEY_FILE: file,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = result.issues.join("\n");
    expect(text).toContain("both set");
    expect(text).not.toContain(syntheticKey);
    expect(text).not.toContain("another-synthetic-plain-key");
  });

  it("refuses to start when the file is missing", () => {
    const result = validateServerEnv({
      ...productionEnv,
      SECRET_ENCRYPTION_KEY_FILE: path.join(directory, "absent"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toContain("does not exist");
      // One clear message, not a second "must contain 32 characters" complaint.
      expect(result.issues.filter((issue) => issue.startsWith("SECRET_ENCRYPTION_KEY:"))).toHaveLength(0);
    }
  });

  it("refuses to start when the file is empty or only whitespace", () => {
    for (const contents of ["", "  \n\t\n"]) {
      const result = validateServerEnv({ ...productionEnv, SECRET_ENCRYPTION_KEY_FILE: keyFile(contents) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues.join("\n")).toContain("empty");
    }
  });

  it("refuses to start when the path cannot be read as a file", () => {
    const result = validateServerEnv({ ...productionEnv, SECRET_ENCRYPTION_KEY_FILE: directory });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join("\n")).toContain("could not be read");
  });

  it("still enforces the production length rule on a key from a file", () => {
    const result = validateServerEnv({ ...productionEnv, SECRET_ENCRYPTION_KEY_FILE: keyFile("too-short") });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join("\n")).toContain("SECRET_ENCRYPTION_KEY: must contain at least 32");
      expect(result.issues.join("\n")).not.toContain("too-short");
    }
  });

  it("makes the production startup throw and never logs the key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() =>
        assertServerEnvAtStartup({ ...productionEnv, SECRET_ENCRYPTION_KEY_FILE: path.join(directory, "absent") }),
      ).toThrow(/SECRET_ENCRYPTION_KEY_FILE/);
      assertServerEnvAtStartup({
        ...productionEnv,
        NODE_ENV: "development",
        SECRET_ENCRYPTION_KEY: syntheticKey,
        SECRET_ENCRYPTION_KEY_FILE: keyFile(syntheticKey),
      });
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join("\n")).not.toContain(syntheticKey);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("encryption key status", () => {
  it("reports file, env and none, never the value", () => {
    const file = keyFile(syntheticKey);
    expect(getEncryptionKeyStatus({ SECRET_ENCRYPTION_KEY_FILE: file })).toEqual({ configured: true, source: "file" });
    expect(getEncryptionKeyStatus({ SECRET_ENCRYPTION_KEY: syntheticKey })).toEqual({ configured: true, source: "env" });
    expect(getEncryptionKeyStatus({})).toEqual({ configured: false, source: null });
    expect(getEncryptionKeyStatus({ SECRET_ENCRYPTION_KEY_FILE: path.join(directory, "absent") })).toEqual({
      configured: false,
      source: "file",
    });
    expect(
      getEncryptionKeyStatus({ SECRET_ENCRYPTION_KEY: syntheticKey, SECRET_ENCRYPTION_KEY_FILE: file }),
    ).toEqual({ configured: false, source: "file" });
    expect(JSON.stringify(getEncryptionKeyStatus({ SECRET_ENCRYPTION_KEY_FILE: file }))).not.toContain(syntheticKey);
  });

  it("resolves to no key when nothing is set", () => {
    expect(resolveEncryptionKey({})).toEqual({ ok: true, key: undefined, source: "none" });
  });
});

describe("synthetic verification environment", () => {
  it("does not add a plain key beside a key file", () => {
    const env: Record<string, string | undefined> = { SECRET_ENCRYPTION_KEY_FILE: keyFile(syntheticKey) };
    fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "synthetic-not-a-secret", env);
    expect(env.SECRET_ENCRYPTION_KEY).toBeUndefined();
    const plain: Record<string, string | undefined> = {};
    fillBlankSyntheticEnv("SECRET_ENCRYPTION_KEY", "synthetic-not-a-secret", plain);
    expect(plain.SECRET_ENCRYPTION_KEY).toBe("synthetic-not-a-secret");
  });
});
