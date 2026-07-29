import { describe, expect, it } from "vitest";
import { SERVER_ENV_KEYS, serverEnvSchema, validateServerEnv } from "@/lib/env";

/**
 * The schema and the read list have to describe the same set of variables.
 *
 * They are separate on purpose — the read list is an allowlist, so an unrelated
 * variable in the process environment cannot reach the parser — but that also
 * means a variable declared in only one of them fails silently. A schema entry
 * with no read entry is dropped before parsing: it validates, takes its
 * default, and stays empty no matter what the deployment sets, which is
 * indistinguishable from a deployment that forgot to set it.
 *
 * That is not hypothetical. `GOOGLE_OAUTH_CLIENT_ID` was added to the schema
 * and not to the list, and Google sign-in reported itself unconfigured on a
 * host where it was configured. Typecheck and lint both passed.
 */

const schemaKeys = Object.keys(serverEnvSchema.shape);

describe("the server environment contract", () => {
  it("reads every variable it declares", () => {
    const unread = schemaKeys.filter((key) => !SERVER_ENV_KEYS.includes(key as never));
    expect(unread).toEqual([]);
  });

  it("declares every variable it reads", () => {
    const undeclared = SERVER_ENV_KEYS.filter((key) => !schemaKeys.includes(key));
    expect(undeclared).toEqual([]);
  });
});

describe("Google sign-in configuration", () => {
  const base = {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  };

  it("reaches the parsed environment when set", () => {
    const result = validateServerEnv({
      ...base,
      GOOGLE_OAUTH_CLIENT_ID: "1234.apps.googleusercontent.com",
      GOOGLE_OAUTH_CLIENT_SECRET: "a-client-secret",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.env.GOOGLE_OAUTH_CLIENT_ID).toBe("1234.apps.googleusercontent.com");
      expect(result.env.GOOGLE_OAUTH_CLIENT_SECRET).toBe("a-client-secret");
    }
  });

  it("is valid when neither half is set", () => {
    expect(validateServerEnv(base).ok).toBe(true);
  });

  it("refuses half a client", () => {
    // The button would render and every attempt would fail at the token
    // exchange — after the registrant had already given Google their password.
    for (const half of [
      { GOOGLE_OAUTH_CLIENT_ID: "1234.apps.googleusercontent.com" },
      { GOOGLE_OAUTH_CLIENT_SECRET: "a-client-secret" },
    ]) {
      const result = validateServerEnv({ ...base, ...half });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.join(" ")).toMatch(/must be set together/);
      }
    }
  });

  it("names the variable but never the value", () => {
    // These strings reach container logs.
    const result = validateServerEnv({
      ...base,
      GOOGLE_OAUTH_CLIENT_SECRET: "a-real-looking-secret-value",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.join(" ")).not.toContain("a-real-looking-secret-value");
    }
  });
});
