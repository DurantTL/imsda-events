import { describe, expect, it } from "vitest";
import {
  canAccessOperationalHealth,
  operationalHealthAccessFor,
  type OperationalHealthAccess,
} from "@/modules/operations/access";
import {
  buildOperationalHealth,
  type OperationalHealthSource,
} from "@/modules/operations/operational-health";

const now = new Date("2026-09-01T18:00:00.000Z");
const fullAccess: OperationalHealthAccess = {
  finance: true,
  communications: true,
  imports: true,
  capacity: true,
};

function source(
  overrides: Partial<OperationalHealthSource> = {},
): OperationalHealthSource {
  return {
    paymentAttempts: [],
    messages: [],
    importRuns: [],
    registrations: [],
    eventCapacity: null,
    forms: [],
    capacityUsage: [],
    ...overrides,
  };
}

function registration(
  overrides: Partial<OperationalHealthSource["registrations"][number]> = {},
): OperationalHealthSource["registrations"][number] {
  return {
    id: "registration-one",
    confirmationCode: "REG-ONE",
    status: "SUBMITTED",
    totalAmountCents: 10_000,
    submittedAt: new Date("2026-08-01T15:00:00.000Z"),
    createdAt: new Date("2026-08-01T15:00:00.000Z"),
    payments: [],
    ...overrides,
  };
}

function paymentAttempt(
  overrides: Partial<OperationalHealthSource["paymentAttempts"][number]> = {},
): OperationalHealthSource["paymentAttempts"][number] {
  return {
    id: "attempt-one",
    registrationId: "registration-one",
    confirmationCode: "REG-ONE",
    status: "FAILED",
    amountCents: 10_000,
    failureCode: "CARD_DECLINED",
    createdAt: new Date("2026-09-01T17:00:00.000Z"),
    updatedAt: new Date("2026-09-01T17:00:00.000Z"),
    ...overrides,
  };
}

describe("operational health access", () => {
  it("opens only the event areas the staff member can resolve", () => {
    expect(canAccessOperationalHealth(["VIEW_EVENT"])).toBe(false);
    expect(canAccessOperationalHealth(["VIEW_EVENT", "MANAGE_COMMUNICATIONS"])).toBe(true);
    expect(operationalHealthAccessFor([
      "VIEW_EVENT",
      "MANAGE_COMMUNICATIONS",
    ])).toEqual({
      finance: false,
      communications: true,
      imports: false,
      capacity: false,
    });
    expect(operationalHealthAccessFor([
      "VIEW_EVENT",
      "MANAGE_REGISTRATION",
    ]).capacity).toBe(true);
  });
});

