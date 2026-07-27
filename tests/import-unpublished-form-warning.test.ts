/**
 * The regression this guards: an import that carries attendee answers into an
 * event with no published form version succeeds, reports no problem, and
 * silently discards every meal, shirt size, and ranked seminar choice. It cost
 * a real Women's Retreat migration weeks before anyone noticed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  importRunFindUnique: vi.fn(),
  registrationFindMany: vi.fn(),
  personFindMany: vi.fn(),
  formVersionFindFirst: vi.fn(),
  importRunCreate: vi.fn(),
  registrationAggregate: vi.fn(),
  paymentAggregate: vi.fn(),
  attendeeCount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    importRun: { findUnique: mocks.importRunFindUnique, create: mocks.importRunCreate },
    registration: { findMany: mocks.registrationFindMany, aggregate: mocks.registrationAggregate },
    person: { findMany: mocks.personFindMany },
    registrationFormVersion: { findFirst: mocks.formVersionFindFirst },
    payment: { aggregate: mocks.paymentAggregate },
    registrationAttendee: { count: mocks.attendeeCount },
  }),
}));

import { previewWr26BundleImport } from "@/modules/imports/repository";

const registrationsCsv = [
  "Registration ID,Timestamp,First Name,Last Name,Email,Final Amount,Status",
  "WR26-1780602786558-7AC3,2026-06-04T14:53:07Z,Caleb,Durant,cdurant@imsda.org,250.00,active",
].join("\n");

const attendeesCsv = [
  "Attendee ID,Registration ID,First Name,Last Name,Meal Preference",
  "A-3857-1,WR26-1780602786558-7AC3,Caleb,Durant,regular",
  "A-3857-2,WR26-1780602786558-7AC3,Cashmere,Durant,vegetarian",
].join("\n");

const bundle = [
  { name: "Registrations.csv", text: registrationsCsv },
  { name: "Attendees.csv", text: attendeesCsv },
];

const WARNING = /no published registration form version/i;

function capturedWarnings() {
  const call = mocks.importRunCreate.mock.calls[0]?.[0];
  const records = call?.data?.records?.create ?? [];
  return records.flatMap((record: { warnings?: string[] }) => record.warnings ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.importRunFindUnique.mockResolvedValue(null);
  mocks.registrationFindMany.mockResolvedValue([]);
  mocks.personFindMany.mockResolvedValue([]);
  mocks.registrationAggregate.mockResolvedValue({ _sum: { totalAmount: null }, _count: 0 });
  mocks.paymentAggregate.mockResolvedValue({ _sum: { amount: null } });
  mocks.attendeeCount.mockResolvedValue(0);
  mocks.importRunCreate.mockImplementation(async () => ({
    id: "imp_1",
    records: [],
    event: { id: "evt_wr26" },
  }));
});

describe("WR26 bundle preview with no published form version", () => {
  it("warns that attendee answers will not be viewable", async () => {
    mocks.formVersionFindFirst.mockResolvedValue(null);

    await previewWr26BundleImport("evt_wr26", "usr_1", bundle).catch(() => undefined);

    expect(capturedWarnings().some((warning: string) => WARNING.test(warning))).toBe(true);
  });

  it("stays quiet once a published form version exists", async () => {
    mocks.formVersionFindFirst.mockResolvedValue({ id: "frmver_8" });

    await previewWr26BundleImport("evt_wr26", "usr_1", bundle).catch(() => undefined);

    // Guard against a vacuous pass: the run must actually have been built.
    expect(mocks.importRunCreate).toHaveBeenCalled();
    expect(capturedWarnings().some((warning: string) => WARNING.test(warning))).toBe(false);
  });

  it("carries the warning once, not once per registration", async () => {
    mocks.formVersionFindFirst.mockResolvedValue(null);
    const manyRegistrations = [
      "Registration ID,Timestamp,First Name,Last Name,Email,Final Amount,Status",
      "WR26-1780602786558-7AC3,2026-06-04T14:53:07Z,Caleb,Durant,cdurant@imsda.org,250.00,active",
      "WR26-1780554485714-0225,2026-06-04T01:28:06Z,Elisabeth,Cowan,ec@example.org,125.00,active",
    ].join("\n");
    const manyAttendees = [
      "Attendee ID,Registration ID,First Name,Last Name,Meal Preference",
      "A-3857-1,WR26-1780602786558-7AC3,Caleb,Durant,regular",
      "A-3853-1,WR26-1780554485714-0225,Elisabeth,Cowan,vegetarian",
    ].join("\n");

    await previewWr26BundleImport("evt_wr26", "usr_1", [
      { name: "Registrations.csv", text: manyRegistrations },
      { name: "Attendees.csv", text: manyAttendees },
    ]).catch(() => undefined);

    expect(capturedWarnings().filter((warning: string) => WARNING.test(warning))).toHaveLength(1);
  });
});
