# Event module requests (#741 slice 3)

An event admin can ask for an event module that is off; a system administrator
decides. Code: `modules/event-modules/requests.ts`, rules in
`modules/event-modules/request-domain.ts`.

## Who can do what

- **Ask:** anyone holding `CONFIGURE_EVENT` on the event (Event Admins by
  default, or an explicit grant). Finance, registration, communications,
  check-in and read-only staff cannot unless granted it. System administrators
  do not ask (the service refuses them with
  `SYSTEM_ADMIN_ENABLES_DIRECTLY`, 403 from the route): they turn modules on directly on `/more`.
- **Decide:** system administrators only, from the "Feature requests" panel in
  System management (`/admin#module-requests`).

## What can be requested

Any module that is not on for the event and applies to it
(`canEnableForEvent`): not a club module on a general event, not a module that
has a stored row or whose data (products, a ranked seminar field) already keeps
it on, and not an always-on module.

## Re-request rules

- **Pending:** another request for the same event and module is refused. The
  database enforces it with the partial unique index
  `ModuleRequest_one_pending_per_module` (`WHERE status = 'PENDING'`), so two
  concurrent submissions leave one.
- **Declined:** the event admin may ask again; the declined request stays as history.
- **Approved:** the module is on, so there is nothing to request.

## Deciding

- Approve turns the module on through the existing enable step in the same
  transaction. If the module cannot be enabled any more (the event type
  changed), the request stays pending and the approval is refused.
- Decline needs a reason (up to 500 characters), which the requester is emailed.
- A request is decided once; a second decision is refused.
- If a system administrator turns the module on directly while a request is
  pending, that request is marked approved in the same transaction, audited,
  and the requester gets the same approved email.

## Audit

`MODULE_REQUEST_CREATED`, `MODULE_REQUEST_APPROVED`, `MODULE_REQUEST_DECLINED`
(plus the existing `EVENT_MODULE_ENABLED` on approval). Metadata holds
`eventId`, `moduleKey` and `requestId` only. The requester's reason and the
decline reason are stored on the request and never copied into audit metadata.

## Email

Queued in the account slice of the outbox in the same transaction as the
change, then delivered best-effort after commit (the outbox sweep retries).

- **Conference office:** when a request is made. The address is the platform
  setting "Support contact" (System management, Platform settings). If it is
  blank no email is queued; the request still appears in the queue.
- **Requester:** when a decision is made, with the decline reason on a decline.

Free text in these emails has `{{` and `}}` broken up, and delivery never
replaces sentinels in `MODULE_REQUEST_*` messages.

Without a Resend key nothing is delivered and the rows stay queued, which is
what the tests read.

## Routes

- `POST /api/events/[eventId]/module-requests` (same-origin, Event Admin of the
  event, rate limited to 10 an hour per account and 20 per client).
- `POST /api/admin/module-requests/[requestId]/decision` (same-origin, system
  administrator): body `{ "decision": "approve" }` or
  `{ "decision": "decline", "declineReason": "..." }`.