describe("operational health aggregation", () => {
  it("reports only the newest failed or stuck attempt for an unpaid active registration", () => {
    const report = buildOperationalHealth(source({
      registrations: [
        registration(),
        registration({
          id: "registration-two",
          confirmationCode: "REG-TWO",
          totalAmountCents: 5_000,
        }),
        registration({
          id: "registration-paid",
          confirmationCode: "REG-PAID",
          totalAmountCents: 2_500,
          payments: [{ amountCents: 2_500, refunds: [] }],
        }),
      ],
      paymentAttempts: [
        paymentAttempt(),
        paymentAttempt({
          id: "attempt-new-retry",
          status: "PROCESSING",
          failureCode: null,
          updatedAt: new Date("2026-09-01T17:55:00.000Z"),
        }),
        paymentAttempt({
          id: "attempt-stuck",
          registrationId: "registration-two",
          confirmationCode: "REG-TWO",
          status: "PENDING",
          amountCents: 5_000,
          failureCode: null,
          updatedAt: new Date("2026-09-01T17:40:00.000Z"),
        }),
        paymentAttempt({
          id: "attempt-paid",
          registrationId: "registration-paid",
          confirmationCode: "REG-PAID",
        }),
      ],
    }), fullAccess, now);

    expect(report.paymentAttempts).toEqual([
      expect.objectContaining({
        id: "attempt-stuck",
        kind: "STUCK",
        severity: "WATCH",
        ageMinutes: 20,
      }),
    ]);
    expect(report.balances.map((entry) => entry.confirmationCode)).toEqual([
      "REG-ONE",
      "REG-TWO",
    ]);
  });

  it("calculates balance due from successful net payments and refunds", () => {
    const report = buildOperationalHealth(source({
      registrations: [
        registration({
          totalAmountCents: 15_000,
          payments: [
            { amountCents: 10_000, refunds: [{ amountCents: 2_000 }] },
            { amountCents: 3_000, refunds: [] },
          ],
        }),
        registration({
          id: "registration-cancelled",
          confirmationCode: "REG-CANCELLED",
          status: "CANCELLED",
        }),
      ],
    }), fullAccess, now);

    expect(report.balances).toEqual([
      expect.objectContaining({
        paidCents: 11_000,
        balanceCents: 4_000,
      }),
    ]);
  });

  it("finds unretried delivery failures and overdue pending messages", () => {
    const common = {
      registrationId: "registration-one",
      confirmationCode: "REG-ONE",
      templateKey: "PAYMENT_RECEIPT",
      attemptCount: 1,
      createdAt: new Date("2026-09-01T17:00:00.000Z"),
      updatedAt: new Date("2026-09-01T17:00:00.000Z"),
      availableAt: new Date("2026-09-01T17:00:00.000Z"),
      providerDeliveryStatus: null,
      hasRetry: false,
    };
    const report = buildOperationalHealth(source({
      messages: [
        {
          ...common,
          id: "message-bounced",
          status: "SENT",
          providerDeliveryStatus: "BOUNCED",
        },
        {
          ...common,
          id: "message-retried",
          status: "FAILED",
          hasRetry: true,
        },
        {
          ...common,
          id: "message-overdue",
          status: "PENDING",
          availableAt: new Date("2026-09-01T17:44:00.000Z"),
          updatedAt: new Date("2026-09-01T17:44:00.000Z"),
        },
        {
          ...common,
          id: "message-not-overdue",
          status: "PENDING",
          availableAt: new Date("2026-09-01T17:46:00.000Z"),
          updatedAt: new Date("2026-09-01T17:46:00.000Z"),
        },
      ],
    }), fullAccess, now);

    expect(report.messages.map((message) => [message.id, message.kind])).toEqual([
      ["message-bounced", "BOUNCED"],
      ["message-overdue", "OVERDUE"],
    ]);
  });

  it("keeps only unfinished import previews with unresolved warnings or errors", () => {
    const report = buildOperationalHealth(source({
      importRuns: [
        {
          id: "import-errors",
          fileName: "errors.csv",
          status: "PENDING",
          warnings: 0,
          errors: 0,
          startedAt: new Date("2026-09-01T17:00:00.000Z"),
          records: [{ status: "ERROR" }],
        },
        {
          id: "import-warnings",
          fileName: "warnings.csv",
          status: "PENDING",
          warnings: 2,
          errors: 0,
          startedAt: new Date("2026-09-01T16:00:00.000Z"),
          records: [],
        },
        {
          id: "import-complete",
          fileName: "complete.csv",
          status: "COMPLETED",
          warnings: 9,
          errors: 0,
          startedAt: new Date("2026-09-01T15:00:00.000Z"),
          records: [{ status: "WARNING" }],
        },
      ],
    }), fullAccess, now);

    expect(report.imports).toEqual([
      expect.objectContaining({
        id: "import-errors",
        errors: 1,
        severity: "URGENT",
      }),
      expect.objectContaining({
        id: "import-warnings",
        warnings: 2,
        severity: "WATCH",
      }),
    ]);
  });

  it("flags event and explicit choice limits while ignoring unlimited and ranked interest", () => {
    const definition = {
      title: "Capacity form",
      description: "",
      confirmationMessage: "Registration received.",
      sections: [{
        id: "section_capacity",
        title: "Capacity choices",
        description: "",
        fields: [
          {
            id: "field_room",
            key: "room",
            label: "Room choice",
            helpText: "",
            type: "RADIO",
            scope: "REGISTRATION",
            required: true,
            options: ["Cabin", "Commuting"],
            availabilityMode: "CAPACITY",
            choiceLimits: { Cabin: 2 },
          },
          {
            id: "field_ranked",
            key: "seminar",
            label: "Seminar ranking",
            helpText: "",
            type: "RANKED_CHOICE",
            scope: "REGISTRATION",
            required: false,
            options: ["One", "Two"],
            availabilityMode: "RANKED_INTEREST",
            choiceLimits: { One: 1 },
          },
          {
            id: "field_unlimited",
            key: "meal",
            label: "Meal",
            helpText: "",
            type: "SELECT",
            scope: "REGISTRATION",
            required: false,
            options: ["Yes", "No"],
            availabilityMode: "CAPACITY",
          },
        ],
      }],
    };
    const report = buildOperationalHealth(source({
      eventCapacity: { capacity: 10, occupied: 9 },
      forms: [{
        id: "form-one",
        name: "Capacity form",
        versionId: "version-one",
        definition,
      }],
      capacityUsage: [
        {
          formId: "form-one",
          fieldId: "field_room",
          optionValue: "Cabin",
          used: 2,
        },
        {
          formId: "form-one",
          fieldId: "field_ranked",
          optionValue: "One",
          used: 1,
        },
      ],
    }), fullAccess, now);

    expect(report.capacity).toEqual([
      expect.objectContaining({
        kind: "CHOICE",
        label: "Cabin",
        severity: "URGENT",
        remaining: 0,
      }),
      expect.objectContaining({
        kind: "EVENT",
        severity: "WATCH",
        remaining: 1,
      }),
    ]);
  });

  it("does not return data from an area outside the supplied access scope", () => {
    const report = buildOperationalHealth(source({
      registrations: [registration()],
      paymentAttempts: [paymentAttempt()],
    }), {
      finance: false,
      communications: false,
      imports: false,
      capacity: false,
    }, now);

    expect(report.summary.total).toBe(0);
    expect(report.paymentAttempts).toEqual([]);
    expect(report.balances).toEqual([]);
  });
});
