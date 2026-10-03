import { z } from "zod";

/**
 * Module requests (#741 slice 3). Pure and client-safe: the limits and the
 * re-request rule live here so the form, the routes and the service agree.
 *
 * Who may ask: an event admin of that event (the `CONFIGURE_EVENT` permission,
 * which only the Event Admin role carries). Other roles, including finance,
 * registration and communications staff, cannot. System administrators do not
 * ask: they turn modules on directly.
 *
 * Re-request rules:
 * - A pending request blocks another for the same event and module (the
 *   database enforces it with a partial unique index).
 * - A declined request does not block: the event admin may ask again.
 * - An approved request means the module is on, so there is nothing to request.
 */

export const MODULE_REQUEST_REASON_MAX = 500;
export const MODULE_REQUEST_DECLINE_REASON_MAX = 500;

export const moduleRequestStatuses = ["PENDING", "APPROVED", "DECLINED"] as const;
export type ModuleRequestStatusValue = (typeof moduleRequestStatuses)[number];

export const moduleRequestSchema = z.object({
  moduleKey: z.string().trim().min(1).max(64),
  reason: z
    .string()
    .trim()
    .min(1, "Tell the conference office why this event needs it.")
    .max(MODULE_REQUEST_REASON_MAX, `Keep the reason under ${MODULE_REQUEST_REASON_MAX} characters.`),
});

export const moduleRequestDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve") }),
  z.object({
    decision: z.literal("decline"),
    declineReason: z
      .string()
      .trim()
      .min(1, "Say why this request is declined.")
      .max(MODULE_REQUEST_DECLINE_REASON_MAX, `Keep the reason under ${MODULE_REQUEST_DECLINE_REASON_MAX} characters.`),
  }),
]);

export type ModuleRequestStatusView = {
  moduleKey: string;
  status: ModuleRequestStatusValue;
  createdAt: Date;
  decidedAt: Date | null;
  declineReason: string | null;
};

/** The request a module's card should show: the newest one for that module. */
export function latestRequestPerModule<T extends { moduleKey: string; createdAt: Date }>(requests: readonly T[]): Map<string, T> {
  const latest = new Map<string, T>();
  for (const request of requests) {
    const current = latest.get(request.moduleKey);
    if (!current || request.createdAt > current.createdAt) latest.set(request.moduleKey, request);
  }
  return latest;
}

/** Whether a new request may be made given the newest one: only a pending request blocks it. */
export function canRequestAgain(latest: { status: ModuleRequestStatusValue } | undefined): boolean {
  return latest?.status !== "PENDING";
}

/** "Oct 3, 2026": a date for the request lists, in UTC so server and browser agree. */
export function formatRequestDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(date);
}
