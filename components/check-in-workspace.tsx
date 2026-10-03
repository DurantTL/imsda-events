"use client";

import { SortOrderNote } from "@/components/list-sort";
import { sortOrderText } from "@/lib/list-sort";
import {
  AlertTriangle,
  CheckCircle2,
  ContactRound,
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
  useRef,
  useState,
} from "react";
import { CheckInPaymentDue } from "@/components/check-in-payment-due";
import { BackgroundCheckBadge } from "@/components/background-check-flags";
import { CheckInScanner } from "@/components/check-in-scanner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ListPager } from "@/components/list-pager";
import { paginate } from "@/lib/pagination";
import {
  ClubCheckInPanel,
  type ClubCheckInProgress,
} from "@/components/club-check-in-panel";
import { useOfflineCheckInQueue } from "@/components/use-offline-check-in-queue";
import {
  checkInSequentially,
  sequentialCheckInSummary,
  type SequentialCheckInStatus,
} from "@/modules/checkin/bulk-check-in";
import { arrivalMatchesSearch, offlineCheckInErrorMessage } from "@/modules/checkin/domain";
import type { CheckInArrival } from "@/modules/checkin/arrival-view";
import type { ClubCheckInInfo } from "@/modules/club-registrations/repository";

/** Arrivals rendered per page; search always runs across the whole roster (#702). */
export const ARRIVALS_PAGE_SIZE = 50;

/** The tally label for people not yet checked in; matches the row status text. */
export const AWAITING_ARRIVAL_LABEL = "Awaiting arrival";

type Arrival = CheckInArrival;

