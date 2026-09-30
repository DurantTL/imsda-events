# eAdventist organizations import (#649)

The office receives the authoritative list of churches, companies, groups,
schools and other organizations from eAdventist as a CSV. A system
administrator uploads it at **Clubs and churches > Import from eAdventist**
(`/admin/organizations/import`). Running it on production is a human action;
this document is the runbook.

**The real export must never be committed, pasted into an issue, or used as a
test fixture.** It holds names in "c/o" lines, emails and phones. Tests use
`tests/fixtures/eadventist-organizations-synthetic.csv`.

## What is stored

Per record: eAdventist `OrganizationID` (unique; the re-import key), `OrgCode`,
name, kind, street address / city / state / postal code, website, office phone,
district, language, `DisbandedOn`, and the parent organization.

Not stored: driving directions, service times, social and streaming links,
attendance, ethnicity, coordinates, email, and the "c/o" lines. The file itself
is parsed in memory and never kept; audit entries hold counts, not names.

## Kinds

`Organization.type` gained values next to the existing `CHURCH` and `CLUB`
(neither changed meaning): `COMPANY`, `GROUP`, `SCHOOL`, `EARLY_CHILDHOOD`,
`BOOKSTORE`, `COMMUNITY_CENTER`, `CAMP`, `CONFERENCE`, `ASSOCIATION`. The three
school types (PK-08, PK-10, 9-12) all become `SCHOOL`; the export's own
`OrgType` text is kept in `sourceOrgType`.

`SubOrgOf` is resolved by name to another row in the same file and stored in
`affiliatedOrganizationId`. It is deliberately not `parentOrganizationId`,
which means "sponsoring church" for a club. A parent that names the conference
itself, is not in the file, or matches two rows is ignored (the preview says
which).

## Upload flow

1. Choose the CSV. The preview lists every row as **New**, **Updated**,
   **Unchanged** or **Skipped**, with counts and the flagged total. Nothing is
   saved. Rows that cannot be read (no id, unknown type, bad date, repeated id)
   are listed separately with the reason.
2. **Save** re-reads the same file inside one transaction, plans it against the
   database as it is at that moment, applies it, and writes one audit entry.
3. Uploading again updates records matched by `OrganizationID`; it never adds
   duplicates. The same file twice is a no-op.

Matching a church that predates the import: a row of type Church with no
stored `OrganizationID` match is linked once to the one existing `CHURCH` with
the same normalized name and no eAdventist id. The preview shows each proposed
match. If two existing churches share the name the row is **Skipped**; fix the
duplicates and upload again.

## Active and inactive

A new record takes the export's `IsActive`. An update never changes whether a
record is active, so a staff decision survives every re-upload. Records with a
`DisbandedOn` date are imported as they are and shown as "Disbanded {date} on
file — review". Staff mark any record active or inactive in one click in the
**Organization directory** (`/admin/organizations/directory`), which lists
non-club organizations and filters by kind, status (including "active with a
disbanded date on file"), and name. Each change is audited. A church with an
active club cannot be switched off until its clubs are moved.

## Registration forms

- `CHURCHES_DIRECTORY` now lists active **Church, Company and Group** records.
- New `SCHOOLS_DIRECTORY` lists active **School** records (for education events).
- The Women's Retreat, Men's Camp and Camp Meeting templates and the builder's
  "Church & club contact" module read the church directory instead of the
  hard-coded list, with the standard "Not listed" choice and follow-up field.
  Forms already created from the old templates keep their stored list until
  staff switch the field to the directory in the builder.
- A saved answer that is no longer in the directory (for example an old
  hard-coded name) is kept as a choice for that registration, so it still
  displays and validates.

## Before running on production

1. Deploy the migration `20260930200000_organization_eadventist_import`
   (additive; nullable columns and new enum values).
2. Upload the real file, read the preview (especially name matches and
   Skipped rows), then Save.
3. Review the "active, disbanded date on file" filter in the directory.
