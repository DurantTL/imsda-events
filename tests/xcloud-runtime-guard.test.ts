import { spawnSync } from "node:child_process";
import {
  chmodSync,
  readFileSync,
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

// A stand-in for the docker CLI: answers `ps` and the two `inspect` formats the
// guard uses, and logs every other call so a test can assert what was run.
const fakeDocker = `#!/bin/sh
case "$1" in
  ps)
    [ -n "$FAKE_PS_FAIL" ] && exit 1
    printf '%s' "$FAKE_CONTAINERS" ;;
  inspect)
    case "$*" in
      *Config.Env*) printf '%s\\n' "$FAKE_ENV" ;;
      *Networks*) printf '%s\\n' "$FAKE_NETWORKS" ;;
    esac ;;
  *)
    echo "$*" >> "$FAKE_DOCKER_LOG"
    case "$*" in
      *"ps -q"*) echo fakecontainerid ;;
      *" up "*) exit 1 ;;
    esac ;;
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
  const dockerLog = path.join(dir, "docker.log");
  writeFileSync(dockerLog, "");

  const runGuard = (env: Record<string, string>) =>
    spawnSync("sh", [script], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        IMSDA_XCLOUD_RUNTIME_DIR: runtime,
        IMSDA_XCLOUD_EXPECTED_NETWORK: network,
        FAKE_DOCKER_LOG: dockerLog,
        ...env,
      },
    });
  return Object.assign(runGuard, {
    runtime,
    dockerLog: () => readFileSync(dockerLog, "utf8"),
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
      FAKE_CONTAINERS: "xcloud-site-239298-app-1 running\n",
      FAKE_ENV: fakeDatabaseUrl,
      FAKE_NETWORKS: `xcloud-site-239298_default\n${network}`,
    });
    expect(result.status).toBe(0);
    expect(run.dockerLog()).toBe("");
    expect(result.stdout).toContain("Manual deployment");
    expect(`${result.stdout}${result.stderr}`).not.toContain("pw@");
  });

  it("defers while a manual swap has no app container running", () => {
    const run = setup(manualFiles);
    const result = run({ FAKE_CONTAINERS: "xcloud-site-239298-app-1-old exited\n" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deferring");
    expect(run.dockerLog()).toBe("");
  });

  it("fails when the manually started container lost its database URL or network", () => {
    const run = setup(manualFiles);
    const noUrl = run({
      FAKE_CONTAINERS: "xcloud-site-239298-app-1 running\n",
      FAKE_ENV: "NODE_ENV=production",
      FAKE_NETWORKS: network,
    });
    expect(noUrl.status).toBe(1);
    expect(noUrl.stderr).toContain("missing DATABASE_URL");

    const noNetwork = run({
      FAKE_CONTAINERS: "xcloud-site-239298-app-1 running\n",
      FAKE_ENV: fakeDatabaseUrl,
      FAKE_NETWORKS: "xcloud-site-239298_default",
    });
    expect(noNetwork.status).toBe(1);
    expect(noNetwork.stderr).toContain(`missing network ${network}`);
    expect(run.dockerLog()).toBe("");
  });

  it("still fails when neither file has a database URL", () => {
    const run = setup({ ...manualFiles, ".env.dburl": "" });
    const result = run({ FAKE_CONTAINERS: "xcloud-site-239298-app-1 running\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is missing or malformed");
  });

  it("refuses to recreate through an override that would drop .env.dburl", () => {
    const run = setup({
      ...manualFiles,
      "docker-compose.yml": "services:\n  app:\n    image: app\n",
    });
    const result = run({ FAKE_ENV: fakeDatabaseUrl, FAKE_NETWORKS: "other" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not load");
  });

  it("fails when no app container exists and no swap is in progress", () => {
    const run = setup(manualFiles);
    const result = run({ FAKE_CONTAINERS: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no app container");
    expect(run.dockerLog()).toBe("");
  });

  it("fails when more than one matching container is running", () => {
    const run = setup(manualFiles);
    const result = run({
      FAKE_CONTAINERS:
        "xcloud-site-111111-app-1 running\nxcloud-site-222222-app-1 running\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("more than one");
    expect(run.dockerLog()).toBe("");
  });

  it("fails when docker ps fails", () => {
    const run = setup(manualFiles);
    const result = run({ FAKE_PS_FAIL: "1" });
    expect(result.status).not.toBe(0);
    expect(run.dockerLog()).toBe("");
  });

  it("fails with the state when the app container is not running", () => {
    const run = setup(manualFiles);
    const result = run({ FAKE_CONTAINERS: "xcloud-site-239298-app-1 exited\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exited");
    expect(run.dockerLog()).toBe("");
  });

  it("ignores another site's container when the pattern is set", () => {
    const run = setup(manualFiles);
    const result = run({
      IMSDA_XCLOUD_CONTAINER_PATTERN: "xcloud-site-239298-app-1",
      FAKE_CONTAINERS:
        "xcloud-site-239298-app-1 running\nxcloud-site-999999-app-1 running\n",
      FAKE_ENV: fakeDatabaseUrl,
      FAKE_NETWORKS: network,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("xcloud-site-239298-app-1 has its runtime");
    expect(run.dockerLog()).toBe("");

    const other = run({
      IMSDA_XCLOUD_CONTAINER_PATTERN: "xcloud-site-239298-app-1",
      FAKE_CONTAINERS: "xcloud-site-999999-app-1 running\n",
    });
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("no app container");
  });

  it("passes through in Compose mode when the container is healthy and the override loads .env.dburl", () => {
    const run = setup({
      ...manualFiles,
      "docker-compose.yml": "services:\n  app:\n    image: app\n",
      "docker-compose.env.yml":
        "services:\n  app:\n    env_file:\n      - .env\n      - .env.dburl\n",
    });
    const result = run({ FAKE_ENV: fakeDatabaseUrl, FAKE_NETWORKS: network });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no container change needed");
    expect(run.dockerLog()).not.toContain(" up ");
  });

  it("does not refuse a healthy container whose override lacks .env.dburl", () => {
    const run = setup({
      ...manualFiles,
      "docker-compose.yml": "services:\n  app:\n    image: app\n",
    });
    const result = run({ FAKE_ENV: fakeDatabaseUrl, FAKE_NETWORKS: network });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("does not load");
  });

  it("fails when .env.dburl exists but is unreadable", () => {
    const run = setup(manualFiles);
    const target = path.join(run.runtime, ".env.dburl");
    rmSync(target);
    // root ignores file modes, so use a directory there (also unreadable as a file).
    if (process.getuid?.() === 0) mkdirSync(target);
    else {
      writeFileSync(target, `${fakeDatabaseUrl}\n`);
      chmodSync(target, 0o000);
    }
    const result = run({ FAKE_CONTAINERS: "xcloud-site-239298-app-1 running\n" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is missing or malformed");
  });
});
