# ADR 0003: Attendee accounts

Status: Accepted
Date: 2026-07-28

## Context

Registrants have no identity. A registration is reachable through a private link carried in an email — a bearer token with no password, no profile, and no memory. That was a deliberate simplification and it has held up: someone who can open their inbox can see their registration, pay a balance, and choose a shirt size without an account existing.

It stops working the moment anyone needs to be *recognised* rather than merely *let in*. A registrant with three registrations has three unrelated links. Someone who deletes the email has nothing. And a discussion feature — the reason this is being scoped now — has no author to attach a post to, because there is nobody signed in.

`User` is staff-only. Every permission in the system is event-scoped and granted by a membership, and the sign-in path carries MFA and the rules protecting roster export and sensitive data.

## Decision

### Attendee accounts live in their own table

`AttendeeAccount` is separate from `User`, with its own credentials, sessions, and sign-in route.

The alternative — attendees as `User` rows with no role and no memberships — means every existing permission check runs against a far larger population, and one careless query is the difference between an attendee and staff access. The staff path already carries MFA and sensitive-data rules; widening who flows through it is the kind of change that fails quietly and badly.

The cost is accepted: two sign-in paths, two session types, and some duplicated recovery logic.

### An account claims registrations by verified email

Sign-up verifies an email address. The account then reaches every registration whose contact email matches, and nothing else.

Verification is the whole control. An unverified address claims nothing, because claiming on an unverified address is just asking to be given somebody else's registration.

Two consequences are accepted deliberately:

- **A shared family address sees several registrations.** That is usually correct — one parent registers the household — and where it is not, the household already shares the inbox those private links were sent to. The account changes nothing about who could already see what.
- **A registration whose contact email is wrong is unreachable by account.** Imported rows carry whatever the workbook held. Staff can already correct a contact address, and doing so is what attaches it.

Matching is on the registration's contact email, normalised the same way the rest of the system normalises addresses. It is never on name.

### Staff can switch to attendee mode, for their own registrations only

Staff register for events too, and asking them to keep a second password for the same person is the kind of friction that produces shared credentials.

A `User` may be linked to an `AttendeeAccount` when both hold the same **verified** email. Switching context then shows that account's registrations.

The rule that matters: **attendee mode shows the staff member their own registrations, never anyone else's.** It is a context switch, not an impersonation feature. Staff who need to see another person's registration already have the roster, which is permissioned, audited, and the correct tool. If impersonation is ever wanted it must be a separate, audited capability with its own decision — not a side effect of this one.

The implemented switch is an authenticated same-origin POST that accepts no
attendee identifier. The server resolves the staff session, derives the only
eligible attendee account from the normalized staff email, creates the separate
attendee session/cookie, and preserves the staff session for a visible return
path. If no active verified account matches, the UI offers only the read-only
event preview.

### An account may hold a second factor, but is not gated on having one

Attendee accounts support TOTP enrolment from the start, using the same
machinery staff use. Building the capability later is far more expensive than
building it now: retrofitting a second factor means a migration, a recovery-code
scheme, and a rollout across accounts that already exist.

Holding one is **not** a condition of having an account. Someone registering for
an event should not be made to install an authenticator to do it, and a barrier
at that point does not protect anything — the registration they are creating is
one they already know about.

The rule inverts when an account reaches further than its own registrations.
Club rosters and medical information are the cases already known to be coming,
and enrolment becomes **required** to reach either. That is a scope rule, not an
account rule: the factor is required by what is being touched, not by who is
touching it.

### Editing takes a fresh emailed code, and never a link

Reading a registration needs only the account. Changing one takes a one-time
code, sent to the account's verified address and entered in the session that
asked for it.

**A code, not a link, and this is the point of the decision.** A link in an
inbox is a bearer token: it works for whoever opens it, it survives forwarding,
it is logged by mail scanners, and it grants its power somewhere other than
where the request came from. A code has to be carried back into the session that
requested it, which binds the change to the person making it. The private
management link already carries the weaknesses of a link; adding a second link
to authorise editing would double them rather than answer them.

The code is short-lived, single-use, invalidated when a new one is requested,
and rate limited per account.

### How much an edit costs is a policy, not a constant

