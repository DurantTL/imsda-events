import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { ChurchAmountsOwed } from "@/components/church-amounts-owed";
import {
  churchAmountsOwedCsvRows,
  groupOwedRows,
  summarizeChurchAmountsOwed,
} from "@/modules/club-registrations/church-owed";
import { listChurchAmountsOwed } from "@/modules/club-registrations/repository";
import { getHonorRosterData } from "@/modules/honors/roster-repository";
import { buildPaymentStatusBlock } from "@/modules/communications/message-blocks";
import { withGroupBilledWording } from "@/modules/communications/templates";
import { summarizePublicPayment } from "@/modules/public-access/domain";
import {
  adjustmentWording,
  financeDetailFacts,
  matchesFinanceFilter,
  summarizeFinanceTotals,
  type FinanceViewRegistration,
} from "@/modules/registrations/finance-view";
import { listRegistrationsForVerifiedEmail } from "@/modules/attendee-accounts/registrations-repository";

// Synthetic data only.
const at = new Date("2026-10-01T09:00:00Z");

beforeEach(() => vi.clearAllMocks());

function registration(confirmationCode: string, status: string, total: string, attendees: number) {
  return { confirmationCode, status, totalAmount: { toString: () => total }, _count: { attendees } };
}

function groupLink(confirmationCode: string, status: string, total: string, attendees: number, contact = { firstName: "Jamie", lastName: "Contact", email: "jamie@example.test" }) {
  return {
    registration: {
      id: `reg-${confirmationCode}`,
      ...registration(confirmationCode, status, total, attendees),
      location: { name: "Des Moines" },
      accountHolderPerson: { firstName: contact.firstName, lastName: contact.lastName, normalizedEmail: contact.email },
      contactSnapshot: contact,
    },
  };
}

const clubRows = [{
  organization: { id: "org-a", name: "Ankeny Son-Seekers", parentOrganization: { id: "church-a", name: "Ankeny SDA Church" } },
  registration: registration("REG-A1", "CONFIRMED", "13", 2),
}];

function mockFinance(groups: unknown[]) {
  dependencies.getPrisma.mockReturnValue({
    clubEventRegistration: { findMany: vi.fn().mockResolvedValue(clubRows) },
    event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB" }) },
    groupEventRegistration: { findMany: vi.fn().mockResolvedValue(groups) },
    registration: { findMany: vi.fn().mockResolvedValue([]) },
  });
}

