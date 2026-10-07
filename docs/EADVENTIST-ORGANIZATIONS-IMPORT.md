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
which means "sponsoring church or company" for a club. A parent that names the conference
itself, is not in the file, or matches two rows is ignored (the preview says
which).

## Who can sponsor a club (#822)

A club's sponsor (`parentOrganizationId`) can be an active **Church, Company or
Group**: companies and groups are congregations not yet organized as churches
(for example a Pathfinder club at a company congregation). The rule is one
constant, `SPONSOR_ORGANIZATION_TYPES` in `modules/organizations/domain.ts`, used
by club create and edit, the club profile, club imports, new club applications,
promo code sponsors, the directory options and the Sterling Volunteers name
check. Any other kind (school, camp, conference and so on) is refused. Pickers
show the kind after the name for a non-church, for example "Sample Youth
Company (Company)". A company-sponsored club's church-billed charges go to the
company (invoices, amounts owed, billing contact). No migration is involved: the
kinds already exist. Church-only behavior is unchanged: the church location and
geocoding, and the import's name matching to stored churches.

## Upload flow

1. Choose the CSV. The preview lists every row as **New**, **Updated**,
   **Unchanged** or **Skipped**, with counts and the flagged total. Nothing is
   saved. Rows that cannot be read (no id, unknown type, bad date, repeated id)
   are listed separately with the reason.
2. **Save** re-reads the same file inside one transaction, plans it against the
   database as it is at that moment, applies it, and writes one audit entry.
3. Uploading again updates records matched by `OrganizationID`; it never adds
   duplicates. The same file twice is a no-op.

Matching runs in whole-file passes, so an early row never takes a church a
later row matches better:

1. **By OrganizationID.** The id is kept in two places that must agree:
   `Organization.eadventistId` and the organization's `EADVENTIST`
   `ExternalIdentity`. Either one matches a row. The row is **Skipped** with a
   note if they disagree, if two organizations claim the id, if the id is held
   by a person or at another provider scope, or if a **club** holds it ("This
   eAdventist id belongs to a club; not imported"). Clubs are never import
   targets. A save writes both places.
2. **By exact name.** A Church, Company or Group row is linked to the one
   unclaimed stored `CHURCH` with the same normalized name and no eAdventist id.
   The preview shows each proposed match. Two such churches make the row
   **Skipped**.
3. **Possible match, no default.** When no exact match exists but an unclaimed
   stored church matches loosely (ignoring case, punctuation, and the words SDA,
   Seventh-day Adventist, Church, Company, Group), the row is marked **Possible
   match: choose**. Staff must pick *Link to {existing name}* or *Create new* for
   every such row; Save is disabled, and the server answers 400 `NEEDS_CHOICES`,
   until they have. A choice that is no longer a current candidate skips the row
   ("Your choice is no longer available, preview again"); it never falls back to
   another church. Linking only sets the id and updates fields; nothing is
   deleted or merged.

A linked `CHURCH` is retyped to Company or Group only if it sponsors no clubs or
promo codes and has no church location; otherwise it stays a church and the
preview says so. The preview always shows what Save will write, so uploading the
same file again is a no-op.

Privacy: for **Group** rows (which often meet in homes) the street address and
office phone are not stored; city, state and postal code are.

`IsActive` accepts Y/N, TRUE/FALSE and 1/0 in any case; any other value
(including blank) rejects that row with a reason.

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

## Church map locations (#724)

The public club map reads `ChurchLocation`, so the import also fills it:

- For every **active church** in the file it creates a location (city, state, ZIP)
  marked `IMPORT`, or updates an `IMPORT` or `GEOCODED` one whose town changed.
  The preview shows how many locations will be created and updated.
- A location a person set by hand (`MANUAL`, including every location that existed
  before this change) is never touched.
- Groups (which often meet in homes), companies, schools and camps get no location:
  the map plots churches only, and a group never gets a street address or point.
- The import never geocodes and stores no coordinates. If a geocoded point's address
  changes, the point is dropped and the location returns to `IMPORT`.

Then a system administrator opens **Find map locations** (link on the directory
page). It needs `GEOCODING_ENABLED=true` and sends only the street address, city,
state and ZIP of active churches that have a street address and no point (never a
town-only address, a group, or a hand-set location) to the U.S. Census Bureau
geocoder. Each church gets a result: matched or no match. Staff **Accept** a match
(location becomes `GEOCODED`), **Set on map** (the existing map picker; saving
there makes it `MANUAL`), or **Skip**. Nothing reaches the public map until a match
is accepted. A match is refused ("The address changed; run Find map locations again") if the church's address changed after the lookup, and the import discards saved results for churches whose address it changes. Only one lookup runs at a time. The whole lookup is capped at about 60 seconds (under a typical proxy timeout); if it can't finish in that time, or the service can't be reached, nothing is changed. Audit entries hold
counts only. Production needs outbound HTTPS to `geocoding.geo.census.gov`
(see `docs/DEPLOY-DOCKER.md`). Running it on production is a human action.

## Before running on production

1. Deploy the migrations `20260930210000_organization_eadventist_import`
   (additive; nullable columns and new enum values) and
   `20261002030000_church_location_source` (adds `ChurchLocation.source`, backfilled
   `MANUAL`, and the `ChurchGeocodeResult` table).
2. Upload the real file, read the preview (especially name matches and
   Skipped rows), then Save.
3. Review the "active, disbanded date on file" filter in the directory.
