import { describe, expect, it, vi } from "vitest";

/** #167: the invoice rules, with no database. Synthetic data only. */
vi.mock("server-only", () => ({}));

import { reconcileEvent, type GroupSource, type PersonSource, type RegistrationSource } from "@/modules/attendance-reconciliation/domain";
import {
  buildInvoiceFigures,
  contactsMatch,
  deriveInvoiceCode,
  eventInvoiceYear,
  finalizationNeedsPermission,
  formatBaseNumber,
  formatVersionNumber,
  normalizeInvoiceCode,
  revisionChangeSummary,
  versionStatusLabel,
} from "@/modules/invoices/domain";
import { invoiceActionSchema } from "@/modules/invoices/schemas";

const person = (id: string, checkedIn: boolean, chargeCents = 2500): PersonSource => ({
  attendeeId: id, name: `Person ${id}`, checkedIn, correction: null, addedAfterSubmission: false, substituted: false, chargeCents, lateRate: false, adjustmentCents: 0,
});

const registration = (id: string, club: string, people: PersonSource[], extras: Partial<RegistrationSource> = {}): RegistrationSource => ({
  registrationId: id, confirmationCode: `C-${id}`, status: "CONFIRMED", label: club, clubId: `club-${club}`, locationId: null, locationName: null,
  estimatedCents: people.length * 2500, people, registrationCharges: [], credits: [], promo: null, review: null, registrationAdjustmentCents: 0, hasPriceLines: true,
  ...extras,
});

const group = (key: string, title: string, registrations: RegistrationSource[], clubId: string | null = null): GroupSource => ({
  key, title, partyKind: "ORGANIZATION", partyId: "church-1", partyName: "Church One", clubId, registrations,
});

function figures(source: GroupSource, grouping: "PER_CHURCH" | "PER_CLUB" = "PER_CHURCH") {
  const result = reconcileEvent([source], grouping);
  const resultGroup = result.groups[0]!;
  return buildInvoiceFigures({
    event: { id: "event-1", name: "Spring Camporee 2027" },
    groupKey: resultGroup.key,
    groupTitle: resultGroup.title,
    invoiceGrouping: grouping,
    party: { kind: "ORGANIZATION", id: "church-1", name: "Church One" },
    clubId: resultGroup.clubId,
    reconciliation: { versionId: "recon-1", versionNumber: 1, ruleVersion: result.ruleVersion },
    group: resultGroup,
  });
}

describe("invoice numbers", () => {
  it("derives the event code from the initials of the words of its name, letters only, at most four", () => {
    expect(deriveInvoiceCode("Spring Camporee 2027")).toBe("SC");
    expect(deriveInvoiceCode("Women's Retreat")).toBe("WR");
    expect(deriveInvoiceCode("Pathfinder Bible Experience Fall Finals")).toBe("PBEF");
    expect(deriveInvoiceCode("  Étoile  d'Or 3rd Gathering ")).toBe("EDG");
    expect(deriveInvoiceCode("Camporee")).toBe("CAM");
    expect(deriveInvoiceCode("2027")).toBe("EV");
  });

  it("accepts an explicit code of two to six letters only", () => {
    expect(normalizeInvoiceCode(" sc ")).toBe("SC");
    expect(normalizeInvoiceCode("SPRING")).toBe("SPRING");
    expect(normalizeInvoiceCode("S")).toBeNull();
    expect(normalizeInvoiceCode("SC1")).toBeNull();
    expect(normalizeInvoiceCode("TOOLONGCODE")).toBeNull();
    expect(normalizeInvoiceCode("")).toBeNull();
  });

  it("formats <CODE><YY>-<NNNN> with -R<n> for revisions, and takes the year in the event's time zone", () => {
    expect(formatBaseNumber("SC", 2027, 1)).toBe("SC27-0001");
    expect(formatBaseNumber("SC", 2027, 12345)).toBe("SC27-12345");
    expect(formatVersionNumber("SC27-0001", 0)).toBe("SC27-0001");
    expect(formatVersionNumber("SC27-0001", 2)).toBe("SC27-0001-R2");
    // Midnight UTC on New Year's Day is still the old year in Chicago.
    expect(eventInvoiceYear(new Date("2027-01-01T01:00:00Z"), "America/Chicago")).toBe(2026);
    expect(eventInvoiceYear(new Date("2027-01-01T01:00:00Z"), "UTC")).toBe(2027);
    expect(eventInvoiceYear(new Date("2027-01-01T01:00:00Z"), "Not/AZone")).toBe(2027);
  });
});

