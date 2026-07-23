# Import scripts

Build 5 provides a guarded WR26-style CSV staging workflow in the application. It reads an uploaded file, stores source snapshots, previews every decision, and writes only to the local IMSDA Events PostgreSQL database after an event administrator confirms an error-free run. No source-system adapter or legacy write path is connected.

## CSV contract

Required headers:

- `source_id`: stable source row identifier
- `confirmation_code`: stable registration confirmation
- `first_name`
- `last_name`
- `total_amount`: US-dollar amount such as `250` or `250.00`

Optional headers:

- `email`
- `phone`
- `attendee_type`
- `status`
- `submitted_at`: ISO-8601 date or timestamp

Header names are case-insensitive after trimming. The parser supports standard quoted CSV values, rejects malformed rows and duplicate source IDs or confirmation codes, caps files at 2 MB and 2,000 data rows, and never evaluates spreadsheet formulas.

Downloadable fixtures live in `public/fixtures/`. `wr26-import-template.csv` is a blank contract example and `wr26-import-sample.csv` contains only fictitious `.test` data.

## Matching and safety

1. A confirmation-code match proposes an update or skip for that registration.
2. Otherwise, a normalized email match reuses an existing person and proposes a new registration.
3. Otherwise, the row proposes a new person and registration.
4. Conflicting identities and invalid fields are errors and block the complete run.
5. Missing email, reused people, and name differences are surfaced as warnings for human review.

Each row records its raw source snapshot, normalized values, matched IDs, proposed action, warnings, errors, and field-level differences. A SHA-256 checksum plus event identifier makes preview idempotent, and the run status makes commit idempotent. The completed run records created, updated, skipped, and error totals and writes an audit entry.
