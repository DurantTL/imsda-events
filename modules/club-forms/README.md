# Club forms module (#610)

Forms that belong to no event. A club fills one in for a member, or emails a
single-use, expiring private link so a parent or staff person fills it in
themselves. Every form is off until a system administrator turns it on.

## What lives here

- `definitions.ts`: the four seeded templates (Pathfinder Club Membership
  Application, Staff/Volunteer Service Information Form, Off-Premises Permission
  Slip, Transportation Passenger List). Definitions use the registration-form
  definition schema (`modules/forms/definition.ts`) and its validator
  unchanged. Text a field label cannot carry (Pledge and Law, approval and
  waiver wording, instructions) is `sectionNotes`. Each template also names its
  sensitive fields, its birth-date fields (a subset), and any staff-only
  (office use) fields.
- `domain.ts`: pure rules: answer sanitizing and validation, the plain and
  sensitive split, link state, email delivery status, and the viewer/role matrix.
- `templates.ts`: sync of the seeds, the on/off switch, what clubs may list.
- `reseal.ts`: the re-seal step a template version bump runs (see below).
- `submissions.ts`: fill in for a member, list, and open one submission (the
  audited read).
- `links.ts`, `link-email.ts`: private links and their email.
- `access.ts`: turns a session into a viewer (club leader, Area Coordinator,
  conference staff).
- `csv.ts`: the staff CSV, non-sensitive columns only.

## Who sees what

| Viewer | Fill in / send link | Submitted forms | Health, conduct, physician, emergency answers | Birth dates |
| --- | --- | --- | --- | --- |
| Director or deputy (or a system administrator acting as the director) of the club | yes | own club, including drafts | shown | shown |
| Registrar, reporter | no | no | no | no |
| Another club's director | no | no (not found) | no | no |
| Area Coordinator (or admin acting as one) | no | every club, submitted only | `Restricted` | `Restricted` |
| Event Admin of a current event | no | every club, submitted only | shown | `Restricted` |
| System administrator | no (unless acting as a director) | every club, submitted only | shown | shown |

**Conference staff** is only system administrators and users with an ACTIVE
`EVENT_ADMIN` membership on an event that has not ended (`hasEventEnded`; the
event model has no archived state). No other event role gets in, whatever other
permissions it holds, including `VIEW_SENSITIVE_DATA`. Every path uses the one
gate in `access.ts` (`resolveStaffViewer`): the staff list and pages, the CSV
export, and the More card.

**Birth dates** follow ADR 0005 Addendum A: only the club's own director and
deputies and system administrators read full birth dates. A template marks them
in `birthDateFieldKeys`; they are also in `sensitiveFieldKeys` (so they are
sealed) and everyone else sees `Restricted`.

Club pages sit behind the roster's second step (these files hold birth dates
and health answers).

**A form that is switched off** blocks new fills and new links only. The
club's past submissions, and the Area Coordinator and staff views of them, stay
readable (read-only). A private link to a switched-off form stops working.

## Sensitive answers

- Marked per field in the template (`sensitiveFieldKeys`).
- Split from the plain answers before anything reaches Prisma, and sealed with
  `lib/secret-box.ts` (AES-256-GCM). The key purpose includes the submission id,
  so a sealed value cannot be opened on another row.
- Never in: the plain `answers` column, list queries, the CSV, logs, audit rows,
  the outbox, or `PublicRegistrationSubmission` drafts (club forms have their
  own tables and never touch the public-form draft path).
- Every open of a submission that has sensitive answers writes a
  `CLUB_FORM_SUBMISSION_VIEWED` audit row first (who, which submission, club,
  form, purpose, and whether the answers and birth dates were revealed; never an
  answer). If the audit write fails, nothing is returned. The club in the page's
  URL is checked before the row is written.

### Changing which fields are sensitive

`sensitiveFieldKeys` decides what is sealed *at write time*. A template version
that makes a field **newly sensitive** would leave that answer in the plain
`answers` column of every existing submission, so `syncClubFormTemplates`
never applies such a change by itself: it runs `resealClubFormSubmissions` in the
same transaction as the template update, moving the answer into each
submission's sealed value. It needs `SECRET_ENCRYPTION_KEY`, and it fails (and
changes nothing) if it cannot re-seal. A version that would make a sensitive
field **stop** being sensitive is refused outright; that needs a reviewed,
hand-written change. Changing only the birth-date class needs no re-seal, since
both classes are sealed.

## Private links

- One address, typed by the director. The email is queued in the link's own
  transaction and delivered after it commits (`after()` in the route; the
  outbox sweep retries).
- The email body holds a sentinel. The token is minted when the message is
  delivered (`prepareClubFormLinkBodyForDelivery`), only its SHA-256 is stored.
- If the email finally fails the link is withdrawn: a non-retryable error or
  running out of retries (`email-delivery.ts`), or a bounce, complaint, failure
  or suppression from the provider (`resend-webhook-repository.ts`), all through
  `retireClubFormLinkForMessage`. The director's list shows the email's delivery
  status (sending, sent, delivered, not delivered).
- Single use: the submit path spends the link with a guarded `updateMany`
  inside the transaction that creates the submission, so racing submits produce
  exactly one submission.
- Default 14 days (1 to 30). Every unusable link gets the same 404.
- Rate limits: `checkClubFormLinkRateLimit` (read, submit) per client, token and
  pair; `checkClubFormLinkCreateRateLimit` per director, club, client and
  recipient.
- The token segment of `/club-forms/` and `/manage/` paths is redacted from the
  request context that log lines carry (`redactTokenPath`).

## Deleting a club

`getOrganizationDeletionCheck` counts filled club forms and private links as
blockers (deactivate the club instead); the foreign keys are `Restrict` as well.

## Open items for a human

- Wording the issue summarises rather than quotes (the membership application's
  statement, waiver and five cooperation points; the Pledge and Law) is drafted
  from those summaries and must be compared with the conference's official forms
  before the template is enabled.
- If #150 (signature evidence) ships, replace the typed name plus acknowledgment
  with it.