describe("the invoice snapshot", () => {
  it("makes one invoice of a church's clubs: a line per club, only attended people billed, totals add up", () => {
    const made = figures(group("organization:church-1", "Church One", [
      registration("r1", "Alpha", [person("a1", true), person("a2", true), person("a3", false)]),
      registration("r2", "Beta", [person("b1", true), person("b2", false)]),
    ]));
    expect(made.snapshot.lines.map((line) => [line.label, line.amountCents])).toEqual([["Alpha", 5000], ["Beta", 2500]]);
    expect(made.amountDueCents).toBe(7500);
    expect(made.registeredCount).toBe(5);
    expect(made.billableCount).toBe(3);
    expect(made.snapshot.totals).toMatchObject({ registered: 5, checkedIn: 3, noShow: 2, billable: 3, amountDueCents: 7500 });
    const alpha = made.snapshot.lines[0]!;
    expect(alpha.people.map((entry) => [entry.attendeeId, entry.billable, entry.amountCents])).toEqual([["a1", true, 2500], ["a2", true, 2500], ["a3", false, null]]);
    expect(made.snapshot.reconciliation).toEqual({ versionId: "recon-1", versionNumber: 1, ruleVersion: "attended-v1" });
  });

  it("carries a per-club group on its own (one club, its church as the party)", () => {
    const made = figures(group("organization:church-1|club:club-Alpha", "Alpha", [registration("r1", "Alpha", [person("a1", true)])], "club-Alpha"), "PER_CLUB");
    expect(made.snapshot.invoiceGrouping).toBe("PER_CLUB");
    expect(made.snapshot.clubId).toBe("club-Alpha");
    expect(made.snapshot.party.name).toBe("Church One");
    expect(made.amountDueCents).toBe(2500);
  });

  it("keeps credits, promo and charges not tied to a person as their own lines", () => {
    const made = figures(group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", true)], {
      registrationCharges: [{ label: "Late fee", cents: 1000 }],
      credits: [{ key: "meal", label: "Meal sponsorship", centsPerUnit: -500, rawUnits: 2, capAtHeadcount: true, recordedCents: -1000 }],
      promo: { code: "SAVE10", type: "FIXED_CENTS", value: 500, maximumDiscountCents: null, recordedCents: 500 },
    })]));
    const line = made.snapshot.lines[0]!;
    expect(line.chargesNotTiedToPerson).toEqual([{ label: "Late fee", amountCents: 1000, kind: "CHARGE" }]);
    expect(line.credits).toEqual([{ label: "Meal sponsorship", units: 2, amountCents: -1000 }]);
    expect(line.promo).toEqual({ code: "SAVE10", amountCents: -500 });
    // 2 x 25 + 10 late fee - 10 credit - 5 promo.
    expect(made.amountDueCents).toBe(5000 + 1000 - 1000 - 500);
  });

  it("a group nobody attended is a $0 invoice with no billable people", () => {
    const made = figures(group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", false)], { registrationCharges: [{ label: "Flat fee", cents: 2000 }] })]));
    expect(made.amountDueCents).toBe(0);
    expect(made.billableCount).toBe(0);
    expect(made.snapshot.lines[0]!.amountCents).toBe(0);
  });

  it("a group missing from the approved reconciliation brings an invoice to $0 with no lines", () => {
    const made = buildInvoiceFigures({
      event: { id: "event-1", name: "E" }, groupKey: "k", groupTitle: "Church One", invoiceGrouping: "PER_CHURCH",
      party: { kind: "ORGANIZATION", id: "church-1", name: "Church One" }, clubId: null,
      reconciliation: { versionId: "recon-2", versionNumber: 2, ruleVersion: "attended-v1" }, group: null,
    });
    expect(made.snapshot.lines).toEqual([]);
    expect(made.amountDueCents).toBe(0);
  });
});

