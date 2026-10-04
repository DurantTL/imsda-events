# Billing responsibility and billing contacts (#165, slice 1)

For events billed to organizations after the event (`DEFERRED_ORGANIZATION_INVOICE`, such as
Spring Camporee). It answers one question: who is financially responsible for each registration,
and do we have a verified person to send the invoice to. It does not calculate or finalize an
invoice (#166, #167, ADR 0008) and does not reconcile attendance (#166). Invoices will use the
people checked in at the event, so the amounts on this screen are labelled "Estimated
(registered)".

The screen is Finance, then Owed by churches, then Billing responsibility
(`/finance/billing-responsibility`). Only MANAGE_FINANCE on the event can open it, use its
actions, or download its CSV; every action checks the permission again on the server and refuses
anything outside the event in the URL. It respects the location filter (#413).

## Who is responsible

Each submitted, confirmed, waitlisted, or cancelled registration has one explicit responsible
party, stored with its source, the staff member who set it (if any), timestamps, and an
append-only history (`RegistrationBillingResponsibilityChange`).

| Registration | Responsible party | If it can't be decided |
| --- | --- | --- |
| Club registration | The club's sponsoring church (`Organization.parentOrganizationId`) | Unresolved: the club has no church on file |
| Group registration (#650) | Its billing person | n/a |
| Anything else | Nobody until staff link an organization | Unresolved: not linked |

Nothing is inferred from an email address or domain, a household, the submitter, the club
director, or a free-text organization answer. A typed church name is shown to staff as a hint
only and is never linked automatically.

Staff can link an unresolved registration to an active church, school, club, or ministry using
the searchable picker (name search only; it shows name, type, and city). Replacing a party the
system already found is an override and needs a written reason. Staff decisions, whether links or
overrides, are audited, kept in the history, and are never replaced when the resolver runs again.
"Use the system's answer" clears a staff decision.

## Billing contacts

An organization's billing contact (usually the treasurer) is entered once by office staff and is
reused for every event. It is separate from the club director, the registration's operational
contacts, and the form submitter; directors and attendees never see or set it.

- Effective-dated: replacing a contact ends the previous one and starts a new one, so the full
  history is kept. The database allows only one active contact per organization, even if two staff
  members replace it at once (the second sees "Someone else just changed this billing contact").
- A new contact starts unverified. Staff mark it verified (who and when are recorded). Ending a
  contact without a replacement keeps it in the history. A contact row is never deleted.
- Readiness shown per invoice group: Ready (verified contact), Contact not verified, No billing
  contact. A group billed to a person is Ready when that person left an email.
- Staff can only manage the contact of an organization that is billed on the event they are
  working in. Audit entries hold ids only, never a contact's name, email, or phone.

## Grouping

The event setting `invoiceGrouping` (changed on the same screen, MANAGE_FINANCE only, audited
with before and after):

- One invoice per church (default): clubs of one church share that church's group, each club as
  its own line.
- One invoice per club: each club stands alone, still addressed to its church's billing contact.

Unresolved registrations are always listed separately. This is a preview only.

## Backfill and dry run

"Check what would change" runs the resolver without writing and reports how many registrations it
would record, how many are unresolved and why, with the free-text hint if there is one. "Record
responsible parties" writes the rule-derived parties. Both are safe to repeat: a second run
changes nothing, a staff decision is kept, parallel runs leave one row per registration, and an
ambiguous registration is recorded as unresolved, never linked. Run it after a club changes its
church or when new registrations arrive; the screen shows a proposal for registrations not yet
recorded.

## Checks

`npm run test:billing-responsibility` runs against a local or CI Postgres and proves the
resolver's idempotence under parallel runs, the one-active-contact rule, history, never-delete,
the check constraints, and that no audit row holds contact details.
