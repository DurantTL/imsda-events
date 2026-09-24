import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { ChurchAmountsOwed } from "@/components/church-amounts-owed";
import { summarizeChurchAmountsOwed } from "@/modules/club-registrations/church-owed";
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
  it("lists each club with its church, billing only submitted and confirmed registrations", async () => {
    dependencies.getPrisma.mockReturnValue({
      clubEventRegistration: { findMany: vi.fn().mockResolvedValue(churchRows) },
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
    });
    expect(await listChurchAmountsOwed("event-1")).toEqual([]);
  });
});
