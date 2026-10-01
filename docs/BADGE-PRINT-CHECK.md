# Name badge print check (#717)

`scripts/verify-badge-print.ts` proves in real Chromium that the printable name
badge page prints only label sheets and lands them on the Avery grid. CI does
not run Playwright or serve a built app, so this is a manual check. Run it
before badge day and after any change to `.badge-*` print CSS or the badges
page.

## What it asserts

For each Avery template (5395, 5392, Presta 94237), both orientations, plus
size, title, attendee-type and "start at label" variants, with print media
emulated and `page.pdf({ format: "Letter", preferCSSPageSize: true })`:

- the PDF has `ceil((labels + start - 1) / perSheet)` pages and none is blank;
- the PDF text has no "Skip to main content", "Badge artwork", "Upload artwork"
  or "No background selected", and the chrome elements compute to `display: none`;
- every page is 8.5 x 11 in;
- the first label is at the template's top/left offset (Presta 94237: 1 in from
  the top and 0.85 in from the left, within 0.02 in) and all labels sit on the
  template's column and row pitch.

The paper is always portrait letter: Avery sheets feed upright. The page's
"Badge orientation" option only turns the text inside each label.

## Running it

It needs a local migrated and seeded database, `playwright-core` Chromium, and a
running production build.

```bash
npm run db:deploy && npm run db:seed
npm run build && npm run start            # note the port
npx playwright-core install chromium      # or set BADGE_PRINT_BROWSER
BADGE_PRINT_BASE_URL=http://localhost:3000 \
BADGE_PRINT_OUT_DIR=/tmp/badge-print \
npm run test:badge-print
```

The script adds synthetic attendees ("Badgecheck SampleNNN", 30 by default,
`BADGE_PRINT_ATTENDEES` to change) to the seeded Women's Retreat event and signs
in by minting a session for the seeded administrator directly in the local
database (staff accounts need a second factor, so the login form cannot be
scripted). Never point it at a production database. PDFs and a PNG of page 1
for each variant are written to `BADGE_PRINT_OUT_DIR`.

## Avery CSV

The CSV export has columns `ID`, `Name`, `Position`, `Attendee type` (last, so
existing Avery merges keep mapping the first three). Attendee type is the same
label the badge prints. When the page's "Show attendee type" box is off the link
adds `type=0`; the column stays in the file with empty values so the header
never changes under a saved Avery merge.
