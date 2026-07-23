# IMSDA Events

IMSDA Events is the new multi-event operations platform for the Iowa-Missouri Conference. The current workspace includes seven no-code registration templates, modular fields, repeatable household/group rosters, conditional visibility, capacity and ranked-interest tracking, scheduled pricing, bounded promo codes, auditable lifecycle/waitlist actions, staff-only registration transfer and attendee substitution, public all-attendee event updates, private self-service links, durable email delivery, and Square Sandbox checkout alongside the authenticated staff workspace.

> Foundation safety boundary: all included names, emails, phone numbers, confirmations, and payment references are fictitious `.test` data. This application does not write to WR26 Google Apps Script, Google Sheets, WordPress, FluentCRM, UltraCamp, eAdventist, Sterling Volunteers, SMS, or push services. Optional external email and Square integrations remain disabled until their credentials are supplied; Square defaults to Sandbox and production additionally requires an explicit safety unlock.

## Technology

- Node.js 20.9 or newer
- Next.js App Router, React, TypeScript, and Tailwind CSS
- PostgreSQL 16 and Prisma 6
- Zod environment and route validation
- Vitest for unit tests
- Docker Compose for the local database

## Local setup

1. Install dependencies and create local environment configuration:

   ```bash
   npm install
   cp .env.example .env
   ```

2. Start PostgreSQL:

   ```bash
   docker compose up -d postgres
   ```

   (Naming the `postgres` service starts only the database, which is what local
   development needs. `docker compose up` alone now also builds and runs the app
   container — see [`docs/DEPLOY-DOCKER.md`](docs/DEPLOY-DOCKER.md).)

3. Apply the committed migrations, load fictitious seed data, and publish the current local demo form:

   ```bash
   npm run db:deploy
   npm run db:seed
   npm run db:refresh-demo
   ```

4. Start the application:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000). The root route redirects to staff sign-in.

   Local seeded credentials:

   ```text
   Email: admin@imsda-events.test
   Password: IMSDA-Local-2026!
   ```

   The same password is seeded for the `registration@`, `finance@`, `communications@`, `checkin@`, `readonly@`, and `system@imsda-events.test` role-test accounts. All are fictitious and local-only.

   The public Women’s Retreat form includes the fictitious promo code
   `LOCAL10` after `npm run db:seed` or `npm run db:refresh-demo`. It applies
   10% off with a $50 maximum, $100 minimum subtotal, and at least 25 local
   test uses remaining after each demo refresh.

To stop the local database without deleting its volume, run `docker compose down`.

### Square Sandbox checkout

Leave the Square values blank for a friendly pay-later/unconfigured experience.
To test card checkout, copy Sandbox-only values into `.env` for
`SQUARE_APPLICATION_ID`, `SQUARE_ACCESS_TOKEN`, `SQUARE_LOCATION_ID`, and
`SQUARE_WEBHOOK_SIGNATURE_KEY`. Configure Square's notification URL to exactly
match `SQUARE_WEBHOOK_NOTIFICATION_URL`, then subscribe to `payment.created`,
`payment.updated`, `refund.created`, and `refund.updated`.

The Web Payments SDK appears on a private registration management page only
when the immutable submission selected card, or a promoted waitlist registrant
explicitly chooses card, and a positive server-derived balance remains.
Promoted registrants see card and pay-later totals before choosing; the card
fee is recomputed once from the preserved discounted subtotal. Card data is
entered directly in Square's hosted fields; the application stores neither
card data nor Square's short-lived source token.
See [`modules/payments/README.md`](modules/payments/README.md) for the
idempotency, webhook, refund, and production-safety boundary.

## Verification

```bash
npm run lint
npm run typecheck
npm run test
npm run build
npm run verify
```

`npm run verify` runs lint, generated route types plus TypeScript, unit tests, and the production build. CI additionally starts PostgreSQL, applies the migration, and seeds a clean database before verification.

With PostgreSQL and the development server running, the live concurrency/integration checks are:

```bash
npm run test:public-capacity
npm run test:public-access
npm run test:public-messaging
npm run test:public-roster
```

## Database commands

