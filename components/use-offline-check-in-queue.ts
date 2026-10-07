"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  checkInQueueItemAfterOfflineRetry,
  offlineCheckInErrorCodeSchema,
  offlineCheckInStorageKey,
  inspectOfflineCheckInQueue,
  offlineCheckInErrorMessage,
  queueItemForCheckIn,
  updateQueuedCheckIn,
  type OfflineCheckInErrorCode,
  type OfflineCheckInQueueItem,
} from "@/modules/checkin/domain";
import { alreadyCheckedInMessage } from "@/modules/checkin/live-changes";

/**
 * A check-in request that has not answered by now is abandoned and kept in the
 * saved queue, then retried with the same key (#825). Long enough for a weak
 * cellular link, short enough that staff are not left staring at a spinner.
 */
export const CHECK_IN_REQUEST_TIMEOUT_MS = 12_000;
/** How often saved, unconfirmed check-ins retry on their own while online. */
export const CHECK_IN_AUTO_RETRY_MS = 20_000;

export type CheckInActionResult = {
  status: "CONFIRMED" | "QUEUED" | "CONFLICT";
  message: string;
  checkedInAt?: string;
};

type CheckInResponse = {
  checkedIn?: boolean;
  disposition?: "CREATED" | "IDEMPOTENT_REPLAY" | "ALREADY_CHECKED_IN";
  checkedInBy?: string | null;
  checkIn?: {
    checkedInAt?: string;
    undoneAt?: string | null;
  };
  error?: string;
  message?: string;
};

function responseErrorCode(
  response: Response,
  payload: CheckInResponse | null,
): OfflineCheckInErrorCode {
  if (response.status === 401 || response.status === 403) {
    return "AUTHORIZATION_REQUIRED";
  }
  if (
    response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500
  ) {
    return "SERVER_UNAVAILABLE";
  }
  const parsed = offlineCheckInErrorCodeSchema.safeParse(payload?.error);
  return parsed.success ? parsed.data : "REQUEST_REJECTED";
}