describe("staff finance view shows group registrations with their billing contact (#650)", () => {
  it("lists each group beside the clubs, billed to its contact, and never under a church", async () => {
    mockFinance([groupLink("GRP-1", "SUBMITTED", "75", 3), groupLink("GRP-2", "WAITLISTED", "50", 2, { firstName: "Sam", lastName: "Wait", email: "sam@example.test" })]);
    const owed = await listChurchAmountsOwed("event-1");
    const group = owed.find((row) => row.confirmationCode === "GRP-1");
    expect(group).toMatchObject({
      kind: "GROUP",
      organizationName: "Jamie Contact",
      churchId: "groups",
      isBilled: true,
      amountOwedCents: 7500,
      attendeeCount: 3,
      locationName: "Des Moines",
      billingContact: { name: "Jamie Contact", email: "jamie@example.test" },
    });
    // A waitlisted group is listed but owes nothing, like a waitlisted club.
    expect(owed.find((row) => row.confirmationCode === "GRP-2")).toMatchObject({ isBilled: false, amountOwedCents: 0 });
    // Clubs first, then groups last.
    expect(owed.map((row) => row.confirmationCode)).toEqual(["REG-A1", "GRP-1", "GRP-2"]);
  });

  it("does not count groups as a church in the summary", async () => {
    mockFinance([groupLink("GRP-1", "SUBMITTED", "75", 3)]);
    const summary = summarizeChurchAmountsOwed(await listChurchAmountsOwed("event-1"));
    expect(summary.churchCount).toBe(1);
    expect(summary.churches.map((church) => church.churchKey)).toEqual(["church-a", "groups"]);
    expect(summary.totalOwedCents).toBe(8800);
  });

  it("shows the page a Group section with the contact, apart from the churches", async () => {
    mockFinance([groupLink("GRP-1", "SUBMITTED", "75", 3)]);
    const markup = renderToStaticMarkup(ChurchAmountsOwed({
      eventId: "event-1", isDeferredOrganizationBilling: true, rows: await listChurchAmountsOwed("event-1"),
    }));
    expect(markup).toContain("Group registrations billed to their contact");
    expect(markup).toContain("Jamie Contact");
    expect(markup).toContain("jamie@example.test");
    expect(markup).toContain("billed to the contact after the event");
    expect(markup).toContain("Groups billed");
    // The churches table is unchanged: one church, billed once; the total includes the group.
    expect(markup).toContain("Ankeny SDA Church");
    expect(markup).toContain("$88.00");
    expect(markup).not.toContain("Groups (billed to their contact)</strong>");
  });

  it("exports the billing contact, and leaves a club-only event's columns alone", async () => {
    mockFinance([groupLink("GRP-1", "SUBMITTED", "75", 3)]);
    const table = churchAmountsOwedCsvRows(await listChurchAmountsOwed("event-1"));
    const header = table[0]!;
    expect(header).toEqual(expect.arrayContaining(["Billing contact", "Billing contact email", "Billed after the event"]));
    const groupLine = table.find((row) => row.includes("GRP-1"))!;
    expect(groupLine).toEqual(expect.arrayContaining(["Jamie Contact", "jamie@example.test", "75.00", "Billed to the group's contact after the event, not paid online"]));
    expect(groupLine).not.toContain("Ankeny SDA Church");
    const clubOnly = churchAmountsOwedCsvRows((await listChurchAmountsOwed("event-1")).filter((row) => row.kind !== "GROUP"));
    expect(clubOnly[0]!.slice(0, 2)).toEqual(["Church", "Club"]);
    expect(clubOnly[0]).not.toContain("Billing contact");
  });

  it("gives each group row its own estimated total, not the sum across groups", async () => {
    mockFinance([groupLink("GRP-1", "SUBMITTED", "75", 3), groupLink("GRP-3", "SUBMITTED", "20", 1)]);
    const table = churchAmountsOwedCsvRows(await listChurchAmountsOwed("event-1"));
    const totalColumn = table[0]!.indexOf("Church or group estimated total");
    expect(table.find((row) => row.includes("GRP-1"))![totalColumn]).toBe("75.00");
    expect(table.find((row) => row.includes("GRP-3"))![totalColumn]).toBe("20.00");
  });

  it("reads groups only for a church-billed club event", async () => {
    const groupFind = vi.fn().mockResolvedValue([]);
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "ATTENDEE_PAY", audience: "CLUB" }) },
      groupEventRegistration: { findMany: groupFind },
      registration: { findMany: vi.fn() },
    });
    expect(await listChurchAmountsOwed("event-1")).toEqual([]);
    expect(groupFind).not.toHaveBeenCalled();
  });

  it("makes rows from sources with only a contact and an amount", () => {
    const [row] = groupOwedRows([{ registrationId: "r1", confirmationCode: "G-1", status: "CANCELLED", totalAmountCents: 5000, attendeeCount: 2, contactName: "Pat Contact", contactEmail: null }]);
    expect(row).toMatchObject({ kind: "GROUP", isBilled: false, amountOwedCents: 0, billingContact: { name: "Pat Contact", email: null } });
    expect(row).not.toHaveProperty("locationName");
  });
});

function rosterDatabase() {
  const registrationShape = (attendeeId: string, first: string) => ({
    locationId: "loc-dm", location: { name: "Des Moines" }, publicFormSubmission: null,
    attendees: [{ id: attendeeId, profileSnapshot: { firstName: first, lastName: "Person", temporaryAttendeeType: "YOUTH", ageOnEventDate: 12 }, checkIns: [] }],
  });
  const db = {
    event: { findUnique: vi.fn().mockResolvedValue({ id: "e1", name: "Honors", startsAt: at, endsAt: at, timezone: "America/Chicago", location: null }) },
    honorSession: { findMany: vi.fn().mockResolvedValue([{ id: "s1", name: "Sabbath", locationId: null, sortOrder: 0, createdAt: at, location: null }]) },
    honorOffering: { findMany: vi.fn().mockResolvedValue([{ id: "o1", span: "SINGLE_SESSION", sessionId: "s1", locationId: null, site: null, capacity: 5, teacherName: "", location: "", isActive: true, honors: [{ honor: { id: "honor-b", name: "Birds", code: "B", isActive: true } }] }]) },
    clubEventRegistration: {
      findMany: vi.fn().mockResolvedValue([{ organizationId: "club-1", organization: { name: "Iowa Club" }, registration: registrationShape("club-att", "Clubby") }]),
    },
    groupEventRegistration: {
      findMany: vi.fn().mockResolvedValue([{ registrationId: "reg-g1", billingPerson: { firstName: "Jamie", lastName: "Contact" }, registration: registrationShape("grp-att", "Grouper") }]),
    },
    clubRosterMember: { findMany: vi.fn().mockResolvedValue([]) },
    honorEnrollment: {
      findMany: vi.fn().mockResolvedValue([
        { offeringId: "o1", registrationAttendeeId: "club-att", consumesSeat: true },
        { offeringId: "o1", registrationAttendeeId: "grp-att", consumesSeat: true },
      ]),
    },
    eventLocation: { findMany: vi.fn().mockResolvedValue([{ id: "loc-dm", name: "Des Moines", sortOrder: 0 }]) },
  };
  dependencies.getPrisma.mockReturnValue(db);
  return db;
}

