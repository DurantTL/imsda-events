# ADR 0002: Unified IMSDA operations platform

Status: Accepted
Date: 2026-07-27

## Decision

IMSDA Events will become the single staff-facing application for event operations and the club-management capabilities currently implemented in CMMS-1. The CMMS repository will not be merged mechanically. Its useful domain concepts will be rebuilt as modules on the current IMSDA Events foundation and migrated with preserved source identifiers.

The application remains a modular monolith with one IMSDA-owned PostgreSQL database. External systems remain authoritative only for the information they provide:

- eAdventist: church organizations, organization codes, and authorized officers.
- Sterling Volunteers: background-screening workflow and clearance status.
- UltraCamp: camp accounts, people, sessions, reservations, housing, and other camp-operational references.
- IMSDA Events: events, forms, registrations, club rosters, consent, event medical summaries, check-in, assignments, communications, and reporting.

Every externally sourced entity must use a stable provider identifier. Name or email matching alone is not an acceptable synchronization key. Each connector must support preview, conflict review, apply, reconciliation, and an audit history.

## Event billing

Events choose one billing policy:

1. Individual payment, using the event payment provider.
2. Post-event church billing.
3. No charge.

Camp group events normally use post-event church billing. Registration status and billing status are separate. After the event, staff reconcile actual attendance and chargeable items, review and lock a settlement, and export a treasury billing report. Treasury remains responsible for issuing the church invoice.

UltraCamp must not create a second payment ledger for these events. Its role is operational reconciliation unless an event explicitly designates UltraCamp as the payment owner.

## Medical and emergency operations

IMSDA Events is the default source for event-specific medical and emergency information. The system will provide an event-scoped camp medical workspace with:

- fast attendee search and badge/QR resolution;
- critical allergies, conditions, medications, emergency contacts, consent status, and last-confirmed timestamps;
- club, housing, campsite, room, IMSDA, and UltraCamp references;
- a medical-exception roster and a separately scoped dietary report;
- audited viewing, searching, printing, and exporting;
- temporary camp-medical roles and reasoned, MFA-protected emergency access;
- a confidential printable event packet for the camp office;
- an optional encrypted offline packet on designated managed devices with automatic expiry and revocation.

UltraCamp medical pass-through is optional and may be enabled only after a supported medical API, access controls, and data-handling agreement are confirmed. Until then, only operational identifiers and medical-form completion status may be synchronized.

## Delivery order

1. Finish and land the active WR26 form, import, shirt-size, and badge work.
2. Establish the system-administrator command center.
3. Add churches, clubs, club years, rosters, consent, and external identities.
4. Add event billing policies and post-event treasury settlement.
5. Add the camp medical workspace and printable emergency packet.
6. Add eAdventist organization synchronization.
7. Add UltraCamp operational synchronization.
8. Add Sterling clearance synchronization, starting with reviewed CSV apply and later using an approved API.
9. Port remaining CMMS class, honors, attendance, rollover, reporting, TLT, nomination, and Camporee modules.
10. Migrate historical CMMS records, verify parity, make CMMS read-only, and retire it.

## Consequences

- Staff receive one application and one access model.
- Existing IMSDA registration, finance, communications, import, check-in, and form systems remain authoritative.
- Sensitive medical and screening information is minimized instead of being copied indiscriminately between providers.
- New provider integrations require explicit source ownership, stable identifiers, reconciliation, and audit evidence.
- CMMS authentication, deployment updater, duplicate event/payment tables, and older framework foundation will not be ported.