export function useOfflineCheckInQueue({
  eventId,
  onConfirmed,
}: {
  eventId: string;
  onConfirmed: (attendeeId: string, checkedInAt: string) => void;
}) {
  const storageKey = useMemo(
    () => offlineCheckInStorageKey(eventId),
    [eventId],
  );
  const [queue, setQueue] = useState<OfflineCheckInQueueItem[]>([]);
  const queueRef = useRef<OfflineCheckInQueueItem[]>([]);
  const [connectionState, setConnectionState] = useState<
    "CHECKING" | "ONLINE" | "OFFLINE"
  >("CHECKING");
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [unreadableItemCount, setUnreadableItemCount] = useState(0);
  const unreadableItemCountRef = useRef(0);
  const storageReadBlockedRef = useRef(false);
  const [processingKeys, setProcessingKeys] = useState<string[]>([]);
  const processingRef = useRef(new Set<string>());
  const onConfirmedRef = useRef(onConfirmed);
  const retryQueuedRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    onConfirmedRef.current = onConfirmed;
  }, [onConfirmed]);

  const commitQueue = useCallback((
    next: OfflineCheckInQueueItem[],
  ) => {
    if (
      storageReadBlockedRef.current
      || unreadableItemCountRef.current > 0
    ) {
      setStorageError(
        unreadableItemCountRef.current > 0
          ? "Unreadable saved queue data is still protected. Discard that data explicitly before saving another action."
          : "Browser storage is unavailable. Nothing new can be queued until storage access is restored and the page is reloaded.",
      );
      return false;
    }
    try {
      if (next.length > 0) {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } else {
        window.localStorage.removeItem(storageKey);
      }
      queueRef.current = next;
      setQueue(next);
      setStorageError("");
      return true;
    } catch {
      setStorageError(
        "This browser could not save the offline queue. Keep the page open, reconnect, and try again.",
      );
      return false;
    }
  }, [storageKey]);

  const upsertQueueItem = useCallback((
    item: OfflineCheckInQueueItem,
  ) => {
    const next = [
      ...queueRef.current.filter(
        (entry) => entry.idempotencyKey !== item.idempotencyKey,
      ),
      item,
    ].sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
    return commitQueue(next);
  }, [commitQueue]);

  const discardQueueItem = useCallback((idempotencyKey: string) => (
    commitQueue(
      queueRef.current.filter(
        (item) => item.idempotencyKey !== idempotencyKey,
      ),
    )
  ), [commitQueue]);

  const submitQueueItem = useCallback(async (
    item: OfflineCheckInQueueItem,
  ): Promise<CheckInActionResult> => {
    if (
      storageReadBlockedRef.current
      || unreadableItemCountRef.current > 0
    ) {
      return {
        status: "CONFLICT",
        message: "Resolve the saved-queue storage warning before retrying. No saved action was changed.",
      };
    }
    if (processingRef.current.has(item.idempotencyKey)) {
      return {
        status: "QUEUED",
        message: "This saved check-in is already being retried.",
      };
    }
    if (!navigator.onLine) {
      setConnectionState("OFFLINE");
      if (item.state === "CONFLICT") {
        return {
          status: "CONFLICT",
          message: offlineCheckInErrorMessage(item.lastErrorCode),
        };
      }
      upsertQueueItem(checkInQueueItemAfterOfflineRetry(item));
      return {
        status: "QUEUED",
        message: "Saved on this device. It is queued, not confirmed.",
      };
    }

    processingRef.current.add(item.idempotencyKey);
    setProcessingKeys(Array.from(processingRef.current));
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(item.attendeeId)}/check-in`,
        {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: item.idempotencyKey,
          }),
          signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
            ? AbortSignal.timeout(CHECK_IN_REQUEST_TIMEOUT_MS)
            : undefined,
        },
      );
      const payload = await response.json().catch(() => null) as
        CheckInResponse | null;

      if (
        response.ok
        && payload?.checkedIn === true
        && payload.checkIn?.checkedInAt
      ) {
        discardQueueItem(item.idempotencyKey);
        onConfirmedRef.current(
          item.attendeeId,
          payload.checkIn.checkedInAt,
        );
        return {
          status: "CONFIRMED",
          checkedInAt: payload.checkIn.checkedInAt,
          message: payload.disposition === "IDEMPOTENT_REPLAY"
            ? "The server confirmed this saved check-in."
            : payload.disposition === "ALREADY_CHECKED_IN"
              ? alreadyCheckedInMessage(payload.checkIn.checkedInAt, payload.checkedInBy)
              : "Check-in confirmed by the server.",
        };
      }

      if (response.ok && payload?.checkedIn === false) {
        upsertQueueItem(updateQueuedCheckIn(item, {
          state: "CONFLICT",
          lastErrorCode: "CHECK_IN_OPERATION_REVERSED",
        }));
        return {
          status: "CONFLICT",
          message: "This exact check-in was later undone and needs staff review.",
        };
      }

      const errorCode = responseErrorCode(response, payload);
      // A 401 means the staff session ended (idle sign-out), not that the
      // check-in is wrong: keep it queued so it retries on its own once staff
      // sign back in (#825). A 403 is a real refusal and still needs review.
      const retryLater = errorCode === "SERVER_UNAVAILABLE"
        || (errorCode === "AUTHORIZATION_REQUIRED" && response.status === 401);
      upsertQueueItem(updateQueuedCheckIn(item, {
        state: retryLater ? "QUEUED" : "CONFLICT",
        lastErrorCode: errorCode,
      }));
      return {
        status: retryLater ? "QUEUED" : "CONFLICT",
        message: retryLater
          ? "Not confirmed. It stays saved on this device and retries on its own; tap Retry to try now."
          : payload?.message ?? "This saved check-in needs staff review.",
      };
    } catch {
      setConnectionState(navigator.onLine ? "ONLINE" : "OFFLINE");
      upsertQueueItem(updateQueuedCheckIn(item, {
        state: "QUEUED",
        lastErrorCode: "NETWORK_UNAVAILABLE",
      }));
      return {
        status: "QUEUED",
        message: "Not saved on the server yet. It stays on this device and retries on its own; tap Retry to try now.",
      };
    } finally {
      processingRef.current.delete(item.idempotencyKey);
      setProcessingKeys(Array.from(processingRef.current));
    }
  }, [discardQueueItem, eventId, upsertQueueItem]);

  const requestCheckIn = useCallback(async (
    attendeeId: string,
  ): Promise<CheckInActionResult> => {
    const existing = queueRef.current.find(
      (item) => item.attendeeId === attendeeId,
    );
    if (existing) return submitQueueItem(existing);

    const item = queueItemForCheckIn(
      attendeeId,
      crypto.randomUUID(),
    );
    if (!upsertQueueItem(item)) {
      return {
        status: "CONFLICT",
        message: "This browser could not save the action. Nothing was queued.",
      };
    }
    if (!navigator.onLine) {
      setConnectionState("OFFLINE");
      return {
        status: "QUEUED",
        message: "Saved on this device. It is queued, not confirmed.",
      };
    }
    return submitQueueItem(item);
  }, [submitQueueItem, upsertQueueItem]);

  const retryQueueItem = useCallback(async (
    idempotencyKey: string,
  ) => {
    const item = queueRef.current.find(
      (entry) => entry.idempotencyKey === idempotencyKey,
    );
    if (!item) {
      return {
        status: "CONFLICT" as const,
        message: "This saved check-in is no longer in the queue.",
      };
    }
    return submitQueueItem(item);
  }, [submitQueueItem]);

  const retryAll = useCallback(async (includeConflicts = true) => {
    const items = queueRef.current.filter(
      (item) => includeConflicts || item.state === "QUEUED",
    );
    for (const item of items) {
      await submitQueueItem(item);
    }
  }, [submitQueueItem]);

  const discardUnreadableItems = useCallback(() => {
    if (unreadableItemCountRef.current < 1) return false;
    try {
      if (queueRef.current.length > 0) {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify(queueRef.current),
        );
      } else {
        window.localStorage.removeItem(storageKey);
      }
      unreadableItemCountRef.current = 0;
      setUnreadableItemCount(0);
      setStorageError("");
      return true;
    } catch {
      storageReadBlockedRef.current = true;
      setStorageError(
        "Browser storage is unavailable. The unreadable saved data was not discarded.",
      );
      return false;
    }
  }, [storageKey]);

  useEffect(() => {
    retryQueuedRef.current = () => retryAll(false);
  }, [retryAll]);

  // A weak cellular link keeps `navigator.onLine` true, so the browser never
  // announces "back online". Saved check-ins that have not been confirmed
  // therefore retry on a timer, with the same keys, until the server answers.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden" || !navigator.onLine) return;
      if (processingRef.current.size > 0) return;
      if (!queueRef.current.some((item) => item.state === "QUEUED")) return;
      void retryQueuedRef.current();
    }, CHECK_IN_AUTO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let saved: OfflineCheckInQueueItem[] = [];
    let invalidItemCount = 0;
    // Saved before this change, or by an older build: an item that failed only
    // because the session had ended is retried automatically after sign-in.
    const requeueSignedOut = (items: OfflineCheckInQueueItem[]) => items.map((item) => (
      item.state === "CONFLICT" && item.lastErrorCode === "AUTHORIZATION_REQUIRED"
        ? { ...item, state: "QUEUED" as const }
        : item
    ));
    let storageReadFailed = false;
    try {
      const inspection = inspectOfflineCheckInQueue(
        window.localStorage.getItem(storageKey),
      );
      saved = requeueSignedOut(inspection.items);
      invalidItemCount = inspection.invalidItemCount;
    } catch {
      storageReadFailed = true;
    }
    const online = navigator.onLine;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      queueRef.current = saved;
      unreadableItemCountRef.current = invalidItemCount;
      storageReadBlockedRef.current = storageReadFailed;
      setQueue(saved);
      setUnreadableItemCount(invalidItemCount);
      if (storageReadFailed) {
        setStorageError(
          "Browser storage is unavailable. Existing saved actions were left untouched, and nothing new will be queued.",
        );
      } else if (invalidItemCount > 0) {
        setStorageError(
          `${invalidItemCount} saved queue ${invalidItemCount === 1 ? "item is" : "items are"} unreadable. The data was left untouched; discard it explicitly before continuing.`,
        );
      }
      setConnectionState(online ? "ONLINE" : "OFFLINE");
      setReady(true);
      if (online && saved.some((item) => item.state === "QUEUED")) {
        void retryQueuedRef.current();
      }
    });

    const handleOnline = () => {
      setConnectionState("ONLINE");
      void retryQueuedRef.current();
    };
    const handleOffline = () => setConnectionState("OFFLINE");
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      const inspection = inspectOfflineCheckInQueue(event.newValue);
      queueRef.current = inspection.items;
      unreadableItemCountRef.current = inspection.invalidItemCount;
      storageReadBlockedRef.current = false;
      setQueue(inspection.items);
      setUnreadableItemCount(inspection.invalidItemCount);
      setStorageError(inspection.invalidItemCount > 0
        ? `${inspection.invalidItemCount} saved queue ${inspection.invalidItemCount === 1 ? "item is" : "items are"} unreadable. The data was left untouched; discard it explicitly before continuing.`
        : "");
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
    };
  }, [storageKey]);

  return {
    queue,
    connectionState,
    ready,
    storageError,
    unreadableItemCount,
    processingKeys,
    requestCheckIn,
    retryQueueItem,
    retryAll,
    discardQueueItem,
    discardUnreadableItems,
  };
}
