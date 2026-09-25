# Navigation map (#428)

How back links, "reached from more than one place," and the staff nav
groupings work, so later pages follow the same pattern.

## Back links

Every page below a section's top level gets a back link to its parent, with
a label that names the destination — never a bare "Back."

- **Shared helper:** `lib/return-to.ts` exports `safeReturnTo(value, fallback)`.
  It only ever returns `value` when it is a same-site relative path (starts
  with a single `/`, never contains `//` or a backslash anywhere, has no
  control characters — checked on the raw value and on it decoded, to catch
  encoded tricks like `%2F%2F` or `%5C`). Anything else — an absolute URL,
  a protocol-relative URL (`//evil.com`), `javascript:`, a backslash trick —
  falls back to the page's default parent. See `tests/return-to.test.ts` for
  the exact accepted and rejected cases.
- **Shared component:** `components/back-link.tsx` exports `BackLink`, a
  small wrapper around `next/link` with an arrow icon. Use it everywhere
  instead of a one-off `<Link>`, so every back link looks and reads the same.
  - `variant="portal"` (the default) matches the club portal's quiet text
    link (`text-button`).
  - `variant="staff"` matches the staff workspace's button row
    (`secondary-button`).

```tsx
import { BackLink } from "@/components/back-link";

<BackLink href={`/account/clubs/${organizationId}`}>Back to {club.name}</BackLink>
<BackLink href="/admin/organizations" variant="staff">Back to churches and clubs</BackLink>
```

### When a page can be reached from more than one place

Some staff pages are opened from two different parents — the directory and a
club's own overview page, or a reports grid and a club's own overview page.
For those, the linking page appends `?from=<encoded path>` to the URL it
opens, and the destination page reads `searchParams.from`, validates it with
`safeReturnTo`, and uses it (falling back to its usual default parent when
`from` is missing or unsafe):

```tsx
// Linking in from a club's own overview page:
const fromHere = `?from=${encodeURIComponent(`/admin/organizations/${organizationId}/club`)}`;
<Link href={`/admin/organizations/${organizationId}/directors${fromHere}`}>Club admins</Link>

// On the destination page:
const backHref = safeReturnTo(from, "/admin/organizations");
```

Pages using this today:

| Page | Default parent | Also reachable from | `from` param |
| --- | --- | --- | --- |
| `/admin/organizations/[organizationId]/profile` | `/admin/organizations` | `/admin/organizations/[organizationId]/club` | yes |
| `/admin/organizations/[organizationId]/directors` | `/admin/organizations` | `/admin/organizations/[organizationId]/club` | yes |
| `/admin/clubs/reports/[organizationId]/[month]` | `/admin/clubs/reports?year=…` | `/admin/organizations/[organizationId]/club` | yes |
| `/more/clubs/reports/[organizationId]/[month]` | `/more/clubs/reports?event=…` | `/more/clubs/[organizationId]?event=…` | yes |

Every `from` value is validated with `safeReturnTo` before it is ever used —
there is no open redirect.

## Club portal (`app/(public)/account/(portal)/clubs/[organizationId]/...`)

The club's own home page (`/account/clubs/[organizationId]`) is the section's
top level; every page below it has a `BackLink` to the club home page, named
with the club: "Back to {club.name}". Deeper pages point one level up:

- `roster`, `profile`, `team`, `notes`, `reports`, `events` → club home
- `reports/[month]` → "All monthly reports" (the reports list)
- `events/[eventId]` → "All club events" (the events list)
- `events/[eventId]/packet`, `events/[eventId]/schedule` → "Back to your event" / "Back to the event"

## Staff club and organization pages

- `admin/organizations` (the churches and clubs directory) → "Back to system
  administration"
- `admin/organizations/[organizationId]/club` (a club as its director sees
  it) → "Back to churches and clubs"; its own links to Club admins, Profile,
  and each monthly report pass `from` back to itself
- `admin/clubs/import`, `admin/clubs/invites`, `admin/clubs/reports`,
  `admin/organizations/background-checks` → "Back to churches and clubs"
- `more/clubs` (a Pathfinder event's club oversight) → "Back to More"
- `more/clubs/[organizationId]` → "Back to clubs"; its links to each monthly
  report pass `from` back to itself
- `more/clubs/reports` → "Back to clubs"

## Staff navigation grouping

Related staff destinations sit together under six labeled groups: **Events,
Clubs and churches, People, Finance, Communications, System.**

- **Sidebar (`components/app-shell.tsx`):** the primary nav groups its
  destinations under **Events, People, Finance, Communications** headings
  (role-based visibility is unchanged — a heading only renders when at least
  one item under it is visible). Dashboard stays pinned above every group;
  More stays a catch-all after them, since it spans several groups. There is
  no direct **Clubs and churches** sidebar destination today — club oversight
  is reached through More — so that heading only appears on the More page
  (below).
- **More page (`app/(workspace)/more/page.tsx`):** its cards are grouped
  under all six headings, including **Clubs and churches** (Clubs, Club
  assignments) and **System** (Operational health, Operational reports). A
  group renders only when at least one of its cards is visible; the
  visibility condition for every card is unchanged from before the sweep.
- **System Command Center (`app/(workspace)/admin/page.tsx`):** its header
  actions (Create event, Team, Accounts, Platform settings, Churches and
  clubs, Honor catalog, Public calendar, Background checks, Refresh) now wrap
  onto additional lines instead of being clipped by the hero's rounded
  corners, on both desktop and phone widths
  (`app/(workspace)/admin/system-admin.module.css`).

## Adding a new page below a section's top level

1. Give it a `BackLink` to its parent, `variant="portal"` in the club portal
   or `variant="staff"` in a staff page, with a label that names the
   destination.
2. If it can be reached from more than one place, add `from` support: the
   linking pages append `?from=<encoded path>`, and the page reads it with
   `safeReturnTo(from, defaultParent)`.
3. Reuse `primary-button`, `secondary-button`, and `text-button` — never a
   new button class.
