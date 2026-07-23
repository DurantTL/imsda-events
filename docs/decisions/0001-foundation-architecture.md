# ADR 0001: Foundation architecture

- Status: Accepted for the foundation review
- Date: 2026-07-22

## Context

IMSDA Events must grow beyond a single event while protecting the current Women’s Retreat workflow during migration. The team also needs a maintainable path from the WR26 App V2 concept to a secure operational platform without inheriting the club-only assumptions of CMMS-1.

## Decision

1. Build a modular monolith in Next.js and TypeScript. Domain boundaries remain explicit under `modules/`, but the application and database deploy together during the early phases.
2. Use PostgreSQL through Prisma as the future source of truth for IMSDA Events records.
3. Treat WR26 App V2 as the experience reference: calm operational layouts, a persistent event selector, staff/attendee thinking, desktop navigation, and event-day mobile navigation.
4. Treat every event operation as server-scoped. Authentication, active event membership, and capability checks happen before protected reads or writes.
5. Keep legacy systems read only until imports are repeatable, reconciliation is accepted, and a documented cutover is approved.
6. Add external systems later through adapters, an outbox, queued jobs, retries, and visible reconciliation state. External failures must not break the core registration transaction.

## Consequences

- The first slice contains no production authentication, payment collection, import, or external write path.
- People and households are permanent identities; registrations and attendee snapshots preserve event history.
- Global administration remains distinct from event membership.
- Feature completeness includes authorization, validation, audit behavior, recovery, and monitoring—not only the visible screen.
