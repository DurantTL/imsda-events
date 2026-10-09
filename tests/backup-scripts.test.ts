import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
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
echo "pg_restore PGHOST=$PGHOST PGPORT=$PGPORT PGHOSTADDR=$PGHOSTADDR PGOPTIONS=$PGOPTIONS $*" >> "$FAKE_LOG"
[ -n "$FAKE_RESTORE_FAIL" ] && exit 1
exit 0
`,
  initdb: `#!/bin/sh
echo "initdb PGPORT=$PGPORT PGHOSTADDR=$PGHOSTADDR PGHOST=$PGHOST $*" >> "$FAKE_LOG"
for arg in "$@"; do [ "$last" = "-D" ] && dir="$arg"; last="$arg"; done
mkdir -p "$dir"
`,
  pg_ctl: `#!/bin/sh
echo "pg_ctl PGPORT=$PGPORT PGHOSTADDR=$PGHOSTADDR PGHOST=$PGHOST $*" >> "$FAKE_LOG"
`,
  psql: `#!/bin/sh
echo "psql PGHOST=$PGHOST PGPORT=$PGPORT PGHOSTADDR=$PGHOSTADDR PGUSER=$PGUSER PGOPTIONS=$PGOPTIONS $*" >> "$FAKE_LOG"
cat >> "$FAKE_PSQL_STDIN"
[ -n "$FAKE_RECORD_FAIL" ] && case "$*" in *"kind="*) exit 1 ;; esac
case "$*" in *"count(*)"*) echo "\${FAKE_COUNT:-3}" ;; esac
exit 0
`,
  // Used only when the tests run as root, as the image does.
  gosu: `#!/bin/sh
echo "gosu $*" >> "$FAKE_LOG"
shift
exec "$@"
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

function setup(options: { gosu?: boolean } = {}) {
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
    if (name === "gosu" && options.gosu === false) continue;
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  mkdirSync(path.join(dir, "tmp"));
  const log = path.join(dir, "calls.log");
  const stdin = path.join(dir, "psql-stdin.log");
  writeFileSync(log, "");
  writeFileSync(stdin, "");

  // A date stand-in so the scheduled-hour test does not depend on the clock.
  const realDate = spawnSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(
    path.join(bin, "date"),
    `#!/bin/sh\ncase "$*" in *"%H %M %S"*) [ -n "$FAKE_NOW" ] && { echo "$FAKE_NOW"; exit 0; } ;; esac\nexec ${realDate} "$@"\n`,
  );
  chmodSync(path.join(bin, "date"), 0o755);

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
        PGHOST: "prod-db.internal",
        PGUSER: "appuser",
        RESTORE_TMP_DIR: path.join(dir, "tmp"),
        NODE_ENV: "test",
        ...env,
      },
    });
  return { run, dir, tmp: path.join(dir, "tmp"), backups, assets, log: () => readFileSync(log, "utf8"), stdin: () => readFileSync(stdin, "utf8") };
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

    expect(result.status).toBe(1);
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

    expect(result.status).toBe(1);
    const recorded = t.log().split("\n").filter((l) => l.includes("kind="));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toContain("kind=BACKUP");
    expect(recorded[0]).toContain("ok=false");
    expect(readdirSync(t.backups).some((f) => f.endsWith(".tar.gz"))).toBe(false);
  });

  it("records a failed restore rehearsal without failing the run", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { ...once, FAKE_RESTORE_FAIL: "1" });

    expect(result.status).toBe(1);
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

describe("restore rehearsal", () => {
  const once = { BACKUP_RUN_ONCE: "1" };

  it("restores into a private temporary server, never the production one", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], once);

    expect(result.status).toBe(0);
    const log = t.log();
    expect(log).toMatch(/initdb .*-D \S+/);
    expect(log).toMatch(/pg_ctl .*-D \S+ -w -s -l \S+ -o .*unix_socket_directories=.* start/);
    expect(log).toMatch(/pg_ctl .*-D \S+ -m immediate -w -s stop/);
    const rehearsalPsql = log
      .split("\n")
      .filter((l) => l.startsWith("psql") && /CREATE DATABASE|DROP DATABASE|count\(\*\)/.test(l));
    expect(rehearsalPsql.length).toBeGreaterThan(0);
    for (const line of rehearsalPsql) {
      expect(line).not.toContain("prod-db.internal");
      expect(line).toContain("PGUSER=postgres");
    }
    // Only the status rows go to the production server.
    const prodCalls = log.split("\n").filter((l) => l.startsWith("psql") && l.includes("prod-db.internal"));
    expect(prodCalls.every((l) => l.includes("kind="))).toBe(true);
    expect(readdirSync(t.tmp)).toEqual([]);
  });

  it("removes the private server directory even when the restore fails", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { ...once, FAKE_RESTORE_FAIL: "1" });

    expect(result.stderr).toContain("RESTORE REHEARSAL FAILED");
    expect(readdirSync(t.tmp)).toEqual([]);
  });

  it("keeps the server-side path for the development stack", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], { ...once, RESTORE_MODE: "server" });

    expect(result.status).toBe(0);
    expect(t.log()).not.toContain("initdb");
    expect(t.log()).toMatch(/psql PGHOST=prod-db\.internal .*CREATE DATABASE/);
  });
});

