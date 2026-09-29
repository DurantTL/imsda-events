# Reference data

Files here are inputs to a staff-run import. None is seeded into any
environment automatically; committing one records where it came from and lets
the tests exercise the real file.

## `adventsource-club-catalog.csv` (#531)

The starting file for the club supply catalog import (Admin → Club supply
catalog, `app/(workspace)/admin/club-supplies/page.tsx`, system
administrators only).

**Source.** A club's honors and uniform master spreadsheet, supplied on
2026-09-28. The sheet is a matrix with one row per member and one column per
item; each item column carries its AdventSource catalog number. Only the
sheet's header rows (section, item name, catalog number) were used. No member
row, and nothing a member wrote, is in this file.

**What was removed from the header rows.** A note naming a member, the sheet's
total and label rows ("Total", "# Needed", "Last Updated" and the like), a
placeholder row, and the club-made honors that have no AdventSource number.
The club's own patch is left out too. `tests/club-supply-reference-csv.test.ts`
fails if any total or label row, or any free-text note (a `?`, or a name over
70 characters), comes back.

**Columns.**

| Column | Meaning |
|---|---|
| `section` | The catalog section. Eight are supply sections (Investiture, Camporees, Pathfinder Bible Experience, Teen Leadership Training, Miscellaneous, Class A Dress Apparel, Class A Uniform Accessories, Other Apparel); the rest are the honor categories and Master Awards. See `modules/club-supplies/domain.ts`. |
| `item` | The AdventSource item name as the sheet had it. A sized item is one row per size, because each size has its own catalog number. |
| `adventsource_catalog_number` | Kept as text so leading zeros survive. Blank where AdventSource sells no number (conference-made camporee patches, most PBE pins). |

**Known quirks, kept on purpose.**

- Catalog numbers repeat: the Good Conduct Stars 1–5 all use 002305, the
  30" and 40" belts share 008585, and every "X - Advanced" honor except First
  Aid carries 007400, the Advanced Honor Star. The import only warns about
  these.
- A few PBE pin rows appear twice, and "Video (GC)" and "Welding (GC)" repeat
  the numbered honor above them. The import merges each repeat into the first
  row with the same section and normalized name (a trailing "(GC)" is
  ignored when matching).
- The sheet spells one section "Reacreation". The import reads it as
  Recreation rather than editing the file.
- Some names have typos ("Sashe", "largee", "Sldie"). They import as they are;
  a typo that breaks the size pattern just leaves the size label blank.

**How rows match.** An item is identified by its section plus its normalized
name (trimmed, whitespace collapsed, lower-cased, "&" read as "and", a trailing
"(GC)" dropped, "X - Advanced" read as "X, Advanced"), never by catalog number,
because AdventSource reuses numbers across items. So a renamed item that keeps
its number imports as a new item; staff then mark the old one inactive. A
missing Catalog Number column or a blank cell keeps the saved number: an import
never clears a number. When repeated rows for one item carry different numbers,
the first non-blank number is kept and the preview warns about the others. An
"X - Advanced" honor with no number in the file, on the saved item, or on its
linked honor gets 007400; the First Aid honors never do.

**Using it.** Upload it on the staff page and read the dry-run preview: added,
updated, and skipped counts, honors matched and unmatched, and repeated-number
warnings. Confirming saves exactly that preview. An honor-section row whose
name matches an existing honor links to it and sets the honor's catalog number
and category; an unmatched row stays an unlinked item. Discontinued items can
be marked inactive afterwards with the toggle on the same page.

## `master-award-rules.json` (#532)

The starting file for the Master Award rules import (Admin → Master Award
rules, `app/(workspace)/admin/master-award-rules/page.tsx`, system
administrators only). Nothing is seeded automatically.

**Source.** The same club spreadsheet as the catalog file, supplied on
2026-09-28. Its Master Award columns are formulas that count how many honors a
member has in each group; the 15 rules here were parsed from those formulas'
structure. Only honor names and minimums are in the file. No member row, and
nothing a member wrote, is in it.