export function CheckInWorkspace({
  eventName,
  eventId,
  initialArrivals,
  canCheckIn,
  backgroundFlaggedAttendeeIds = [],
  clubs = [],
}: {
  eventName: string;
  eventId: string;
  /** Server-projected arrivals (#757): only what this screen renders, never form answers. Balances are already 0 for events billed to an organization. */
  initialArrivals: CheckInArrival[];
  canCheckIn: boolean;
  /** Adults at a youth or children's event without a current check (#388). Shown, never blocking. */
  backgroundFlaggedAttendeeIds?: string[];
  /** Active club registrations for this event (#412): who to check in as a group, and what their church owes. */
  clubs?: ClubCheckInInfo[];
}) {
  const [arrivals, setArrivals] = useState<Arrival[]>(initialArrivals);
  const paymentDueByConfirmationCode = useMemo(() => Object.fromEntries(
    initialArrivals
      .filter((arrival) => arrival.balanceCents > 0)
      .map((arrival) => [arrival.confirmationCode, {
        balanceCents: arrival.balanceCents,
        partySize: arrival.partySize,
      }]),
  ), [initialArrivals]);
  const owingCount = Object.keys(paymentDueByConfirmationCode).length;
  const [query, setQueryText] = useState("");
  const [rosterPage, setRosterPageState] = useState(1);
  const rosterHeadingRef = useRef<HTMLHeadingElement>(null);
  const setRosterPage = useCallback((page: number) => {
    setRosterPageState(page);
    rosterHeadingRef.current?.scrollIntoView?.({ block: "start" });
  }, []);
  const setQuery = useCallback((next: string) => {
    setQueryText(next);
    setRosterPageState(1);
  }, []);
  const [undoPendingId, setUndoPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // Review before discarding saved offline data (#471): both are local,
  // device-only discards, so there's nothing to await and no busy guard
  // needed — the dialog still confirms in-page rather than via
  // `window.confirm()`, which iOS Safari can silently fail to show.
  const [discardTarget, setDiscardTarget] = useState<{ idempotencyKey: string; attendeeId: string; attendeeLabel: string } | null>(null);
  const [confirmingDiscardUnreadable, setConfirmingDiscardUnreadable] = useState(false);
  // This device's latest result per attendee from a club run, so a row that
  // failed reads "Needs review" even when nothing was saved to the queue.
  const [bulkResultById, setBulkResultById] = useState<
    Record<string, SequentialCheckInStatus>
  >({});

  // Q1 (#412) reviewer leftover: bulkResultById only ever grew, so a club
  // run's CONFLICT could keep marking someone "Needs review" long after it
  // was resolved another way. Clear an attendee's entry wherever their
  // outcome is superseded: a confirmed check-in (here), a successful undo,
  // and a discarded saved retry.
  const clearBulkResult = useCallback((attendeeId: string) => {
    setBulkResultById((current) => {
      if (!(attendeeId in current)) return current;
      const next = { ...current };
      delete next[attendeeId];
      return next;
    });
  }, []);

  const applyConfirmedCheckIn = useCallback((
    attendeeId: string,
    checkedInAt: string,
  ) => {
    setArrivals((current) => current.map((item) => (
      item.id === attendeeId
        ? { ...item, checkedIn: true, checkedInAt }
        : item
    )));
    clearBulkResult(attendeeId);
    setMessage("A saved check-in was confirmed by the server.");
  }, [clearBulkResult]);

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

  const clubByConfirmationCode = useMemo(() => new Map(
    clubs.map((club) => [club.confirmationCode, club]),
  ), [clubs]);
  const visible = useMemo(() => arrivals.filter((arrival) => arrivalMatchesSearch(
    arrival,
    query,
    clubByConfirmationCode.get(arrival.confirmationCode)?.organizationName,
  )), [arrivals, query, clubByConfirmationCode]);
  // The saved-on-this-device list, oldest first: the order the check-ins were taken.
  const orderedQueue = useMemo(
    () => [...queue].sort((left, right) => new Date(left.queuedAt).getTime() - new Date(right.queuedAt).getTime()),
    [queue],
  );
  const rosterSlice = useMemo(
    () => paginate(visible, rosterPage, ARRIVALS_PAGE_SIZE),
    [visible, rosterPage],
  );
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

  // Q1 (#412): search by club name or confirmation code opens the same club
  // view as scanning the club's code. Only clubs the query actually matches,
  // so an empty search stays uncluttered.
  const matchedClubs = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];
    return clubs.filter((club) => (
      club.organizationName.toLowerCase().includes(trimmed)
      || club.confirmationCode.toLowerCase().includes(trimmed)
    ));
  }, [clubs, query]);
  const [bulkBusyCode, setBulkBusyCode] = useState<string | null>(null);
  const [bulkProgress, setBulkProgress] = useState<ClubCheckInProgress | null>(null);

  async function checkInMany(confirmationCode: string, clubLabel: string, attendeeIds: string[]) {
    if (!canCheckIn || attendeeIds.length === 0 || bulkBusyCode) return;
    setBulkBusyCode(confirmationCode);
    setBulkProgress({ current: 0, total: attendeeIds.length });
    setMessage("");
    try {
      const outcome = await checkInSequentially(
        attendeeIds,
        requestCheckIn,
        ({ current, total }) => setBulkProgress({ current, total }),
      );
      setBulkResultById((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(outcome.perAttendee).map(
          ([attendeeId, result]) => [attendeeId, result.status],
        )),
      }));
      setMessage(`${clubLabel}: ${sequentialCheckInSummary(attendeeIds, outcome, attendeeLabel)}`);
    } finally {
      setBulkBusyCode(null);
      setBulkProgress(null);
    }
  }

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
      clearBulkResult(arrival.id);
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

  function discardSavedItem(idempotencyKey: string, attendeeId: string, attendeeLabel: string) {
    setDiscardTarget({ idempotencyKey, attendeeId, attendeeLabel });
  }

  function confirmDiscardSavedItem() {
    if (!discardTarget) return;
    if (discardQueueItem(discardTarget.idempotencyKey)) {
      clearBulkResult(discardTarget.attendeeId);
      setMessage(`Discarded the saved retry for ${discardTarget.attendeeLabel}.`);
    }
    setDiscardTarget(null);
  }

  function discardUnreadableSavedData() {
    setConfirmingDiscardUnreadable(true);
  }

  function confirmDiscardUnreadableSavedData() {
    if (discardUnreadableItems()) {
      setMessage("Discarded the unreadable saved queue data.");
    }
    setConfirmingDiscardUnreadable(false);
  }

  function attendeeLabel(attendeeId: string) {
    const attendee = arrivals.find((arrival) => arrival.id === attendeeId);
    return attendee
      ? `${attendee.firstName} ${attendee.lastName}`
      : `Attendee reference …${attendeeId.slice(-6)}`;
  }

  return (
    <>
    <section className="page-stack">
      {/* Search and Scan come first (#743): the desk opens on the two things staff do all day. */}
      <div className="checkin-tools">
        <CheckInScanner
          conflictAttendeeIds={queue
            .filter((item) => item.state === "CONFLICT")
            .map((item) => item.attendeeId)}
          eventId={eventId}
          paymentDueByConfirmationCode={paymentDueByConfirmationCode}
          backgroundFlaggedAttendeeIds={backgroundFlaggedAttendeeIds}
          clubsByConfirmationCode={Object.fromEntries(clubByConfirmationCode)}
          onConfirmCheckIn={(attendee) => requestCheckIn(attendee.id)}
          savedQueueUnreadable={unreadableItemCount > 0}
          queuedAttendeeIds={queue
            .filter((item) => item.state === "QUEUED")
            .map((item) => item.attendeeId)}
        />
        <label className="search-field panel">
          <Search aria-hidden="true" size={18} />
          <span className="sr-only">Search arrivals</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, club, or confirmation code"
            value={query}
          />
        </label>
      </div>

      {/* Results and messages sit right under the search that produced them. */}
      {message && (
        <div aria-live="polite" className="inline-notice" role="status">
          {message}
        </div>
      )}

      {matchedClubs.map((club) => {
        const clubAttendees = arrivals
          .filter((arrival) => arrival.confirmationCode === club.confirmationCode)
          .map((arrival) => {
            const savedItem = queueByAttendee.get(arrival.id);
            return {
              id: arrival.id,
              firstName: arrival.firstName,
              lastName: arrival.lastName,
              attendeeType: arrival.attendeeType,
              checkedIn: arrival.checkedIn,
              backgroundFlagged: backgroundFlaggedAttendeeIds.includes(arrival.id),
              savedState: savedItem?.state,
              lastResult: bulkResultById[arrival.id],
            };
          });
        return (
          <ClubCheckInPanel
            attendees={clubAttendees}
            busy={bulkBusyCode !== null}
            progress={bulkBusyCode === club.confirmationCode ? bulkProgress : null}
            savedQueueUnreadable={unreadableItemCount > 0}
            canCheckIn={canCheckIn}
            amountOwedCents={club.amountOwedCents}
            confirmationCode={club.confirmationCode}
            key={club.confirmationCode}
            onCheckInMany={(attendeeIds) => checkInMany(
              club.confirmationCode,
              club.organizationName,
              attendeeIds,
            )}
            organizationName={club.organizationName}
            locationName={club.locationName ?? null}
          />
        );
      })}

      <div className="checkin-hero">
        <div>
          <p className="hero-eyebrow">On-site operations</p>
          <h2>Ready for arrivals</h2>
          <p>
            Search by first or last name, club, or confirmation code and record
            arrivals for {eventName}. Offline check-ins stay clearly queued
            until the server confirms them.
          </p>
          <div className="checkin-print-links">
            <Link
              className="secondary-button checkin-pass-link"
              href={`/check-in/passes?event=${encodeURIComponent(eventId)}`}
            >
              <Printer aria-hidden="true" size={16} />
              Print attendee passes
            </Link>
            <Link
              className="secondary-button checkin-pass-link"
              href={`/check-in/badges?event=${encodeURIComponent(eventId)}`}
            >
              <ContactRound aria-hidden="true" size={16} />
              Print name badges
            </Link>
          </div>
        </div>
        <div className="checkin-tallies">
          <span><strong>{checkedIn}</strong><small>Confirmed</small></span>
          <span>
            <strong>{arrivals.length - checkedIn}</strong>
            <small>{AWAITING_ARRIVAL_LABEL}</small>
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
          <SortOrderNote>{sortOrderText("time saved", "asc", "date")}</SortOrderNote>
          <div className="check-in-queue-list">
            {orderedQueue.map((item) => {
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
                        item.attendeeId,
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

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Arrival roster</p>
            <h2 ref={rosterHeadingRef}>Expected attendees</h2>
            {owingCount > 0 && (
              <small className="checkin-balance-note">
                {owingCount} {owingCount === 1 ? "registration still owes" : "registrations still owe"} money.{" "}
                Card amounts include Square&rsquo;s in-person fee (2.6% + 15&cent;).{" "}
                Balances are as of when this page loaded &mdash; refresh after
                finance records a payment.
              </small>
            )}
          </div>
          <span className="count-badge">
            <UsersRound aria-hidden="true" size={16} /> {visible.length} match
          </span>
        </div>
        <SortOrderNote>{sortOrderText("registration", "desc", "date")}</SortOrderNote>
        {rosterSlice.items.map((arrival) => {
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
                <strong translate="no">{arrival.firstName} {arrival.lastName}</strong>
                <small>
                  <span translate="no">{arrival.confirmationCode}</span> ·{" "}
                  {arrival.attendeeType.toLowerCase()}
                </small>
                {backgroundFlaggedAttendeeIds.includes(arrival.id) && <BackgroundCheckBadge />}
                <CheckInPaymentDue
                  balanceCents={arrival.balanceCents}
                  confirmationCode={arrival.confirmationCode}
                  partySize={arrival.partySize}
                />
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
                      : AWAITING_ARRIVAL_LABEL}
              </span>
              <button
                className={arrival.checkedIn ? "undo-button" : ""}
                disabled={
                  !canCheckIn
                  || processing
                  || undoPendingId === arrival.id
                  || (arrival.checkedIn && !online)
                  || (!arrival.checkedIn && unreadableItemCount > 0)
                  // A club run in progress already sends this attendee's
                  // check-in through checkInSequentially if they're in that
                  // club; a second, independent request from this row would
                  // race it (reviewer leftover).
                  || (!arrival.checkedIn && bulkBusyCode !== null)
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
        <ListPager label="Arrival roster pages" onPage={setRosterPage} slice={rosterSlice} />
        {visible.length === 0 && (
          <div className="empty-state">
            <Search aria-hidden="true" size={24} />
            <h3>{arrivals.length === 0 ? "No expected attendees yet" : "No arrivals found"}</h3>
            <p>{arrivals.length === 0
              ? "Nobody is registered for this event, so there is no one to check in. Registrations appear here once people submit the public form."
              : "Check the name or confirmation code and try again."}</p>
          </div>
        )}
      </section>
    </section>

    <ConfirmDialog
      busy={false}
      confirmLabel={discardTarget ? `Discard retry for ${discardTarget.attendeeLabel}` : "Discard retry"}
      destructive
      error=""
      onCancel={() => setDiscardTarget(null)}
      onConfirm={confirmDiscardSavedItem}
      open={discardTarget !== null}
      title={discardTarget ? `Discard the saved retry for ${discardTarget.attendeeLabel}?` : "Discard the saved retry?"}
    >
      <p>This only removes the retry from this device. It does not undo a server check-in.</p>
    </ConfirmDialog>

    <ConfirmDialog
      busy={false}
      confirmLabel="Discard unreadable data"
      destructive
      error=""
      onCancel={() => setConfirmingDiscardUnreadable(false)}
      onConfirm={confirmDiscardUnreadableSavedData}
      open={confirmingDiscardUnreadable}
      title={`Discard ${unreadableItemCount} unreadable saved queue ${unreadableItemCount === 1 ? "item" : "items"}?`}
    >
      <p>This cannot undo or change any check-in already received by the server.</p>
    </ConfirmDialog>
    </>
  );
}
