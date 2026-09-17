/**
 * The regression this guards: re-running a WR26 import after staff corrected
 * a payment's status (or method/received date) in the app must not clobber
 * that correction back to whatever the sheet still says. Once a payment
 * exists for a registration, the importer may create new payments but must
 * never update an existing one's financial fields.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  importRunFindFirst: vi.fn(),
  importRunUpdateMany: vi.fn(),
  importRunUpdate: vi.fn(),
  registrationFindFirst: vi.fn(),
  registrationFindUnique: vi.fn(),
  registrationUpdate: vi.fn(),
  registrationAttendeeUpdate: vi.fn(),
  personUpdate: vi.fn(),
  paymentFindFirst: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentCreate: vi.fn(),
  importRecordUpdate: vi.fn(),
  registrationAggregate: vi.fn(),
  attendeeCount: vi.fn(),
  auditLogCreate: vi.fn(),
}));

const existingRegistrationId = "reg_1";
const existingAttendeeId = "att_1";
const existingPersonId = "per_1";
const existingPaymentId = "pay_existing";

const normalizedData = {
  sourceId: "wr26:reg-1",
  confirmationCode: "WR26-1",
  firstName: "Caleb",
  lastName: "Durant",
  email: "cdurant@imsda.org",
  phone: "",
  attendeeType: "ATTENDEE" as const,
  status: "CONFIRMED" as const,
  totalAmountCents: 25000,
  submittedAt: "2026-06-04T14:53:07.000Z",
  payment: {
    sourceId: "wr26:pay-1",
    amountCents: 25000,
    status: "PENDING" as const,
    method: "MANUAL" as const,
    externalReference: "wr26:pay-1",
    receivedAt: null,
  },
};

const importRun = {
  id: "imp_1",
  eventId: "evt_1",
  sourceSystem: "WR26_GOOGLE_SHEETS_BUNDLE",
  sourceRunKey: "run_1",
  fileName: "wr26-bundle.csv",
  sourceChecksum: "checksum",
  status: "PENDING",
  recordsCreated: 0,
  recordsUpdated: 0,
  recordsSkipped: 0,
  warnings: 0,
  errors: 0,
  summary: {},
  startedAt: new Date(),
  completedAt: null,
  startedBy: { displayName: "Caleb Durant" },
  records: [
    {
      id: "rec_1",
      sourceRow: 1,
      sourceRecordKey: normalizedData.sourceId,
      confirmationCode: normalizedData.confirmationCode,
      status: "READY",
      proposedAction: "UPDATE",
      matchedPersonId: existingPersonId,
      matchedRegistrationId: existingRegistrationId,
      committedEntityId: null,
      rawSnapshot: {},
      normalizedData,
      differences: [],
      warnings: [],
      errors: [],
    },
  ],
};

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    importRun: {
      findFirst: mocks.importRunFindFirst,
    },
    $transaction: async (callback: (tx: unknown) => Promise<void>) => {
      const tx = {
        importRun: { updateMany: mocks.importRunUpdateMany, update: mocks.importRunUpdate },
        registration: {
          findFirst: mocks.registrationFindFirst,
          findUnique: mocks.registrationFindUnique,
          update: mocks.registrationUpdate,
          aggregate: mocks.registrationAggregate,
        },
        registrationAttendee: { update: mocks.registrationAttendeeUpdate, count: mocks.attendeeCount },
        person: { update: mocks.personUpdate },
        payment: { findFirst: mocks.paymentFindFirst, update: mocks.paymentUpdate, create: mocks.paymentCreate },
        importRecord: { update: mocks.importRecordUpdate },
        auditLog: { create: mocks.auditLogCreate },
      };
      return callback(tx);
    },
  }),
}));

import { commitImportRun } from "@/modules/imports/repository";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.importRunFindFirst.mockResolvedValue(importRun);
  mocks.importRunUpdateMany.mockResolvedValue({ count: 1 });
  mocks.registrationFindFirst.mockResolvedValue({
    id: existingRegistrationId,
    accountHolderPersonId: existingPersonId,
    attendees: [{ id: existingAttendeeId }],
  });
  mocks.registrationFindUnique.mockResolvedValue({
    id: existingRegistrationId,
    accountHolderPersonId: existingPersonId,
    contactSnapshot: {},
    accountHolderPerson: { id: existingPersonId, firstName: "Caleb", lastName: "Durant", normalizedEmail: normalizedData.email, phone: null },
    attendees: [{ id: existingAttendeeId, personId: existingPersonId, profileSnapshot: { sourceId: normalizedData.sourceId } }],
    publicFormSubmission: null,
  });
  mocks.registrationUpdate.mockResolvedValue({});
  mocks.registrationAttendeeUpdate.mockResolvedValue({ id: existingAttendeeId, sourceId: normalizedData.sourceId });
  mocks.personUpdate.mockResolvedValue({});
  mocks.paymentFindFirst.mockResolvedValue({
    id: existingPaymentId,
    status: "SUCCEEDED",
    method: "CARD_REFERENCE",
    amount: "250.00",
    receivedAt: new Date("2026-06-05T00:00:00.000Z"),
  });
  mocks.registrationAggregate.mockResolvedValue({ _count: 1, _sum: { totalAmount: "250.00" } });
  mocks.attendeeCount.mockResolvedValue(1);
  mocks.importRecordUpdate.mockResolvedValue({});
  mocks.importRunUpdate.mockResolvedValue({});
  mocks.auditLogCreate.mockResolvedValue({});
});

describe("commitImportRun payment preservation", () => {
  it("never updates a payment that already exists, even though the sheet's status differs", async () => {
    await commitImportRun("evt_1", "imp_1", "usr_1");

    expect(mocks.paymentFindFirst).toHaveBeenCalled();
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });

  it("still creates a payment for a registration that has none yet", async () => {
    mocks.paymentFindFirst.mockResolvedValue(null);
    mocks.paymentCreate.mockResolvedValue({ id: "pay_new" });

    await commitImportRun("evt_1", "imp_1", "usr_1");

    expect(mocks.paymentCreate).toHaveBeenCalledTimes(1);
    expect(mocks.paymentUpdate).not.toHaveBeenCalled();
  });
});