describe("asset and partial-file handling", () => {
  it("fails, and records the run as failed, when the assets directory is missing", () => {
    const t = setup();
    rmSync(t.assets, { recursive: true });

    const result = t.run("backup-scheduler.sh", [], { BACKUP_RUN_ONCE: "1" });

    expect(result.stderr).toContain("does not exist");
    expect(existsSync(t.assets)).toBe(false);
    const row = t.log().split("\n").find((l) => l.includes("kind=BACKUP"));
    expect(row).toContain("ok=false");
  });

  it("fails on an empty assets directory only when assets are required", () => {
    const t = setup();
    rmSync(path.join(t.assets, "flyer.txt"));

    const lenient = t.run("assets-backup.sh", []);
    const strict = t.run("assets-backup.sh", [], { BACKUP_REQUIRE_ASSETS: "true" });

    expect(lenient.status).toBe(0);
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain("BACKUP_REQUIRE_ASSETS");
  });

  it("removes its partial file when the dump fails and prunes stale partials first", () => {
    const t = setup();
    writeFileSync(path.join(t.backups, "imsda-events-old.dump.partial"), "x");
    writeFileSync(path.join(t.backups, "imsda-assets-old.tar.gz.partial"), "x");

    const result = t.run("pg-backup.sh", [], { FAKE_DUMP_FAIL: "1" });
    t.run("assets-backup.sh", []);

    expect(result.status).not.toBe(0);
    expect(readdirSync(t.backups).filter((f) => f.endsWith(".partial"))).toEqual([]);
  });
});

describe("required off-site copy and schedule", () => {
  it("records off-site failed when it is required but not configured", () => {
    const t = setup();

    const result = t.run("backup-scheduler.sh", [], {
      BACKUP_RUN_ONCE: "1",
      BACKUP_REQUIRE_OFFSITE: "true",
    });

    expect(result.status).toBe(1);

    expect(result.stderr).toContain("BACKUP_REQUIRE_OFFSITE");
    const row = t.log().split("\n").find((l) => l.includes("kind=BACKUP"));
    expect(row).toContain("ok=true");
    expect(row).toContain("offsite=false");
  });

  it("waits for the scheduled hour instead of running at start", () => {
    const t = setup();
    const fakeSleep = path.join(t.dir, "bin", "sleep");
    writeFileSync(fakeSleep, '#!/bin/sh\necho "sleep $*" >> "$FAKE_LOG"\nexit 99\n');
    chmodSync(fakeSleep, 0o755);

    // 07:30:15 UTC with the run due at 08:00 is 29 minutes 45 seconds away.
    const result = t.run("backup-scheduler.sh", [], { BACKUP_AT_HOUR: "8", FAKE_NOW: "07 30 15" });

    expect(result.status).not.toBe(0);
    expect(t.log()).toContain("sleep 1785");
    expect(t.log()).not.toContain("pg_dump");
  });

  it("wraps to tomorrow when the hour has passed, including 08 and 09 as decimals", () => {
    const t = setup();
    const fakeSleep = path.join(t.dir, "bin", "sleep");
    writeFileSync(fakeSleep, '#!/bin/sh\necho "sleep $*" >> "$FAKE_LOG"\nexit 99\n');
    chmodSync(fakeSleep, 0o755);

    t.run("backup-scheduler.sh", [], { BACKUP_AT_HOUR: "8", FAKE_NOW: "09 08 09" });

    // 24h - (1h 8m 9s) = 22h 51m 51s
    expect(t.log()).toContain("sleep 82311");
  });

  it("rejects an invalid hour", () => {
    const t = setup();

    expect(t.run("backup-scheduler.sh", [], { BACKUP_AT_HOUR: "25" }).status).toBe(2);
    expect(t.run("backup-scheduler.sh", [], { BACKUP_AT_HOUR: "abc" }).status).toBe(2);
    expect(t.run("backup-scheduler.sh", [], { BACKUP_VERIFY_EVERY: "0" }).status).toBe(2);
    expect(t.run("backup-scheduler.sh", [], { BACKUP_VERIFY_EVERY: "x" }).status).toBe(2);
  });
});

