import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { ChurchAmountsOwed } from "@/components/church-amounts-owed";
import { churchAmountsOwedCsvRows, individualOwedRows, summarizeChurchAmountsOwed } from "@/modules/club-registrations/church-owed";
import { listChurchAmountsOwed } from "@/modules/club-registrations/repository";

beforeEach(() => {
  vi.clearAllMocks();
});

function registration(
  confirmationCode: string,
  status: string,
  total: string,
  attendees: number,
) {
  return { confirmationCode, status, totalAmount: { toString: () => total }, _count: { attendees } };
}

const churchRows = [
  {
    organization: { id: "org-z", name: "Zion Pathfinders", parentOrganization: { id: "church-z", name: "Zion SDA Church" } },
    registration: registration("REG-Z1", "SUBMITTED", "63", 5),
  },
  {
    organization: { id: "org-a", name: "Ankeny Son-Seekers", parentOrganization: { id: "church-a", name: "Ankeny SDA Church" } },
    registration: registration("REG-A1", "CONFIRMED", "13", 2),
  },
  {
    organization: { id: "org-a2", name: "Ankeny Adventurers", parentOrganization: { id: "church-a", name: "Ankeny SDA Church" } },
    registration: registration("REG-A2", "SUBMITTED", "9", 1),
  },
  {
    organization: { id: "org-w", name: "Waiting Warriors", parentOrganization: { id: "church-z", name: "Zion SDA Church" } },
    registration: registration("REG-W1", "WAITLISTED", "45", 5),
  },
  {
    organization: { id: "org-c", name: "Cancelled Comets", parentOrganization: { id: "church-a", name: "Ankeny SDA Church" } },
    registration: registration("REG-C1", "CANCELLED", "27", 3),
  },
  {
    organization: { id: "org-n", name: "Orphan Explorers", parentOrganization: null },
    registration: registration("REG-N1", "SUBMITTED", "18", 2),
  },
];

describe("what each church owes (#409)", () => {
  it("still shows staff the total each church owes, unchanged by the registrant per-person view (#621)", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue(churchRows) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB" }) },
      registration: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const owed = await listChurchAmountsOwed("event-1");
    expect(owed.find((row) => row.confirmationCode === "REG-Z1")).toMatchObject({ isBilled: true, amountOwedCents: 6300 });
    expect(owed.find((row) => row.confirmationCode === "REG-A1")).toMatchObject({ isBilled: true, amountOwedCents: 1300 });
  });

  it("lists each club with its church, billing only submitted and confirmed registrations", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue(churchRows) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB" }) },
      registration: { findMany: vi.fn().mockResolvedValue([]) },
    });

    const owed = await listChurchAmountsOwed("event-1");

    // Billed clubs first, grouped by church name, a club with no church last;
    // then the waitlisted and cancelled clubs.
    expect(owed.map((row) => row.confirmationCode)).toEqual([
      "REG-A2", "REG-A1", "REG-Z1", "REG-N1", "REG-C1", "REG-W1",
    ]);
    expect(owed.find((row) => row.confirmationCode === "REG-A1")).toMatchObject({
      organizationName: "Ankeny Son-Seekers",
      churchName: "Ankeny SDA Church",
      status: "CONFIRMED",
      attendeeCount: 2,
      isBilled: true,
      amountOwedCents: 1300,
    });
    // A waitlisted or cancelled club is listed but owes nothing.
    expect(owed.find((row) => row.confirmationCode === "REG-W1")).toMatchObject({ isBilled: false, amountOwedCents: 0 });
    expect(owed.find((row) => row.confirmationCode === "REG-C1")).toMatchObject({ isBilled: false, amountOwedCents: 0 });

    const summary = summarizeChurchAmountsOwed(owed);
    expect(summary).toMatchObject({
      billedClubCount: 4,
      churchCount: 2,
      notBilledCount: 2,
      // 63 + 13 + 9 + 18, never the waitlisted $45 or cancelled $27.
      totalOwedCents: 10300,
    });
    expect(summary.churches).toEqual([
      { churchKey: "church-a", churchName: "Ankeny SDA Church", clubCount: 2, amountOwedCents: 2200 },
      { churchKey: "church-z", churchName: "Zion SDA Church", clubCount: 1, amountOwedCents: 6300 },
      { churchKey: "none", churchName: "No sponsoring church on file", clubCount: 1, amountOwedCents: 1800 },
    ]);
  });

  it("shows the estimate per church and lists waitlisted and cancelled clubs separately at $0", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue(churchRows) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB" }) },
      registration: { findMany: vi.fn().mockResolvedValue([]) },
    });
    const markup = renderToStaticMarkup(ChurchAmountsOwed({
      eventId: "event-1",
      isDeferredOrganizationBilling: true,
      rows: await listChurchAmountsOwed("event-1"),
    }));

    expect(markup).toContain("Estimated amount owed");
    expect(markup).toContain("billed to the church after the event, not paid online");
    expect(markup).toContain("Clubs billed");
    expect(markup).toContain("Churches billed");
    expect(markup).toContain("$103.00");
    expect(markup).toContain("Ankeny SDA Church");
    expect(markup).toContain("$22.00");
    expect(markup).toContain("Waitlisted or cancelled club");
    expect(markup).toContain("No amount owed while waitlisted");
    expect(markup).toContain("Cancelled — nothing owed");
    expect(markup).not.toContain("$45.00");
    expect(markup).not.toContain("$27.00");
  });

  it("returns nothing for an event with no church-billed registrations", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB" }) },
      registration: { findMany: vi.fn().mockResolvedValue([]) },
    });
    expect(await listChurchAmountsOwed("event-1")).toEqual([]);
  });
});

