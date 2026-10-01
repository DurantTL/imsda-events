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
  or "No background selected", and the chrome elements (including the act-as banner, auto-select notice and empty state) compute to `display: none`;
- every page is 8.5 x 11 in;
- the first label is at the template's top/left offset (Presta 94237: 1 in from
  the top and 0.85 in from the left, within 0.02 in) and all labels sit on the
  template's column and row pitch.

Print width (#732): at Scale Default, Chrome shrinks the whole page to fit when
the printed document is wider than the paper, so the sheet printed at about 77%
and sat up and to the left of the die-cuts. Playwright's `page.pdf` at scale 1
never shrinks, so the script measures the layout instead, with print media
emulated, at the 816 px page width and at 1088 px (4/3 of it, the wider width
Chrome lays print out at before it fits the page):

- `document.documentElement.scrollWidth` is at most 816 and the shrink factor
  (page width / max(page width, scrollWidth)) is 1;
- at both widths, no element and not `body` reaches past 816 px (the print CSS
  pins `html`, `body` to 8.5 in and gives every ancestor of the sheets
  `width: auto`, `min-width: 0` and no sidebar track);
- `.badge-sheet` is exactly 8.5 x 11 in.

The paper is always portrait letter: Avery sheets feed upright. The page's
"Badge orientation" option only turns the text inside each label.

## Running it

Local use only. The script writes synthetic registrations and mints a session
that skips the second factor, so it refuses to run when `NODE_ENV=production`,
when `DATABASE_URL` or `BADGE_PRINT_BASE_URL` is not localhost, 127.0.0.1 or
::1, or when `BADGE_PRINT_STAFF_EMAIL` is not a seeded `@imsda-events.test`
account. These checks (shared with `prisma/seed.ts` in
`scripts/support/local-only-guard.ts`) run before Prisma or the session store
load. The minted session is revoked when the run ends.

It needs a local migrated and seeded database, Chromium, and a running
production build. `playwright-core` and `pdfjs-dist` are not project
dependencies (they would add about 107 MB to the production image), so install
them without saving:

```bash
npm i --no-save playwright-core@1.56.1 pdfjs-dist@4.10.38
npm run db:deploy && npm run db:seed
npm run build && npm run start            # note the port
npx playwright-core install chromium      # or set BADGE_PRINT_BROWSER
BADGE_PRINT_BASE_URL=http://localhost:3000 \
BADGE_PRINT_OUT_DIR=/tmp/badge-print \
npm run test:badge-print
```

If either package is missing the script prints the install line above and exits.

The script adds synthetic attendees ("Badgecheck SampleNNN", 30 by default,
`BADGE_PRINT_ATTENDEES` to change) to the seeded Women's Retreat event and signs
in as the seeded administrator (`BADGE_PRINT_STAFF_EMAIL` to change). PDFs and a
PNG of page 1 for each variant are written to `BADGE_PRINT_OUT_DIR`. Variants
include one without `?event=` so the auto-select notice renders. Run it once
as the administrator (artwork panel shown) and once with
`BADGE_PRINT_STAFF_EMAIL=checkin@imsda-events.test` (check-in staff, no artwork
panel). Acting as another user is not covered.

## Printing tip

For exact label alignment print from Chrome or Edge, open More settings and set
Paper size Letter, Margins None, **Scale: Custom 100** (not Default), and
headers and footers off. Keep Custom 100 until a plain-paper test print
confirms the width fix below. The badges page shows this tip on screen
next to the Print button; it is hidden when printing.

## Avery CSV

The CSV export has columns `ID`, `Name`, `Position`, `Attendee type` (last, so
existing Avery merges keep mapping the first three). Attendee type is the same
label the badge prints. When the page's "Show attendee type" box is off the link
adds `type=0`; the column stays in the file with empty values so the header
never changes under a saved Avery merge.