describe("private rehearsal isolation and safety", () => {
  const once = { BACKUP_RUN_ONCE: "1" };
  const hostile = {
    PGPORT: "6543",
    PGHOSTADDR: "10.0.0.1",
    PGSERVICE: "prod",
    PGPASSFILE: "/nonexistent/pgpass",
    PGPASSWORD: "synthetic-password",
  };

  it("scrubs every PG variable before the private server starts and uses port 5432", () => {
    const t = setup();

    t.run("backup-scheduler.sh", [], { ...once, ...hostile });

    const lines = t.log().split("\n");
    const isolated = lines.filter((l) => /^(initdb|pg_ctl|pg_restore)/.test(l)
      || (l.startsWith("psql") && /CREATE DATABASE|DROP DATABASE|count\(\*\)/.test(l)));
    expect(isolated.length).toBeGreaterThan(4);
    for (const line of isolated) {
      expect(line).not.toContain("PGHOSTADDR=10.0.0.1");
      expect(line).not.toContain("PGPORT=6543");
    }
    expect(lines.find((l) => l.startsWith("pg_ctl") && l.includes(" start"))).toContain("-c port=5432");
    expect(lines.find((l) => l.startsWith("pg_ctl") && l.includes(" start"))).toContain("-c listen_addresses=");
    expect(lines.find((l) => l.startsWith("pg_restore"))).toContain("PGPORT=5432");
    // The status rows still go to production with the real settings.
    const record = lines.find((l) => l.startsWith("psql") && l.includes("kind=BACKUP"));
    expect(record).toContain("PGPORT=6543");
  });

  it("keeps a non-public search_path for the restore and the row counts", () => {
    const t = setup();

    t.run("backup-scheduler.sh", [], { ...once, PGOPTIONS: "-c search_path=events" });

    const lines = t.log().split("\n");
    expect(lines.find((l) => l.startsWith("pg_restore"))).toContain("PGOPTIONS=-c search_path=events");
    expect(lines.find((l) => l.startsWith("psql") && l.includes("count(*)"))).toContain("PGOPTIONS=-c search_path=events");
    expect(lines.find((l) => l.startsWith("initdb"))).not.toContain("search_path");
  });

  it("refuses when there is not enough free space and starts nothing", () => {
    const t = setup();

    const result = t.run("pg-restore-verify.sh", [], {
      RESTORE_HEADROOM_MB: "999999999",
      BACKUP_FILE: (() => {
        const file = path.join(t.backups, "imsda-events-x.dump");
        writeFileSync(file, "dump");
        return file;
      })(),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("free");
    expect(t.log()).not.toContain("initdb");
  });

  it("removes stale restore-check directories", () => {
    const t = setup();
    mkdirSync(path.join(t.tmp, "restore-check.OLD123"));
    writeFileSync(path.join(t.backups, "imsda-events-x.dump"), "dump");

    t.run("pg-restore-verify.sh", [], {});

    expect(readdirSync(t.tmp)).toEqual([]);
  });

  it("fails the rehearsal when Registration or Person is empty, unless allowed", () => {
    const t = setup();
    writeFileSync(path.join(t.backups, "imsda-events-x.dump"), "dump");

    const empty = t.run("pg-restore-verify.sh", [], { FAKE_COUNT: "0" });
    const allowed = t.run("pg-restore-verify.sh", [], { FAKE_COUNT: "0", REHEARSAL_ALLOW_EMPTY: "true" });

    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("0 rows");
    expect(allowed.status).toBe(0);
  });

  it.skipIf(typeof process.getuid !== "function" || process.getuid() !== 0)(
    "as root, drops to postgres with gosu, and refuses without gosu or su-exec",
    () => {
      const withGosu = setup();
      withGosu.run("backup-scheduler.sh", [], { BACKUP_RUN_ONCE: "1" });
      expect(withGosu.log()).toContain("gosu postgres initdb");

      const without = setup({ gosu: false });
      writeFileSync(path.join(without.backups, "imsda-events-x.dump"), "dump");
      const result = without.run("pg-restore-verify.sh", []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("neither gosu nor su-exec");
      expect(without.log()).not.toContain("initdb");
    },
  );
});

describe("retention keeps the newest backups", () => {
  it("never prunes the newest three dumps, however old", () => {
    const t = setup();
    const old = new Date(Date.now() - 60 * 86400_000);
    for (let i = 1; i <= 5; i += 1) {
      const file = path.join(t.backups, `imsda-events-2026010${i}T000000Z.dump`);
      writeFileSync(file, "x");
      utimesSync(file, new Date(old.getTime() + i * 1000), new Date(old.getTime() + i * 1000));
    }

    // The fake pg_dump adds a sixth, fresh file; the three newest overall remain.
    t.run("pg-backup.sh", []);

    const remaining = readdirSync(t.backups).filter((f) => f.endsWith(".dump")).sort();
    expect(remaining).toHaveLength(3);
    expect(remaining).toContain("imsda-events-20260105T000000Z.dump");
    expect(remaining).toContain("imsda-events-20260104T000000Z.dump");
  });

  it("does not prune when fewer than four exist", () => {
    const t = setup();
    const old = new Date(Date.now() - 60 * 86400_000);
    for (const name of ["a", "b"]) {
      const file = path.join(t.backups, `imsda-assets-${name}.tar.gz`);
      writeFileSync(file, "x");
      utimesSync(file, old, old);
    }

    t.run("assets-backup.sh", []);

    expect(readdirSync(t.backups).filter((f) => f.endsWith(".tar.gz"))).toHaveLength(3);
  });
});
