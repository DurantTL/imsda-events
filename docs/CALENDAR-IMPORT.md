# Imported calendars (Google Calendar / ICS)

Issue [#444](https://github.com/DurantTL/imsda-events/issues/444), part B. Staff
bring a Google Calendar (or any ICS feed) onto the public calendar. The import is
read-only: nothing is ever written back to Google.

## Where staff use it

System administration, **Conference calendar**, tab **Imported calendars**
(`/admin/calendar`). Only system administrators can use it, the same as the rest
of the calendar admin; every check is server-side.

1. In Google Calendar, open the calendar's settings, **Integrate calendar**, and copy
   **Public address in iCal format**, or for a private calendar the
   **Secret address in iCal format**. `https://` and `webcal://` both work.
2. **Add calendar**: name, address, optional category and type (conference date or
   office closure) for new items, whether new items publish automatically (off by
   default, so they arrive as drafts), and how often to refresh (15 minutes or more).
3. **Preview** reads the feed and shows what an import would create, update and
   remove, with dates, repeat summary and warnings. It writes nothing.
4. **Import** applies it. After that the calendar refreshes by itself, and
   **Refresh now** does it on demand.

## The address is a secret

A private "secret address" is a password in URL form. It is stored encrypted
(`SECRET_ENCRYPTION_KEY`, purpose `calendar-feed-url`) and is write-only in the
admin: the page and every API response show only the host and last four
characters. A blank address on edit keeps the saved one. It is never logged and
never appears in an error message. Saving a calendar needs `SECRET_ENCRYPTION_KEY`
to be set; without it the save is refused with a 503.

Only public `https` hosts are fetched: no credentials in the URL, no port other than
443, no private, loopback, link-local or carrier-grade-NAT addresses (checked on
the name and again on every connection), 10 second timeout, 2 MB and 2,000 events at
most, and at most three redirects, each re-checked.

## What happens to imported items

- **Mapping:** title, description (plain text), location, link (http/https only),
  dates and time label (in Central time), cancelled status, repeat rule and skipped
  dates. A changed single occurrence (RECURRENCE-ID) becomes its own item and the
  series skips that date. A repeat the calendar cannot show is imported as its first
  date only, with a warning.
- **Refresh is idempotent.** An unchanged item writes nothing. An item with no UID is
  skipped with a warning.
- **Local edits are kept.** Changing an imported item's title, dates, location and so
  on records that field; a refresh never overwrites it. **Reset to Google's version**
  clears those edits and re-reads the feed.
- **Hide** removes an item from the public calendar and `/calendar/feed.ics` without
  touching Google, and a refresh never unhides it. Imported items can be hidden but
  not deleted (a refresh would bring them back).
- **Gone from the feed:** the item is unpublished and marked, never deleted, so
  anything linked to it (#445) survives. If it returns it comes back as the same row,
  republished only if it was published before it left.
- **Deleting a feed** keeps every imported item as an ordinary entry; hidden or
  removed ones become unpublished drafts, so deleting never makes anything appear.
- One feed failing records a short message on that feed (shown in the list) and
  changes nothing else.

## Refresh cadence

The existing five-minute sweep (`POST /api/internal/outbox/sweep`) calls
`refreshDueCalendarFeeds()` after its outbox work: enabled feeds that have been
imported at least once and whose last fetch is older than their own interval, at
most three per sweep. A failure there never fails the sweep. The sweep response
reports `calendarFeeds: { due, refreshed, failed }`.

## Deploy

Run `npm run db:deploy` (migration `20261003180000_calendar_feed_import`: a
`CalendarFeed` table and additive columns on `CalendarEntry`). Existing entries are
untouched. No import runs until staff add a feed and press Import.
