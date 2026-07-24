import { describe, expect, it } from "vitest";
import {
  assertServerEnvAtStartup,
  isServerEnvironmentError,
  ServerEnvironmentError,
  validateServerEnv,
} from "@/lib/env";

const databaseUrl = "postgresql://imsda:imsda@db:5432/imsda_events?schema=public";
const longSecret = "a-secret-that-is-at-least-thirty-two-characters";

const productionEnv = {
  NODE_ENV: "production",
  DATABASE_URL: databaseUrl,
  APP_BASE_URL: "https://events.imsda.org",
  MANAGE_LINK_DERIVATION_SECRET: longSecret,
  ATTENDEE_PASS_SIGNING_SECRET: longSecret,
  RATE_LIMIT_HASH_SECRET: longSecret,
  OUTBOX_SWEEP_TOKEN: longSecret,
  RESEND_API_KEY: "re_a_production_key",
  ACCOUNT_EMAIL_SENDER_ADDRESS: "events@imsda.org",
};

function issuesFor(source: Record<string, string | undefined>) {
  const result = validateServerEnv(source);
  return result.ok ? [] : result.issues;
}

describe("server environment contract", () => {
  it("accepts a complete production environment", () => {
    const result = validateServerEnv(productionEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.APP_BASE_URL).toBe("https://events.imsda.org");
    expect(result.env.RATE_LIMIT_TRUSTED_PROXY_HOPS).toBe(0);
    expect(result.env.SQUARE_ENABLE_PRODUCTION).toBe(false);
  });

  it("requires every security-critical secret in production rather than at first use", () => {
    const issues = issuesFor({
      ...productionEnv,
      MANAGE_LINK_DERIVATION_SECRET: undefined,
      ATTENDEE_PASS_SIGNING_SECRET: undefined,
      RATE_LIMIT_HASH_SECRET: undefined,
      OUTBOX_SWEEP_TOKEN: undefined,
    });

    expect(issues).toHaveLength(4);
    for (const key of [
      "MANAGE_LINK_DERIVATION_SECRET",
      "ATTENDEE_PASS_SIGNING_SECRET",
      "RATE_LIMIT_HASH_SECRET",
      "OUTBOX_SWEEP_TOKEN",
    ]) {
      expect(issues.some((issue) => issue.startsWith(`${key}:`))).toBe(true);
    }
  });

  it("names the variable and the rule without echoing the value", () => {
    const issues = issuesFor({
      ...productionEnv,
      ATTENDEE_PASS_SIGNING_SECRET: "short-secret",
    });

    expect(issues).toEqual([
      "ATTENDEE_PASS_SIGNING_SECRET: must contain at least 32 characters in production",
    ]);
    expect(issues.join(" ")).not.toContain("short-secret");
  });

  it("requires somewhere to send account email from in production", () => {
    // An invited colleague who never receives a link cannot obtain a credential
    // at all, and no operator action substitutes for it at scale. So this is a
    // startup requirement, not a runtime disappointment.
    const issues = issuesFor({
      ...productionEnv,
      RESEND_API_KEY: undefined,
      ACCOUNT_EMAIL_SENDER_ADDRESS: undefined,
    });

    expect(issues).toHaveLength(2);
    expect(issues.some((issue) => issue.startsWith("ACCOUNT_EMAIL_SENDER_ADDRESS:"))).toBe(true);
    expect(issues.some((issue) => issue.startsWith("RESEND_API_KEY:"))).toBe(true);
  });

  it("rejects a sender or reply-to that is not an address", () => {
    expect(issuesFor({ ...productionEnv, ACCOUNT_EMAIL_SENDER_ADDRESS: "events" })).toEqual([
      "ACCOUNT_EMAIL_SENDER_ADDRESS: must be an email address",
    ]);
    expect(issuesFor({ ...productionEnv, ACCOUNT_EMAIL_REPLY_TO: "help at imsda" })).toEqual([
      "ACCOUNT_EMAIL_REPLY_TO: must be an email address",
    ]);
  });

  it("names the account sender by default so the recipient recognises it", () => {
    const result = validateServerEnv(productionEnv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.ACCOUNT_EMAIL_SENDER_NAME).toBe("IMSDA Events");
  });

  it("leaves the same secrets optional outside production", () => {
    expect(validateServerEnv({
      NODE_ENV: "development",
      DATABASE_URL: databaseUrl,
    }).ok).toBe(true);
  });

  it("rejects a rotation secret that is configured but too short", () => {
    expect(issuesFor({
      ...productionEnv,
      MANAGE_LINK_DERIVATION_SECRET_PREVIOUS: "still-too-short",
    })).toEqual([
      "MANAGE_LINK_DERIVATION_SECRET_PREVIOUS: must contain at least 32 characters when configured",
    ]);
  });

  it("rejects the malformed values that previously 403'd every write", () => {
    expect(issuesFor({ ...productionEnv, DATABASE_URL: "not-a-url" })).toEqual([
      expect.stringContaining("DATABASE_URL"),
      expect.stringContaining("DATABASE_URL"),
    ]);
    expect(issuesFor({ ...productionEnv, APP_BASE_URL: "events.imsda.org" })).toEqual([
      expect.stringContaining("APP_BASE_URL"),
    ]);
  });

  it("holds the Square production lock in the startup contract too", () => {
    expect(issuesFor({ ...productionEnv, SQUARE_ENVIRONMENT: "production" })).toEqual([
      expect.stringContaining("SQUARE_ENABLE_PRODUCTION"),
    ]);
    expect(validateServerEnv({
      ...productionEnv,
      SQUARE_ENVIRONMENT: "production",
      SQUARE_ENABLE_PRODUCTION: "true",
    }).ok).toBe(true);
  });

  it("keeps the proxy-hop and client-IP header rules together", () => {
    expect(issuesFor({
      ...productionEnv,
      RATE_LIMIT_TRUSTED_PROXY_HOPS: "2",
      RATE_LIMIT_CLIENT_IP_HEADER: "cf-connecting-ip",
    })).toEqual([
      expect.stringContaining("RATE_LIMIT_CLIENT_IP_HEADER"),
    ]);
    expect(issuesFor({ ...productionEnv, RATE_LIMIT_TRUSTED_PROXY_HOPS: "11" })).toEqual([
      expect.stringContaining("RATE_LIMIT_TRUSTED_PROXY_HOPS"),
    ]);
  });

  it("refuses to start a production server with an invalid environment", () => {
    expect(() => assertServerEnvAtStartup({
      ...productionEnv,
      ATTENDEE_PASS_SIGNING_SECRET: undefined,
    })).toThrow(ServerEnvironmentError);
  });

  it("warns instead of refusing outside production", () => {
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const result = assertServerEnvAtStartup({
        NODE_ENV: "development",
        DATABASE_URL: "not-a-url",
      });
      expect(result.ok).toBe(false);
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
  });

  it("identifies configuration faults so callers can answer 500 instead of 403", () => {
    expect(isServerEnvironmentError(new ServerEnvironmentError("bad", []))).toBe(true);
    expect(isServerEnvironmentError(new Error("bad"))).toBe(false);
  });
});
