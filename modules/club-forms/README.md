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
  waiver wording, instructions) is `sectionNotes`. Bump a template's `version`
  to change a stored definition; `syncClubFormTemplates` never touches
  `enabled`.
- `domain.ts`: pure rules: answer sanitizing and validation, the plain and
  sensitive split, link state, and the viewer/role matrix.
- `templates.ts`: sync of the seeds, the on/off switch, what clubs may list.
- `submissions.ts`: fill in for a member, list, and open one submission (the
  audited read).
- `links.ts`, `link-email.ts`: private links.
- `access.ts`: turns a session into a viewer (club leader, Area Coordinator,
  conference staff).
- `csv.ts`: the staff CSV, non-sensitive columns only.

## Who sees what

| Viewer | Fill in / send link | Submitted forms | Sensitive answers |
| --- | --- | --- | --- |
| Director or deputy (or a system administrator acting as the director) of the club | yes | own club, including drafts | shown |
| Registrar, reporter | no | no | no |
| Another club's director | no | no (not found) | no |
| Area Coordinator (or admin acting as one) | no | every club, submitted only | `Restricted` |
| Conference staff (any active event membership) | no | every club, submitted only | shown with `VIEW_SENSITIVE_DATA` on an active membership, or system administrator; else `Restricted` |

Clubs and Area Coordinators never see a disabled template or its forms;
conference staff see everything. Club pages sit behind the roster's second
step (these files hold birth dates and health answers).

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
  form, purpose, and whether the answers were revealed; never an answer). If the
  audit write fails, nothing is returned.

## Private links

- One address, typed by the director. The email is queued in the link's own
  transaction and delivered after it commits (`after()` in the route; the
  outbox sweep retries).
- The email body holds a sentinel. The token is minted when the message is
  delivered (`prepareClubFormLinkBodyForDelivery`), only its SHA-256 is stored,
  and a definitive delivery failure revokes the link.
- Single use: the submit path spends the link with a guarded `updateMany`
  inside the transaction that creates the submission, so racing submits produce
  exactly one submission.
- Default 14 days (1 to 30). Every unusable link gets the same 404.
- Rate limits: `checkClubFormLinkRateLimit` (read, submit) per client, token and
  pair; `checkClubFormLinkCreateRateLimit` per director, club, client and
  recipient.

## Open items for a human

- Wording the issue summarises rather than quotes (the membership application's
  statement, waiver and five cooperation points; the Pledge and Law) is drafted
  from those summaries and must be compared with the conference's official forms
  before the template is enabled.
- If #150 (signature evidence) ships, replace the typed name plus acknowledgment
  with it.
