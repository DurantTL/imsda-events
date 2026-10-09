import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptDir = path.join(process.cwd(), "scripts/backup");

// Stand-ins for the real binaries. They log what they were called with so the
// tests can assert behavior without PostgreSQL, a network, or credentials.
const fakes: Record<string, string> = {
  pg_dump: `#!/bin/sh
echo "pg_dump $*" >> "$FAKE_LOG"
[ -n "$FAKE_DUMP_FAIL" ] && exit 1
for arg in "$@"; do
  case "$arg" in --file=*) file="\${arg#--file=}" ;; esac
done
head -c 4096 /dev/zero > "$file"
`,
  pg_restore: `#!/bin/sh
echo "pg_restore $*" >> "$FAKE_LOG"
[ -n "$FAKE_RESTORE_FAIL" ] && exit 1
exit 0
`,
  psql: `#!/bin/sh
echo "psql $*" >> "$FAKE_LOG"
cat >> "$FAKE_PSQL_STDIN"
[ -n "$FAKE_RECORD_FAIL" ] && case "$*" in *"kind="*) exit 1 ;; esac
case "$*" in *"count(*)"*) echo 3 ;; esac
exit 0
`,
  aws: `#!/bin/sh
echo "aws $*" >> "$FAKE_LOG"
echo "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID AWS_DEFAULT_REGION=$AWS_DEFAULT_REGION" >> "$FAKE_LOG"
[ -n "$FAKE_AWS_FAIL" ] && { echo "upload denied" >&2; exit 1; }
exit 0
`,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "backup-scripts-"));
  dirs.push(dir);
  const bin = path.join(dir, "bin");
  const backups = path.join(dir, "backups");
  const assets = path.join(dir, "assets");
  mkdirSync(bin);
  mkdirSync(backups);
  mkdirSync(assets);
  writeFileSync(path.join(assets, "flyer.txt"), "synthetic flyer bytes");
  for (const [name, body] of Object.entries(fakes)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  const log = path.join(dir, "calls.log");
  const stdin = path.join(dir, "psql-stdin.log");
  writeFileSync(log, "");
  writeFileSync(stdin, "");

  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync("sh", [path.join(scriptDir, script), ...args], {
      encoding: "utf8",
      input: "",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        BACKUP_DIR: backups,
        ASSET_DIR: assets,
        FAKE_LOG: log,
        FAKE_PSQL_STDIN: stdin,
        PGDATABASE: "imsda_events",
        NODE_ENV: "test",
        ...env,
      },
    });
  return { run, dir, backups, assets, log: () => readFileSync(log, "utf8"), stdin: () => readFileSync(stdin, "utf8") };
}

const r2Env = {
  R2_ACCOUNT_ID: "acct0123",
  R2_ACCESS_KEY_ID: "AKIA-FAKE-KEY-ID",
  R2_SECRET_ACCESS_KEY: "fake-secret-value-do-not-use",
  R2_BUCKET: "test-bucket",
};
const offsite = { BACKUP_OFFSITE_COMMAND: `sh ${path.join(scriptDir, "offsite-r2.sh")} "$1"` };

