import "server-only";

import { getServerEnv } from "@/lib/env";
import { getPrisma } from "@/lib/prisma";
import { logError, logInfo, logWarn } from "@/lib/logger";
import { currentCorrelationId } from "@/lib/request-context";

/**
 * Something that watches the signals.
 *
 * The review's line was "a failed payment webhook still pages nobody": the
 * health endpoint, the outbox depth, and the payment attempt state were all
 * observable, and nothing looked at any of them. This dispatches an alert when
 * a condition is true, and — the part that decides whether alerting survives
 * contact with an operator — keeps quiet about a condition it has already
 * reported until the repeat window passes.
 *
 * Every alert is also written to the log at its severity, so a deployment with
 * no webhook configured still leaves a trail an aggregator can match on.
 */

export type AlertSeverity = "URGENT" | "WATCH";

export type Alert = {
  /**
   * Identifies the *condition*, not the occurrence: two runs that find the same
   * problem must produce the same key, or suppression cannot work.
   */
  key: string;
  severity: AlertSeverity;
  summary: string;
  detail?: string;
  context?: Record<string, string | number | boolean | null>;
};

export type AlertDispatchResult = {
  sent: Alert[];
  suppressed: Alert[];
  /** Delivery failed; the condition is still recorded as outstanding. */
  undelivered: Alert[];
};

const WEBHOOK_TIMEOUT_MS = 5000;

export function isAlertDeliveryConfigured() {
  return Boolean(getServerEnv().ALERT_WEBHOOK_URL);
}

/** Pure: whether this condition is due to be reported again. */
export function isAlertDue(
  lastSentAt: Date | null,
  now: Date,
  repeatMinutes: number,
): boolean {
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= repeatMinutes * 60 * 1000;
}

async function postToWebhook(
  alert: Alert,
  options: { fetchImpl?: typeof fetch } = {},
) {
  const url = getServerEnv().ALERT_WEBHOOK_URL;
  if (!url) return { delivered: false, attempted: false };

  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        // `text` is what Slack and Teams incoming webhooks render; the
        // structured fields are for anything else reading the same payload.
        text: `[${alert.severity}] IMSDA Events: ${alert.summary}${alert.detail ? ` — ${alert.detail}` : ""}`,
        severity: alert.severity,
        key: alert.key,
        summary: alert.summary,
        detail: alert.detail ?? null,
        context: alert.context ?? {},
        correlationId: currentCorrelationId() ?? null,
        sentAt: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) {
      logWarn("An alert could not be delivered to the configured webhook.", {
        alertKey: alert.key,
        status: response.status,
      });
      return { delivered: false, attempted: true };
    }
    return { delivered: true, attempted: true };
  } catch (error) {
    logWarn("The alert webhook could not be reached.", {
      alertKey: alert.key,
      error: error instanceof Error ? error.name : typeof error,
    });
    return { delivered: false, attempted: true };
  }
}

function record(alert: Alert) {
  const fields = {
    alertKey: alert.key,
    severity: alert.severity,
    ...(alert.detail ? { detail: alert.detail } : {}),
    ...alert.context,
  };
  if (alert.severity === "URGENT") {
    // Logged through logError so it lands on stderr with the request's
    // correlation id, without an error object to redact.
    logError(`ALERT ${alert.summary}`, new AlertConditionError(alert.detail ?? alert.summary), fields);
  } else {
    logWarn(`ALERT ${alert.summary}`, fields);
  }
}

/** Carries the operator-facing text into the logger's redaction allowance. */
export class AlertConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlertConditionError";
  }
}

/**
 * Sends what is due and records it. A condition whose delivery failed is left
 * un-recorded so the next run tries again rather than treating a dropped page
 * as a delivered one.
 */
export async function dispatchAlerts(
  alerts: readonly Alert[],
  options: { now?: Date; fetchImpl?: typeof fetch; repeatMinutes?: number } = {},
): Promise<AlertDispatchResult> {
  const now = options.now ?? new Date();
  const repeatMinutes = options.repeatMinutes ?? getServerEnv().ALERT_REPEAT_MINUTES;
  const result: AlertDispatchResult = { sent: [], suppressed: [], undelivered: [] };

  for (const alert of alerts) {
    const existing = await getPrisma().alertNotification.findUnique({
      where: { key: alert.key },
      select: { id: true, lastSentAt: true, resolvedAt: true },
    });
    // A condition that had been resolved is new again.
    const lastSentAt = existing?.resolvedAt ? null : existing?.lastSentAt ?? null;
    if (!isAlertDue(lastSentAt, now, repeatMinutes)) {
      result.suppressed.push(alert);
      continue;
    }

    record(alert);
    const delivery = await postToWebhook(alert, { fetchImpl: options.fetchImpl });
    if (delivery.attempted && !delivery.delivered) {
      result.undelivered.push(alert);
      continue;
    }

    await getPrisma().alertNotification.upsert({
      where: { key: alert.key },
      update: {
        severity: alert.severity,
        summary: alert.summary,
        lastSentAt: now,
        sendCount: { increment: 1 },
        resolvedAt: null,
      },
      create: {
        key: alert.key,
        severity: alert.severity,
        summary: alert.summary,
        firstSeenAt: now,
        lastSentAt: now,
      },
    });
    result.sent.push(alert);
  }

  return result;
}

/**
 * Marks conditions that are no longer true as resolved, so the next occurrence
 * pages immediately instead of waiting out a repeat window that started while
 * the problem was still present.
 */
export async function resolveAlertsExcept(
  activeKeys: readonly string[],
  keyPrefix: string,
  now = new Date(),
) {
  const resolved = await getPrisma().alertNotification.updateMany({
    where: {
      key: { startsWith: keyPrefix, notIn: [...activeKeys] },
      resolvedAt: null,
    },
    data: { resolvedAt: now },
  });
  if (resolved.count > 0) {
    logInfo("Alert conditions cleared.", { cleared: resolved.count, keyPrefix });
  }
  return resolved.count;
}

/**
 * Pages about a condition with no database behind it — the database itself
 * being unreachable, most obviously. There is nowhere to record suppression, so
 * this always attempts delivery.
 */
export async function dispatchUnsuppressedAlert(
  alert: Alert,
  options: { fetchImpl?: typeof fetch } = {},
) {
  record(alert);
  return postToWebhook(alert, options);
}
