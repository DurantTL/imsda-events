import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  getPrisma: vi.fn(),
  getServerEnv: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ getPrisma: dependencies.getPrisma }));
vi.mock("@/lib/env", () => ({ getServerEnv: dependencies.getServerEnv }));
vi.mock("@/lib/logger", () => ({
  logError: dependencies.logError,
  logWarn: dependencies.logWarn,
  logInfo: dependencies.logInfo,
}));
vi.mock("@/lib/request-context", () => ({ currentCorrelationId: () => "corr-1" }));

import {
  dispatchAlerts,
  dispatchUnsuppressedAlert,
  isAlertDue,
  resolveAlertsExcept,
  type Alert,
} from "@/modules/operations/alerting";
import {
  ALERT_WINDOW_MINUTES,
  assessSystemSignals,
  type SystemAlertSignals,
} from "@/modules/operations/alert-scan";

const now = new Date("2026-07-24T12:00:00.000Z");

const urgent: Alert = {
  key: "system.outbox.backed-up",
  severity: "URGENT",
  summary: "Email delivery is falling behind",
  detail: "31 messages are due and undelivered",
};

function prismaFixture(existing: Record<string, unknown> | null = null) {
  const upserts: Array<Record<string, unknown>> = [];
  const prisma = {
    alertNotification: {
      findUnique: vi.fn(async () => existing),
      upsert: vi.fn(async (query: Record<string, unknown>) => {
        upserts.push(query);
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: 2 })),
    },
  };
  dependencies.getPrisma.mockReturnValue(prisma);
  return { prisma, upserts };
}