describe("offsite-r2.sh", () => {
  it("uploads to the account's R2 endpoint without logging the credentials", () => {
    const t = setup();
    const file = path.join(t.backups, "imsda-events-x.dump");
    writeFileSync(file, "dump");

    const result = t.run("offsite-r2.sh", [file], r2Env);

    expect(result.status).toBe(0);
    const log = t.log();
    expect(log).toContain(
      `aws s3 cp ${file} s3://test-bucket/imsda-events/imsda-events-x.dump --endpoint-url https://acct0123.r2.cloudflarestorage.com --only-show-errors`,
    );
    expect(log).toContain("AWS_DEFAULT_REGION=auto");
    expect(result.stdout + result.stderr).not.toContain(r2Env.R2_SECRET_ACCESS_KEY);
    expect(result.stdout + result.stderr).not.toContain(r2Env.R2_ACCESS_KEY_ID);
  });

  it("refuses to run when a required variable is missing", () => {
    const t = setup();
    const file = path.join(t.backups, "a.dump");
    writeFileSync(file, "dump");

    const result = t.run("offsite-r2.sh", [file], { ...r2Env, R2_BUCKET: "" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("R2_BUCKET is not set");
    expect(t.log()).not.toContain("aws ");
  });
});

describe("record-status.sh", () => {
  it("passes values to psql as variables, not as SQL text", () => {
    const t = setup();

    const result = t.run("record-status.sh", [
      "BACKUP", "true", "2026-10-12T03:00:00Z", "2026-10-12T03:04:00Z", "4096", "512", "true",
    ]);

    expect(result.status).toBe(0);
    expect(t.log()).toContain("kind=BACKUP");
    expect(t.log()).toContain("dump=4096");
    expect(t.log()).toContain("offsite=true");
    expect(t.stdin()).toContain('INSERT INTO "BackupRun"');
    expect(t.stdin()).not.toContain("4096");
  });

  it("rejects malformed values before touching the database", () => {
    const t = setup();

    const result = t.run("record-status.sh", [
      "BACKUP", "true", "now", "2026-10-12T03:04:00Z",
    ]);
    const injection = t.run("record-status.sh", [
      "BACKUP", "true", "2026-10-12T03:00:00Z", "2026-10-12T03:04:00Z", "1; DROP TABLE x",
    ]);

    expect(result.status).toBe(2);
    expect(injection.status).toBe(2);
    expect(t.log()).not.toContain("psql");
  });
});

describe("backup-scheduler.sh", () => {
  const once = { BACKUP_RUN_ONCE: "1", ...offsite, ...r2Env };

  it("backs up, copies off-site, rehearses, and records both results", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], once);

    expect(result.status).toBe(0);
    const files = readdirSync(t.backups);
    expect(files.some((f) => f.startsWith("imsda-events-") && f.endsWith(".dump"))).toBe(true);
    expect(files.some((f) => f.startsWith("imsda-assets-") && f.endsWith(".tar.gz"))).toBe(true);

    const log = t.log();
    expect(log.match(/aws s3 cp/g)).toHaveLength(2);
    const recorded = log.split("\n").filter((l) => l.includes("kind="));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toContain("kind=BACKUP");
    expect(recorded[0]).toContain("ok=true");
    expect(recorded[0]).toContain("dump=4096");
    expect(recorded[0]).toContain("offsite=true");
    expect(recorded[0]).toMatch(/assets=\d+/);
    expect(recorded[1]).toContain("kind=REHEARSAL");
    expect(recorded[1]).toContain("ok=true");

    const output = result.stdout + result.stderr;
    expect(output).not.toContain(r2Env.R2_SECRET_ACCESS_KEY);
    expect(output).not.toContain(r2Env.R2_ACCESS_KEY_ID);
  });

  it("records a failed off-site copy but still keeps and prunes local backups", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { ...once, FAKE_AWS_FAIL: "1" });

    expect(result.status).toBe(0);
    expect(readdirSync(t.backups).some((f) => f.endsWith(".dump"))).toBe(true);
    const backupRow = t.log().split("\n").find((l) => l.includes("kind=BACKUP"));
    expect(backupRow).toContain("ok=true");
    expect(backupRow).toContain("offsite=false");
    expect(result.stderr).toContain("OFF-SITE COPY FAILED");
  });

  it("records an unknown off-site result when none is configured", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { BACKUP_RUN_ONCE: "1" });

    expect(result.status).toBe(0);
    const backupRow = t.log().split("\n").find((l) => l.includes("kind=BACKUP"));
    expect(backupRow).toContain("ok=true");
    expect(backupRow).toContain("offsite=");
    expect(backupRow).not.toContain("offsite=true");
    expect(backupRow).not.toContain("offsite=false");
  });

  it("records a failed backup, skips assets and rehearsal, and keeps running", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { ...once, FAKE_DUMP_FAIL: "1" });

    expect(result.status).toBe(0);
    const recorded = t.log().split("\n").filter((l) => l.includes("kind="));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("kind=BACKUP");
    expect(recorded[0]).toContain("ok=false");
    expect(readdirSync(t.backups).some((f) => f.endsWith(".tar.gz"))).toBe(false);
  });

  it("records a failed restore rehearsal without failing the run", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { ...once, FAKE_RESTORE_FAIL: "1" });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("RESTORE REHEARSAL FAILED");
    const rehearsal = t.log().split("\n").find((l) => l.includes("kind=REHEARSAL"));
    expect(rehearsal).toContain("ok=false");
  });

  it("carries on when the status cannot be recorded", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { ...once, FAKE_RECORD_FAIL: "1" });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not record status");
    expect(existsSync(t.backups)).toBe(true);
  });
});
