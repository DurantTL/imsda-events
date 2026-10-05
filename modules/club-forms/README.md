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

The coordinator health view (#658, ADR 0005 Addendum C, Proposed) is a separate,
narrow read-only view over some of these answers and the club registration's
dietary note. It does not change this table: Area Coordinators still see
`Restricted` here.

Club pages sit behind the roster's second step (these files hold birth dates
and health answers).

**A form that is switched off** blocks new fills and new links only. The
club's past submissions, and the Area Coordinator and staff views of them, stay
readable (read-only). A private link to a switched-off form stops working.

## Add to roster (#721)

A template can allow its submitted forms to be added to the club roster. It is
a per-form setting in the builder ("Allow adding to the roster"), stored as
`ClubFormTemplate.rosterMapping` (field keys only, never an answer) and edited
with the rest of the draft, so it is published and versioned with the form.
`roster-mapping.ts` holds the shape and every rule; `roster-add.ts` the two
steps.

- **Mapping:** the admin picks the roster type (youth member or staff) and which
  question fills each roster field (name, birth date, gender, class, role, up to
  two guardian contacts). The seeded Membership Application and Staff/Volunteer
  templates ship with a mapping pre-filled from their field keys, **off**; it
  applies until the template has its own stored mapping.
- **Protection rules** (checked in the builder, at publish, and again before the
  action is offered or used): the roster's birth date comes only from a field the
  template marks as a birth date and stays sealed; a birth-date field can fill
  nothing else; any other sensitive field can fill nothing; a health field can
  never be mapped (sensitive health answers are blocked by the rule above, and a
  health-looking question that nobody flagged is blocked by wording). The
  encrypted Health Record (#611) is never read or written from a form.
- **Who:** the club's director and deputy (or an admin acting as the director),
  for their own club. Registrars, Area Coordinators and conference staff never
  see the action.
- **Flow:** on a submitted form, **Add to roster** opens a review screen,
  pre-filled from the mapped answers (the open is audited like any open of a
  form with sensitive answers). Nothing is written until the director confirms.
  The director checks and edits the details, and the roster's own validation
  applies. It is always the current club year (only it is editable, #541). A
  form already filed against a member can only be linked to them, never add a
  new person. A member later removed from the roster counts as not added, so the
  form can be added again.
- **Duplicates:** the same name and birth date in the club and year offers
  **Link to existing member** instead. People are never merged; linking only
  records which member the form belongs to and changes nothing on the member.
- **Record:** the submission stores `rosterAction` (`ADDED` or `LINKED`),
  `rosterActionMemberId` and `rosterActionAt`, and also files itself against the
  member (`rosterMemberId`), so the form shows in the member's own list of forms;
  its answers never change. The applicant's address stays on the form. The
  action then reads "Added to roster" and links to the member. Add and link are
  audited (`CLUB_FORM_SUBMISSION_ADDED_TO_ROSTER`,
  `CLUB_FORM_SUBMISSION_LINKED_TO_ROSTER`) with ids and the template key only.
- **Birth date:** only the applicant's own birth-date question can fill the
  roster's birth date: the first birth-date question in form order that is not
  about a child or relative (the Staff form has five children's birth dates).
- **Gender:** both seeded forms (version 3) ask a required Male/Female question
  that maps to the roster's gender. Older submissions without it still work; the
  director picks it on the review screen.
- **Not mapped:** the roster has no address or member-contact field, so the
  applicant's address and own phone or email are not copied. The Membership
  Application's phone pre-fills the first guardian's phone.

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
hand-written change; so is a birth-date field that stops being one. Changing only
the birth-date class needs no re-seal, since both classes are sealed.

The re-seal runs in the **sync step**, `npm run club-forms:sync`, which
`docker-entrypoint.sh` runs after `prisma migrate deploy` and before the app
starts (run it by hand locally after `db:seed`). A system administrator can also
run the same `syncClubFormTemplates` from **Sync templates** on `/admin/club-forms`
(`POST /api/admin/club-forms/sync`, #742): it shows UPDATED / SKIPPED / unchanged
per form, and its audit entry (`CLUB_FORM_TEMPLATES_SYNCED`) holds counts only. It carries on past a form it refuses, reports every refusal
and exits non-zero. Until it has run for a version bump, writers refuse the
behind form ("temporarily unavailable"), the admin page shows "Needs sync", and
readers and the CSV restrict the union of the stored and the code's sensitive
keys. Writers also take a share lock on the template row with a 3 s
`lock_timeout` and answer "being updated" (`FORM_BUSY`) rather than wait behind
a re-seal.

## Club form builder (#712)

System administrators edit every form and create new ones at
`/admin/club-forms` (builder at `/admin/club-forms/<key>`; desktop only, phones
get `BuilderPhoneNotice`). Every route (`app/api/admin/club-forms/**`) runs the
cross-origin check and `requireSystemAdministrator` on each request.

- **Draft and publish.** A save stores the whole next-version spec in
  `ClubFormTemplate.draft` (the live columns do not change). Publish, in one
  transaction under the template's row lock, writes the draft to the live
  columns, bumps `version` by one and records the version in
  `ClubFormTemplateVersion` (frozen copies, add-only; the migration backfills
  each template's current version). `builder.ts` is the server side,
  `builder-domain.ts` the pure rules.
- **Validation** reuses `registrationFormDefinitionSchema` (unique keys, valid
  choices, ranked-choice min and max) plus club form limits (no pricing,
  capacity, calculated fields, attendee roster or payment) and returns issues
  keyed `field:<id>`, `section:<id>`, `removed:<key>` or `template`. Saves and
  publishes both check; a stale tab (`baseVersion`, `expectedDraftUpdatedAt`)
  is refused with `TEMPLATE_CHANGED`.
- **Old submissions** show and export on the version they were filled in on
  (`getClubFormTemplateAtVersion`, `versions.ts`). Sensitive and birth-date keys
  are the union of that version's and the current ones, so an older view can only
  be more restricted. The CSV has a column for every non-sensitive field any
  version had. A draft submission being edited moves to the latest version.
- **Sensitive-flag protection.** A field that was sensitive or a birth date in
  any published version keeps that flag (refused on save and publish) and cannot
  be deleted while any submission exists; it is hidden from new forms instead
  (`hiddenFieldKeys`: kept in the definition, left out of new fills, links and
  validation). Marking a field sensitive later re-seals existing answers in the
  publish transaction (`resealClubFormSubmissions`; fails, changing nothing, if
  encryption is not set up). The builder reads definitions only: no answer, sealed
  or plain, reaches it, its logs or its audit rows.
- **Sync.** Creating a form or its first publish sets `customizedAt`; the sync then
  skips it (logs it, prints `SKIPPED`) and it no longer follows the code's seed
  version, though a key the code seed later marks sensitive is still sealed in
  existing answers. An unpublished draft does **not** pause the sync: a seed
  version bump is still applied to the live columns (with the usual re-seal), so
  the live form stays fillable. The draft stays in place but goes **stale**
  (`draftBaseVersion` no longer matches `version`): the sync logs and prints
  `UPDATED <key>: draft is now stale` and still exits 0; save and publish refuse a
  stale draft (`TEMPLATE_CHANGED`, "The form was updated by a code change after
  this draft was started..."); the builder shows a notice and Discard. Discard is
  available whenever a draft exists. Never-edited seeds update from code as
  before. A seed that is behind the code cannot be edited until the sync has run.
- **Unfinished drafts.** A save accepts any draft that is structurally a draft
  (size-capped) and returns the full check's problems as warnings; publish runs
  the full check and the protection rules under the lock. A stored draft that no
  longer parses is shown with an error and a Discard button.
- **Hidden fields** are left out of every new-fill path (director page, draft
  edit, private link) and the server ignores answers to them. A draft saved again
  carries forward stored plain and sealed answers to hidden or removed fields
  (never returned to the client; anything that came out of the sealed value goes
  back into it, and an unreadable sealed value answers `SENSITIVE_UNREADABLE`). Views and prints omit a hidden field with no
  answer; the CSV formats each row with its own version's field and keeps
  headings unique.
- **Audit.** `CLUB_FORM_TEMPLATE_CREATED`, `_DRAFT_SAVED`, `_DRAFT_DISCARDED`,
  `_PUBLISHED`, `_ENABLED` and `_DISABLED` carry the actor, template key and
  version.
- A copy starts from the published version (not the draft), drops hidden fields,
  and starts as a disabled version 1.

## Private links

- One address, typed by the director. The email is queued in the link's own
  transaction and delivered after it commits (`after()` in the route; the
  outbox sweep retries).
- The email body holds a sentinel. The token is minted when the message is
  delivered (`prepareClubFormLinkBodyForDelivery`), only its SHA-256 is stored.
- If the email finally fails the link is withdrawn: a non-retryable error or
  running out of retries or a stale claim on the last attempt (`email-delivery.ts`),
  or a bounce, failure or suppression from the provider that actually applied
  (`resend-webhook-repository.ts`; a spam complaint arrives after delivery and
  does not withdraw the link), all through
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
