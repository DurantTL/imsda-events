# ADR 0004: Attendee community

Status: Accepted
Date: 2026-07-30

## Context

The Women’s Retreat needs a shared attendee space during the event. Attendee
accounts now provide an identity, and active registrations provide the correct
event boundary, but staff must be able to pause participation, enforce conduct,
respond to reports, and remove the content after it is no longer operationally
useful.

Staff also need to inspect the experience before launch. The existing
staff-to-attendee preview is intentionally not impersonation, so it must not
create posts, replies, reports, or conduct acceptance on behalf of an attendee.

## Decision

### Access is event and registration scoped

Only a verified attendee account with an active registration for the event may
enter or mutate its community. A staff session can preview published community
content through the event workspace, but preview is read-only. Staff do not
silently acquire an attendee identity.

### Participation requires current conduct acceptance

Each event owns its conduct copy and version. Changing the copy increments the
version, and an attendee must accept that current version before posting or
replying. Reading remains available so a conduct change does not hide staff
updates or the context of a moderation decision.

### Conversation is deliberately shallow

The first release supports posts and one level of replies. It is not a general
social network: there are no private messages, follower graphs, reactions, or
deep reply trees. Staff can independently pause new posts and replies without
removing the existing record.

### Notifications are in-app and controlled by the attendee

Preferences are `NONE`, `REPLIES`, or `ALL`. Notifications are stored in the
application and shown in the attendee hub. Email, SMS, and push delivery are not
implied by this preference and require separate communication policy work.

### Reports and moderation remain distinct

An attendee report creates a review item; it does not automatically hide a
post. Staff with communications management permission may hide, restore, or
remove content and resolve or dismiss reports. Creation, reporting, moderation,
settings changes, and report resolution are audited.

### Retention follows the event

The event owns a retention period measured from its end time. The authenticated
outbox sweep also removes expired community content, so there is one operational
scheduler and one secret to monitor. Cascades remove replies, reports, and
notifications with their posts.

## Consequences

- Community is disabled by default for every event and requires deliberate
  staff configuration.
- A cancelled or waitlisted registration cannot continue participating.
- Staff preview can verify copy and moderation state but cannot be mistaken for
  a real attendee test.
- Notifications do not generate external messages, avoiding an accidental new
  bulk-email channel.
- Removing a post is a moderation state until retention cleanup; staff actions
  remain auditable.

## Alternatives considered

**Use staff users for every participant.** Rejected because it widens the staff
identity and permission boundary to the attendee population.

**Allow management-link participation without an account.** Rejected because a
forwarded bearer link would become a posting identity and author attribution
would be unreliable.

**Automatically hide every reported post.** Rejected because one participant
could suppress another without staff review.

**Email every community update.** Rejected because it creates an external
delivery and preference problem larger than the retreat’s immediate need.