/**
 * Church-billed events with no club registrations (#606): Leadership Weekend (individuals, church billed)
 * and Outdoor School (a school billed). Synthetic data only.
 */
function individual(id: string, code: string, status: string, total: string, people: number, first: string, responses: Record<string, unknown>, amended?: Record<string, unknown>) {
  return {
    id, confirmationCode: code, status, totalAmount: { toString: () => total }, location: null,
    accountHolderPerson: { firstName: first, lastName: "Sample" }, publicFormSubmission: { responses }, _count: { attendees: people },
    operations: amended ? [{ afterSnapshot: { registrationResponses: amended } }] : [],
  };
}

describe("what each church or organization owes on an event with no club registrations (#606)", () => {
  const registrations = [
    individual("r1", "LW-1", "CONFIRMED", "35", 1, "Sam", { church_name: "Sample Hills SDA Church", pathfinder_club: "Sample Trail Pathfinders" }),
    individual("r2", "LW-2", "SUBMITTED", "45", 1, "Pat", { church_name: "Sample Hills SDA Church" }),
    individual("r3", "LW-3", "SUBMITTED", "25", 1, "Robin", { church_name: "Not listed", church_name_other: "Sample Fellowship" }),
    individual("r4", "LW-4", "CANCELLED", "35", 1, "Lee", { church_name: "Sample Hills SDA Church" }),
    individual("r5", "OS-1", "CONFIRMED", "300", 20, "Dana", { responsible_organization: "Sample Elementary School", contact_name: "Dana Sample" }),
    individual("r6", "LW-5", "WAITLISTED", "35", 1, "Kim", {}),
  ];

  function mockEvent(billingMode: string, audience = "GENERAL") {
    const registrationFindMany = vi.fn().mockResolvedValue(registrations);
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode, audience }) },
      registration: { findMany: registrationFindMany },
    });
    return registrationFindMany;
  }

  it("groups active registrations by the church or school the form names, with statuses and amounts", async () => {
    const findMany = mockEvent("DEFERRED_ORGANIZATION_INVOICE");
    const owed = await listChurchAmountsOwed("event-1");
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ eventId: "event-1", clubRegistration: null });
    expect(owed.every((row) => row.kind === "INDIVIDUAL")).toBe(true);
    expect(owed.find((row) => row.confirmationCode === "LW-1")).toMatchObject({ organizationName: "Sam Sample", churchName: "Sample Hills SDA Church", attendeeCount: 1, amountOwedCents: 3500, isBilled: true, status: "CONFIRMED" });
    // A "Not listed" church is the text typed beside it; the school is the school name.
    expect(owed.find((row) => row.confirmationCode === "LW-3")!.churchName).toBe("Sample Fellowship");
    expect(owed.find((row) => row.confirmationCode === "OS-1")).toMatchObject({ churchName: "Sample Elementary School", attendeeCount: 20, amountOwedCents: 30000 });
    // A cancelled or waitlisted registration is listed at $0; one naming no organization has none on file.
    expect(owed.find((row) => row.confirmationCode === "LW-4")).toMatchObject({ isBilled: false, amountOwedCents: 0 });
    expect(owed.find((row) => row.confirmationCode === "LW-5")).toMatchObject({ churchName: null, isBilled: false, amountOwedCents: 0 });
    const summary = summarizeChurchAmountsOwed(owed);
    expect(summary).toMatchObject({ billedClubCount: 4, churchCount: 3, notBilledCount: 2, totalOwedCents: 3500 + 4500 + 2500 + 30000 });
    expect(summary.churches.map((church) => [church.churchName, church.clubCount, church.amountOwedCents])).toEqual([
      ["Sample Elementary School", 1, 30000],
      ["Sample Fellowship", 1, 2500],
      ["Sample Hills SDA Church", 2, 8000],
    ]);
  });

  it("groups the same organization typed with different capitalization or spacing", () => {
    const rows = individualOwedRows([
      { id: "a", confirmationCode: "A", status: "CONFIRMED", totalAmountCents: 1000, attendeeCount: 1, registrantName: "A B", responses: { church_name_other: "Sample  Fellowship" } },
      { id: "b", confirmationCode: "B", status: "CONFIRMED", totalAmountCents: 2000, attendeeCount: 1, registrantName: "C D", responses: { church_name_other: "sample fellowship " } },
    ]);
    expect(summarizeChurchAmountsOwed(rows).churches).toHaveLength(1);
    expect(summarizeChurchAmountsOwed(rows).churches[0]!.amountOwedCents).toBe(3000);
  });

  it("exports them in the CSV under a Church or organization column", async () => {
    mockEvent("DEFERRED_ORGANIZATION_INVOICE");
    const table = churchAmountsOwedCsvRows(await listChurchAmountsOwed("event-1"));
    expect(table[0]!.slice(0, 2)).toEqual(["Church or organization", "Club or registrant"]);
    const lw1 = table.find((row) => row[2] === "LW-1")!;
    expect(lw1).toEqual(["Sample Hills SDA Church", "Sam Sample", "LW-1", "CONFIRMED", "Yes", 1, "35.00", "80.00", "Billed to the church after the event, not paid online"]);
    expect(table.find((row) => row[2] === "OS-1")).toEqual(["Sample Elementary School", "Dana Sample", "OS-1", "CONFIRMED", "Yes", 20, "300.00", "300.00", "Billed to the church after the event, not paid online"]);
    expect(table.find((row) => row[2] === "LW-4")!.slice(4, 8)).toEqual(["No", 1, "0.00", ""]);
  });

  it("shows them on the page with registration wording", async () => {
    mockEvent("DEFERRED_ORGANIZATION_INVOICE");
    const markup = renderToStaticMarkup(ChurchAmountsOwed({ eventId: "event-1", isDeferredOrganizationBilling: true, rows: await listChurchAmountsOwed("event-1") }));
    expect(markup).toContain("Church or organization");
    expect(markup).toContain("Registrations billed");
    expect(markup).toContain("Sample Elementary School");
    expect(markup).toContain("$405.00");
    expect(markup).not.toContain("Clubs billed");
  });

  it("bills the church an amendment changed it to, not the one first submitted", async () => {
    const amended = [
      individual("r1", "LW-1", "CONFIRMED", "35", 1, "Sam", { church_name: "Church A" }, { church_name: "Church B" }),
      individual("r2", "LW-2", "CONFIRMED", "45", 1, "Pat", { church_name: "Church A" }),
    ];
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue([]) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "GENERAL" }) },
      registration: { findMany: vi.fn().mockResolvedValue(amended) },
    });
    const owed = await listChurchAmountsOwed("event-1");
    expect(owed.find((row) => row.confirmationCode === "LW-1")!.churchName).toBe("Church B");
    expect(summarizeChurchAmountsOwed(owed).churches.map((church) => [church.churchName, church.amountOwedCents])).toEqual([["Church A", 4500], ["Church B", 3500]]);
  });

  it("leaves a CLUB event exactly as it was: club rows only, no relabeled columns, whatever else is registered", async () => {
    const clubRows = [{
      organization: { id: "org-a", name: "Ankeny Son-Seekers", parentOrganization: { id: "church-a", name: "Ankeny SDA Church" } },
      registration: registration("REG-A1", "CONFIRMED", "13", 2),
    }];
    const findMany = mockEvent("DEFERRED_ORGANIZATION_INVOICE", "CLUB");
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue(clubRows) },
      event: { findUnique: vi.fn().mockResolvedValue({ billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB" }) },
      // A single-person registration and a TLT Opportunities sign-up on the same CLUB event.
      registration: { findMany: findMany.mockResolvedValue([
        individual("r1", "IND-1", "CONFIRMED", "10", 1, "Sam", { church_name: "Ankeny SDA Church" }),
        individual("r2", "TLT-1", "CONFIRMED", "0", 1, "Jo", { club_name: "Sample Creek Pathfinders" }),
      ]) },
    });
    const owed = await listChurchAmountsOwed("event-1");
    expect(findMany).not.toHaveBeenCalled();
    expect(owed.map((row) => row.confirmationCode)).toEqual(["REG-A1"]);
    expect(owed.some((row) => row.kind)).toBe(false);
    const summary = summarizeChurchAmountsOwed(owed);
    expect(summary.churches.map((church) => [church.churchName, church.clubCount, church.amountOwedCents])).toEqual([["Ankeny SDA Church", 1, 1300]]);
    const table = churchAmountsOwedCsvRows(owed);
    expect(table[0]!.slice(0, 2)).toEqual(["Church", "Club"]);
    expect(table).toHaveLength(2);
    const markup = renderToStaticMarkup(ChurchAmountsOwed({ eventId: "event-1", isDeferredOrganizationBilling: true, rows: owed }));
    expect(markup).toContain("Clubs billed");
    expect(markup).not.toContain("Registrations billed");
  });

  it("reads nothing extra for an attendee-pay event, and keeps the club export columns", async () => {
    const findMany = mockEvent("ATTENDEE_PAY");
    expect(await listChurchAmountsOwed("event-1")).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
    const clubTable = churchAmountsOwedCsvRows([{ organizationId: "o", organizationName: "Club", churchId: "c", churchName: "Church", confirmationCode: "C-1", status: "CONFIRMED", attendeeCount: 3, isBilled: true, amountOwedCents: 900 }]);
    expect(clubTable[0]!.slice(0, 2)).toEqual(["Church", "Club"]);
  });
});
