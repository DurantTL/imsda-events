# Responsive layout patterns (#447)

Most directors and Area Coordinators use phones. These are the patterns the
club portal, Area Coordinator and staff pages follow, and the check that holds
them. Follow them for any new page; if the phone audit fails on yours, use the
pattern below instead of a one-off fix.

## The phone audit

`scripts/verify-mobile-layout.ts` (`npm run test:mobile-layout`) signs in as
synthetic users (a club director of two clubs, an Area Coordinator, the seeded
event administrator and system administrator), visits the main pages at 360,
390, 768 and 1024 px in headless Chromium, saves a full-page screenshot of each
(and of every dialog it opens), and fails when it finds:

| Finding | Rule | Applies at |
| --- | --- | --- |
| `horizontal-scroll` | `documentElement.scrollWidth <= innerWidth`; the elements sticking out are named | every width |
| `table-scrolls-sideways` | a table needs sideways scrolling inside its wrapper: make it cards | 600 px and under |
| `small-tap-target` | a button, form control, summary or stand-alone link under 44 px (a link inside a sentence is exempt) | 600 px and under |
| `dialog-too-tall` | a dialog or sheet taller than the screen, or cut off at the top or bottom | every width |
| `sticky-bar-covers-content` / `sticky-bar-size` | the last content is hidden under a fixed bar, or fixed bars take over a third of the screen | every width |

It runs as its own workflow (`.github/workflows/mobile-layout.yml`), not in
`ci.yml`: on pull requests that touch `components/**`, `app/**/*.tsx`,
`app/globals.css`, the script or the workflow, weekly, and by hand. Screenshots
are the `mobile-layout-screenshots` artifact. Locally:

```bash
npm i --no-save playwright-core@1.56.1
npm run db:deploy && npm run db:seed && npm run club-forms:sync && npm run lodging:sync
npm run build && npm run start          # production mode; note the port
MOBILE_LAYOUT_BROWSER=/path/to/chromium MOBILE_LAYOUT_OUT_DIR=/tmp/mobile-layout \
  npm run test:mobile-layout
```

Options: `MOBILE_LAYOUT_WIDTHS=360,390`, `MOBILE_LAYOUT_ONLY=club-roster` (page
name contains), `MOBILE_LAYOUT_NO_SHOTS=1`. `MOBILE_LAYOUT_SELF_TEST=1` injects
one defect of every kind into each page, and the run must then fail.

Like the badge-print check it is local-only: it refuses to run with
`NODE_ENV=production`, a `DATABASE_URL` or base URL that is not on this
machine, or a staff account that is not a seeded `@imsda-events.test` one. It
writes synthetic rows whose ids start with `mobilecheck` (two churches, two
clubs, two accounts with a placeholder authenticator, a roster, a monthly
report, invites, a background-check list and a club event) and mints sessions
that skip the second step. Nothing in it is a real person.

**Adding a page:** add a line to `pages` in the script. A page that needs data
the script does not create gets that data in `seedSynthetic`. A button that
opens a dialog without `aria-haspopup="dialog"` goes in `dialogOpeners`.
**Accepting a finding** (`acceptedFindings`) needs a reason and should be rare;
fix the page instead.

## Patterns

### Never widen the page

- A grid or flex child that holds a table, an input row or long text needs
  `min-width: 0`; otherwise its content sets the track width. `.page-stack` and
  `.workspace-content` already do this for their direct children.
- Use `minmax(0, 1fr)`, never a bare `1fr`, for tracks that hold form controls.
  `.form-grid.two-column` is two columns down to 521 px and one column below.
- A `<select>` with long options is capped at `max-width: 100%` globally.
  Names (clubs, people) are long: wrap with `overflow-wrap: anywhere`.
- A table that must stay a table (a wide data grid) sits in a scroll box
  (`.report-table-wrap`, `.table-wrap`, `.table-scroll`), which never widens
  the page.

### Tables become cards on a phone

Under 600 px a list table is stacked cards by CSS alone, so the first paint is
already cards. Opt in with `table.table-cards` and
`components/table-card-labels.tsx`:

```tsx
<div className="report-table-wrap">
  <table role="table" className="report-table table-cards">
    <caption className="sr-only">Club forms</caption>
    <thead role="rowgroup">
      <tr role="row"><th role="columnheader" scope="col">Form</th>...</tr>
    </thead>
    <tbody role="rowgroup">
      <tr role="row">
        <th role="rowheader" scope="row">{name}</th>   {/* the card's title */}
        <td {...cardCell("Status")}>{status}</td>        {/* "Status: value" line */}
        <td {...cardCell(null)}>{actions}</td>           {/* controls only, no label */}
      </tr>
    </tbody>
  </table>
</div>
```

The ARIA roles keep the table semantics when `display` changes. The header row
is visually hidden on a phone, so **column sorting is not available on cards**
(the order stays the default; say so in a note, as the roster does). If sorting
is essential on a phone, keep the table and its scroll box and record the
exception in `acceptedFindings`. Used by: roster (`.roster-card-table`), club
reports, honors, area overview and points, invites, background checks, team,
accounts, club forms, attendee listing.

### 44px tap targets

`:root { --touch-target: 44px }` applies at 768 px and under. Under it:

- every text-like `input`, `select`, `textarea`, color input and `summary` is at
  least 44px tall (`app/globals.css`, "#447");
- `.primary-button`, `.secondary-button`, `.text-button` and the other shared
  link/button classes are already 44px;
- a link or sort button inside a table cell or header is 44px;
- a checkbox or radio is 22px and its **label** is the 44px target. A checkbox
  with no visible label (a table cell) is wrapped in
  `<label className="checkbox-hit">`, which is 44 x 44;
- an icon-only button is 44 x 44 (`min-width` as well as `min-height`).

Change sizes on desktop separately: every rule is inside a media query or
uses `max(var(--type-floor), ...)`.

### Dialogs and sheets

Use `.modal-backdrop` > `.modal-card` (scrolls inside itself, `max-height`
follows `100dvh` so the phone's collapsing browser bars do not cut it) and
`useAccessibleDialog`. Do not make a popup taller than the screen without an
inner scroll; do not put the only close or confirm button below the fold of a
long form (the card scrolls, so keep Cancel and Save inside the card).
`ConfirmDialog` is the shared confirmation.

### Fixed bars

The staff phone tab bar (`.mobile-nav`, 67 px) is fixed; `body` already pads
by 73 px so the last content clears it. A page-level save bar
(`.event-savebar`) sits above it (`bottom: 67px`). Do not add another fixed or
sticky bar on a phone; the audit fails when bars take more than a third of the
screen or hide the last line of a page.

### Type

Floors are tokens: 12px for helper text and 14px for body and labels at 768 px
and under (#684). Write `font-size: max(var(--type-floor, 0px), 0.62rem)`;
never a bare rem under 0.75.

## Known gaps

- The registration form builder is not a phone page: under 768 px a notice
  replaces it (#685). At 768 px it is a desktop layout with 28-30 px controls;
  the audit applies tap targets to phones only.
- Sorting on tables that became cards (above).