describe("staff class rosters include groups (#650)", () => {
  it("lists a group's people and classes beside the clubs', under the group, not a club", async () => {
    rosterDatabase();
    const data = (await getHonorRosterData("e1", { includeDietary: false }))!;
    const groupPerson = data.attendees.find((person) => person.id === "grp-att")!;
    expect(groupPerson).toMatchObject({ clubId: "group:reg-g1", clubName: "Group: Jamie Contact", attendeeType: "YOUTH", locationName: "Des Moines" });
    expect(data.enrollments.map((row) => row.attendeeId).sort()).toEqual(["club-att", "grp-att"]);
    // Listed by name, like clubs: "Group: ..." comes before "Iowa Club".
    expect(data.clubs.map((club) => club.id)).toEqual(["group:reg-g1", "club-1"]);
    // A group is not a club: no club is named after it.
    expect(data.clubs.find((club) => club.id === "group:reg-g1")?.name).toBe("Group: Jamie Contact");
  });

  it("never puts a group on a club director's own schedule", async () => {
    const db = rosterDatabase();
    const data = (await getHonorRosterData("e1", { includeDietary: false, organizationId: "club-1" }))!;
    expect(db.groupEventRegistration.findMany).not.toHaveBeenCalled();
    expect(data.attendees.map((person) => person.id)).toEqual(["club-att"]);
  });

  it("follows the site filter for groups as for clubs", async () => {
    const db = rosterDatabase();
    await getHonorRosterData("e1", { includeDietary: false, locationId: "loc-dm" });
    expect(db.groupEventRegistration.findMany.mock.calls[0]![0].where).toEqual({
      eventId: "e1", registration: { status: { in: ["SUBMITTED", "CONFIRMED"] }, locationId: "loc-dm" },
    });
  });
});

describe("what a group is told about billing (#650)", () => {
  it("says the contact is billed after the event, with the estimated total, and never a church", () => {
    const block = buildPaymentStatusBlock({
      state: "GROUP_INVOICED", totalCents: 7500, paidCents: 0, balanceCents: 7500,
      organization: "Some Church", billingContact: "Somebody Else", perPersonNotice: "$25 per person.",
    });
    expect(block).toContain("No payment is due online.");
    expect(block).toContain("You'll be billed after the event.");
    expect(block).toContain("Estimated total: $75.00");
    expect(block).toContain("$25 per person.");
    expect(block).not.toMatch(/church|organization/i);
  });

  it("changes only the default church-billed sentence of a confirmation email", () => {
    const defaultBody = "Your registration is recorded. This event bills the responsible organization directly — do not send payment yourself.";
    expect(withGroupBilledWording(defaultBody, true)).toContain("You'll be billed after the event — do not send payment yet.");
    expect(withGroupBilledWording(defaultBody, true)).not.toContain("responsible organization");
    expect(withGroupBilledWording(defaultBody, false)).toBe(defaultBody);
    // Wording staff wrote themselves is left as they wrote it.
    expect(withGroupBilledWording("Custom staff wording.", true)).toBe("Custom staff wording.");
  });

  it("shows the contact's manage page a billed-after-the-event summary that keeps the estimate", () => {
    const summary = summarizePublicPayment({
      status: "SUBMITTED", totalCents: 7500, payments: [], isDeferredOrganizationBilling: true, billedToGroup: true,
    });
    expect(summary).toMatchObject({ state: "GROUP_BILLED", label: "Billed after the event", totalCents: 7500, amountDueCents: 0, paymentEligible: false });
    expect(summary.detail).not.toMatch(/organization/i);
    // A church-billed club keeps its own wording.
    expect(summarizePublicPayment({ status: "SUBMITTED", totalCents: 7500, payments: [], isDeferredOrganizationBilling: true }).state).toBe("ORGANIZATION_BILLED");
  });
});

