# ADR 0013: One account and one sign-in per person

Status: Proposed. The direction was decided by the Communication Director on 2026-09-30 (#554); this design awaits approval. The implementation plan and slices are at the end; table-by-table detail is in [docs/SINGLE-ACCOUNT-MIGRATION.md](../SINGLE-ACCOUNT-MIGRATION.md).
Date: 2026-09-30
Supersedes: the "staff can switch to attendee mode" part of [ADR 0003](0003-attendee-accounts.md), and the "two separate accounts per person" outcome of its "attendee accounts live in their own table" part. **Proposed, pending Caleb's answer to Open question 2:** under the link model below the two tables are kept (one `User`, one `AttendeeAccount`, linked 1:1), so ADR 0003's table separation itself is not undone; if the answer is a physical single table, this ADR is revised. Everything else in ADR 0003 stands.

## Context

ADR 0003 kept staff (`User`) and registrants (`AttendeeAccount`) apart: two tables, two
credentials, two sign-in pages, and two session cookies. Its reason is still sound: every
`EventPermission` hangs off a `User`. Letting a much larger population through the staff
sign-in path is the kind of change that fails quietly.

The product has since changed underneath it:

- Area coordinators, event managers and club directors attend almost every event, not
  only club events. Club roles (`ClubDirectorGrant`, `AreaCoordinatorGrant`) already live on
  `AttendeeAccount`, so the same person is split across two logins.
- A system administrator with no attendee account can't use "act as" (#442) to see what a
  director or coordinator sees.
- Profile lives in two places (#543, #646), and people are asked for a second password for
  the same email.

The director's decision (#554): "really it is all one system." Each person has **one
sign-in**. Staff, coordinator, director and attendee are **roles on that person**, and every
staff member automatically has the attendee side.

## Decision

### One person, one sign-in, one profile, with the two tables kept underneath

About forty tables record their actor as either a `User` or an `AttendeeAccount` (audit
authors, grants, roster edits, club registrations, orders, honors, transfers …).
Physically merging the tables would rewrite every one of those foreign keys and every
permission query in a single migration. That can't be done safely within weeks, and it isn't
needed for what people actually experience.

Instead:

1. **Every staff `User` is linked 1:1 to an `AttendeeAccount`.** Add a unique, nullable
   `User.attendeeAccountId`. The linked account is that person's attendee side:
   registrations, club roles, coordinator grant and profile.
   - Every new staff user gets one automatically: an existing verified account with the same
     normalised email is linked, and otherwise one is created. The staff invite/activation
     already proves control of the email, so the created account starts verified.
   - Giving an existing attendee a staff role creates the `User` linked to *their* account.
     No second person is ever created.
2. **One sign-in page** (`/sign-in`; the old `/login` and `/account/sign-in` redirect to it).
   It is **one form with one submit** (see "The single sign-in page, with no account
   enumeration" below); it must not change shape after the email is typed. What it grants:
   - **Staff access:** exactly as today, either the staff password followed by the staff
     second factor, or a user-verified staff passkey on its own. On success it issues **both**
     sessions: the staff session and the linked attendee session.
   - **Attendee access only:** attendee password, Google or passkey, exactly as today, and it
     issues the attendee session only.
   - A sign-in method that is weaker than the staff rules (such as Google alone) **never**
     issues a staff session. The person gets their attendee side and a prompt to finish
     staff verification. **This keeps ADR 0003's core security property: staff permissions
     are reached only through the staff sign-in rules, with MFA.**
3. **Role-aware landing** (#108): after sign-in, a person with one role lands on it. A person
   with several gets a small chooser (Staff workspace, My club, Area coordinator, My
   registrations), and the header offers a switcher with no second sign-in.
4. **One profile page.** Name, phone and other personal fields live on the attendee side and
   show in both places. Staff-only fields (job title, bio) appear as an extra section for
   people with staff access.
5. **Sign-out ends both sessions.** Revoking or suspending staff access ends the staff
   session only. The person keeps their attendee side.
6. **Act as** (#442) always works for staff, because every staff member now has an attendee
   side. It stays tied to the staff session and never widens what the attendee side can see.

The sessions, cookies and permission checks stay separate internally. An `AttendeeSession`
can still never be resolved as a staff session, and nothing grants an `EventPermission` to
an attendee account. What changes is that people no longer see or manage two accounts.

### What stays exactly as it is

- Private registration links keep working, and nobody needs an account to register.
- Registrations still attach to an attendee account only by verified email.
- MFA is still required for staff, and for any attendee-side scope that reaches club rosters
  or medical information (ADR 0003, ADR 0005).
- The per-event edit policies (`TIERED`, `VERIFY_EVERY_EDIT`).

### Physically merging the tables later

A full single-table merge remains possible later, one actor column at a time, once the link
exists everywhere. It is not part of this decision and is not needed for October.

## Migration and cutover

Linking existing staff to existing attendee accounts connects two identities. That is an
identity decision, so it is a **human-approved step**.

1. **Schema:** add `User.attendeeAccountId` (nullable, unique). This is additive and changes
   no behaviour.
2. **Dry run (read-only report):** for every `User`:
   - **Link:** a verified attendee account has the same normalised email.
   - **Create:** there is no attendee account for the email.
   - **Needs review:** the attendee account for the email is unverified or disabled, or
     already linked. Also flagged here: a staff member who appears to use a different email
     for attendee registrations (same name and phone on another verified account). That case
     is listed only and never linked automatically.
3. **Director reviews the report and approves.** Only then does the apply step run. It is
   audited, can be re-run safely, and runs one person per transaction.
4. **Switch sign-in over:** the unified sign-in page and role-aware landing go live. The old
   routes redirect. Existing sessions stay valid, so nobody is signed out mid-task.
5. **Rollback:** the old sign-in pages stay in the code behind a switch for two weeks after
   cutover. Links can be removed individually without touching registrations.

**Timing:** build now. Cutover happens **after the Women's Retreat (Oct 9–11)**, targeted for
Oct 13–14. There are no sign-in changes on the live site between Oct 6 and the end of the
retreat. Retreat registrants are unaffected either way: they use private links or their
existing attendee accounts, which keep working.

## Consequences

- One sign-in and one profile per person. Staff never keep a second password for their
  attendee side.
- The staff sign-in path still carries the whole staff population and no one else.
  Attendee-only people never get a staff session, which removes ADR 0003's original concern.
- Code paths that currently branch on "staff or attendee" keep working. New work should
  resolve "the person" from either session through one helper rather than reading the two
  cookies directly.
- An attendee-only sign-in method (Google) on a staff person's account is allowed for the
  attendee side only. Support needs to explain why "Sign in with Google" doesn't open the
  staff workspace.

## Alternatives considered

- **Merge into one table now.** This rewrites about forty actor relations and every
  permission query at once, weeks before the deadline. Rejected for October. It stays
  available as a later, gradual step.
- **Keep two accounts and improve the "switch to attendee mode" button.** This doesn't meet
  the decision ("everyone has both automatically"), and it leaves staff without an attendee
  account unable to use act-as.
- **Let any attendee sign-in method open the staff workspace.** Rejected: it would bypass
  staff MFA.

---

# Implementation plan

This part turns the decision above into reviewable slices. It adds no product decision
except where it says **Open question**, and these new proposed rules, which **need sign-off**
before they are built:

- suspending a person's attendee side ends both sessions;
- slice (d) disables the attendee password (`disabledAt`) for people with staff access;
- an attendee account is auto-created for staff at activation;
- a pair whose staff side has a role but no active second factor and no passkey
  (`STAFF_NO_SECOND_FACTOR`) is blocked from linking until the person enrols, which is stricter
  than today's enrol-at-next-sign-in gate.

The read-only dry run moved into slice (a) (it only reads, so it can ship now); merging and
linking stay in slice (d). The table-by-table inventory, backfill, rollback and
verification queries are in [docs/SINGLE-ACCOUNT-MIGRATION.md](../SINGLE-ACCOUNT-MIGRATION.md).
The read-only dry run is `npm run accounts:dry-run`.

## Decisions on record (#554 comments)

| Date | Who | Decision |
| --- | --- | --- |
| Sept 28 | Caleb | Reversing ADR 0003's separate-accounts rule is approved. |
| Sept 28 | Caleb | **Guest registration stays.** After registering, people are clearly offered an account so their details are saved for next time. |
| Sept 28 | Caleb | **Two-step is optional for accounts with no staff role.** |
| Sept 28 | Caleb | **People with both accounts under different emails stay separate.** It only affects the two system administrators; no linking tool is built. |
| Sept 30 | Communication Director | One account, one sign-in per person. Staff, coordinator, director and attendee are roles on the person. Every staff member automatically has the attendee side. |
| Sept 30 | Communication Director | Carried over from ADR 0003: event-scoped permissions; **two-step required for staff and for any scope that reaches rosters or medical data**; verified-email claiming; private registration links. |
| Sept 30 | Communication Director | Cutover after the Women's Retreat (Oct 9-11). Merging existing accounts in production runs only after a dry-run preview and the director's approval. |
| Oct 1 | Director | The work is **on hold and lowest priority**; the director says when to start. |
| Oct 6 | Director | Approved writing the plan and the read-only dry run. The cutover still waits for his go-ahead. |

Where the comments disagree on timing, the later one should win: the Sept 29 note ("slices b
to e wait until after Camp Meeting 2027") is older than the Sept 30 cutover date and the Oct 1
hold. See **Open questions**.

## Target model

As decided above: two tables stay, and a unique nullable `User.attendeeAccountId` links the
staff `User` to that person's `AttendeeAccount`. The attendee account is the person's
profile, registrations, club roles and coordinator grant. The `User` row holds staff
credentials and event roles. Nothing is moved, deleted or copied between tables.

Two rules make the link safe:

1. **Same verified email.** A link is only created between a `User` and an `AttendeeAccount`
   whose normalised emails are equal and whose attendee email is verified. Different-email
   people stay separate (Sept 28), so there is no manual "link these two" tool.
2. **Emails stay in step.** While linked, the two emails must be equal. An email change on
   either side is one transaction that changes both and re-verifies, or is refused. (Open
   question: whether to allow it at all while linked.)

## Sessions and authorization

- Staff and attendee sessions stay separate tables and cookies. Nothing grants an
  `EventPermission` to an attendee account, and an `AttendeeSession` is never resolved as a
  staff session.
- One helper, `resolvePerson()`, answers "who is this and which roles do they hold" from
  whichever sessions the browser carries. New code uses it instead of reading both cookies.
- Staff authorization is unchanged: `getCurrentSession()`, event memberships, system admin,
  MFA, step-up.
- **What a staff session requires, exactly** (unchanged from today): either (a) the
  `AuthCredential` password followed by an ACTIVE `UserMfaEnrollment` code or recovery code,
  or (b) a user-verified `UserPasskey` assertion on its own (`modules/access/passkeys.ts`).
  Nothing else, and never an attendee credential. No extra prompt is added after a staff
  passkey, and no password-plus-passkey path is created.
- **An `AttendeeCredential` password, an attendee passkey or Google can only ever yield the
  attendee session**, whatever second factor follows. An attendee password followed by a staff
  authenticator code is still not a staff sign-in. A person holding a staff role who signs in
  that way sees their attendee side and a prompt to finish staff verification.
- **When an email has both rows,** the single form checks the staff credential for staff
  access and the attendee credential for attendee access, **independently**: the same typed
  password may satisfy one, both or neither, and each outcome is decided on its own.
- Second step by scope, not by page: required for any staff role, and for any scope that
  reaches rosters or medical information (ADR 0003, 0005). It stays **optional** for an
  account with no staff role and no club or coordinator role. The club and coordinator
  gate (`accountNeedsSecondStep`) is unchanged.
- Sign-out ends both sessions. Revoking staff access ends the staff session only.
  Suspending a person's attendee side ends both.

## The single sign-in page, with no account enumeration

`/sign-in` replaces `/login` and `/account/sign-in`, which redirect to it. The flow "ask for
the email, then show the staff or attendee method" described under Decision **must not** be
built literally: a page that changes after the email is entered tells a stranger whether that
email holds a staff account.

The requirement is therefore:

- **One form, one submit.** Email and password go together. The response for an unknown
  email, a wrong password, a locked account and a disabled account has the same shape and
  status and the same timing (a dummy password hash is verified when no account exists).
- **The second step appears only after the password is right**, and only for people who need
  it. Someone who already knows the password learns nothing new.
- **Passkeys use the discoverable-credential flow** (no email typed), and Google is its own
  button. Neither reveals whether an address has an account.
- Rate limits stay per address and per source, and count identically for known and unknown
  addresses. The staff lockout and step-up rules are unchanged.
- Support text never says "this address has a staff account".
- The same rule covers every other place an address is typed, each answering identically
  whether or not the address exists, and whether or not it belongs to staff: **password
  reset** (always "if an account exists, we sent a link"), **attendee sign-up for an
  existing email** (same confirmation, no "already registered"), the **post-registration
  "create an account" offer** (shown the same way; it never reveals an existing account),
  and the **Google callback for a staff email** (lands on the attendee side with the same
  neutral prompt as any other address, never an error naming staff).

## Act as (#442) and the club second step (#484)

- **Act as** already runs entirely inside the staff session (a `StaffActAs` row tied to the
  `UserSession`), so it works for staff with no attendee account today. What the link fixes
  is the *attendee mode* switch (`findSwitchableAttendeeAccountForStaff`), which returns
  nothing for staff without an attendee account. After slice (b) it uses the link. Act-as
  keeps its attribution to the staff user and never widens the attendee side.
- **The club second step** (`accountNeedsSecondStep`, `AttendeeSession.secondFactorVerifiedAt`)
  stays on the attendee session. A person who signs in with the staff factor gets both
  sessions with `secondFactorVerifiedAt` set on the attendee one, so a staff director is not
  asked twice. Google-only sign-in does not set it, so club pages still ask.

## Risks

- **Sign-in and permissions everywhere.** Each slice needs its own security review.
- **Enumeration** through response shape, status, timing or rate-limit messages (above).
- **A weaker method issuing staff access.** Tests must prove every non-staff-grade method
  yields the attendee session only.
- **Wrong link.** Equal email is not proof of one person (a shared family or office
  mailbox). The dry run flags duplicates and unverified emails, and a human approves each link.
- **Irreversible loss** if tables were merged rather than linked. The link model avoids it:
  rollback is clearing the column.
- **Email drift** between linked rows (rule 2).
- **Actor columns.** There are 170 actor and owner columns on 109 models (the "about forty"
  above undercounted), 48 of them plain strings with no foreign key. Linking does not touch
  them, but any later physical merge must repoint every one.
- **Cutover with live sessions.** Existing sessions stay valid, and the switch is read per
  request, not a data change.
- **Support load** from "why does Google not open the staff workspace".

## Slices

Each slice is its own PR with its own review. Production data steps (backfill and apply) are
human-gated and never run from CI.

**(a) Link column, plan and read-only tooling. No behaviour change.**
- The plan, the dry run, its tests and `docs/SINGLE-ACCOUNT-MIGRATION.md` ship first (this PR).
- Then an additive migration: `User.attendeeAccountId`, nullable, unique, `ON DELETE SET NULL`.
  No backfill in the migration; every row starts `NULL`. No code reads or writes it yet.
- Acceptance: CI migrates and seeds a clean database; the schema-drift check is clean; all
  existing tests pass unchanged; `SELECT count(*) FROM "User" WHERE "attendeeAccountId" IS NOT NULL`
  is 0 after deploy; dropping the column is tested on a copy.

**(b) One resolver and authorization.**
- `resolvePerson()`; new staff users get a verified linked attendee account at activation;
  granting a staff role to an existing attendee creates the `User` linked to their account;
  attendee mode, act-as and the profile page use the link.
- Acceptance: a staff user without an attendee account gets one at activation; no path issues
  a staff session from an attendee-grade method (a test per method); the existing permission
  suite is green; act-as and club second-step tests are green; behind a switch, off by default.

**(c) The single sign-in page.**
- `/sign-in`, with `/login` and `/account/sign-in` redirecting when the switch is on.
- Acceptance: identical status, body shape and timing for unknown, wrong-password, locked
  and disabled cases (tests, including a timing-equalisation check); staff MFA, passkey and
  rate-limit tests unchanged; a staff person gets both sessions, an attendee-only person
  gets one; **attendee password plus a valid staff TOTP code yields no staff session**
  (likewise attendee passkey and Google); with both rows present, the staff and attendee
  credentials are checked independently; password reset, attendee sign-up for an existing
  email, the post-registration "create an account" offer and the Google callback for a staff
  email each respond identically for existing, unknown and staff addresses (tests);
  guest registration still works with no account; the post-registration offer to create an
  account is shown.

**(d) Link tooling (preview and apply).**
- The slice (a) dry run feeds a preview and apply tool: one person per transaction, audited,
  re-runnable, refusing pairs the dry run marks `blocked`.
- Acceptance: apply refuses without a recorded director approval; preview and apply agree on
  the pair list; applying twice changes nothing the second time; every conflict class has a
  test; nothing applies automatically; the verification queries in the migration doc are
  clean after a run on a copy of production.

**(e) Remove the old paths.**
- Delete the redirect shims, the "switch to attendee mode" flow and the duplicated recovery
  code, after the two-week rollback window.
- Acceptance: no references to the removed routes; the switch is gone; full verify is green.

## Timing and gates

- No sign-in change on the live site between Oct 6 and the end of the Women's Retreat
  (Oct 9-11).
- The cutover is slices (b) and (c) turned on after the retreat, and only when the director
  says to start (Oct 1 hold).
- **Production linking runs only after a dry-run preview and the director's approval.**
  Merging, deployment and production migrations stay human-only (AGENTS.md).

## Open questions

1. **Timing.** The Sept 29 comment waits for Camp Meeting 2027; the Sept 30 comment cuts over
   right after the retreat; the Oct 1 comment puts everything on hold. Which governs?
2. **Link or merge.** This ADR keeps two tables. The issue text says "a single account model;
   `User` is the likely base". Confirm the link model is the intent.
3. **Email changes while linked** (rule 2): change both together, or forbid?
4. **Attendee passkey as a staff factor (D2).** Can an attendee passkey count as a staff
   second factor? **Default: no.** It stays attendee-grade; only `UserPasskey` counts for staff.
5. **Staff at activation:** create a verified attendee account automatically (this ADR), or
   only when they first use an attendee feature?