| Command | Purpose |
| --- | --- |
| `npm run db:generate` | Regenerate the Prisma client. |
| `npm run db:migrate -- --name <name>` | Create and apply a development migration. |
| `npm run db:deploy` | Apply committed migrations without creating new ones. |
| `npm run db:seed` | Upsert fictitious `.test` foundation data. |
| `npm run db:refresh-demo` | Publish the current Women’s Retreat template only in the seeded localhost database. |
| `npm run db:studio` | Open Prisma Studio against the configured database. |

Never place real attendee exports, medical details, production identifiers, or credentials in migrations, seeds, tests, issues, screenshots, or commits.

## Current API

- `POST /api/auth/login` validates a staff credential and creates an eight-hour database session.
- `POST /api/auth/logout` revokes the current session and expires its HttpOnly cookie.
- `POST /api/auth/password-reset/request` creates a single-use 30-minute reset token. Development returns a local link; production email delivery is not connected.
- `POST /api/auth/password-reset/complete` updates the scrypt password hash and revokes all prior sessions.

- `GET /api/health` checks the application and PostgreSQL connection.
- `GET /api/events` returns only events assigned to the development session user.
- `GET /api/events/:eventId/overview` validates the event ID, verifies active event membership and `VIEW_EVENT`, then returns database-derived totals.
- `GET|POST /api/events/:eventId/registrations` lists or creates registrations after event-scoped permission checks.
- `GET|PATCH /api/events/:eventId/registrations/:registrationId` loads or edits a registration and its primary attendee.
- `POST /api/events/:eventId/registrations/:registrationId/lifecycle/:action` performs an explicit cancel, reactivate, waitlist, or promote transition with capacity release/restore, audit history, and transactional notices.
- `POST /api/events/:eventId/registrations/:registrationId/transfer` atomically changes the registration owner/contact while preserving all registration facts, revokes prior private access, and queues notices.
- `POST /api/events/:eventId/registrations/:registrationId/attendees/:attendeeId/substitution` replaces one unchecked-in attendee in place while preserving the attendee row, answers, pricing, and capacity claims.
- `POST /api/events/:eventId/registrations/:registrationId/attendees` adds a person to a registration party.
- `POST /api/events/:eventId/registrations/:registrationId/payments` records a validated cash, check, or other manual payment.
- `GET|POST /api/events/:eventId/promo-codes` lists or creates event discounts for finance managers; the API never returns attendee data.
- `PATCH /api/events/:eventId/promo-codes/:promoCodeId` edits future uses or deactivates a code with optimistic conflict protection.
- `POST /api/events/:eventId/payments/:paymentId/refunds` records a full or partial refund against an offline payment; Square card refunds must be initiated in Square.
- `GET|POST /api/public/manage/:token/payment` returns a private server balance quote or submits an idempotent Square payment using a short-lived browser token.
- `POST /api/public/manage/:token/payment-choice` idempotently saves card or pay-later for a promoted waitlist registration, with optimistic conflict protection and a server-owned fee quote.
- `POST /api/webhooks/square` verifies the raw-body Square signature and idempotently reconciles payment and refund lifecycle events.
- `POST /api/events/:eventId/attendee-passes/resolve` verifies a signed, PII-free QR pass or resolves a manual registration confirmation code after event-scoped check-in authorization.
- `GET /api/public/manage/:token/attendee-passes/:attendeeId/qr` renders a private, no-store attendee QR pass only after registration-link authorization.
- `POST /api/events/:eventId/attendees/:attendeeId/check-in` records or safely retries an arrival using a strict client UUID idempotency key; `DELETE` explicitly undoes the active arrival while online.
- `GET|POST /api/events/:eventId/announcements` lists announcements or creates a draft.
- `PATCH /api/events/:eventId/announcements/:announcementId` publishes a draft; eligible all-attendee notices appear on the public event landing feed after their publication time.
- `PATCH /api/events/:eventId/messaging-settings` updates local-capture mode, sender/reply-to details, and internal notification recipients.
- `PUT /api/events/:eventId/message-templates/:templateId` validates and publishes a new immutable template version.
- `POST /api/events/:eventId/message-templates/:templateId/test` renders and captures a fictitious test message locally.
- `POST /api/events/:eventId/messages/process-local` claims pending outbox rows and records local capture attempts.
- `POST /api/events/:eventId/messages/process` claims committed outbox rows for local capture or the configured external email provider with retry/backoff.
- `POST /api/events/:eventId/messages/:messageId/retry` requires a stable client UUID and server-issued request fingerprint, then idempotently creates and post-commit processes one audited immutable copy.
- `GET|POST /api/events/:eventId/balance-reminders` previews the exact current balance audience or idempotently creates the reviewed batch without silently sending external email.
- `POST /api/events/:eventId/messages/:messageId/resend-confirmation` creates an audited immutable confirmation copy, optionally to one corrected destination without changing the contact record.
- `GET /api/events/:eventId/exports/registrations` downloads a formula-safe CSV roster and balance report.
- `GET|POST /api/events/:eventId/memberships` lists or creates staff assignments for event administrators.
- `PATCH /api/events/:eventId/memberships/:membershipId` changes a staff role or active status while preserving at least one active event administrator.
- `GET /api/events/:eventId/imports` lists recent staging runs for authorized event administrators.
- `POST /api/events/:eventId/imports/preview` validates a CSV, stores an immutable source snapshot per row, and prepares CREATE, UPDATE, SKIP, or ERROR decisions without changing registrations.
- `GET /api/events/:eventId/imports/:importRunId` returns the reviewable records and field-level differences for one run.
- `POST /api/events/:eventId/imports/:importRunId/commit` applies a reviewed, error-free run to the local database exactly once.
- `GET /api/events/:eventId/imports/:importRunId/exceptions` downloads formula-safe warnings and errors as CSV.
- `GET /api/events/:eventId/imports/reconciliation` returns cumulative created, updated, skipped, and error totals.
- `GET|POST /api/events/:eventId/forms` lists event forms and templates or creates a local draft from a template.
- `GET|PATCH /api/events/:eventId/forms/:formId` returns one versioned form or saves its draft with optimistic conflict protection.
- `POST /api/events/:eventId/forms/:formId/test-submissions` validates and stores a fictitious response against an exact form version.
- `POST /api/events/:eventId/forms/:formId/publish` publishes a tested draft as an immutable local version and archives the prior published version.
- `GET|POST /api/events/:eventId/program-assignments` previews a deterministic ranked-interest assignment or applies the exact reviewed fingerprint as a new immutable, audited run.
- `GET /api/events/:eventId/program-assignments/:runId/roster` downloads the event-authorized, formula-safe CSV for one frozen assignment run.
- `POST /api/public/events/:eventSlug/forms/:formSlug/registrations` validates, prices, capacity-checks, waitlists if necessary, and saves an anonymous registration idempotently.
- `POST /api/public/events/:eventSlug/forms/:formSlug/promo-code` returns a same-origin, rate-limited, server-calculated display quote without consuming a use.
- `GET|PATCH /api/public/manage/:token` resolves a hash-only, expiring private link and permits contact-only self-service changes.
- `POST /api/webhooks/resend` verifies provider events and reconciles delivery status idempotently.

