import { describe, expect, it } from "vitest";
import {
  billingResponsibilityCsvRows,
  groupBillingLines,
  organizationReadiness,
  personReadiness,
  planResolution,
  resolveByRule,
  staffSourceFor,
  summarizeBillingGroups,
  type BillingContactView,
  type BillingLine,
  type ResponsibleParty,
  type Resolution,
} from "@/modules/billing-responsibility/domain";

/** Synthetic data only. */

const church = (id: string, name: string): ResponsibleParty => ({ kind: "ORGANIZATION", id, name });

function line(overrides: Partial<BillingLine> & Pick<BillingLine, "registrationId" | "party">): BillingLine {
  return {
    confirmationCode: `CONF-${overrides.registrationId}`,
    status: "CONFIRMED",
    attendeeCount: 10,
    totalAmountCents: 10_000,
    locationName: null,
    clubId: null,
    clubName: null,
    registrantName: "Pat Example",
    source: "CLUB_SPONSORING_CHURCH",
    reason: null,
    recorded: true,
    outdated: false,
    hint: null,
    ...overrides,
  };
}

const contact = (verifiedAt: string | null): BillingContactView => ({
  name: "Terry Treasurer", email: "treasurer@example.test", roleLabel: "Treasurer",
  effectiveFrom: "2026-10-01T00:00:00.000Z", verifiedAt,
});

describe("resolveByRule (#165)", () => {
  it("resolves a club registration to its sponsoring church", () => {
    expect(resolveByRule({ club: { organizationId: "club-1", parentOrganizationId: "church-1" }, groupBillingPersonId: null })).toEqual({
      kind: "ORGANIZATION", organizationId: "church-1", personId: null, source: "CLUB_SPONSORING_CHURCH",
    });
  });

  it("leaves a club with no sponsoring church unresolved instead of guessing", () => {
    expect(resolveByRule({ club: { organizationId: "club-1", parentOrganizationId: null }, groupBillingPersonId: null })).toMatchObject({
      kind: "UNRESOLVED", organizationId: null, personId: null, source: "UNRESOLVED_CLUB_HAS_NO_CHURCH",
    });
  });

  it("resolves a group registration to its billing person", () => {
    expect(resolveByRule({ club: null, groupBillingPersonId: "person-1" })).toEqual({
      kind: "PERSON", organizationId: null, personId: "person-1", source: "GROUP_BILLING_PERSON",
    });
  });

  it("leaves any other registration unresolved: a free-text answer is never an input", () => {
    expect(resolveByRule({ club: null, groupBillingPersonId: null })).toMatchObject({ kind: "UNRESOLVED", source: "UNRESOLVED_NO_ORGANIZATION_LINKED" });
  });
});

describe("planResolution (#165)", () => {
  const rule: Resolution = { kind: "ORGANIZATION", organizationId: "church-1", personId: null, source: "CLUB_SPONSORING_CHURCH" };

  it("creates when nothing is recorded, then reports unchanged on the retry", () => {
    const first = planResolution(null, rule);
    expect(first).toEqual({ action: "CREATE", next: rule });
    expect(planResolution(rule, rule)).toEqual({ action: "UNCHANGED" });
  });

  it("updates a rule-derived row when the club's church changed", () => {
    expect(planResolution({ ...rule, organizationId: "church-0" }, rule)).toEqual({ action: "UPDATE", next: rule });
  });

  it("never replaces a staff link or override", () => {
    for (const source of ["STAFF_LINKED", "STAFF_OVERRIDE"] as const) {
      expect(planResolution({ kind: "ORGANIZATION", organizationId: "church-9", personId: null, source }, rule)).toEqual({ action: "KEEP_STAFF_DECISION" });
    }
  });

  it("calls a choice a link when the rules found nothing and an override when they did", () => {
    expect(staffSourceFor(resolveByRule({ club: null, groupBillingPersonId: null }))).toBe("STAFF_LINKED");
    expect(staffSourceFor(rule)).toBe("STAFF_OVERRIDE");
  });
});

describe("readiness (#165)", () => {
  it("is Ready only with a verified active contact", () => {
    expect(organizationReadiness(null)).toBe("NO_CONTACT");
    expect(organizationReadiness(contact(null))).toBe("NOT_VERIFIED");
    expect(organizationReadiness(contact("2026-10-02T00:00:00.000Z"))).toBe("READY");
    expect(personReadiness("a@example.test")).toBe("READY");
    expect(personReadiness(null)).toBe("NO_CONTACT");
  });
});