describe("what counts as a changed billable amount", () => {
  const base = () => group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", false)])]);

  it("the amounts fingerprint ignores names, labels and the reconciliation version, and moves with any amount", () => {
    const first = figures(base());
    const renamed = figures({ ...base(), title: "Church One (renamed)", registrations: [registration("r1", "Alpha renamed", [{ ...person("a1", true), name: "Someone Else" }, person("a2", false)])] });
    expect(renamed.amountsFingerprint).toBe(first.amountsFingerprint);
    const attended = figures(group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true), person("a2", true)])]));
    expect(attended.amountsFingerprint).not.toBe(first.amountsFingerprint);
    const repriced = figures(group("organization:church-1", "Church One", [registration("r1", "Alpha", [person("a1", true, 3000), person("a2", false)])]));
    expect(repriced.amountsFingerprint).not.toBe(first.amountsFingerprint);
  });

  it("an original always needs the permission; a revision needs it only when an amount differs", () => {
    const original = figures(base());
    expect(finalizationNeedsPermission({ revision: 0, amountsFingerprint: original.amountsFingerprint }, null)).toBe(true);
    expect(finalizationNeedsPermission({ revision: 1, amountsFingerprint: original.amountsFingerprint }, { amountsFingerprint: original.amountsFingerprint })).toBe(false);
    expect(finalizationNeedsPermission({ revision: 1, amountsFingerprint: "different" }, { amountsFingerprint: original.amountsFingerprint })).toBe(true);
    // A revision with no finalized version to compare with is treated as an original.
    expect(finalizationNeedsPermission({ revision: 1, amountsFingerprint: original.amountsFingerprint }, null)).toBe(true);
  });

  it("summarizes a revision in words: amounts, contact, or both", () => {
    const prior = { amountsFingerprint: "a", amountDueCents: 5000, contactName: "Tina", contactEmail: "tina@contact.test" };
    expect(revisionChangeSummary({ ...prior, contactName: "Sam", contactEmail: "sam@contact.test" }, prior)).toMatchObject({ amountsChanged: false, contactChanged: true });
    expect(revisionChangeSummary({ ...prior, amountsFingerprint: "b", amountDueCents: 7500 }, prior)).toMatchObject({ amountsChanged: true, contactChanged: false, previousAmountCents: 5000, amountCents: 7500 });
  });

  it("contacts match by name and address, ignoring case and spacing; a missing contact matches only a missing one", () => {
    expect(contactsMatch({ name: "Tina Treasurer", email: "Tina@Contact.test" }, { name: " tina treasurer ", email: "tina@contact.test" })).toBe(true);
    expect(contactsMatch({ name: "Tina", email: "a@contact.test" }, { name: "Tina", email: "b@contact.test" })).toBe(false);
    expect(contactsMatch({ contactName: "Tina", contactEmail: "a@contact.test" }, { name: "Tina", email: "a@contact.test" })).toBe(true);
    expect(contactsMatch(null, { name: "Tina", email: "a@contact.test" })).toBe(false);
    expect(contactsMatch(null, { name: null, email: null })).toBe(true);
  });
});

describe("labels and the action schema", () => {
  it("names the three version statuses", () => {
    expect(["DRAFT", "FINALIZED", "SUPERSEDED"].map((status) => versionStatusLabel(status as "DRAFT"))).toEqual(["Draft", "Finalized", "Superseded"]);
  });

  it("finalizing needs an explicit confirmation and a request key; revising needs a reason; unknown actions (such as sending) do not exist", () => {
    const key = "a-request-key-0123456789";
    expect(invoiceActionSchema.safeParse({ action: "finalize", versionId: "v1", idempotencyKey: key, confirm: true }).success).toBe(true);
    expect(invoiceActionSchema.safeParse({ action: "finalize", versionId: "v1", idempotencyKey: key }).success).toBe(false);
    expect(invoiceActionSchema.safeParse({ action: "finalize", versionId: "v1", idempotencyKey: key, confirm: false }).success).toBe(false);
    expect(invoiceActionSchema.safeParse({ action: "finalize", versionId: "v1", idempotencyKey: "short", confirm: true }).success).toBe(false);
    expect(invoiceActionSchema.safeParse({ action: "revise", invoiceId: "i1", mode: "CONTACT_ONLY", reason: "  " }).success).toBe(false);
    expect(invoiceActionSchema.safeParse({ action: "revise", invoiceId: "i1", mode: "FROM_RECONCILIATION", reason: "Adjusted" }).success).toBe(true);
    expect(invoiceActionSchema.safeParse({ action: "revise", invoiceId: "i1", mode: "OTHER", reason: "x" }).success).toBe(false);
    expect(invoiceActionSchema.safeParse({ action: "send", invoiceId: "i1" }).success).toBe(false);
    expect(invoiceActionSchema.safeParse({ action: "create-drafts" }).success).toBe(true);
  });
});