The browser receives only a random opaque session token in an HttpOnly, SameSite cookie. The database stores its SHA-256 digest, expiry, and revocation state. Staff passwords use salted scrypt hashes; reset tokens are also stored only as digests. Mutation routes require a same-origin request in addition to authentication and event authorization.

## Architecture

```text
app/                  pages, layouts, and route handlers
components/           reusable shell and brand components
modules/access/       credentials, sessions, recovery, memberships, roles, and capability rules
modules/events/       event reads, selection, and overview data
modules/people/       permanent identity and household boundary
modules/registrations registration and attendee boundary
modules/payments/     payment and refund boundary
modules/promo-codes/  bounded discount, quote, redemption, and immutable snapshot boundary
modules/checkin/      check-in and reconciliation boundary
modules/communications announcements, versioned templates, transactional outbox, and delivery-history boundary
modules/forms/        registration templates, definitions, tests, and immutable versions
modules/audit/        transaction-compatible audit interface
integrations/         future external adapters only
prisma/               schema, migration, and fictitious seed
scripts/imports/      staging CSV contract and operator notes
tests/                permission and domain tests
docs/decisions/       architecture decision records
```

The platform begins as a modular monolith. People and households persist across events; registrations, attendees, payments, refunds, check-ins, announcements, audits, and imports are event-scoped. PostgreSQL becomes authoritative only after staging imports, reconciliation, and cutover approval.

See [ADR 0001](docs/decisions/0001-foundation-architecture.md) for the decision and consequences.

