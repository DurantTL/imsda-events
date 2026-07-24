import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const dependencies = vi.hoisted(() => ({
  getServerEnv: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/logger", () => ({ logWarn: dependencies.logWarn }));

import {
  checkPasswordAgainstBreachCorpus,
  isBreachCheckEnabled,
} from "@/modules/access/password-breach";

const password = "correct horse battery staple";
const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
const prefix = digest.slice(0, 5);
const suffix = digest.slice(5);

function env(overrides: Record<string, unknown> = {}) {
  dependencies.getServerEnv.mockReturnValue({
    NODE_ENV: "production",
    PASSWORD_BREACH_CHECK_URL: "https://corpus.test/range/",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  env();
});

describe("breach corpus check", () => {
  it("sends a hash prefix and nothing else", async () => {
    const fetchImpl = vi.fn(async () => new Response(`${suffix}:42\n`, { status: 200 }));

    const result = await checkPasswordAgainstBreachCorpus(password, { fetchImpl });

    expect(result).toEqual({ checked: true, breached: true, occurrences: 42 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://corpus.test/range/${prefix}`);
    expect(url).not.toContain(suffix);
    expect(JSON.stringify(init)).not.toContain(password);
  });

  it("clears a password whose suffix is not in the returned bucket", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "0000000000000000000000000000000000A:9\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1\n",
      { status: 200 },
    ));

    expect(await checkPasswordAgainstBreachCorpus(password, { fetchImpl }))
      .toEqual({ checked: true, breached: false });
  });

  it("fails open when the corpus is unreachable", async () => {
    // Refusing to complete an activation because a third party is down would
    // lock someone out to prevent a weaker password.
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });

    expect(await checkPasswordAgainstBreachCorpus(password, { fetchImpl }))
      .toEqual({ checked: false, breached: false });
    expect(dependencies.logWarn).toHaveBeenCalledOnce();
  });

  it("fails open on a corpus error response", async () => {
    const fetchImpl = vi.fn(async () => new Response("slow down", { status: 429 }));

    expect(await checkPasswordAgainstBreachCorpus(password, { fetchImpl }))
      .toEqual({ checked: false, breached: false });
    expect(dependencies.logWarn).toHaveBeenCalledOnce();
  });

  it("does not call out at all when the check is off", async () => {
    const fetchImpl = vi.fn();

    expect(await checkPasswordAgainstBreachCorpus(password, { fetchImpl, enabled: false }))
      .toEqual({ checked: false, breached: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is on in production and off elsewhere unless set explicitly", () => {
    env({ NODE_ENV: "production" });
    expect(isBreachCheckEnabled()).toBe(true);

    env({ NODE_ENV: "development" });
    expect(isBreachCheckEnabled()).toBe(false);

    env({ NODE_ENV: "development", PASSWORD_BREACH_CHECK: "enabled" });
    expect(isBreachCheckEnabled()).toBe(true);

    env({ NODE_ENV: "production", PASSWORD_BREACH_CHECK: "disabled" });
    expect(isBreachCheckEnabled()).toBe(false);
  });
});
