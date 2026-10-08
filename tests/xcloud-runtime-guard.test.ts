import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "scripts/xcloud-post-deploy.sh");
const network = "postgresql_test_xcloud-network";
const fakeDatabaseUrl = "DATABASE_URL=postgresql://user:pw@db:5432/app";

// A stand-in for the docker CLI: answers `ps`, the two `inspect` formats the
// guard uses, and records any `compose` call so a test can assert none happened.
const fakeDocker = `#!/bin/sh
case "$1" in
  ps) printf '%s' "$FAKE_CONTAINERS" ;;
  inspect)
    case "$*" in
      *Config.Env*) printf '%s\\n' "$FAKE_ENV" ;;
      *Networks*) printf '%s\\n' "$FAKE_NETWORKS" ;;
    esac ;;
  compose) echo "$*" >> "$FAKE_COMPOSE_LOG"; exit 1 ;;
esac
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), "xcloud-guard-"));
  dirs.push(dir);
  const runtime = path.join(dir, "runtime");
  const bin = path.join(dir, "bin");
  mkdirSync(runtime);
  mkdirSync(bin);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(runtime, name), content);
  }
  writeFileSync(path.join(bin, "docker"), fakeDocker);
  chmodSync(path.join(bin, "docker"), 0o755);
  const composeLog = path.join(dir, "compose.log");
  writeFileSync(composeLog, "");

  return (env: Record<string, string>) =>
    spawnSync("sh", [script], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        IMSDA_XCLOUD_RUNTIME_DIR: runtime,
        IMSDA_XCLOUD_EXPECTED_NETWORK: network,
        FAKE_COMPOSE_LOG: composeLog,
        ...env,
      },
    });
}

const override = "services:\n  app:\n    env_file:\n      - .env\n";
const manualFiles = {
  ".env": "RESEND_API_KEY=x\n",
  ".env.dburl": `${fakeDatabaseUrl}\n`,
  "docker-compose.env.yml": override,
  "docker-compose.yml": "",
};

describe("xCloud runtime guard", () => {
  it("accepts a manual deployment whose database URL lives in .env.dburl", () => {
    const run = setup(manualFiles);
    const result = run({
      FAKE_CONTAINERS: "xcloud-site-239298-app-1\n",
      FAKE_ENV: fakeDatabaseUrl,
      FAKE_NETWORKS: `xcloud-site-239298_default\n${network}`,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Manual deployment");
    expect(`${result.stdout}${result.stderr}`).not.toContain("pw@");
  });

  it("defers while a manual swap has no app container running", () => {
    const run = setup(manualFiles);
    const result = run({ FAKE_CONTAINERS: "xcloud-site-239298-app-1-old\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deferring");
  });

  it("fails when the manually started container lost its database URL or network", () => {
    const run = setup(manualFiles);
    const noUrl = run({
      FAKE_CONTAINERS: "xcloud-site-239298-app-1\n",
      FAKE_ENV: "NODE_ENV=production",
      FAKE_NETWORKS: network,
    });
    expect(noUrl.status).toBe(1);
    expect(noUrl.stderr).toContain("missing DATABASE_URL");

    const noNetwork = run({
      FAKE_CONTAINERS: "xcloud-site-239298-app-1\n",
      FAKE_ENV: fakeDatabaseUrl,
      FAKE_NETWORKS: "xcloud-site-239298_default",
    });
    expect(noNetwork.status).toBe(1);
    expect(noNetwork.stderr).toContain(`missing network ${network}`);
  });

  it("still fails when neither file has a database URL", () => {
    const run = setup({ ...manualFiles, ".env.dburl": "" });
    const result = run({ FAKE_CONTAINERS: "xcloud-site-239298-app-1\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is missing or malformed");
  });

  it("refuses to recreate through an override that would drop .env.dburl", () => {
    const run = setup({
      ...manualFiles,
      "docker-compose.yml": "services:\n  app:\n    image: app\n",
    });
    const result = run({ FAKE_CONTAINERS: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not load");
  });
});
