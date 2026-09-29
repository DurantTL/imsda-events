# Location waitlists and the daily digest (#599)

How a full location of a multi-location event (#413) waitlists a club, who is
told, and how the daily email to Area Coordinators and event staff is sent.

## Behaviour

- **Joining.** When the event's waitlist is on and the location a club picks has
  no room for the club's people, the club registration is `WAITLISTED` at that
  location instead of refused. Capacity and the row lock use the same admission
  path as any club registration (`checkLocationSeats`, `lockEventLocation`).
  Without an event waitlist the club still gets `LOCATION_FULL`.
- **Order.** A waiting club's `RegistrationWaitlistEntry.position` stays unique
  per event, as it always was. Its place in line at the location is the number
  of waiting clubs at that location at or ahead of it, so order is first come
  first served per location. Staff lists show "Waitlisted at *location* (#N)".
- **Promotion.** A seat that opens at a location (a cancellation, an amendment
  that removes people or moves the club away, a club member moved out by a
  transfer, or a raised location capacity) is offered to that location's
  waiting clubs first, in their own order, and then to the rest of the event
  queue. The same auto-promotion loop as a cancel does it, with each candidate's
  location locked inside the loop; a busy location is skipped, never fatal.
  Only events with the waitlist and auto-promotion on do this.
- **Coordinator.** A location has an optional Area Coordinator, chosen by staff
  in Event settings, Locations, from the active Area Coordinators. A revoked or
  expired coordinator shows as "No active coordinator" and is never emailed.
  Cloning an event or applying a template carries the coordinator only if they
  are still active at that moment.

## Who gets which email

| Who | What | When |
| --- | --- | --- |
| The club director (the registration's contact) | The existing waitlist joined, promoted and removed emails, now naming the location and giving the club's place in line there | Right away, queued in the same transaction as the change and sent after commit |
| The location's active Area Coordinator | One digest of what changed on their locations' waitlists | Once a day, mornings |
| Event administrators (active `EVENT_ADMIN` memberships) | One digest of what changed on every location of their events | Once a day, mornings |

A person who is both coordinator and administrator gets one email. These are
one-off operational notices to named people, not bulk mail to attendees.

## The daily digest

- **Record.** Each join, promotion and removal at a location writes a row to
  `LocationWaitlistChange` in the same transaction as the registration change,
  with the club, location, people and place in line as they were.
- **Schedule.** It reuses the scheduled outbox sweep (`POST
  /api/internal/outbox/sweep`, bearer `OUTBOX_SWEEP_TOKEN`, every
  `OUTBOX_SWEEP_INTERVAL_SECONDS`, 300 by default; see `DEPLOY-DOCKER.md`).
  Each sweep calls `sendDueLocationWaitlistDigests`, which does nothing until
  **7:00 AM Central** (`America/Chicago`), then covers every change made before
  that moment that has not been digested. Changes after 7:00 AM wait for the
  next morning. No new route, cron entry or secret is needed.
- **Nothing on a quiet day.** No changes, no email.
- **Idempotent.** One message per recipient per Central date, keyed
  `location-waitlist-digest:<date>:<email>` in the outbox. A retry or a second
  sweep reuses it. The changes are stamped `digestedAt` in the transaction that
  queues the messages.
- **Delivery.** Messages are outbox rows with no event (`templateKey`
  `LOCATION_WAITLIST_DIGEST`, `recipientKind` `INTERNAL`), sent through the
  account email queue and its sender (`ACCOUNT_EMAIL_SENDER_ADDRESS`,
  `RESEND_API_KEY`), so they carry the usual delivery status, attempts, backoff
  and provider events. A failed send never touches a registration: the message
  stays queued and the next sweep retries it. While account email is not
  configured nothing is queued and the changes wait.
- **Edge.** A change committed late enough to fall before the send time but
  after the day's digest was queued waits for the next day's digest.

## Checks

- `npm run test:location-waitlist` runs against a real PostgreSQL database
  (waitlisting, per-location order, promotion order, races, a busy location, the
  digest, the failed-send path, cloning). CI runs it after `test:event-locations`.
- `tests/location-waitlist-digest*.test.ts` cover the digest rules without a
  database.