describe("groupBillingLines (#165)", () => {
  const a = church("church-1", "Alpha SDA Church");
  const lines = [
    line({ registrationId: "r1", party: a, clubId: "club-1", clubName: "Alpha Pathfinders" }),
    line({ registrationId: "r2", party: a, clubId: "club-2", clubName: "Alpha Adventurers", totalAmountCents: 4_000 }),
    line({ registrationId: "r3", party: a, clubId: "club-3", clubName: "Alpha Waitlisted", status: "WAITLISTED" }),
    line({ registrationId: "r4", party: church("church-2", "Beta SDA Church"), clubId: "club-4", clubName: "Beta Pathfinders" }),
    line({ registrationId: "r5", party: { kind: "UNRESOLVED" }, source: "UNRESOLVED_NO_ORGANIZATION_LINKED", hint: "Gamma church" }),
    line({ registrationId: "r7", party: church("church-2", "Beta SDA Church"), clubId: "club-7", clubName: "Beta Stale", outdated: true }),
    line({ registrationId: "r6", party: { kind: "PERSON", id: "p1", name: "Group Leader", email: "leader@example.test" }, source: "GROUP_BILLING_PERSON" }),
  ];
  const contacts = new Map([["church-1", contact("2026-10-02T00:00:00.000Z")]]);

  it("groups several clubs of one church together with each club as its own line, per church", () => {
    const groups = groupBillingLines(lines, "PER_CHURCH", contacts);
    const alpha = groups.find((group) => group.title === "Alpha SDA Church")!;
    expect(alpha.lines.map((entry) => entry.clubName)).toEqual(["Alpha Adventurers", "Alpha Pathfinders", "Alpha Waitlisted"]);
    expect(alpha.owedCents).toBe(14_000);
    expect(alpha.billedCount).toBe(2);
    expect(alpha.readiness).toBe("READY");
    expect(groups.find((group) => group.title === "Beta SDA Church")!.readiness).toBe("NO_CONTACT");
  });

  it("splits each club into its own group per club, still addressed to the church's contact", () => {
    const groups = groupBillingLines(lines, "PER_CLUB", contacts);
    const alphaGroups = groups.filter((group) => group.party.kind === "ORGANIZATION" && group.party.id === "church-1");
    expect(alphaGroups.map((group) => group.title).sort()).toEqual(["Alpha Adventurers", "Alpha Pathfinders", "Alpha Waitlisted"]);
    expect(alphaGroups.every((group) => group.readiness === "READY" && group.lines.length === 1)).toBe(true);
  });

  it("keeps unresolved registrations in one list, last, and groups never mix parties", () => {
    for (const mode of ["PER_CHURCH", "PER_CLUB"] as const) {
      const groups = groupBillingLines(lines, mode, contacts);
      expect(groups.at(-1)!.party.kind).toBe("UNRESOLVED");
      expect(groups.at(-1)!.readiness).toBe("UNRESOLVED");
      expect(groups.at(-1)!.lines).toHaveLength(1);
      expect(groups.find((group) => group.party.kind === "PERSON")!.readiness).toBe("READY");
    }
  });

  it("summarizes without counting unresolved as an invoice group", () => {
    const summary = summarizeBillingGroups(groupBillingLines(lines, "PER_CHURCH", contacts));
    expect(summary).toMatchObject({ groupCount: 3, readyCount: 2, needsContactCount: 1, unresolvedCount: 1 });
  });

  it("exports the contact, readiness and hint, and no phone number", () => {
    const rows = billingResponsibilityCsvRows(groupBillingLines(lines, "PER_CHURCH", contacts), "PER_CHURCH");
    expect(rows[0]).toContain("Contact readiness");
    const unresolvedRow = rows.find((row) => row[9] === "CONF-r5")!;
    expect(unresolvedRow[4]).toBe("Unresolved");
    expect(unresolvedRow.at(-1)).toBe("Gamma church");
    const alphaRow = rows.find((row) => row[9] === "CONF-r1")!;
    expect(alphaRow[5]).toBe("Terry Treasurer");
    expect(alphaRow[7]).toBe("treasurer@example.test");
    expect(rows.flat().some((cell) => String(cell).includes("555"))).toBe(false);
    const outdatedColumn = rows[0]!.indexOf("Out of date");
    expect(outdatedColumn).toBeGreaterThan(-1);
    expect(rows.find((row) => row[9] === "CONF-r7")![outdatedColumn]).toBe("Yes");
    expect(rows.find((row) => row[9] === "CONF-r1")![outdatedColumn]).toBe("");
  });
});
