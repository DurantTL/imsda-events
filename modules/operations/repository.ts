import "server-only";

import { getPrisma } from "@/lib/prisma";
import type { OperationalHealthAccess } from "@/modules/operations/access";
import {
  buildOperationalHealth,
  type OperationalHealthSource,
} from "@/modules/operations/operational-health";

function moneyToCents(value: { toString(): string } | number) {
  return Math.round(Number(value) * 100);
}

async function loadFinanceSource(eventId: string) {
  const prisma = getPrisma();
  const [attempts, registrations] = await Promise.all([
    prisma.paymentAttempt.findMany({
      where: {
        eventId,
        provider: "SQUARE",
        registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        registrationId: true,
        status: true,
        amountCents: true,
        failureCode: true,
        createdAt: true,
        updatedAt: true,
        registration: { select: { confirmationCode: true } },
      },
    }),
    prisma.registration.findMany({
      where: {
        eventId,
        status: { in: ["SUBMITTED", "CONFIRMED"] },
      },
      orderBy: { submittedAt: "asc" },
      select: {
        id: true,
        confirmationCode: true,
        status: true,
        totalAmount: true,
        submittedAt: true,
        createdAt: true,
        payments: {
          where: { status: "SUCCEEDED" },
          select: {
            amount: true,
            refunds: {
              where: { status: "SUCCEEDED" },
              select: { amount: true },
            },
          },
        },
      },
    }),
  ]);
  return {
    paymentAttempts: attempts.map((attempt) => ({
      id: attempt.id,
      registrationId: attempt.registrationId,
      confirmationCode: attempt.registration.confirmationCode,
      status: attempt.status,
      amountCents: attempt.amountCents,
      failureCode: attempt.failureCode,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt,
    })),
    registrations: registrations.map((registration) => ({
      id: registration.id,
      confirmationCode: registration.confirmationCode,
      status: registration.status,
      totalAmountCents: moneyToCents(registration.totalAmount),
      submittedAt: registration.submittedAt,
      createdAt: registration.createdAt,
      payments: registration.payments.map((payment) => ({
        amountCents: moneyToCents(payment.amount),
        refunds: payment.refunds.map((refund) => ({
          amountCents: moneyToCents(refund.amount),
        })),
      })),
    })),
  };
}

async function loadMessageSource(eventId: string) {
  const messages = await getPrisma().messageOutbox.findMany({
    where: {
      eventId,
      OR: [
        { status: { in: ["FAILED", "PENDING"] } },
        { providerDeliveryStatus: { in: ["BOUNCED", "COMPLAINED", "FAILED"] } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      registrationId: true,
      templateKey: true,
      status: true,
      providerDeliveryStatus: true,
      attemptCount: true,
      availableAt: true,
      createdAt: true,
      updatedAt: true,
      registration: { select: { confirmationCode: true } },
      _count: {
        select: {
          retries: {
            where: {
              status: {
                in: ["FAILED", "PENDING", "PROCESSING", "SENT"],
              },
            },
          },
        },
      },
    },
  });
  return messages.map((message) => ({
    id: message.id,
    registrationId: message.registrationId,
    confirmationCode: message.registration?.confirmationCode ?? null,
    templateKey: message.templateKey,
    status: message.status,
    providerDeliveryStatus: message.providerDeliveryStatus,
    attemptCount: message.attemptCount,
    availableAt: message.availableAt,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    hasRetry: message._count.retries > 0,
  }));
}

async function loadImportSource(eventId: string) {
  const runs = await getPrisma().importRun.findMany({
    where: {
      eventId,
      status: { not: "COMPLETED" },
      OR: [
        { status: "FAILED" },
        { warnings: { gt: 0 } },
        { errors: { gt: 0 } },
        { records: { some: { status: { in: ["ERROR", "WARNING"] } } } },
      ],
    },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      fileName: true,
      status: true,
      warnings: true,
      errors: true,
      startedAt: true,
      records: {
        where: { status: { in: ["ERROR", "WARNING"] } },
        select: { status: true },
      },
    },
  });
  return runs.map((run) => ({
    id: run.id,
    fileName: run.fileName ?? "Imported CSV",
    status: run.status,
    warnings: run.warnings,
    errors: run.errors,
    startedAt: run.startedAt,
    records: run.records,
  }));
}

async function loadCapacitySource(eventId: string) {
  const prisma = getPrisma();
  const [event, occupied, forms, usage] = await Promise.all([
    prisma.event.findUnique({
      where: { id: eventId },
      select: { capacity: true },
    }),
    prisma.registrationAttendee.count({
      where: {
        eventId,
        registration: { status: { in: ["SUBMITTED", "CONFIRMED"] } },
      },
    }),
    prisma.registrationForm.findMany({
      where: { eventId, status: "PUBLISHED" },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        versions: {
          where: { status: "PUBLISHED" },
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { id: true, definition: true },
        },
      },
    }),
    prisma.registrationCapacityReservation.groupBy({
      by: ["formId", "fieldId", "optionValue"],
      where: { eventId, releasedAt: null },
      _count: { _all: true },
    }),
  ]);
  return {
    eventCapacity: event
      ? { capacity: event.capacity, occupied }
      : null,
    forms: forms.flatMap((form) => {
      const version = form.versions[0];
      return version ? [{
        id: form.id,
        name: form.name,
        versionId: version.id,
        definition: version.definition,
      }] : [];
    }),
    capacityUsage: usage.map((entry) => ({
      formId: entry.formId,
      fieldId: entry.fieldId,
      optionValue: entry.optionValue,
      used: entry._count._all,
    })),
  };
}

const emptySource: OperationalHealthSource = {
  paymentAttempts: [],
  messages: [],
  importRuns: [],
  registrations: [],
  eventCapacity: null,
  forms: [],
  capacityUsage: [],
};

export async function getOperationalHealth(
  eventId: string,
  access: OperationalHealthAccess,
  now = new Date(),
) {
  const [finance, messages, imports, capacity] = await Promise.all([
    access.finance
      ? loadFinanceSource(eventId)
      : Promise.resolve({
          paymentAttempts: emptySource.paymentAttempts,
          registrations: emptySource.registrations,
        }),
    access.communications
      ? loadMessageSource(eventId)
      : Promise.resolve(emptySource.messages),
    access.imports
      ? loadImportSource(eventId)
      : Promise.resolve(emptySource.importRuns),
    access.capacity
      ? loadCapacitySource(eventId)
      : Promise.resolve({
          eventCapacity: emptySource.eventCapacity,
          forms: emptySource.forms,
          capacityUsage: emptySource.capacityUsage,
        }),
  ]);

  return buildOperationalHealth({
    paymentAttempts: finance.paymentAttempts,
    registrations: finance.registrations,
    messages,
    importRuns: imports,
    eventCapacity: capacity.eventCapacity,
    forms: capacity.forms,
    capacityUsage: capacity.capacityUsage,
  }, access, now);
}