**Shape.** An object keyed by the Master Award's name. Each rule has
`groups`, an array of `{ "minimum": n, "honors": [honor names] }`, and
`groupsRequired`, how many groups the formula said must be met. A rule is
earned when every group reaches its minimum; a member's honors come from their
year-round honor record (#486), the latest entry per honor being COMPLETED.
Examples: Aquatic is one group (any 7 of 16); Health is three (3 of 7, 2 of
5, 2 of 5); Naturalist is three (4 of 17, 2 of 16, 1 of 6).

**Known limits, kept on purpose.**

- Family, Origins, and Heritage parsed only partly: the formula needs two
  groups and only one (5 of 12) could be read. The import flags it for a manual
  check, and the administrator adds the missing group from the official
  requirements before activating it.
- Each group counts its own honors independently, exactly as the sheet does.
  No honor appears in two groups in this file, and a rule that lists one honor
  in two groups can't be saved or activated (it would count twice).
- Honor names are the sheet's. They match the honor list by normalized name
  ("X - Advanced" reads as "X, Advanced"); the preview lists every name that
  matches nothing, and the rule keeps it on its group for review. A rule with
  an unmatched honor is flagged for a manual check too.

**Using it.** Upload it on the staff page and read the dry-run preview: rules to
add, honors matched and unmatched, and which rules need a manual check.
Confirming saves exactly that preview, and every rule arrives as a DRAFT. A
rule already on file is never changed, so re-running the import can't undo an
administrator's edits. The administrator then reviews, edits and activates each
rule one by one; only ACTIVE rules are used to show progress. A rule flagged
for a manual check can't be activated until the administrator says they checked
it. Every import, edit, activation and deactivation is audited.

## Earned awards signals (#532)

- **Class completed.** Nothing in the app recorded that a class was finished
  (the roster keeps only a member's current class), so a director marks it on
  the Earned awards screen (`MemberClassCompletion`). That, and only that,
  suggests the class's insignia set (name strip, chevron, pin, ribbon bar; Master
  Guide: name strip, star with chevrons, pin), matched by the Investiture
  section plus name in the supply catalog.
- **Attended.** A person checked in to the event (an active check-in), which is
  what the Honors Weekend write-back already treats as attendance. An ended
  event with no check-ins at all falls back to who was registered.

## Ready-to-import files (`imports/`, #622)

Upload-ready files, one per staff import that exists. They are built by
`scripts/build-import-files.ts` from the two reference files above, so rebuild
them with `npm run imports:build` (never edit them by hand).
`npm run imports:build -- --check` reports a stale file, and
`tests/import-files.test.ts` fails when a committed file differs from the
generator's output or when the real import parser reports any error.

| File | Rows | Upload on | Import |
|---|---|---|---|
| `imports/club-supply-catalog.csv` | 850 items | Admin → Club supply catalog (`app/(workspace)/admin/club-supplies/page.tsx`) | `POST /api/admin/club-supplies/import`, columns `Section,Item,Catalog Number,Active` |
| `imports/master-award-rules.json` | 15 rules (412 honor names) | Admin → Master Award rules (`app/(workspace)/admin/master-award-rules/page.tsx`) | `POST /api/admin/master-award-rules/import` |

Both pages are for system administrators only, and both show a dry-run preview
before anything is saved.

**Club supply file.** One row per source row, in the source's order, with the
header the template route produces. `section` is rewritten to the import's own
section label (`Reacreation` becomes `Recreation`, `Health And Science` becomes
`Health and Science`, and so on); the item names and catalog numbers are
byte-for-byte the source's. A blank catalog number stays blank, and `Active` is
left blank so every item takes the import's default (active). The sized-item
rows, the repeated numbers, and the repeated PBE pins stay as they are. On a
clean catalog the preview shows 843 added and 7 skipped as repeats, no
problems, and 10 repeated-number warnings (expected: see the quirks above).
The 120 uniform rows (Class A Dress Apparel 93, Class A Uniform Accessories 16,
Other Apparel 11) are in this file.

**Master award file.** The same 15 rules as `master-award-rules.json`, checked
with the real rules parser. All 412 honor names in it are rows of the club
supply file, so once honors exist they match by name.

### Order to import

1. **Honors** (`imports/` has no honors file yet; see the gaps). Honors must
   exist before the two files below, or nothing links.
2. **Club supply catalog.** Honor-section rows link to the honors whose names
   match and set each honor's catalog number and category. Without honors they
   import as unlinked items, and a later re-import links them (an import
   matches items by section plus name, so re-running it is safe).
3. **Master Award rules.** They match honors by name; every rule arrives as a
   DRAFT for an administrator to review and activate.

### Uniforms

There is no separate uniform import, and none was built. A uniform is a sized
club supply item (`modules/uniforms/`, #497), so the uniform catalog is the
Class A Dress Apparel, Class A Uniform Accessories and Other Apparel rows of
`imports/club-supply-catalog.csv`.

### Known gaps

- **No honors file.** The honor catalog import (`POST /api/admin/honors/import`,
  columns `Code,Name,Description,Active,Catalog Number,Category`) requires a
  unique `Code` for every honor. No honor code exists in the repository (the
  seed data has no honors, and the club sheet has only AdventSource numbers,
  which repeat and are sometimes blank), and codes are permanent identity for
  later updates, so none was invented. A human decides the code scheme (for
  example the General Conference honor numbers) before an honors file can be
  built. The 531 honor rows in the supply file (546 with the 15 Master Awards)
  are the names and categories such a file would use.
- **No descriptions or prices.** The sources have neither, so they are blank.
- **89 supply rows have no catalog number** (conference-made patches and most
  PBE pins), as in the source.
- **Family, Origins, and Heritage** is still a partial rule (see above).
- **Club-made honors and the club's own patch** are not in the source, so not
  in the files.
