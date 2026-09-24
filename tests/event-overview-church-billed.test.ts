import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({ getPrisma: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));

import { getEventOverview } from "@/modules/events/repository";

function prismaFor(billingMode: "ATTENDEE_PAY" | "DEFERRED_ORGANIZATION_INVOICE") {
  return {
    event: {
      findUnique: vi.fn().mockResolvedValue({
        id: "event-1",
        slug: "camporee",
        name: "Synthetic Camporee",
        startsAt: new Date("2027-04-09T21:00:00.000Z"),
        endsAt: new Date("2027-04-11T17:00:00.000Z"),
        timezone: "America/Chicago",
        location: null,
        capacity: null,
        isPublished: true,
        registrationOpensOn: null,
        registrationClosesOn: null,
        waitlistEnabled: false,
        collectsShirtSizes: false,
        checksAdultBackgrounds: false,
        autoPromoteWaitlist: false,
        billingMode,
      }),
    },
    registration: {
      findMany: vi.fn().mockResolvedValue([
        { totalAmount: "63.00", payments: [] },
        { totalAmount: "13.00", payments: [] },
      ]),
    },
    registrationAttendee: { count: vi.fn().mockResolvedValue(7) },
    checkIn: { count: vi.fn().mockResolvedValue(0) },
    registrationWaitlistEntry: { count: vi.fn().mockResolvedValue(0) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("event overview metrics (#409)", () => {
  it("counts a church-billed event's totals as billed to churches, not pending payment", async () => {
    dependencies.getPrisma.mockReturnValue(prismaFor("DEFERRED_ORGANIZATION_INVOICE"));
    const overview = await getEventOverview("event-1");
    expect(overview?.metrics).toMatchObject({
      isDeferredOrganizationBilling: true,
      pendingPaymentCount: 0,
      outstandingCents: 0,
      churchBilledCents: 7_600,
    });
  });

  it("keeps attendee-pay balances as pending payment", async () => {
    dependencies.getPrisma.mockReturnValue(prismaFor("ATTENDEE_PAY"));
    const overview = await getEventOverview("event-1");
    expect(overview?.metrics).toMatchObject({
      isDeferredOrganizationBilling: false,
      pendingPaymentCount: 2,
      outstandingCents: 7_600,
      churchBilledCents: 0,
    });
  });
});