describe("staff finance list words a group truthfully (#650)", () => {
  const base: FinanceViewRegistration = {
    status: "SUBMITTED", totalAmountCents: 7500, paidCents: 0, balanceCents: 7500, isDeferredOrganizationBilling: true, payments: [],
  };
  const church = { ...base };
  const group = { ...base, isGroup: true };

  it("lists a group under its own filter, never under the churches'", () => {
    const rows = [church, group];
    expect(rows.filter((row) => matchesFinanceFilter(row, "CHURCH_BILLED"))).toEqual([church]);
    expect(rows.filter((row) => matchesFinanceFilter(row, "GROUP_BILLED"))).toEqual([group]);
    // Neither is ever an attendee balance.
    expect(rows.filter((row) => matchesFinanceFilter(row, "BALANCE"))).toEqual([]);
  });

  it("keeps a group's estimate out of the outstanding balance, as a church's is", () => {
    expect(summarizeFinanceTotals([church, group]).outstanding).toBe(0);
  });

  it("says the estimate is billed to the group contact, not to a church", () => {
    expect(financeDetailFacts({ isDeferredOrganizationBilling: true, isGroup: true, paidCents: 0, payments: [] })[0]!.label)
      .toBe("Estimated amount (billed to the group contact)");
    expect(financeDetailFacts({ isDeferredOrganizationBilling: true, paidCents: 0, payments: [] })[0]!.label).toBe("Estimated church amount");
    expect(adjustmentWording(true, true).title).toBe("Adjust estimated amount");
    expect(JSON.stringify(adjustmentWording(true, true))).not.toMatch(/church/i);
    expect(adjustmentWording(true).title).toBe("Adjust estimated church amount");
  });
});

describe("a group contact's account page (#650)", () => {
  function fixture(groupRegistration: { id: string } | null) {
    dependencies.getPrisma.mockReturnValue({
      $queryRaw: vi.fn().mockResolvedValue([{ id: "registration-1" }]),
      registration: {
        findMany: vi.fn().mockResolvedValue([{
          id: "registration-1", confirmationCode: "REG-GROUP", status: "SUBMITTED",
          submittedAt: new Date("2026-08-01T12:00:00.000Z"), updatedAt: new Date("2026-08-01T13:00:00.000Z"),
          totalAmount: { toString: () => "75" }, contactSnapshot: { email: "jamie@example.test" }, groupRegistration,
          accountHolderPerson: { firstName: "Jamie", lastName: "Contact", normalizedEmail: "jamie@example.test", phone: null },
          event: {
            name: "Honors Weekend", slug: "honors-weekend", startsAt: new Date("2026-12-05T15:00:00.000Z"), endsAt: new Date("2026-12-06T22:00:00.000Z"),
            timezone: "America/Chicago", location: null, attendeeEditPolicy: "TIERED", billingMode: "DEFERRED_ORGANIZATION_INVOICE",
            seminarPreferenceClosesOn: null, seminarPreferenceSelfServiceLocked: false, programAssignmentRuns: [],
          },
          attendees: [], publicFormSubmission: null, payments: [], waitlistEntry: null, operations: [],
        }]),
      },
    });
  }

  it("shows the estimated total and the billed-later notice, with no church wording and no payable balance", async () => {
    fixture({ id: "group-1" });
    const [registration] = await listRegistrationsForVerifiedEmail("jamie@example.test");
    expect(registration?.groupBilling).toEqual({
      billed: true, estimateCents: 7500, notice: "You'll be billed after the event.", label: "You'll be billed after the event.",
    });
    expect(registration?.churchBilling).toBeNull();
    expect(registration?.balanceCents).toBe(0);
    expect(JSON.stringify(registration?.groupBilling)).not.toMatch(/church/i);
  });

  it("leaves a club's registration with its church wording and no group billing", async () => {
    fixture(null);
    const [registration] = await listRegistrationsForVerifiedEmail("jamie@example.test");
    expect(registration?.groupBilling).toBeNull();
    expect(registration?.churchBilling?.billed).toBe(true);
  });
});
