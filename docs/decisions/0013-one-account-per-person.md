# ADR 0013: One account and one sign-in per person

Status: Proposed. The direction was decided by the Communication Director on 2026-09-30 (#554); this design awaits approval.
Date: 2026-09-30
Supersedes: the "attendee accounts live in their own table" and "staff can switch to attendee mode" parts of [ADR 0003](0003-attendee-accounts.md). Everything else in ADR 0003 stands.

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
   It asks for the email once and then:
   - **Person has staff access:** requires the staff password and the staff second factor
     (or a staff passkey), exactly as today. On success it issues **both** sessions: the staff
     session and the linked attendee session.
   - **Attendee only:** attendee password, Google or passkey, exactly as today, and it issues
     the attendee session only.
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
