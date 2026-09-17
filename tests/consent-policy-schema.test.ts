import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("consent policy persistence", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const migration = readFileSync("prisma/migrations/20260917090000_consent_policies/migration.sql", "utf8");

  function model(name: string) {
    const start = schema.indexOf(`model ${name} {`);
    return schema.slice(start, schema.indexOf("\n}", start));
  }

  it("fixes kind and scope on the policy definition, not on versions", () => {
    expect(model("ConsentPolicy")).toMatch(/\bkind\s+PolicyKind\b/);
    expect(model("ConsentPolicy")).toMatch(/\bscope\s+PolicyScope\b/);
    expect(model("ConsentPolicyVersion")).not.toMatch(/\bkind\s+/);
    expect(migration).toContain("ConsentPolicy kind, scope, and event are immutable");
    expect(migration).toContain("ConsentPolicy_scope_event_check");
  });

  it("rejects any database UPDATE of a published version", () => {
    expect(migration).toContain("CREATE TRIGGER \"ConsentPolicyVersion_published_immutable\"");
    expect(migration).toMatch(/BEFORE UPDATE ON "ConsentPolicyVersion"/);
    expect(migration).toContain("published ConsentPolicyVersion rows are immutable");
  });

  it("never archives versions, so every published version stays selectable and referenceable", () => {
    const statusEnum = schema.slice(schema.indexOf("enum ConsentPolicyVersionStatus {"));
    expect(statusEnum.slice(0, statusEnum.indexOf("}"))).not.toContain("ARCHIVED");
    expect(migration).toContain("CREATE TYPE \"ConsentPolicyVersionStatus\" AS ENUM ('DRAFT', 'PUBLISHED');");
  });

  it("records version number, text, effective window, publisher, publish time, hash, and material change", () => {
    const version = model("ConsentPolicyVersion");
    for (const field of ["versionNumber", "title", "bodyText", "effectiveFrom", "effectiveTo", "publishedByUserId", "publishedAt", "contentHash", "isMaterialChange"]) {
      expect(version).toMatch(new RegExp(`\\b${field}\\s+`));
    }
    expect(migration).toContain("ConsentPolicyVersion_published_fields_check");
    expect(migration).toContain("ConsentPolicyVersion_one_draft_per_policy");
  });

  it("keeps per-event applicability inside the event boundary", () => {
    expect(model("EventConsentPolicyApplicability")).toMatch(/\bisRequired\s+Boolean/);
    expect(migration).toContain("policy belongs to another event");
    expect(migration).toContain("attendee type belongs to another event");
    expect(migration).toContain("EventConsentPolicyApplicability_age_band_check");
  });

  it("ships no policy text in the migration or seed data", () => {
    expect(migration).not.toMatch(/INSERT\s+INTO\s+"ConsentPolicy/i);
    const seed = readFileSync("prisma/seed.ts", "utf8");
    expect(seed).not.toMatch(/consentPolicy/i);
  });
});
