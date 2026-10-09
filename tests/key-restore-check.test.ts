import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isScratchDatabaseName, runKeyRestoreCheck } from "../scripts/backup/verify-key-restore";
import { SecretBoxError, sealSecretWithKey } from "@/lib/secret-box";

const key = "synthetic-backup-key-0123456789-abcdefghijklmn";
const otherKey = "synthetic-different-key-0123456789-abcdefghijk";
const scratchUrl = "postgresql://user:hunter2pw@db:5432/imsda_events_restore_check?schema=public";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "imsda-restore-check-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

function keyFile(contents: string) {
  const file = path.join(directory, "backup-key");
  writeFileSync(file, contents, { mode: 0o400 });
  return file;
}

function harness(
  env: Record<string, string | undefined>,
  options: { canaryOnly?: boolean; sealed?: string | null | Error } = {},
) {
  const out: string[] = [];
  const readSealedValue = vi.fn(async () => {
    if (options.sealed instanceof Error) throw options.sealed;
    return options.sealed ?? null;
  });
  const run = () =>
    runKeyRestoreCheck({
      env,
      canaryOnly: options.canaryOnly ?? false,
      log: (line) => out.push(line),
      error: (line) => out.push(line),
      readSealedValue,
    });
  return { run, out, readSealedValue, text: () => out.join("\n") };
}

describe("key restore check", () => {
  it("accepts only restore_check database names", () => {
    expect(isScratchDatabaseName("restore_check")).toBe(true);
    expect(isScratchDatabaseName("imsda_events_restore_check")).toBe(true);
    for (const name of ["imsda_events", "restore_check_old", "imsda_events_test", "scratch", "restore_checks", ""]) {
      expect(isScratchDatabaseName(name)).toBe(false);
    }
  });

  it("works with only the key file set, in canary-only mode", async () => {
    const h = harness({ SECRET_ENCRYPTION_KEY_FILE: keyFile(`${key}\n`) }, { canaryOnly: true });
    await expect(h.run()).resolves.toBe(0);
    expect(h.text()).toContain("PASSED");
    expect(h.text()).not.toContain(key);
    expect(h.readSealedValue).not.toHaveBeenCalled();
  });

  it("refuses a database that is not a scratch database, without reading it or printing the URL", async () => {
    const h = harness({
      SECRET_ENCRYPTION_KEY_FILE: keyFile(key),
      DATABASE_URL: "postgresql://user:hunter2pw@db:5432/imsda_events?schema=public",
    });
    await expect(h.run()).resolves.toBe(1);
    expect(h.text()).toContain("not a scratch database");
    expect(h.text()).not.toContain("hunter2pw");
    expect(h.readSealedValue).not.toHaveBeenCalled();
  });

  it("opens a sealed value from the scratch database with the right key", async () => {
    const sealed = sealSecretWithKey("synthetic-totp-secret", "mfa-totp-secret", key);
    const h = harness({ SECRET_ENCRYPTION_KEY_FILE: keyFile(key), DATABASE_URL: scratchUrl }, { sealed });
    await expect(h.run()).resolves.toBe(0);
    expect(h.text()).toContain("opened one sealed value");
    expect(h.text()).not.toContain(key);
    expect(h.text()).not.toContain("synthetic-totp-secret");
    expect(h.text()).not.toContain(sealed);
  });

  it("fails with the wrong key and prints nothing secret", async () => {
    const sealed = sealSecretWithKey("synthetic-totp-secret", "mfa-totp-secret", otherKey);
    const h = harness({ SECRET_ENCRYPTION_KEY_FILE: keyFile(key), DATABASE_URL: scratchUrl }, { sealed });
    await expect(h.run()).resolves.toBe(1);
    expect(h.text()).toContain("could NOT open");
    for (const secret of [key, otherKey, sealed, "synthetic-totp-secret", "hunter2pw"]) {
      expect(h.text()).not.toContain(secret);
    }
  });

  it("fails clearly when there is no key, a bad file, or a short key", async () => {
    await expect(harness({}, { canaryOnly: true }).run()).resolves.toBe(1);
    const missing = harness({ SECRET_ENCRYPTION_KEY_FILE: path.join(directory, "absent") }, { canaryOnly: true });
    await expect(missing.run()).resolves.toBe(1);
    expect(missing.text()).toContain("does not exist");
    const short = harness({ SECRET_ENCRYPTION_KEY_FILE: keyFile("short-key") }, { canaryOnly: true });
    await expect(short.run()).resolves.toBe(1);
    expect(short.text()).not.toContain("short-key");
  });

  it("refuses a key shorter than the production minimum in the operator helpers", () => {
    expect(() => sealSecretWithKey("x", "p", "short")).toThrow(SecretBoxError);
  });

  it("withholds details when the database cannot be read", async () => {
    const h = harness(
      { SECRET_ENCRYPTION_KEY_FILE: keyFile(key), DATABASE_URL: scratchUrl },
      { sealed: new Error("password authentication failed for user hunter2pw") },
    );
    await expect(h.run()).resolves.toBe(1);
    expect(h.text()).not.toContain("hunter2pw");
  });
});
