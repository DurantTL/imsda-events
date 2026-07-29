import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { publicContactFromSnapshot } from "@/modules/public-access/domain";

/**
 * An account claims every registration whose contact address is its own verified
 * address (ADR 0003). "Contact address" has to mean exactly the same thing here
 * as it does on the private management page, or a registrant would see an
 * address on one page and be told it claims nothing on the other.
 *
 * The rule lives in two languages: `publicContactFromSnapshot` renders it, and
 * the SQL in `registrations-repository` matches on it. This file pins both ends
 * so a change to either one fails here rather than quietly listing the wrong
 * registrations.
 */

/** What the management page shows as the contact address for a registration. */
function renderedContactEmail(
  contactSnapshot: unknown,
  personNormalizedEmail: string | null,
) {
  return publicContactFromSnapshot(contactSnapshot, {
    firstName: "Fallback",
    lastName: "Person",
    email: personNormalizedEmail ?? "",
    phone: "",
  }).email;
}

const cases: Array<{
  name: string;
  snapshot: unknown;
  personEmail: string | null;
  expected: string;
}> = [
  {
    name: "the snapshot address wins when there is one",
    // This is the case that matters most: correcting a contact address through
    // self-service rewrites the snapshot and leaves the Person row alone, so
    // matching on the Person alone would miss every corrected registration.
    snapshot: { email: "corrected@example.com" },
    personEmail: "original@example.com",
    expected: "corrected@example.com",
  },
  {
    name: "the person's address is the fallback",
    snapshot: {},
    personEmail: "original@example.com",
    expected: "original@example.com",
  },
  {
    name: "a blank snapshot address falls back rather than claiming nothing",
    snapshot: { email: "   " },
    personEmail: "original@example.com",
    expected: "original@example.com",
  },
  {
    name: "a snapshot address is compared case-insensitively",
    snapshot: { email: "Mixed.Case@Example.COM" },
    personEmail: null,
    expected: "mixed.case@example.com",
  },
  {
    name: "a registration with no address anywhere claims nothing",
    snapshot: {},
    personEmail: null,
    expected: "",
  },
];

describe("which address a registration is claimed by", () => {
  for (const scenario of cases) {
    it(scenario.name, () => {
      expect(renderedContactEmail(scenario.snapshot, scenario.personEmail))
        .toBe(scenario.expected);
    });
  }

  it("never falls back to a name", () => {
    // Matching on a name would hand a stranger the registrations of everyone
    // who shares it.
    const contact = publicContactFromSnapshot(
      { firstName: "Same", lastName: "Name" },
      { firstName: "Same", lastName: "Name", email: "", phone: "" },
    );
    expect(contact.email).toBe("");
  });
});

describe("the SQL that matches it", () => {
  const source = readFileSync(
    new URL("../modules/attendee-accounts/registrations-repository.ts", import.meta.url),
    "utf8",
  );

  it("prefers the snapshot address, treating blank as absent", () => {
    // `nullif(trim(...), '')` is what makes a blank snapshot address fall
    // through to the Person row, matching `nonEmptyString` on the render side.
    expect(source).toContain("nullif(trim(registration.\"contactSnapshot\"->>'email'), '')");
    expect(source).toContain("person.\"normalizedEmail\"");
    expect(source).toMatch(/coalesce\(/);
  });

  it("compares case-insensitively", () => {
    // An imported row may carry whatever case the workbook held.
    expect(source).toMatch(/lower\(coalesce\(/);
  });

  it("leaves drafts out", () => {
    // An abandoned form is not something anyone submitted, and listing one back
    // to a registrant as theirs would be a puzzle rather than a service.
    expect(source).toContain(`registration."status" <> 'DRAFT'`);
  });

  it("matches on the address alone", () => {
    const where = source.slice(source.indexOf("WHERE"), source.indexOf("`);"));
    expect(where).not.toMatch(/firstName|lastName|"Person"\."(first|last)Name/i);
  });
});
