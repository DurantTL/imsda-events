import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateServerEnv } from "@/lib/env";

const base = { DATABASE_URL: "postgresql://synthetic:synthetic@localhost:5432/synthetic" };

function flag(source: Record<string, string | undefined>) {
  const result = validateServerEnv({ ...base, ...source });
  if (!result.ok) throw new Error(result.issues.join("; "));
  return result.env.HEALTH_RECORDS_ENABLED;
}

describe("HEALTH_RECORDS_ENABLED", () => {
  it("is off when unset or blank", () => {
    expect(flag({})).toBe(false);
    expect(flag({ HEALTH_RECORDS_ENABLED: "" })).toBe(false);
    expect(flag({ HEALTH_RECORDS_ENABLED: "false" })).toBe(false);
  });

  it("turns on only for the exact value true, and any other value fails the environment instead of guessing", () => {
    expect(flag({ HEALTH_RECORDS_ENABLED: "true" })).toBe(true);
    for (const value of ["TRUE", "yes", "1", "on"]) {
      expect(validateServerEnv({ ...base, HEALTH_RECORDS_ENABLED: value }).ok).toBe(false);
    }
  });

  it("is documented as false and is not passed on by the deployment files", () => {
    expect(readFileSync(".env.example", "utf8")).toMatch(/^HEALTH_RECORDS_ENABLED=false$/m);
    for (const file of ["docker-compose.yml", "Dockerfile"]) {
      expect(readFileSync(file, "utf8"), file).not.toContain("HEALTH_RECORDS_ENABLED");
    }
  });
});