function okFetch() {
  return vi.fn(async () => new Response("ok", { status: 200 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  dependencies.getServerEnv.mockReturnValue({
    ALERT_WEBHOOK_URL: "https://hooks.test/imsda",
    ALERT_REPEAT_MINUTES: 60,
  });
});

describe("the repeat window", () => {
  it("sends a condition that has never been reported", () => {
    expect(isAlertDue(null, now, 60)).toBe(true);
  });

  it("stays quiet until the window passes", () => {
    expect(isAlertDue(new Date(now.getTime() - 59 * 60_000), now, 60)).toBe(false);
    expect(isAlertDue(new Date(now.getTime() - 60 * 60_000), now, 60)).toBe(true);
  });
});

describe("dispatching", () => {
  it("posts an alert and records that it was sent", async () => {
    const { upserts } = prismaFixture(null);
    const fetchImpl = okFetch();

    const result = await dispatchAlerts([urgent], { now, fetchImpl });

    expect(result.sent).toEqual([urgent]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://hooks.test/imsda");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      severity: "URGENT",
      key: "system.outbox.backed-up",
      correlationId: "corr-1",
    });
    // Slack and Teams render `text`; everything else can read the fields.
    expect(body.text).toContain("[URGENT] IMSDA Events: Email delivery is falling behind");
    expect(upserts).toHaveLength(1);
  });

  it("suppresses a condition it has already reported this hour", async () => {
    const { prisma } = prismaFixture({
      id: "alert-1",
      lastSentAt: new Date(now.getTime() - 10 * 60_000),
      resolvedAt: null,
    });
    const fetchImpl = okFetch();

    const result = await dispatchAlerts([urgent], { now, fetchImpl });

    expect(result.suppressed).toEqual([urgent]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(prisma.alertNotification.upsert).not.toHaveBeenCalled();
  });

  it("treats a resolved condition as new again", async () => {
    prismaFixture({
      id: "alert-1",
      lastSentAt: new Date(now.getTime() - 60_000),
      resolvedAt: new Date(now.getTime() - 30_000),
    });
    const fetchImpl = okFetch();

    expect((await dispatchAlerts([urgent], { now, fetchImpl })).sent).toEqual([urgent]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not record a page it failed to deliver", async () => {
    const { prisma } = prismaFixture(null);
    const fetchImpl = vi.fn(async () => { throw new TypeError("unreachable"); });

    const result = await dispatchAlerts([urgent], { now, fetchImpl });

    // Recording it would let a dropped page mute the next hour.
    expect(result.undelivered).toEqual([urgent]);
    expect(result.sent).toEqual([]);
    expect(prisma.alertNotification.upsert).not.toHaveBeenCalled();
    expect(dependencies.logWarn).toHaveBeenCalled();
  });

  it("still logs, and counts as sent, with no webhook configured", async () => {
    dependencies.getServerEnv.mockReturnValue({
      ALERT_WEBHOOK_URL: undefined,
      ALERT_REPEAT_MINUTES: 60,
    });
    const { upserts } = prismaFixture(null);

    const result = await dispatchAlerts([urgent], { now });

    // Nothing to deliver to, but the log line is what an aggregator matches on.
    expect(result.sent).toEqual([urgent]);
    expect(dependencies.logError).toHaveBeenCalledWith(
      "ALERT Email delivery is falling behind",
      expect.anything(),
      expect.objectContaining({ alertKey: "system.outbox.backed-up", severity: "URGENT" }),
    );
    expect(upserts).toHaveLength(1);
  });

  it("logs a watch-level alert as a warning rather than an error", async () => {
    prismaFixture(null);

    await dispatchAlerts([{ ...urgent, severity: "WATCH" }], { now, fetchImpl: okFetch() });

    expect(dependencies.logWarn).toHaveBeenCalled();
    expect(dependencies.logError).not.toHaveBeenCalled();
  });

  it("pages without suppression when there is no database to record it in", async () => {
    const fetchImpl = okFetch();

    await dispatchUnsuppressedAlert({
      key: "system.database.unavailable",
      severity: "URGENT",
      summary: "The database is unreachable",
    }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(dependencies.getPrisma).not.toHaveBeenCalled();
  });

  it("clears conditions that are no longer true", async () => {
    const { prisma } = prismaFixture(null);

    expect(await resolveAlertsExcept(["system.payments.failed"], "system.", now)).toBe(2);
    expect(prisma.alertNotification.updateMany).toHaveBeenCalledWith({
      where: {
        key: { startsWith: "system.", notIn: ["system.payments.failed"] },
        resolvedAt: null,
      },
      data: { resolvedAt: now },
    });
  });
});

describe("what counts as an alert", () => {
  const quiet: SystemAlertSignals = {
    outbox: {
      pending: 1,
      due: 0,
      processing: 0,
      failed: 0,
      oldestDueAgeMs: null,
      eventsWithDueMessages: 0,
      accountMessagesDue: 0,
    },
    failedMessages: 0,
    failedPayments: 0,
    stuckPayments: 0,
    oldestStuckPaymentMinutes: null,
  };

  it("says nothing when everything is draining", () => {
    expect(assessSystemSignals(quiet)).toEqual([]);
  });

  it("pages when the queue is backed up", () => {
    const alerts = assessSystemSignals({
      ...quiet,
      outbox: { ...quiet.outbox, due: 40, oldestDueAgeMs: 45 * 60_000 },
    });

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: "system.outbox.backed-up",
      severity: "URGENT",
    });
    expect(alerts[0].detail).toContain("due and undelivered");
  });

  it("pages on the first message that gives up entirely", () => {
    const alerts = assessSystemSignals({ ...quiet, failedMessages: 1 });

    expect(alerts[0]).toMatchObject({ key: "system.outbox.messages-failed" });
    expect(alerts[0].summary).toContain("1 message gave up");
    expect(alerts[0].context).toMatchObject({ windowMinutes: ALERT_WINDOW_MINUTES });
  });

  it("pages on a failed card payment", () => {
    const alerts = assessSystemSignals({ ...quiet, failedPayments: 2 });
    expect(alerts[0]).toMatchObject({ key: "system.payments.failed", severity: "URGENT" });
    expect(alerts[0].summary).toContain("2 card payments failed");
  });

  it("pages when a payment never reaches a result, which is the missing webhook", () => {
    const alerts = assessSystemSignals({
      ...quiet,
      stuckPayments: 1,
      oldestStuckPaymentMinutes: 40,
    });

    expect(alerts[0]).toMatchObject({ key: "system.payments.stuck" });
    expect(alerts[0].detail).toContain("webhook is not arriving");
    expect(alerts[0].context).toMatchObject({ oldestStuckMinutes: 40 });
  });

  it("reports every condition that is true, not just the first", () => {
    const alerts = assessSystemSignals({
      ...quiet,
      outbox: { ...quiet.outbox, due: 40 },
      failedMessages: 3,
      failedPayments: 1,
      stuckPayments: 1,
      oldestStuckPaymentMinutes: 20,
    });

    expect(alerts.map((alert) => alert.key)).toEqual([
      "system.outbox.backed-up",
      "system.outbox.messages-failed",
      "system.payments.failed",
      "system.payments.stuck",
    ]);
  });
});
