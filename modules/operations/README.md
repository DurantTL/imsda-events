# Operational health

`/more/health` is a read-only, event-scoped exception center. It deliberately queries only the categories the signed-in staff member can resolve:

- `MANAGE_FINANCE`: current Square failures/stalls and active registration balances.
- `MANAGE_COMMUNICATIONS`: unretried failed, bounced, complained, provider-failed, or overdue pending outbox rows.
- `MANAGE_IMPORTS`: unfinished/failed previews with warnings or errors.
- `CONFIGURE_EVENT`, `MANAGE_REGISTRATION`, or `MANAGE_FORMS`: overall event capacity and explicitly limited form choices.

The summary excludes names, email addresses, private form answers, card details, raw provider errors, and import row content. Every item links to the existing authorized workspace; the health page has no mutation endpoint.

Current thresholds and resolution rules:

- A Square `PROCESSING` or `PENDING` attempt is stuck after 15 minutes. Only the newest attempt for an unpaid active registration is considered.
- A `PENDING` outbox row is overdue 15 minutes after `availableAt`. A failed ancestor is no longer current after a retry exists.
- A completed import is treated as reviewed. Unfinished/failed runs use both run totals and error/warning record statuses.
- A configured limit is near capacity in its final 10%, with at least the last one place treated as near for small limits. Reaching or exceeding the limit is urgent.
- Registration balance is total minus successful payments plus successful refunds, for `SUBMITTED` and `CONFIRMED` registrations only.
- Offline check-in conflicts are intentionally stored in that device's local queue, so staff resolve them on Check-in rather than in this server summary.
