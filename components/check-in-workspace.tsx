"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Printer,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  UsersRound,
  Wifi,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useMemo,
  useState,
} from "react";
import { CheckInScanner } from "@/components/check-in-scanner";
import { useOfflineCheckInQueue } from "@/components/use-offline-check-in-queue";
import { offlineCheckInErrorMessage } from "@/modules/checkin/domain";
import type { RegistrationRecord } from "@/modules/registrations/repository";

type Arrival = RegistrationRecord["attendees"][number] & {
  confirmationCode: string;
  email: string;
};

export function CheckInWorkspace({
  eventName,
  eventId,
  initialRegistrations,
  canCheckIn,
}: {
  eventName: string;
  eventId: string;
  initialRegistrations: RegistrationRecord[];
  canCheckIn: boolean;
}) {
  const [arrivals, setArrivals] = useState<Arrival[]>(
    initialRegistrations.flatMap((registration) => (
      registration.attendees.map((attendee) => ({
        ...attendee,
        confirmationCode: registration.confirmationCode,
        email: registration.accountHolder.email,
      }))
    )),
  );
  const [query, setQuery] = useState("");
  const [undoPendingId, setUndoPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const applyConfirmedCheckIn = useCallback((
    attendeeId: string,
    checkedInAt: string,
  ) => {
    setArrivals((current) => current.map((item) => (
      item.id === attendeeId
        ? { ...item, checkedIn: true, checkedInAt }
        : item
    )));
    setMessage("A saved check-in was confirmed by the server.");
  }, []);

  const {
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
  } = useOfflineCheckInQueue({
    eventId,
    onConfirmed: applyConfirmedCheckIn,
  });

  const visible = useMemo(() => arrivals.filter((arrival) => (
    `${arrival.firstName} ${arrival.lastName} ${arrival.confirmationCode} ${arrival.email}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )), [arrivals, query]);
  const queueByAttendee = useMemo(() => new Map(
    queue.map((item) => [item.attendeeId, item]),
  ), [queue]);
  const processingKeySet = useMemo(
    () => new Set(processingKeys),
    [processingKeys],
  );
  const checkedIn = arrivals.filter((arrival) => arrival.checkedIn).length;
  const queued = queue.filter((item) => item.state === "QUEUED").length;
  const conflicts = queue.length - queued;
  const online = connectionState === "ONLINE";

  async function toggleCheckIn(arrival: Arrival) {
    if (!canCheckIn) return;
    setMessage("");

    if (!arrival.checkedIn) {
      const result = await requestCheckIn(arrival.id);
      setMessage(
        `${arrival.firstName} ${arrival.lastName}: ${result.message}`,
      );
      return;
    }

    if (!online) {
      setMessage(
        "Undo is not available offline. Reconnect before changing a confirmed check-in.",
      );
      return;
    }

    setUndoPendingId(arrival.id);
    try {
      const response = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/attendees/${encodeURIComponent(arrival.id)}/check-in`,
        {
          method: "DELETE",
          cache: "no-store",
        },
      );
      const result = await response.json().catch(() => null) as {
        message?: string;
      } | null;
      if (!response.ok) {
        throw new Error(
          result?.message ?? "The server could not undo this check-in.",
        );
      }
      setArrivals((current) => current.map((item) => (
        item.id === arrival.id
          ? { ...item, checkedIn: false, checkedInAt: null }
          : item
      )));
      setMessage(
        `Check-in undone for ${arrival.firstName} ${arrival.lastName}.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? `${error.message} Undo was not queued; reconnect and try again.`
          : "Undo was not saved or queued. Reconnect and try again.",
      );
    } finally {
      setUndoPendingId(null);
    }
  }

  function discardSavedItem(idempotencyKey: string, attendeeLabel: string) {
    const confirmed = window.confirm(
      `Discard the saved retry for ${attendeeLabel}? This only removes the retry from this device. It does not undo a server check-in.`,
    );
    if (!confirmed) return;
    if (discardQueueItem(idempotencyKey)) {
      setMessage(`Discarded the saved retry for ${attendeeLabel}.`);
    }
  }

  function discardUnreadableSavedData() {
    const confirmed = window.confirm(
      `Discard ${unreadableItemCount} unreadable saved queue ${unreadableItemCount === 1 ? "item" : "items"}? This cannot undo or change any check-in already received by the server.`,
    );
    if (!confirmed) return;
    if (discardUnreadableItems()) {
      setMessage("Discarded the unreadable saved queue data.");
    }
  }

  function attendeeLabel(attendeeId: string) {
    const attendee = arrivals.find((arrival) => arrival.id === attendeeId);
    return attendee
      ? `${attendee.firstName} ${attendee.lastName}`
      : `Attendee reference …${attendeeId.slice(-6)}`;
  }

  return (
    <section className="page-stack">
      <div className="checkin-hero">
        <div>
          <p className="hero-eyebrow">On-site operations</p>
          <h2>Ready for arrivals</h2>
          <p>
            Search by attendee name, email, or confirmation code and record
            arrivals for {eventName}. Offline check-ins stay clearly queued
            until the server confirms them.
          </p>
          <Link
            className="secondary-button checkin-pass-link"
            href={`/check-in/passes?event=${encodeURIComponent(eventId)}`}
          >
            <Printer aria-hidden="true" size={16} />
            Print attendee passes
          </Link>
        </div>
        <div className="checkin-tallies">
          <span><strong>{checkedIn}</strong><small>Confirmed</small></span>
          <span>
            <strong>{arrivals.length - checkedIn}</strong>
            <small>Not confirmed</small>
          </span>
          <span><strong>{queue.length}</strong><small>Saved locally</small></span>
        </div>
      </div>

      <div
        aria-live="polite"
        className={`check-in-network-status is-${connectionState.toLowerCase()}`}
        role="status"
      >
        {online
          ? <Wifi aria-hidden="true" size={18} />
          : <WifiOff aria-hidden="true" size={18} />}
        <div>
          <strong>
            {connectionState === "CHECKING"
              ? "Checking the connection"
              : online
                ? "Online"
                : "Offline"}
          </strong>
          <span>
            {connectionState === "CHECKING"
              ? "Saved actions will appear here after this page loads."
              : online
                ? queue.length > 0
                  ? "Saved check-ins can now be retried. Queued items retry automatically after reconnection."
                  : "New check-ins are confirmed with the server immediately."
                : "New check-ins are saved only on this device and are not confirmed yet. Undo is unavailable."}
          </span>
        </div>
        {ready && queue.length > 0 && (
          <button
            className="secondary-button"
            disabled={
              !online
              || processingKeys.length > 0
              || unreadableItemCount > 0
            }
            onClick={() => void retryAll(true)}
            type="button"
          >
            <RefreshCw
              aria-hidden="true"
              className={processingKeys.length > 0 ? "is-spinning" : ""}
              size={16}
            />
            Retry all
          </button>
        )}
      </div>

      {storageError && (
        <div className="inline-notice error check-in-storage-warning" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <span>{storageError}</span>
          {unreadableItemCount > 0 && (
            <button
              className="text-button danger-text"
              onClick={discardUnreadableSavedData}
              type="button"
            >
              <Trash2 aria-hidden="true" size={15} />
              Discard unreadable data
            </button>
          )}
        </div>
      )}

      {queue.length > 0 && (
        <section
          aria-labelledby="saved-check-ins-title"
          className="panel check-in-queue-panel"
        >
          <div className="section-heading">
            <div>
              <p className="eyebrow">Saved on this device</p>
              <h2 id="saved-check-ins-title">Check-ins needing confirmation</h2>
              <p>
                These are not counted as checked in until the server confirms
                them. Keep conflicts here until staff resolve or discard them.
              </p>
            </div>
            <span className="count-badge">
              {queued} queued{conflicts > 0 ? ` · ${conflicts} need review` : ""}
            </span>
          </div>
          <div className="check-in-queue-list">
            {queue.map((item) => {
              const label = attendeeLabel(item.attendeeId);
              const processing = processingKeySet.has(item.idempotencyKey);
              return (
                <article
                  className={`check-in-queue-item is-${item.state.toLowerCase()}`}
                  key={item.idempotencyKey}
                >
                  <span aria-hidden="true">
                    {item.state === "CONFLICT"
                      ? <AlertTriangle size={19} />
                      : <RefreshCw size={19} />}
                  </span>
                  <div>
                    <strong>{label}</strong>
                    <small>
                      {item.state === "CONFLICT"
                        ? "Needs staff review"
                        : "Queued — not confirmed"}
                      {" · saved "}
                      {new Date(item.queuedAt).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </small>
                    <p>{offlineCheckInErrorMessage(item.lastErrorCode)}</p>
                  </div>
                  <div className="check-in-queue-actions">
                    <button
                      className="secondary-button"
                      disabled={
                        !online
                        || processing
                        || unreadableItemCount > 0
                      }
                      onClick={() => void retryQueueItem(item.idempotencyKey)}
                      type="button"
                    >
                      <RefreshCw
                        aria-hidden="true"
                        className={processing ? "is-spinning" : ""}
                        size={15}
                      />
                      {processing ? "Retrying…" : "Retry"}
                    </button>
                    <button
                      className="text-button danger-text"
                      disabled={processing}
                      onClick={() => discardSavedItem(
                        item.idempotencyKey,
                        label,
                      )}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={15} />
                      Discard
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      <div className="checkin-tools">
        <CheckInScanner
          conflictAttendeeIds={queue
            .filter((item) => item.state === "CONFLICT")
            .map((item) => item.attendeeId)}
          eventId={eventId}
          onConfirmCheckIn={(attendee) => requestCheckIn(attendee.id)}
          queuedAttendeeIds={queue
            .filter((item) => item.state === "QUEUED")
            .map((item) => item.attendeeId)}
        />
        <label className="search-field panel">
          <Search aria-hidden="true" size={18} />
          <span className="sr-only">Search arrivals</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, email, or confirmation code"
            value={query}
          />
        </label>
      </div>

      {message && (
        <div aria-live="polite" className="inline-notice" role="status">
          {message}
        </div>
      )}

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Arrival roster</p>
            <h2>Expected attendees</h2>
          </div>
          <span className="count-badge">
            <UsersRound aria-hidden="true" size={16} /> {visible.length} shown
          </span>
        </div>
        {visible.map((arrival) => {
          const savedItem = queueByAttendee.get(arrival.id);
          const processing = savedItem
            ? processingKeySet.has(savedItem.idempotencyKey)
            : false;
          return (
            <div className="arrival-row" key={arrival.id}>
              <span className={`person-avatar ${arrival.checkedIn ? "green" : "purple"}`}>
                {arrival.firstName[0]}{arrival.lastName[0]}
              </span>
              <span>
                <strong>{arrival.firstName} {arrival.lastName}</strong>
                <small>
                  {arrival.confirmationCode} ·{" "}
                  {arrival.attendeeType.toLowerCase()}
                </small>
              </span>
              <span className="arrival-time">
                {arrival.checkedInAt
                  ? new Date(arrival.checkedInAt).toLocaleTimeString([], {
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : savedItem?.state === "CONFLICT"
                    ? "Needs review"
                    : savedItem
                      ? "Queued — not confirmed"
                      : "Awaiting arrival"}
              </span>
              <button
                className={arrival.checkedIn ? "undo-button" : ""}
                disabled={
                  !canCheckIn
                  || processing
                  || undoPendingId === arrival.id
                  || (arrival.checkedIn && !online)
                  || (!arrival.checkedIn && unreadableItemCount > 0)
                }
                onClick={() => void toggleCheckIn(arrival)}
                title={arrival.checkedIn && !online
                  ? "Reconnect before undoing a confirmed check-in."
                  : undefined}
                type="button"
              >
                {arrival.checkedIn
                  ? <RotateCcw aria-hidden="true" size={17} />
                  : savedItem?.state === "CONFLICT"
                    ? <AlertTriangle aria-hidden="true" size={17} />
                    : savedItem
                      ? <RefreshCw aria-hidden="true" size={17} />
                      : <CheckCircle2 aria-hidden="true" size={17} />}
                {undoPendingId === arrival.id
                  ? "Saving…"
                  : processing
                    ? "Retrying…"
                    : arrival.checkedIn
                      ? online ? "Undo" : "Reconnect to undo"
                      : savedItem?.state === "CONFLICT"
                        ? "Retry check-in"
                        : savedItem
                          ? "Retry queued"
                          : "Check in"}
              </button>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="empty-state">
            <Search aria-hidden="true" size={24} />
            <h3>No arrivals found</h3>
            <p>Check the name or confirmation code and try again.</p>
          </div>
        )}
      </section>
    </section>
  );
}