## Design direction

The workspace preserves the calm operational structure of WR26 App V2 while using the public IMSDA identity:

- IMSDA navy `#003B5C`
- IMSDA purple `#582C83`
- IMSDA gold `#F0B323`
- Noto Sans typography
- desktop sidebar and mobile bottom navigation
- event selector plus Overview, People, Check-in, Communications, and More routes
- working event selection that follows staff between pages

The current UI writes authoritative operational state to the configured IMSDA Events PostgreSQL database. Staff sign-in/out, local recovery, event role/status management, registration create/edit, reviewed whole-registration transfer, in-place attendee substitution, party attendees, manual payments, partial offline refunds, signed attendee passes, camera/manual pass resolution, partial-party check-in/online undo, recoverable device-local offline check-in, CSV export, audit history, announcement draft/publish with a filtered public all-attendee feed, reviewed CSV imports, registration-form draft/test/publish, and message-template/outbox workflows are functional. A published form is available at `/register/{event-slug}/{form-slug}` and can save either one attendee or an ordered household/group roster locally. It records attendee-scoped answers, pricing, capacity claims, and the exact confirmation after commit. A private management link can collect the remaining card balance through Square Sandbox when configured; no real payment is possible with the default configuration.

## Registration builder workflow

1. Sign in as an event administrator or registration manager and open **Registration builder**.
2. Create a form from Simple RSVP, Retreat registration, Household interest, Women’s Retreat 2026, Man Camp 2026, Spring Camporee 2026, or Camp Meeting 2026, or edit a saved event draft.
3. Add, remove, and reorder sections and fields; insert reusable modules; configure labels, stable field keys, field types, scope, choices, help text, and required status.
4. Configure conditional visibility, ordinary versus capacity/ranked-interest choices, per-choice limits, prices, automatic fees, and optional date-driven late prices. Add the **Promo code** drop-in module when the event offers finance-managed discounts. Use the calculation-preview date to test both sides of a pricing deadline.
5. Save the draft, complete the live preview with fictitious responses, and run a test submission. Validation feedback is attached to the exact saved version.
6. Publish only after a valid test passes. The published definition becomes immutable, its public registration link activates, and a later edit automatically creates the next draft version while the prior public version remains live.

The builder supports short and long text, email, phone, dropdown, radio, multiselect, ranked choice, checkbox, date, number, and automatic-fee fields. Conditional logic, scheduled late pricing, card-fee gross-up, bounded promo-code rules, repeatable attendee modules, public rendering, server-side validation and pricing, immutable answer snapshots, duplicate-submit idempotency, serializable capacity reservations, automatic waitlists, private links, external email delivery, and Square payment collection are implemented. File uploads remain separate work.

## Staging import workflow

1. Sign in as an event administrator and open **Import & reconcile**.
2. Download the template or sample CSV, or choose a compatible `.csv` file up to 2 MB and 2,000 data rows.
3. Select **Preview import**. Review row validation, identity matches, proposed actions, warnings, and field-level differences. Preview never changes a registration.
4. Correct and re-upload files with errors. Warning-only runs remain eligible for a reviewed commit.
5. Select **Commit to local database**, acknowledge the confirmation, and commit once. Repeating the same upload returns the existing run; repeating commit is safe and does not duplicate data.
6. Use reconciliation totals and the exception CSV to document the result.

The format template is available at `/fixtures/wr26-import-template.csv`; a wholly fictitious walkthrough file is available at `/fixtures/wr26-import-sample.csv`. See [`scripts/imports/README.md`](scripts/imports/README.md) for the exact field contract and matching rules.

## Build status and next review gate

The detailed built-versus-remaining matrix and the behavior comparison with `DurantTL/WR26-IMSDA` are in [the build status and WR26 gap audit](docs/BUILD-STATUS-AND-WR26-GAP-AUDIT.md).

Signed attendee QR passes, camera/manual staff resolution, the recoverable offline check-in conflict queue, reviewed balance reminders, corrected-address confirmation copies, bounded promo-code administration, whole-registration transfer, and in-place attendee substitution are complete. Printable passes and group rosters are the remaining event-day release gate. Scheduled/targeted announcements remain later work. Production Square activation remains gated behind approved credentials, an exact public webhook URL, operational refund testing, and the explicit production unlock.
