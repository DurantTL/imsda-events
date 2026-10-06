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

It runs as its own workflow, not in `ci.yml` (CI minutes are tight):

- **Pull requests, quick run** (360 and 1024 px, no screenshots), only when a
  the table-card or list-sort helpers (`components/table-card-labels.tsx`,
  `components/list-sort.tsx`), the script, `scripts/support/**` or the workflows
  change. The shared CSS is left out on purpose: it changes in most pull
  requests, so it is covered by the label and the weekly run.
- **Pull requests with the `mobile-check` label**, whatever they change: the
  same quick run, started by `mobile-layout-label.yml`. Put the label on a PR
  that changes a page's layout. A workflow cannot OR a `paths` filter with a
  label, so the label trigger is a small second workflow that calls the first
  (`workflow_call`). A PR that matches both shares one concurrency group, so one
  of the two runs is cancelled (it shows as a cancelled check). Adding a
  different label does not start a run.
- **Weekly (Monday) and by hand** (`workflow_dispatch`): the full run, all four
  widths, with screenshots (the `mobile-layout-screenshots` artifact, 14 days).

The job is optional (`continue-on-error: true`, like badge-print): a browser or
runner flake does not turn a pull request red, so read the job's log. Workflows
have `permissions: contents: read`. The label is created in the repository
(`mobile-check`). Locally:

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
`MOBILE_LAYOUT_CLEANUP=1` deletes every `mobilecheck` row the run created
(children before parents) when it ends; leave it off in CI, where the database
is thrown away, and use it on a dev database you want to keep tidy.

It is local-only: it refuses to run with `NODE_ENV=production`, or a
`DATABASE_URL` or base URL that is not on this machine, and then, before it
writes anything, refuses a database that is not a seeded dev or CI one
(`admin@imsda-events.test`, `system@imsda-events.test` and `usr_system_admin`
must exist). Sessions are always revoked and Prisma disconnected, even when the
browser fails to start. It writes synthetic rows whose ids start with
`mobilecheck` (two churches, two clubs, two accounts with a placeholder
authenticator, a roster, a monthly report, invites, a background-check list and
a club event) and mints sessions that skip the second step. Nothing in it is a
real person.

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

The ARIA roles keep the table semantics when `display` changes. Make the
person's name (or the item's title) the row header (`<th scope="row">`): it
becomes the card's title. On a desktop the row header looks like a normal cell
if the table has no `.report-table` styling; check the wide table too.

The header row is visually hidden on a phone, so a **sortable column's header
control is not usable on cards**. Say how the list is ordered with a
`SortOrderNote`, and give the phone another way to change it:

- a client-sorted list (honors) keeps its order and its note;
- a server-sorted list (the attendee listing) adds Sort and Direction selects to
  its GET filter form, shown at 600 px and under (`.attendee-sort-phone`), and
  its header links are `PhoneHiddenSortLink`, which is out of the tab order on a
  phone so there are no invisible Tab stops. The header row itself stays in the
  accessibility tree so each cell keeps its column name.

If a list cannot give up its sort header, keep the table in its scroll box and
record the exception in `acceptedFindings`. Used by: roster
(`.roster-card-table`), club reports, honors, area overview and points,
invites, background checks, team, accounts, club forms, attendee listing.

### 44px tap targets

`:root { --touch-target: 44px }` is set at 768 px and under; the rules this section lists apply at **600 px and under** (phones), the width the audit uses, so the registration form builder and other tablet layouts keep their sizes. At 600 px and under:

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