What each change requires is stored, chosen per event, and inherited from the
platform default the way every other event default is. It is not a constant in
the code, because the answer is already known to change: the Women's Retreat
needs the lenient version this year, and later events should start strict.

Two policies to begin with.

**`TIERED`** — what the Women's Retreat runs:

| Change | What it takes |
| --- | --- |
| Viewing a registration | The account |
| Shirt size, meal choice, and similar per-attendee answers | The account |
| Contact details, cancellations, transfers | Account plus emailed code |
| Medical information, club rosters (when built) | Account plus enrolled second factor |

**`VERIFY_EVERY_EDIT`** — the intended default for new events: every change above
viewing takes the emailed code, and the bottom row still takes the factor.

Shirt size sits outside the code requirement under `TIERED` deliberately. The
reviewed shirt-size batch mails a private link precisely because a migrated
registrant has no account yet, and putting a code in front of that answer would
strand the campaign it was built for. A wrong shirt size costs a wrong shirt,
which is not what a verification step is for.

The bottom row is exempt from the policy in both directions: medical and club
data require the enrolled factor whatever an event has chosen. A per-event
setting may add friction and may not remove it, or the setting becomes a way to
turn off the protection it exists to describe.

Following the rule platform settings already established, changing the default
never rewrites an event that already exists. Tightening the default for next
year's events cannot quietly re-gate a campaign already in flight — which is the
entire reason the Women's Retreat can keep the lenient policy while everything
created after it starts strict.

### What an account does

In priority order, each independently shippable:

1. **See every registration across events.** Replaces hunting for the right email. The first slice and the one carrying most of the value.
2. **Keep a profile.** Name, contact details, shirt size, dietary and accessibility needs — held once instead of retyped per event.
3. **Pay a balance.** Needs Square configured; otherwise identical to the existing payment path.
4. **Prefill a new registration.** Touches the public registration flow, which is load-bearing and well tested, so it goes last and behind the others being proven.

Community and discussion features are **not** in scope here. This ADR exists so they have an author to attach to.

The community was subsequently implemented as its own event-scoped module under
[ADR 0004](0004-attendee-community.md). That does not change this account
boundary: community authors are attendee accounts, and staff preview is not
impersonation.

## Consequences

The private link does not go away. It stays the path for someone who will never make an account, and it is how a migrated registrant reaches self-service the first time. Accounts are additive; a registrant who ignores them loses nothing.

Sign-up is a public, unauthenticated, email-sending endpoint — the most abusable surface the platform will have — and the step-up code is a second one. Both need the existing rate limiting, per address and per source, or the platform becomes a way to send mail to strangers. Enumeration has to be considered in every response too: "an account exists for this address" is not something a stranger may learn.

Nothing here grants an `EventPermission`. An attendee account cannot hold one, and the type system should keep it that way rather than relying on a runtime check.

## Alternatives considered

**One table with roles.** Rejected above: it widens the population flowing through the staff auth path.

**Confirmation code plus email to claim.** Materially harder to claim someone else's registration, and it handles imported rows with duplicated addresses. Rejected as the default because it puts friction on every registrant to prevent a case the shared inbox already permits. Worth reconsidering if a claim is ever reported as wrong.

**No accounts; extend private links.** Longer-lived links with more on the page. Cheapest, and genuinely sufficient for everything except being recognised — which is the one thing actually being asked for.

**A magic link to authorise editing.** One click instead of typing six digits, and the flow staff already know from password reset. Rejected: a link is a bearer token that works for whoever opens it, survives forwarding, and is followed by mail scanners. The private management link already carries those weaknesses because it has to reach someone with no account at all. An edit made *from* an account has a session to bind to, and a code is what binds it.

**Hardcoding the tiers.** Simpler, and correct for exactly one event. Rejected because the requirement is already known to change: the lenient version is what the Women's Retreat needs now, and strict is what later events should start from. A constant would make that a code change and a deploy, and would offer no way for two concurrent events to differ.

**Requiring a second factor to hold an account.** Rejected as a barrier that protects nothing at the moment it is imposed — the registration being created is one the person already knows about — while costing the platform registrations from anyone unwilling to install an authenticator to sign up for a retreat.
