# Honors Weekend class waitlist (#831)

Decided by the owner on 2026-10-08 (comment on #831). Built on the class
seats of #359 and the class requirements of #832. Code: `modules/honors/waitlist-domain.ts`
(pure rules), `modules/honors/waitlist-repository.ts` (transactions, offers, email),
`components/class-waitlist-panel.tsx` (the director's screen).

## What a director sees

When a class is full, the class page lists **Class waitlists**: a director can put a
youth on a full class's waitlist, sees each place in line, and, when a seat is offered,
**Accept the seat** or **Decline the seat**. Staff, adults and underage children use no
seat and no waitlist spot, and nothing here is offered to a "Group" registration.

## The rules

- **Order.** Youth are offered seats in the order they joined (`joinOrder`, assigned by the
  database). Nobody moves ahead by emailing staff, and a direct pick never takes a seat
  that a youth in line could be offered: a save first gives free seats to the line.
- **Offer, then accept.** A seat that opens (a director changes picks, a registration is
  cancelled, staff add capacity) is **offered** to the next eligible youth. A live offer
  **holds** the seat: it counts with the taken seats, so the class shows full to everyone else.
  The director has the event's window (**Honors setup > Class waitlist offers**, 1 to 168
  hours, 24 by default, `Event.honorWaitlistOfferHours`) to accept.
- **Pass on.** An offer not accepted in time becomes `EXPIRED` and the seat goes to the next
  youth. A director who declines passes it on at once. Someone whose offer lapsed may join
  again, at the end of the line.
- **Conflicts.** A youth who already holds a class in that session (or an all-sessions class)
  is **skipped and keeps their place**; the seat goes to the next. If a youth holding an
  offer picks a class in that session, the offer is released (back to `WAITING`, place kept)
  and passes on. Joining a waitlist is allowed while holding another class in the session,
  so a director can swap.
- **Class-change deadline.** Promotion stops when class changes close for the registration's
  site (the site's own close wins over the event's, as for every other edit). Nothing is
  offered, joined or accepted after it, and an offer still live at the deadline lapses
  (`Class changes closed`) without passing the seat on.
- **Email.** Each offer queues **one transactional email to that club's director** (the
  registration's contact), through the existing outbox, one message per offer, with a
  deterministic idempotency key (`honor-class-waitlist-offer:<entry>:<offer number>`), never
  a bulk send. It names the class, the youth and the accept-by time, and links to the club's
  page. If email delivery is disabled for the event the message is suppressed; the offer is
  still shown on the director's page.
- **Limits.** A waitlist spot is not a seat and never counts toward the per-club youth limit,
  and neither does an offer. Only seats do. A club already at a class's limit is skipped when
  seats are offered (it keeps its place), and acceptance refuses if it would pass the limit.
- **Requirements (#832).** A youth can join only if eligible for the class (age, minimum
  class level, prerequisite honors); the director's confirmation (or staff's audited
  override) is stored with the place. Acceptance re-checks everything, so a roster level that
  has dropped since refuses the acceptance and the offer stays until it is declined or lapses.

## Safety

- Every operation that offers, takes or releases a seat runs in one **serializable**
  transaction that first locks the affected classes (`SELECT ... FOR UPDATE` in id order),
  the same lock the seat save takes. Free seats are `capacity - seats taken - live offers`,
  so an offer and a direct pick can never overfill a class.
- A partial unique index allows one open place (`WAITING` or `OFFERED`) per youth and class.
- Audit: `HONOR_CLASS_WAITLIST_JOINED`, `_OFFERED`, `_ACCEPTED`, `_DECLINED`, `_REMOVED`,
  `_OFFER_EXPIRED`, `_OFFER_RELEASED`, `_WINDOW_UPDATED`. Ids only, never names.

## When offers lapse (the time-based trigger)

Expiry is **enforced on read and write, and applied by the existing outbox sweep**:

- A lapsed offer holds no seat (live offers are those with `offerExpiresAt > now`), can't be
  accepted (accepting late records the lapse and passes the seat on), and doesn't count as a
  taken seat in any view.
- `sweepClassWaitlists` runs from the outbox sweep endpoint (already scheduled every few
  minutes) and writes the lapse, offers the seat to the next youth and sends that email.
  Every save and cancellation touching a class does the same for it immediately.

No new scheduler was added.

## Not done

Group registrations have no waitlist. The staff catalog table shows seats only. Event
cloning does not copy the acceptance window (a clone starts at 24 hours).
