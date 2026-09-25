# Navigation map (#428)

How back links, "reached from more than one place," and the staff nav
groupings work, so later pages follow the same pattern.

## Back links

Every page below a section's top level gets a back link to its parent, with
a label that names the destination — never a bare "Back."

- **`lib/return-to.ts` exports `safeReturnTo(value, fallback)`.** It only
  ever returns `value` when it is a same-site relative path: starts with a
  single `/`, never contains `//` or a backslash anywhere, has no control
  characters, and is never an API route (`/api` or `/api/...`) — checked on
  the raw value and on it decoded, repeatedly, to catch encoded and
  multiply-encoded tricks like `%2F%2F`, `%5C`, or `%2525252F%2525252F`. If
  decoding is still changing the string when the round limit is reached, the
  value is rejected rather than accepted on an unstable form. Anything
  unsafe — an absolute URL, a protocol-relative URL (`//evil.com`),
  `javascript:`, a backslash trick, an API route — falls back to the page's
  default parent. See `tests/return-to.test.ts` for the exact accepted and
  rejected cases.
- **`lib/return-to.ts` also exports `allowedReturnTo(value, allowed, fallback)`.**
  Stricter than `safeReturnTo` alone: accepts `value` only when it is both a
  safe relative path *and* exactly one of `allowed` — a small, page-specific
  list of known parents. Every page below that accepts a `from` param uses
  this, not `safeReturnTo` alone, so `from` can never steer the link to an
  arbitrary same-site path, only to a place that actually links here.
- **`components/back-link.tsx` exports `BackLink`,** a small wrapper around
  `next/link` with an arrow icon. Use it everywhere instead of a one-off
  `<Link>`, so every back link looks and reads the same.
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

A few staff pages are opened from two different parents — the directory (or
a reports grid) and a club's own overview page. For those, the linking page
appends `?from=<encoded path>` to the URL it opens, and the destination page
reads `searchParams.from` and validates it with `allowedReturnTo` against
its own exact, known list of parents (not `safeReturnTo` alone — a merely
"safe" path that isn't one of this page's real parents still falls back):

```tsx
// Linking in from a club's own overview page:
const clubHref = `/admin/organizations/${organizationId}/club`;
<Link href={`/admin/organizations/${organizationId}/directors?from=${encodeURIComponent(clubHref)}`}>Club admins</Link>

// On the destination page:
const clubHref = `/admin/organizations/${organizationId}/club`;
const backHref = allowedReturnTo(from, [clubHref], "/admin/organizations");
const backLabel = backHref === clubHref ? `Back to ${club.name}` : "Back to churches and clubs";
```

Pages using this today:

| Page | Default parent | Only other allowed `from` |
| --- | --- | --- |
| `/admin/organizations/[organizationId]/profile` | `/admin/organizations` | `/admin/organizations/[organizationId]/club` |
| `/admin/organizations/[organizationId]/directors` | `/admin/organizations` | `/admin/organizations/[organizationId]/club` |
| `/admin/clubs/reports/[organizationId]/[month]` | `/admin/clubs/reports?year=…` | `/admin/organizations/[organizationId]/club` |
| `/more/clubs/reports/[organizationId]/[month]` | `/more/clubs/reports?event=…` | `/more/clubs/[organizationId]?event=…` |

## Club portal (`app/(public)/account/(portal)/clubs/[organizationId]/...`)

The club's own home page (`/account/clubs/[organizationId]`) is the section's
top level; every page below it has a `BackLink` to the club home page, named
with the club: "Back to {club.name}". Deeper pages point one level up:

- `roster`, `profile`, `team`, `notes`, `reports`, `events` → "Back to
  {club.name}" (the club home page)
- `reports/[month]` → "Back to monthly reports" (the reports list)
- `events/[eventId]` → "Back to club events" (the events list)
- `events/[eventId]/packet`, `events/[eventId]/schedule` → "Back to
  {eventName}" (the event registration page)

The club home page itself links back to `/account/clubs` ("All my clubs"),
but only when the signed-in person actually directs more than one club —
otherwise there's nowhere else for that link to usefully go.

The Area Coordinator portal (`app/(public)/account/(portal)/area/...`)
follows the same pattern: `area/[organizationId]` → "All clubs";
`area/[organizationId]/reports/[month]` → "Back to {club.name}".

## Staff club and organization pages

- `admin/organizations` (the churches and clubs directory) → "Back to system
  administration"
- `admin/organizations/[organizationId]/club` (a club as its director sees
  it) → "Back to churches and clubs"; its own links to Club admins, Club
  profile, and each monthly report pass `from` back to itself
- `admin/clubs/import`, `admin/clubs/invites`, `admin/clubs/reports`,
  `admin/organizations/background-checks` → "Back to churches and clubs"
- `more/clubs` (a Pathfinder event's club oversight) → "Back to More"
- `more/clubs/[organizationId]` → "Back to clubs"; its links to each monthly
  report pass `from` back to itself
- `more/clubs/reports` → "Back to clubs"
- `more/club-assignments`, `more/honors`, `more/event-content` → "Back to
  More"

## Staff navigation grouping

Related staff destinations sit together under six labeled groups: **Events,
Clubs and churches, People, Finance, Communications, System.** Nobody sees a
link they couldn't already reach before this grouping existed — every
group's visibility condition is exactly what gated that destination before.

- **Sidebar (`components/app-shell.tsx`):** the primary nav groups its
  destinations under all six headings; a heading only renders when at least
  one item under it is visible for the signed-in user and selected event.
  Dashboard stays pinned above every group; More stays a catch-all after
  them, since it spans several groups.
  - **Clubs and churches** and **System** are computed per render, not
    static list entries, because their destination and visibility depend on
    the signed-in user and the selected event:
    - System admins see Clubs and churches pointed at `/admin/organizations`;
      an EVENT_ADMIN on a club-billed event (the same rule
      `resolveClubOversight` in `modules/club-rosters/event-oversight.ts`
      uses) sees it pointed at `/more/clubs?event=…` instead. `WorkspaceLayout`
      (`app/(workspace)/layout.tsx`) computes this `clubOversight` flag per
      event, server-side, the same way `more/page.tsx` does, and passes it on
      each `ShellEvent`.
    - System holds the same "System management" destination (`/admin`) as
      the existing "Global administration" callout above it — system admins
      only.
  - The **mobile tab bar** keeps its own, separate order — Home, People,
    Payments, Promos, Check-in, Emails, More — regardless of the sidebar's
    grouping, and never shows Clubs and churches or System (`mobileNavigationOrder`
    in `components/app-shell.tsx`).
- **More page (`app/(workspace)/more/page.tsx`):** its cards are grouped
  under all six headings (`<h2>` group labels, `<h3>` card titles), including
  **Clubs and churches** (Clubs, Club assignments) and **System** (Operational
  health, Operational reports). A group renders only when at least one of its
  cards is visible; the visibility condition for every card is unchanged
  from before the sweep.
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
   `allowedReturnTo(from, [...knownParents], defaultParent)` — an explicit
   allowlist of that page's actual parents, not `safeReturnTo` alone.
3. Reuse `primary-button`, `secondary-button`, and `text-button` — never a
   new button class.
