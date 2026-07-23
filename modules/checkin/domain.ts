import { z } from "zod";

export const checkInRequestSchema = z.strictObject({
  idempotencyKey: z.uuid(),
});

export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

export const offlineCheckInErrorCodeSchema = z.enum([
  "NETWORK_UNAVAILABLE",
  "SERVER_UNAVAILABLE",
  "AUTHORIZATION_REQUIRED",
  "ATTENDEE_NOT_FOUND",
  "REGISTRATION_NOT_ELIGIBLE",
  "IDEMPOTENCY_KEY_REUSED",
  "CHECK_IN_OPERATION_REVERSED",
  "CHECK_IN_OPERATION_CONFLICT",
  "REQUEST_REJECTED",
]);

export type OfflineCheckInErrorCode =
  z.infer<typeof offlineCheckInErrorCodeSchema>;

export const offlineCheckInQueueItemSchema = z.strictObject({
  operation: z.literal("CHECK_IN"),
  attendeeId: z.string().trim().min(1).max(128),
  idempotencyKey: z.uuid(),
  queuedAt: z.iso.datetime({ offset: true }),
  attempts: z.number().int().nonnegative().max(10_000),
  state: z.enum(["QUEUED", "CONFLICT"]),
  lastErrorCode: offlineCheckInErrorCodeSchema,
});

export type OfflineCheckInQueueItem =
  z.infer<typeof offlineCheckInQueueItemSchema>;

export function offlineCheckInStorageKey(eventId: string) {
  return `imsda-events:check-in-queue:v1:${eventId}`;
}

export function inspectOfflineCheckInQueue(value: string | null): {
  items: OfflineCheckInQueueItem[];
  invalidItemCount: number;
} {
  if (!value) return { items: [], invalidItemCount: 0 };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return { items: [], invalidItemCount: 1 };
    }
    const items: OfflineCheckInQueueItem[] = [];
    let invalidItemCount = 0;
    for (const item of parsed) {
      const result = offlineCheckInQueueItemSchema.safeParse(item);
      if (result.success) {
        items.push(result.data);
      } else {
        invalidItemCount += 1;
      }
    }
    return { items, invalidItemCount };
  } catch {
    return { items: [], invalidItemCount: 1 };
  }
}

export function parseOfflineCheckInQueue(value: string | null) {
  return inspectOfflineCheckInQueue(value).items;
}

export function queueItemForCheckIn(
  attendeeId: string,
  idempotencyKey: string,
  now = new Date(),
): OfflineCheckInQueueItem {
  return offlineCheckInQueueItemSchema.parse({
    operation: "CHECK_IN",
    attendeeId,
    idempotencyKey,
    queuedAt: now.toISOString(),
    attempts: 0,
    state: "QUEUED",
    lastErrorCode: "NETWORK_UNAVAILABLE",
  });
}

export function updateQueuedCheckIn(
  item: OfflineCheckInQueueItem,
  input: {
    state: OfflineCheckInQueueItem["state"];
    lastErrorCode: OfflineCheckInErrorCode;
  },
): OfflineCheckInQueueItem {
  return {
    ...item,
    attempts: item.attempts + 1,
    state: input.state,
    lastErrorCode: input.lastErrorCode,
  };
}

export function checkInQueueItemAfterOfflineRetry(
  item: OfflineCheckInQueueItem,
) {
  return item.state === "CONFLICT"
    ? item
    : updateQueuedCheckIn(item, {
        state: "QUEUED",
        lastErrorCode: "NETWORK_UNAVAILABLE",
      });
}

export function offlineCheckInErrorMessage(code: OfflineCheckInErrorCode) {
  switch (code) {
    case "NETWORK_UNAVAILABLE":
      return "Waiting for a connection. This attendee is not confirmed yet.";
    case "SERVER_UNAVAILABLE":
      return "The server did not answer. Keep this item and retry when the connection is stable.";
    case "AUTHORIZATION_REQUIRED":
      return "Your staff session needs attention. Sign in again, then retry this item.";
    case "ATTENDEE_NOT_FOUND":
      return "This attendee is no longer available in the selected event. Verify the event before retrying or discarding.";
    case "REGISTRATION_NOT_ELIGIBLE":
      return "This registration is cancelled, waitlisted, or otherwise not eligible. Resolve the registration before retrying.";
    case "IDEMPOTENCY_KEY_REUSED":
      return "This saved retry key conflicts with another attendee. Discard it and start a new check-in.";
    case "CHECK_IN_OPERATION_REVERSED":
      return "This exact check-in was later undone. Discard it before starting a new check-in.";
    case "CHECK_IN_OPERATION_CONFLICT":
      return "Another staff action changed this attendee at the same time. Retry to load the final result.";
    case "REQUEST_REJECTED":
      return "The server rejected this saved action. Verify the attendee and retry, or discard it.";
  }
}
