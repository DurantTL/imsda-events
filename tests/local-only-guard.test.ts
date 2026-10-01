import { describe, expect, it } from "vitest";
import {
  assertLocalDatabase,
  assertLocalUrl,
  assertSeededStaffEmail,
} from "../scripts/support/local-only-guard";

const local = "postgresql://u:p@localhost:5432/imsda";

describe("assertLocalDatabase", () => {
  it("accepts local hostnames", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(() => assertLocalDatabase({ DATABASE_URL: `postgresql://u:p@${host}:5432/db` })).not.toThrow();
    }
  });

  it("refuses NODE_ENV=production even for a local database", () => {
    expect(() => assertLocalDatabase({ NODE_ENV: "production", DATABASE_URL: local })).toThrow(/NODE_ENV=production/);
  });

  it("refuses remote, missing and malformed DATABASE_URL", () => {
    expect(() => assertLocalDatabase({ DATABASE_URL: "postgresql://u:p@db.example.test:5432/db" })).toThrow(/db\.example\.test/);
    expect(() => assertLocalDatabase({ DATABASE_URL: "postgresql://u:p@10.0.0.5/db" })).toThrow(/outside a local database/);
    expect(() => assertLocalDatabase({})).toThrow(/DATABASE_URL is required/);
    expect(() => assertLocalDatabase({ DATABASE_URL: "not a url" })).toThrow(/not a valid URL/);
  });

  it("names the action in the refusal", () => {
    expect(() => assertLocalDatabase({ NODE_ENV: "production", DATABASE_URL: local }, "seed demo data")).toThrow(/seed demo data/);
  });
});

describe("assertLocalUrl", () => {
  it("allows only localhost URLs", () => {
    expect(() => assertLocalUrl("http://localhost:3000", "BASE")).not.toThrow();
    expect(() => assertLocalUrl("http://127.0.0.1:3717", "BASE")).not.toThrow();
    expect(() => assertLocalUrl("https://events.example.test", "BASE")).toThrow(/BASE outside localhost/);
    expect(() => assertLocalUrl("nope", "BASE")).toThrow(/not a valid URL/);
  });
});

describe("assertSeededStaffEmail", () => {
  it("allows only seeded test accounts", () => {
    expect(() => assertSeededStaffEmail("admin@imsda-events.test")).not.toThrow();
    expect(() => assertSeededStaffEmail("checkin@imsda-events.test")).not.toThrow();
    expect(() => assertSeededStaffEmail("someone@imsda.org")).toThrow(/only seeded/);
    expect(() => assertSeededStaffEmail("x@imsda-events.test.evil.org")).toThrow(/only seeded/);
  });
});
