/**
 * Real-browser phone-layout audit (#447).
 *
 * Signs in as synthetic seeded users, visits the main club portal, Area
 * Coordinator and staff pages at 360, 390, 768 and 1024 px wide in headless
 * Chromium, and checks what a director or coordinator on a phone would hit:
 *
 *  - no horizontal page scroll: documentElement.scrollWidth <= innerWidth,
 *    and the elements that stick out are named when it fails;
 *  - no table that has to be scrolled sideways on a phone (<= 600 px). Such a
 *    table becomes stacked cards (`table-cards`, docs/RESPONSIVE.md);
 *  - tap targets of at least 44 px on the controls a thumb has to hit (phone
 *    widths only, <= 600 px; tablets keep the denser desktop sizes): buttons,
 *    form controls, summaries, and links that are not part of a sentence;
 *  - no dialog or sheet taller than the screen without scrolling inside it
 *    (every `aria-haspopup="dialog"` button on the page is opened, and the
 *    dialog is closed again without being submitted);
 *  - no fixed or sticky bar that hides the last thing on the page, and no
 *    bar that takes more than a third of the screen;
 *  - table cells (#811): no cell's text runs into or over its neighbour or out of its
 *    own cell, no two columns touch with no gap, each card label (`data-label`) is its
 *    column header, a header sits over its column, an honor pill never loses its
 *    "In progress / Completed" status, and a table marked `data-fit-width` fits its box;
 *  - form fields: every visible text input, select, textarea and search box has a boundary (its own
 *    border, or its nearest bordered wrapper within two levels, such as the `.search-field` box) with at
 *    least 3:1 contrast against the background behind it (WCAG 2.2 SC 1.4.11);
 *  - date fields (#918): every date, time and datetime-local input in an opened dialog (the honor history
 *    dialog's Completion date) sits inside its own label and form, is as tall as the dialog's other
 *    single-line fields, and overlaps no other field, helper text or label;
 *  - squeezed text (#996): no visible text in a box narrower than about four characters, no text that wraps one
 *    character per line, and no ordinary word (6 to 15 letters) broken in the middle; only emails, codes and
 *    unbroken strings that cannot fit may break anywhere;
 *  - table wider than its box (#997, tablet and desktop widths): a data table wider than the box around it is a finding. A table may
 *    scroll sideways only when its box has `data-scroll-cue` and really draws an edge fade or shadow (the `.scroll-cue` class); a
 *    box that clips it (overflow hidden) never qualifies;
 *  - sticky bars (#996): when a page opens, no sticky or fixed action bar (one holding a button) sits on top of text;
 *  - the shell's "Loading IMSDA Events…" fallback is waited out before anything is measured, and a page that never
 *    leaves it is a finding;
 *  - a full-page screenshot of every page and width, saved as an artifact.
 *
 * Every layout assertion is made for every page at every width. A finding that
 * a person has looked at and accepted goes in `acceptedFindings` below, with a
 * reason, never in a weaker check.
 *
 * LOCAL USE ONLY. It writes synthetic clubs, people and accounts (every id
 * starts with "mobilecheck") and mints sessions that skip the second factor,
 * so it refuses to run with NODE_ENV=production, with a DATABASE_URL or
 * MOBILE_LAYOUT_BASE_URL that is not on this machine, or against a database
 * that is not a seeded dev or CI one (admin@imsda-events.test,
 * system@imsda-events.test and usr_system_admin must exist). Both guards run
 * before anything is written. Nothing it creates is a real person or club.
 *
 * playwright-core is deliberately not a dependency (it would bloat the
 * production image); install it first with
 *   npm i --no-save playwright-core@1.56.1
 * Chromium itself is not installed by npm: point MOBILE_LAYOUT_BROWSER at an
 * existing Chromium/Chrome executable (or let Playwright find its own).
 *
 *   MOBILE_LAYOUT_BASE_URL=http://localhost:3000 \
 *   MOBILE_LAYOUT_OUT_DIR=/tmp/mobile-layout npm run test:mobile-layout
 *
 * Environment:
 *   MOBILE_LAYOUT_BASE_URL  default http://localhost:3000
 *   MOBILE_LAYOUT_OUT_DIR   screenshots and report.json are saved here (default: a temp dir)
 *   MOBILE_LAYOUT_WIDTHS    comma list of widths (default 360,390,768,1024)
 *   MOBILE_LAYOUT_ONLY      run only the pages whose name contains this text
 *   MOBILE_LAYOUT_BROWSER   path to a Chromium executable (default: Playwright's)
 *   MOBILE_LAYOUT_NO_SHOTS  set to 1 to skip the screenshots
 *   MOBILE_LAYOUT_CLEANUP   set to 1 to delete every `mobilecheck` row it created when the run ends
 *   MOBILE_LAYOUT_TEXT_RULES the text and form rules (headings, labels, focus rings, text overlap, disabled contrast) run on every
 *                           page by default; set to "pbe" to narrow them to the pbe-* and staff-pbe-* pages while iterating
 *   MOBILE_LAYOUT_SELF_TEST set to 1 to inject one defect of every kind into each page;
 *                           the run must then FAIL with all of them reported
 *   DATABASE_URL            the local database the app uses (read from .env when not exported)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { Prisma, PrismaClient } from "@prisma/client";
import { assertLocalDatabase, assertLocalUrl } from "./support/local-only-guard";

loadEnvConfig(process.cwd());

// Structural stand-ins: playwright-core is installed on demand, not a dependency.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Page = any;
type Context = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const baseUrl = (process.env.MOBILE_LAYOUT_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const outDir = process.env.MOBILE_LAYOUT_OUT_DIR ?? mkdtempSync(path.join(tmpdir(), "mobile-layout-"));
const widths = (process.env.MOBILE_LAYOUT_WIDTHS ?? "360,390,768,1024")
  .split(",").map((value) => Number(value.trim())).filter((value) => value > 0);
const only = process.env.MOBILE_LAYOUT_ONLY;
const takeShots = process.env.MOBILE_LAYOUT_NO_SHOTS !== "1";
const selfTest = process.env.MOBILE_LAYOUT_SELF_TEST === "1";

const P = "mobilecheck";
const eventId = "evt_wr26";
const clubEventId = `${P}_club_event`;
const clubEventSlug = `${P}-club-weekend`;
const clubA = `${P}_club_a`;
const clubB = `${P}_club_b`;
// A published public event page with one of every content block kind (#816).
const blocksEventId = `${P}_blocks_event`;
const blocksEventSlug = `${P}-blocks-weekend`;
// A new club application waiting for a decision, and a private link that opens the form (#817).
const applicationLinkToken = `${P}-application-link-token-0123456789-abcdefghijklmnopqrstuv`;
// A class that teaches several honors, on the staff class builder (#812).
const multiHonorSessionId = `${P}_honor_session`;
const multiHonorIds = [1, 2, 3, 4].map((index) => `${P}_honor_${index}`);
const multiHonorOfferingId = `${P}_honor_offering`;
// A PBE-shaped event (the pathfinder_bible_experience starter's rules and the pbe_registration form), published, with the
// general registration link on and church billing: the public page, the general-link team flow, the club portal and the staff pages.
const pbeEventId = `${P}_pbe_event`;
const pbeEventSlug = `${P}-pbe-bible-experience`;
const pbeTeamName = "Mobilecheck Bible Bees";
const pbeDraftKey = "0123456789abcdef0123456789abcdef";
// An attendee-pay event with a cancellation policy, one registration of two people (the director's own email, so the portal lists it
// and the private link opens it), and requests in several states: the registrant's panel and the staff queue (#170).
const cancelEventId = `${P}_cancel_event`;
const cancelEventSlug = `${P}-cancel-weekend`;
// A general event with personal staff invitation links (#804, #1027): the invite list in every status, and a link form that also
// asks the event's own attendee questions.
const staffInviteEventId = `${P}_staffinv_event`;
const staffInviteEventSlug = `${P}-staff-invitations`;
const staffInviteEmail = (key: string) => `${P}.staffinv.${key}@example.test`;
const churchA = `${P}_church_a`;
const churchB = `${P}_church_b`;
const reportMonth = "2026-09";
const touchTarget = 44;
/** Tolerance for sub-pixel rounding only; a 43 px control is a failure. */
const touchTolerance = 0.5;
/** WCAG 2.2 SC 1.4.11: the boundary of a form control against the background behind it. */
const fieldBoundaryRatio = 3;
let fieldsChecked = 0;
/**
 * Widths at or under this are phones: the 44px tap-target rule and the
 * tables-become-cards rule apply. Tablets (768 and up) keep the denser desktop
 * sizes, and are still checked for page scroll, dialogs and bars.
 */
const touchMaxWidth = 600;
/**
 * Staff text floor (#981): text on a staff page is never smaller than 14px (the body floor,
 * max(var(--type-body-floor), 0.875rem)). Deliberate exceptions, each with its reason. A selector
 * matches the text's element or any ancestor of it.
 */
const staffTextFloorPx = 14;
const staffTextFloorExceptions: Array<{ selector: string; reason: string }> = [
  { selector: ".badge-sheet", reason: "the badge print preview shows the printed label at its real print size (Avery sheets are drawn in inches)" },
  { selector: ".sr-only, .visually-hidden", reason: "visually hidden text is not shown" },
];
/** Uppercase, letter-spaced labels (eyebrows, sidebar group labels) may be 12px: they read larger than lowercase text of the same size. */
const upperLabelFloorPx = 12;
const cardsMaxWidth = 600;

/** "visitor" is a signed-out public page: no session cookie at all. */
type Role = "event-admin" | "system-admin" | "kitchen" | "director" | "area" | "attendee" | "visitor";
type SignedInRole = Exclude<Role, "visitor">;

type PageSpec = {
  name: string;
  path: string;
  role: Role;
  /** Why the page is skipped at every width (kept in the report so nobody wonders). */
  note?: string;
  /** The sign-in page itself (or a page that may send a signed-out visitor there): do not report landing on it as "signed-out". */
  signInPage?: boolean;
  /** An invalid-link state that may answer 404 (the not-found page is what a person sees). */
  allow404?: boolean;
  /** The copy the page must show, so a broken route (a blank page, another error) does not pass as the state it stands for. */
  expectText?: RegExp;
  /** Runs after the page loads and before it is measured (fills a step of a form, say). It must leave nothing submitted. */
  prepare?: (page: Page, width: number) => Promise<void>;
  /** A walkthrough run after the page's first look (it clicks through states, and may submit a synthetic form). */
  flow?: "general-link" | "pending-teams";
};

const staff = (name: string, route: string, role: Role = "event-admin"): PageSpec => ({
  name: `staff-${name}`,
  path: route.includes("event=") ? route : `${route}${route.includes("?") ? "&" : "?"}event=${eventId}`,
  role,
});
const club = (name: string, suffix: string, clubId = clubA): PageSpec => ({
  name: `club-${name}`,
  path: `/account/clubs/${clubId}${suffix}`,
  role: "director",
});
const area = (name: string, route: string): PageSpec => ({ name: `area-${name}`, path: route, role: "area" });

const pages: PageSpec[] = [
  // Register a new club (#817), signed out: the public form and the private link's form.
  { name: "public-register-new-club", path: "/clubs/register", role: "visitor" },
  { name: "public-register-new-club-invited", path: `/clubs/register/${applicationLinkToken}`, role: "visitor" },
  // Pages the audit had never visited (#996): sign-in, recovery, calendar, club directory, and the invalid-link states.
  { name: "public-login", path: "/login", role: "visitor", signInPage: true },
  { name: "public-forgot-password", path: "/forgot-password", role: "visitor", signInPage: true },
  { name: "public-reset-password", path: "/reset-password", role: "visitor", signInPage: true },
  { name: "public-profile-sign-in", path: "/profile/sign-in", role: "visitor", signInPage: true },
  { name: "public-recover-registration", path: "/recover-registration", role: "visitor" },
  { name: "public-calendar", path: "/calendar", role: "visitor" },
  { name: "public-home", path: "/", role: "visitor" },
  { name: "public-clubs", path: "/clubs", role: "visitor" },
  { name: "public-manage-invalid-link", path: `/manage/${P}-invalid-link-token-0123456789-abcdefghijklmnopqrstuvwxyz`, role: "visitor", allow404: true, expectText: /no longer active/i },
  { name: "public-unsubscribe-invalid-link", path: `/unsubscribe/${P}-invalid-link-token-0123456789-abcdefghijklmnopqrstuvwxyz`, role: "visitor", allow404: true, expectText: /unsubscribe link didn.t work/i },
  { name: "public-staff-invite-invalid-link", path: `/staff-invite/${P}-invalid-link-token-0123456789-abcdefghijklmnopqrstuvwxyz`, role: "visitor", allow404: true, expectText: /isn.t available/i },
  { name: "staff-select-event", path: "/select-event", role: "event-admin" },
  { name: "staff-archived-events", path: "/archived-events", role: "event-admin" },
  // The public event page with one of each content block (#816), signed out.
  { name: "public-event-page-all-blocks", path: `/events/${blocksEventSlug}`, role: "visitor" },
  // Club portal (a director of two clubs).
  { name: "account-overview", path: "/account", role: "director" },
  { name: "account-overview-attendee", path: "/account", role: "attendee" },
  { name: "account-registrations", path: "/account/registrations", role: "director" },
  { name: "account-profile", path: "/account/profile", role: "director" },
  { name: "account-registrations-attendee", path: "/account/registrations", role: "attendee" },
  { name: "account-profile-attendee", path: "/account/profile", role: "attendee" },
  { name: "club-all-clubs", path: "/account/clubs", role: "director" },
  club("home", ""),
  club("roster", "/roster"),
  club("roster-inactive", "/roster?inactive=1"),
  club("registration-events", "/events"),
  club("registration-form", `/events/${clubEventId}`),
  club("class-tracking", "/class-tracking"),
  club("honors", "/honors"),
  club("class-tracking-report", "/exports/class-tracking"),
  club("class-history", `/class-tracking/${P}_person_a_01`),
  club("roster-export", "/roster/export"),
  club("orders-print", "/orders/print"),
  club("schedule", `/events/${clubEventId}/schedule`),
  club("honors-report", "/exports/honors"),
  club("honors-report-person", "/exports/honors?view=person"),
  club("monthly-records", "/records"),
  club("monthly-report-form", `/records?month=${reportMonth}`),
  club("orders", "/orders"),
  // Meeting notes on the Monthly records page: the add popup is opened, saved and checked for the pinned "Saved" banner (#810).
  club("meeting-notes", "/records"),
  club("club-info", "/club-info"),
  club("forms", "/forms"),
  club("health", "/health"),
  // Area Coordinator.
  area("overview", "/account/area-clubs/overview"),
  area("events", "/account/area-clubs/events"),
  area("team-permissions", "/account/area-clubs/team-permissions"),
  area("new-club-applications", "/account/area-clubs/applications"),
  area("points", "/account/area-clubs/points"),
  area("reports", "/account/area-clubs/reports"),
  area("club-home", `/account/area/${clubA}`),
  area("club-report", `/account/area/${clubA}/reports/${reportMonth}`),
  // No area club Orders page (#918): club Orders are not an Area Coordinator's to see; the route answers 404.
  area("club-honors", `/account/area/${clubA}/honors`),
  area("club-forms", `/account/area/${clubA}/forms`),
  area("club-awards", `/account/area/${clubA}/awards`),
  area("health", "/account/area/health"),
  // Staff, as an event administrator.
  staff("overview", "/overview"),
  staff("people-registrations", "/people"),
  // Email selected (#850): the dialog with Custom message (unpublished, so its notice and link show) and the announcement hint.
  staff("people-email-selected", "/people"),
  staff("attendee-listing", "/people/attendees"),
  staff("duplicates", "/people/duplicates"),
  staff("finance", "/finance"),
  staff("finance-invoices", "/finance/invoices"),
  staff("finance-church-owed", "/finance/church-owed"),
  // The event's scholarship fund (#398): a long sponsor name, a pledge, and an award on a cancelled registration.
  staff("finance-scholarship-fund", "/finance/scholarship-fund"),
  staff("finance-cancellation-policy", "/finance/cancellation-policy"),
  staff("finance-square-payments", "/finance/square-payments"),
  staff("lodging", "/more/lodging"),
  staff("lodging-requests", "/more/lodging/requests"),
  staff("lodging-assignments", "/more/lodging/assignments"),
  staff("issued-assets", "/more/issued-assets"),
  staff("issued-assets-desk", "/check-in/assets"),
  // Check-out for a person with keys out, a held cash deposit, a lost key and a charge (#214), and the closeout.
  staff("issued-assets-checkout", `/check-in/assets?attendee=${P}_reg_attendee_3_0`),
  staff("issued-assets-closeout", "/more/issued-assets/closeout"),
  staff("kitchen-report", "/more/kitchen-report"),
  staff("kitchen-scanner-import", "/more/kitchen-report/scanner-import"),
  // Meal money closeout (#212): the money table, the exceptions and their review forms.
  staff("kitchen-closeout", "/more/kitchen-report/closeout"),
  // Kitchen counts (#1029): the phone entry forms and the per-service table, with a long note and a correction in the history.
  staff("kitchen-counts", "/more/kitchen-report/counts"),
  // The same page as a Kitchen staff user (#1029): no event view, so the sidebar and phone tabs show only Kitchen counts.
  staff("kitchen-counts-as-kitchen-staff", "/more/kitchen-report/counts", "kitchen"),
  staff("more-menu", "/more"),
  staff("event-features", "/more/features"),
  // The More launcher as a system administrator: every switchable module card has Turn off, and its confirm must fit (#810).
  staff("more-launcher-admin", "/overview", "system-admin"),
  staff("reports", "/more/reports"),
  staff("reports-clubs", "/more/reports/clubs"),
  staff("clubs-oversight", "/more/clubs"),
  staff("clubs-oversight-club", `/more/clubs/${clubA}`),
  staff("clubs-oversight-reports", "/more/clubs/reports"),
  staff("honors", "/more/honors"),
  staff("honors-rosters", "/more/honors/rosters"),
  staff("event-health", "/more/event-health"),
  staff("attendee-configuration", "/more/attendee-configuration"),
  staff("club-assignments", "/more/club-assignments"),
  staff("program-assignments", "/more/program-assignments"),
  staff("club-forms-staff", "/more/club-forms"),
  staff("reports-packets", "/more/reports/packets"),
  staff("responsible-adults", "/people/responsible-adults"),
  staff("directory-review", "/people/directory-review"),
  staff("person-matches", "/people/matches", "system-admin"),
  staff("promo-codes", "/more/promo-codes"),
  staff("tags", "/more/tags"),
  staff("event-settings", "/more/event-settings"),
  staff("team-results", "/more/team-results"),
  staff("check-in", "/check-in"),
  // The printable name badge sheets (#981): the sheet preview must not make the page scroll sideways.
  staff("check-in-badges", "/check-in/badges"),
  staff("communications", "/communications"),
  // The template editor with attachments, a picture and a button (#824), and a draft announcement with attachments.
  staff("communications-editor", `/communications?event=${blocksEventId}&view=templates`, "system-admin"),
  staff("communications-announcement-attachments", `/communications?event=${blocksEventId}`, "system-admin"),
  // The delivery log with a failed send and a queued message (#860): the Retry failed review and the refresh notice.
  staff("communications-deliveries", `/communications?event=${blocksEventId}&view=deliveries`, "system-admin"),
  // Scheduled email batches (#177): a waiting, an approved and a paused schedule with a long unbroken name, and the new-schedule form.
  staff("communications-settings", `/communications?event=${blocksEventId}&view=settings`, "system-admin"),
  staff("communications-scheduled", `/communications/scheduled?event=${blocksEventId}`, "system-admin"),
  staff("communications-scheduled-new", `/communications/scheduled?event=${blocksEventId}&new=1`, "system-admin"),
  staff("registration-builder", "/registration-builder"),
  // Staff, as a system administrator.
  staff("system-home", "/admin", "system-admin"),
  staff("calendar-admin", "/admin/calendar", "system-admin"),
  staff("churches-clubs", "/admin/organizations", "system-admin"),
  staff("churches-clubs-directory", "/admin/organizations/directory", "system-admin"),
  staff("club-invites", "/admin/clubs/invites", "system-admin"),
  staff("club-applications", "/admin/clubs/applications", "system-admin"),
  staff("club-reports-summary", "/admin/clubs/summary", "system-admin"),
  staff("club-reports", "/admin/clubs/reports", "system-admin"),
  staff("club-transfers", "/admin/clubs/transfers", "system-admin"),
  staff("background-checks", "/admin/organizations/background-checks", "system-admin"),
  staff("club-as-director", `/admin/organizations/${clubA}/club`, "system-admin"),
  staff("club-as-director-honors", `/admin/organizations/${clubA}/club/honors`, "system-admin"),
  staff("team", "/admin/team", "system-admin"),
  staff("accounts", "/admin/accounts", "system-admin"),
  staff("system-settings", "/admin/settings", "system-admin"),
  staff("system-email", "/admin/email", "system-admin"),
  staff("system-readiness", "/admin/readiness", "system-admin"),
  staff("club-supplies", "/admin/club-supplies", "system-admin"),
  staff("club-forms", "/admin/club-forms", "system-admin"),
  // The club form settings page, with the "Email these addresses when this form is submitted" box (#1017).
  staff("club-form-alerts", "/admin/club-forms/off_premises_permission_slip", "system-admin"),
  // The form template library and its editor (#1064).
  staff("form-templates", "/admin/form-templates", "system-admin"),
  staff("form-template-editor", "/admin/form-templates/simple_rsvp", "system-admin"),
  staff("map-locations", "/admin/organizations/map-locations", "system-admin"),
  staff("honor-catalog", "/admin/honors", "system-admin"),
  staff("year-end-reports", "/admin/clubs/reports/year-end", "system-admin"),
  staff("church-import", "/admin/organizations/import", "system-admin"),
  staff("club-import", "/admin/clubs/import", "system-admin"),
  // The club-list JSON preview (#1038): new and unmatched rows, a check note, every card opened.
  {
    ...staff("club-import-list-preview", "/admin/clubs/import", "system-admin"),
    prepare: async (page) => {
      const clubs = Array.from({ length: 4 }, (_, index) => ({
        name: `Invented Hollow ${index + 1} Pathfinders with a long club name to wrap on a phone`,
        type: "CLUB",
        isActive: index !== 3,
        sponsoringChurch: null,
        churchSearchHint: index % 2 ? "Nowhere Town" : "Church",
        state: index === 2 ? "IA" : null,
        namesOnSheet: { "2025-2026": `Invented Hollow ${index + 1} Club` },
        checkNote: "Check the spelling of this invented club name against the sheet.",
      }));
      await page.locator('input[type="file"]').setInputFiles({ name: "club-list.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ clubs })) });
      await page.getByText(/clubs? found/).waitFor();
      await page.evaluate(() => document.querySelectorAll("details.club-import-club").forEach((element) => { (element as HTMLDetailsElement).open = true; }));
    },
  },
  staff("club-directors", `/admin/organizations/${clubA}/directors`, "system-admin"),
  // The block editor with one of each kind, as a system administrator (custom HTML is editable).
  staff("event-content-blocks", `/more/event-content?event=${blocksEventId}`, "system-admin"),
  // Personal staff invitations (#804, #1027): the invite list (every status, with Re-invite on the declined person) and the
  // approval list. The link form itself is added once the open link's token exists (see staffInvitePages).
  staff("staff-invitations", `/people/staff-invitations?event=${staffInviteEventId}`),
  staff("staff-invitation-approvals", `/people/staff-invitations/approvals?event=${staffInviteEventId}`),
  // The system administrator's notification bell (#1032), opened: the panel must sit inside the window with its links reachable.
  {
    ...staff("admin-bell-open", "/admin/settings", "system-admin"),
    prepare: async (page, width) => {
      await page.getByRole("button", { name: /^Notifications/ }).click();
      const panel = page.locator(".attention-popover");
      await panel.waitFor();
      await page.getByRole("heading", { name: "Needs attention" }).waitFor();
      // Wait for the read that opening the panel starts, so the list (not "Checking…") is what gets measured.
      await panel.locator("section, [role=status]").first().waitFor();
      await page.waitForFunction(() => !document.querySelector(".attention-popover")?.textContent?.includes("Checking"));
      const box = await panel.boundingBox();
      if (!box || box.x < 0 || box.x + box.width > width + 0.5) {
        throw new Error(`the notification panel sits outside the ${width}px window (x ${box?.x}, width ${box?.width})`);
      }
    },
  },
];

/** The public link form of one not-yet-used invitation: with a spouse and a child added, so every person's event questions show. */
function staffInvitePages(openToken: string): PageSpec[] {
  return [{
    name: "public-staff-invite-form",
    path: `/staff-invite/${openToken}`,
    role: "visitor",
    expectText: /Register for/i,
    prepare: async (page) => {
      await page.getByLabel("My spouse is coming").check();
      await page.getByRole("button", { name: /Add a child/i }).click();
    },
  }];
}

/** Every page a PBE user touches (the pages that need a row's id are built once the event is seeded). */
function pbePages(team: { registrationId: string; teamKey: string }): PageSpec[] {
  const portal = `/account/clubs/${clubA}/events/${pbeEventId}`;
  const pbeStaff = (name: string, route: string) => staff(`pbe-${name}`, `${route}${route.includes("?") ? "&" : "?"}event=${pbeEventId}`);
  return [
    { name: "pbe-public-event-page", path: `/events/${pbeEventSlug}`, role: "visitor" },
    { name: "pbe-general-link-start", path: `/register/${pbeEventSlug}/general`, role: "visitor", flow: "general-link" },
    { name: "pbe-club-portal-teams", path: portal, role: "director" },
    { name: "pbe-club-portal-new-team", path: `${portal}?draft=${pbeDraftKey}`, role: "director" },
    { name: "pbe-club-portal-registered-team", path: `${portal}?team=${encodeURIComponent(team.teamKey)}`, role: "director" },
    { name: "pbe-club-portal-team-form", path: `${portal}/team-form?team=${encodeURIComponent(team.teamKey)}`, role: "director" },
    { name: "pbe-club-portal-team-form-blank", path: `${portal}/team-form/blank`, role: "director" },
    pbeStaff("registrations", "/people"),
    { ...pbeStaff("pending-teams", "/people/pending-teams"), flow: "pending-teams" },
    // A system administrator also sees "Add this club to the directory" on a team whose club is not listed (#1031).
    { ...staff("pbe-pending-teams-admin", `/people/pending-teams?event=${pbeEventId}`, "system-admin"), flow: "pending-teams" },
    pbeStaff("team-results", "/more/team-results"),
    pbeStaff("team-form-report", "/more/reports/clubs/team-form"),
    pbeStaff("team-form-registration", `/more/reports/clubs/team-form/${team.registrationId}`),
    pbeStaff("team-form-level", "/more/reports/clubs/team-form/level"),
    pbeStaff("event-settings", "/more/event-settings"),
  ];
}

/**
 * Buttons that open a dialog or sheet without `aria-haspopup`. Each is tried on every
 * page (the first visible match); opening is harmless, and Escape closes it unsubmitted.
 */
const dialogOpeners = [
  // The More launcher trigger is a link, not a button (#741, #810).
  'a[aria-haspopup="dialog"]',
  "[data-monthly-report-open]",
  "[data-meeting-note-add]",
  'button:has-text("Add to roster")',
  'button:has-text("Upload CSV")',
  'button:has-text("Add club admin")',
  'button:has-text("New announcement")',
  'button[aria-label^="Add or view honors"]',
  'button[aria-label^="Honors for "]',
  'button[aria-label^="Edit "]',
  "button.record-card",
  ".finance-record",
];

/**
 * Findings someone has looked at and accepted. Key: `<kind>|<page name>|<selector or text>`
 * with `*` allowed as a suffix. Each needs a reason. Empty on purpose: fix, do not accept.
 */
const acceptedFindings: Array<{ match: string; reason: string }> = [];

/** Set once the database client exists: the meeting-note check deletes the note it saves (and its audit rows) through it. */
let noteCleanup: PrismaClient | null = null;
const layoutNoteText = "Synthetic layout check note.";

/** Removes the meeting notes this audit saved and their CLUB_MEETING_NOTE_* audit rows, so repeated runs leave nothing behind. */
async function deleteLayoutNotes() {
  if (!noteCleanup) return;
  const notes = await noteCleanup.clubMeetingNote.findMany({ where: { organizationId: clubA, notes: layoutNoteText }, select: { id: true } });
  const ids = notes.map((note) => note.id);
  if (ids.length === 0) return;
  await noteCleanup.auditLog.deleteMany({ where: { entityType: "ClubMeetingNote", entityId: { in: ids }, action: { startsWith: "CLUB_MEETING_NOTE_" } } });
  await noteCleanup.clubMeetingNote.deleteMany({ where: { id: { in: ids } } });
}

type Finding = { kind: string; page: string; width: number; detail: string };
const findings: Finding[] = [];
const accepted: Finding[] = [];
const pagesVisited: string[] = [];
let dialogsOpened = 0;
/** Date, time and datetime-local fields checked inside open dialogs (#918). */
let dateFieldsChecked = 0;
/** The widths at which a dialog date field was checked (#918), so a run that never opened the honor history dialog fails. */
const dateFieldWidths = new Set<number>();
/** How far a date field's height may differ from the dialog's other single-line fields, in px. */
const dateFieldHeightTolerance = 2;
/** The widths at which Back to top was really exercised (a page long enough to scroll). */
const backToTopChecked = new Set<number>();
/** Cases that could not be exercised (kept visible in the output rather than silently skipped). */
const untestedNotes: string[] = [];
const pageErrors: string[] = [];

function isAccepted(finding: Finding) {
  const key = `${finding.kind}|${finding.page}|${finding.detail}`;
  return acceptedFindings.some(({ match }) => (match.endsWith("*") ? key.startsWith(match.slice(0, -1)) : key === match));
}
function record(kind: string, page: string, width: number, detail: string) {
  const finding = { kind, page, width, detail };
  (isAccepted(finding) ? accepted : findings).push(finding);
}

/* ------------------------------------------------------------------ data */

const longName = "Saint Bartholomew-Montgomery Pathfinder Adventurers of the Western Prairie";

/**
 * Refuses a database that is not a seeded dev or CI one: the audit signs in as
 * the seeded staff and writes rows beside them, so those must be there. This is
 * a second guard after the localhost check, and runs before anything is written.
 */
async function assertSeededDatabase(prisma: PrismaClient) {
  const wanted = [
    { where: { email: "admin@imsda-events.test" }, name: "admin@imsda-events.test" },
    { where: { email: "system@imsda-events.test" }, name: "system@imsda-events.test" },
    { where: { id: "usr_system_admin" }, name: "usr_system_admin" },
  ];
  const missing: string[] = [];
  for (const item of wanted) {
    if (!(await prisma.user.findFirst({ where: item.where, select: { id: true } }))) missing.push(item.name);
  }
  if (missing.length > 0) {
    throw new Error(`Refusing to write synthetic rows: this is not a seeded dev or CI database (missing ${missing.join(", ")}). Run \`npm run db:seed\` on a local database first.`);
  }
}


/**
 * A published event whose page has one block of every kind (#816), saved through
 * the real repository so what the audit sees is what staff would publish. A
 * 1x1 image, stretched by the layout, is enough: the audit looks at structure.
 * Long words and long addresses are here on purpose.
 */
async function seedBlocksEvent(prisma: PrismaClient) {
  // A refund policy (#891) with a long unbroken word and two paragraphs, so the public event page renders and wraps it.
  const blocksRefundPolicy = "Refunds are available until October 1.\nAfter that, a fee of Supercalifragilisticexpialidocious-and-an-extremely-long-unbroken-synthetic-word applies.\n\nNo refunds are given after the event starts.";
  const { createEventAsset } = await import("../modules/events/asset-repository");
  const { replaceEventContent } = await import("../modules/events/content-repository");
  const { eventContentInputSchema } = await import("../modules/events/content-schemas");
  await prisma.event.upsert({
    where: { id: blocksEventId },
    update: { isPublished: true, refundPolicy: blocksRefundPolicy },
    create: {
      refundPolicy: blocksRefundPolicy,
      id: blocksEventId, slug: blocksEventSlug, name: "Mobilecheck Blocks Weekend",
      startsAt: new Date("2027-03-05T15:00:00Z"), endsAt: new Date("2027-03-07T18:00:00Z"), timezone: "America/Chicago",
      isPublished: true, registrationOpensOn: "2026-10-01", registrationClosesOn: "2027-02-28",
    },
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  let asset = await prisma.eventAsset.findFirst({ where: { eventId: blocksEventId, displayName: { startsWith: "mobilecheck-photo" } }, select: { id: true } });
  if (!asset) {
    const created = await createEventAsset(blocksEventId, new File([png], "mobilecheck-photo.png", { type: "image/png" }), "usr_system_admin");
    asset = { id: created.id };
  }
  const long = "Supercalifragilisticexpialidocious-and-an-extremely-long-unbroken-synthetic-word-for-wrapping";
  const mapsId = "!1m18!1m12!1m3!1d3000.5!2d-93.6!3d41.6!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x0%3A0x0!2sSynthetic!5e0!3m2!1sen!2sus!4v1700000000000";
  const image = { assetId: asset.id, alt: "A synthetic test image" };
  const input = eventContentInputSchema.parse({
    sections: [
      { kind: "HERO", title: `Mobilecheck Blocks Weekend ${long}`, isPublished: true, data: { ...image, subtitle: `A subtitle that is long enough to wrap onto several lines on a phone ${long}`, button: { label: "Register for the weekend", target: "REGISTER" }, overlay: 45 } },
      { kind: "IMAGE", title: "Photo with text", body: `Text beside the photo. ${long}\n\nA second paragraph.`, isPublished: true, data: { ...image, caption: "A caption", imageSide: "RIGHT" } },
      { kind: "GALLERY", title: "Photo gallery", isPublished: true, data: { images: [0, 1, 2, 3, 4].map((index) => ({ ...image, caption: `Caption ${index + 1}` })) } },
      { kind: "FORMATTED_TEXT", title: "Formatted text", isPublished: true, body: `## A heading\n\nSome **bold**, *italic* and a [link](https://example.org/${long}).\n\n### A smaller heading\n\n- First bullet\n- Second bullet\n\n1. First step\n2. Second step` },
      { kind: "EMBED", title: "Video", isPublished: true, data: { provider: "YOUTUBE", id: "dQw4w9WgXcQ", title: "Synthetic welcome video" } },
      { kind: "EMBED", title: "Map", isPublished: true, data: { provider: "GOOGLE_MAPS", id: mapsId, title: "Synthetic map" } },
      { kind: "FAQ", title: "Questions and answers", isPublished: true, data: { entries: [{ question: `Where do I park? ${long}`, answer: `The north lot. ${long}` }, { question: "What should I bring?", answer: "A water bottle." }] } },
      { kind: "SCHEDULE", title: "Schedule", isPublished: true, data: { rows: [{ day: "Friday", time: "7:00 PM", title: "Opening worship", location: "Chapel", description: "Songs and a short message." }, { day: "Friday", time: "9:00 PM", title: long }, { day: "Sabbath", time: "9:30 AM", title: "Sabbath school" }] } },
      { kind: "SPEAKERS", title: "Speakers", isPublished: true, data: { speakers: [{ name: "Pat Mobilecheck-Speaker", role: "Pastor", bio: `A short synthetic bio. ${long}`, ...image }, { name: "Sam Example", role: "Youth leader", bio: "" }] } },
      { kind: "CONTACT", title: "Contact", isPublished: true, data: { contacts: [{ name: "Dana Mobilecheck-Contact", role: "Event coordinator", email: "a-very-long-synthetic-address-for-wrapping@mobilecheck.example.test", phone: "(515) 555-0100" }] } },
      { kind: "COUNTDOWN", title: "Countdown", isPublished: true, data: { target: "EVENT_START", label: "Until we gather" } },
      { kind: "CUSTOM_HTML", title: "Custom HTML", isPublished: true, body: `<h2>A custom heading</h2><p>Custom paragraph. ${long}</p><table><tr><th>Day</th><th>Meal</th></tr><tr><td>Friday</td><td>Supper</td></tr></table><img src="/api/public/events/${blocksEventSlug}/assets/${asset.id}" alt="A synthetic test image" width="1600" height="900">` },
    ],
  });
  await replaceEventContent(blocksEventId, input, "usr_system_admin", { isSystemAdmin: true });
}

/**
 * A Pathfinder Bible Experience shaped event: the starter's team rules, the Iowa and Missouri sites and the pbe_registration
 * form, published, with the general registration link on and church billing. Two teams are registered through the real link
 * code: one matched to club A by its director's email (so it is an ordinary club registration, shown in the club portal and on
 * the staff Registrations, team results and team form pages) and one that waits for staff (the pending teams page). Idempotent.
 * Returns the ids the team pages need.
 */
async function seedPbeEvent(prisma: PrismaClient) {
  const { starterEventTemplates } = await import("../modules/event-templates/starters");
  const { createRegistrationFormFromTemplateInTransaction } = await import("../modules/forms/repository");
  const { calendarDateIn, addDays } = await import("../modules/calendar/domain");
  const starter = starterEventTemplates.find((entry) => entry.starterKey === "pathfinder_bible_experience");
  if (!starter?.teamSettings || !starter.locations) throw new Error("The Pathfinder Bible Experience starter is missing or has no team rules.");
  const today = calendarDateIn(new Date());
  // A database that kept the event from an earlier run (cleanup off): dates move with today so registration is still open, and
  // the teams an earlier walkthrough submitted (with their mail and audit rows) go, so each run starts the same and can reuse its names.
  if (await prisma.event.findUnique({ where: { id: pbeEventId }, select: { id: true } })) {
    await prisma.event.update({
      where: { id: pbeEventId },
      data: { startsAt: new Date(`${addDays(today, 90)}T15:00:00Z`), endsAt: new Date(`${addDays(today, 90)}T23:00:00Z`), registrationOpensOn: addDays(today, -5), registrationClosesOn: addDays(today, 60) },
    });
    const earlier = await prisma.generalLinkSubmission.findMany({ where: { eventId: pbeEventId, teamName: { startsWith: "Mobilecheck Walkthrough Team" } }, select: { id: true } });
    if (earlier.length > 0) {
      const ids = earlier.map((row) => row.id);
      await prisma.auditLog.deleteMany({ where: { eventId: pbeEventId, entityId: { in: ids } } });
      await prisma.messageOutbox.deleteMany({ where: { eventId: pbeEventId, recipientEmail: { startsWith: `${P}.walkthrough.` } } });
      await prisma.generalLinkSubmission.deleteMany({ where: { id: { in: ids } } });
    }
  }
  if (!(await prisma.event.findUnique({ where: { id: pbeEventId }, select: { id: true } }))) {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@imsda-events.test" }, select: { id: true } });
    await prisma.$transaction(async (tx) => {
      await tx.event.create({
        data: {
          id: pbeEventId, slug: pbeEventSlug, name: "Mobilecheck IA & MO Bible Experience",
          startsAt: new Date(`${addDays(today, 90)}T15:00:00Z`), endsAt: new Date(`${addDays(today, 90)}T23:00:00Z`), timezone: "America/Chicago",
          isPublished: true, registrationOpensOn: addDays(today, -5), registrationClosesOn: addDays(today, 60),
          billingMode: starter.billingMode, audience: "CLUB", checksAdultBackgrounds: starter.checksAdultBackgrounds, generalRegistrationLinkEnabled: true,
        },
      });
      await tx.eventTeamSettings.create({
        data: { eventId: pbeEventId, ...starter.teamSettings!, levelInfo: (starter.teamSettings!.levelInfo ?? []) as unknown as Prisma.InputJsonValue },
      });
      await tx.eventMembership.create({ data: { eventId: pbeEventId, userId: admin.id, role: "EVENT_ADMIN", status: "ACTIVE" } });
      await tx.eventLocation.createMany({
        data: starter.locations!.map((location, position) => ({
          eventId: pbeEventId, name: location.name, normalizedName: location.name.toLowerCase(), address: location.address, capacity: location.capacity, sortOrder: position,
        })),
      });
      await createRegistrationFormFromTemplateInTransaction(tx, pbeEventId, "usr_system_admin", starter.formTemplateKey);
    });
    const created = await prisma.registrationForm.findFirstOrThrow({ where: { eventId: pbeEventId } });
    await prisma.registrationFormVersion.updateMany({ where: { formId: created.id }, data: { status: "PUBLISHED", publishedAt: new Date() } });
    await prisma.registrationForm.update({ where: { id: created.id }, data: { status: "PUBLISHED" } });
  }
  const form = await prisma.registrationForm.findFirstOrThrow({ where: { eventId: pbeEventId }, include: { versions: true } });
  const versionId = form.versions[0]!.id;
  const locations = await prisma.eventLocation.findMany({ where: { eventId: pbeEventId }, orderBy: { sortOrder: "asc" } });
  const { submitGeneralLinkRegistration } = await import("../modules/general-link-registrations/repository");
  const person = (first: string, last: string, age: number, alternate = false) => ({
    clientId: `c${`${first}${last}`.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12)}`,
    // Team members only, no role question (#1044).
    responses: { first_name: first, last_name: last, attendee_age: age, ...(alternate ? { alternate: true } : {}) } as Record<string, unknown>,
  });
  const submit = async (teamName: string, clubName: string, email: string, key: string, location: string, extraResponses: Record<string, unknown> = {}) => {
    if (await prisma.generalLinkSubmission.findFirst({ where: { eventId: pbeEventId, teamName } })) return;
    await submitGeneralLinkRegistration(pbeEventSlug, {
      versionId, idempotencyKey: key,
      responses: {
        club_name: clubName, director_name: "Dana Mobilecheck-Directorsson", email, phone: "515-555-0100",
        coordinator_name: "Casey Mobilecheck-Coordinator", coordinator_address: "1 Synthetic Road", coordinator_city: "Testville", coordinator_state: "IA", coordinator_zip: "50000",
        coordinator_phone: "515-555-0101", coordinator_email: `${P}.coordinator@example.test`, director_confirmation: true,
        ...extraResponses,
      },
      attendees: [person("Bartholomew-Alexander", "Quillfeather-Hargreaves", 14), person("Maria", "de la Cruz-Montenegro", 15, true), person("Lisa", "Hickman", 16), person("Pat", "Mobilecheck-Member", 15)],
      website: "",
    }, { locationId: location, teamName });
  };
  // Matched: the account email is club A's director on file. Waiting: an email that matches nobody, naming club B.
  await submit(pbeTeamName, `Mobilecheck ${longName}`, `${P}.director@example.test`, `${P}-pbe-matched-key-0001`, locations[0]!.id);
  await submit("Mobilecheck Sword Drillers of the Riverside Valley", "Mobilecheck Eagles Club", `${P}.unmatched.director-with-a-long-address@example.test`, `${P}-pbe-pending-key-0002`, locations[1]!.id);
  // Waiting, club not in the directory (#1031): "Not listed" and the name the director typed, for staff to add.
  await submit("Mobilecheck Lantern Bearers", "Not listed", `${P}.unlisted.director@example.test`, `${P}-pbe-unlisted-key-0003`, locations[0]!.id, { club_name_other: "Mobilecheck Lantern Pathfinders" });
  return prisma.clubEventRegistration.findFirstOrThrow({ where: { eventId: pbeEventId, organizationId: clubA }, select: { registrationId: true, teamKey: true } });
}

/**
 * A registration the director can ask to cancel from the portal and the private link, with requests already in several states (#170).
 * Idempotent. Everything is made through the real repository functions, so the pages show what a registrant and a finance manager see.
 */
async function seedCancellationEvent(prisma: PrismaClient): Promise<PageSpec[]> {
  const { addDays, calendarDateIn } = await import("../modules/calendar/domain");
  const { createPolicyVersion } = await import("../modules/cancellation-policy/repository");
  const { createRegistrationAccessToken } = await import("../modules/public-access/repository");
  const requests = await import("../modules/cancellation-requests/repository");
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@imsda-events.test" }, select: { id: true } });
  const today = calendarDateIn(new Date());
  const registrationId = `${P}_reg_cancel`;
  const formId = `${P}_cancel_form`;
  const formVersionId = `${P}_cancel_form_version`;
  if (!(await prisma.event.findUnique({ where: { id: cancelEventId }, select: { id: true } }))) {
    await prisma.$transaction(async (tx) => {
      await tx.event.create({
        data: {
          id: cancelEventId, slug: cancelEventSlug, name: "Mobilecheck Cancellation Weekend",
          startsAt: new Date(`${addDays(today, 90)}T15:00:00Z`), endsAt: new Date(`${addDays(today, 92)}T18:00:00Z`), timezone: "America/Chicago",
          isPublished: true, billingMode: "ATTENDEE_PAY",
        },
      });
      await tx.eventMembership.create({ data: { eventId: cancelEventId, userId: admin.id, role: "EVENT_ADMIN", status: "ACTIVE" } });
      await tx.registrationForm.create({ data: { id: formId, eventId: cancelEventId, createdByUserId: admin.id, name: "Cancellation form", slug: `${P}-cancel-form` } });
      await tx.registrationFormVersion.create({
        data: { id: formVersionId, formId, createdByUserId: admin.id, versionNumber: 1, status: "PUBLISHED", publishedAt: new Date(), definition: { title: "Check", description: "", confirmationMessage: "Received.", sections: [{ id: `${P}_contact`, title: "Contact", description: "", fields: [{ id: `${P}_email`, key: "email", label: "Email", helpText: "", type: "EMAIL", scope: "REGISTRATION", required: false, options: [] }] }] } },
      });
      // The director's own person row (the audit's accounts make one), so this is their registration, not a second person.
      const holder = await tx.person.findUnique({ where: { normalizedEmail: `${P}.director@example.test` } })
        ?? await tx.person.create({ data: { id: `${P}_person_cancel_holder`, firstName: "Dana", lastName: "Mobilecheck-Directorsson", normalizedEmail: `${P}.director@example.test` } });
      await tx.registration.create({
        data: {
          id: registrationId, eventId: cancelEventId, accountHolderPersonId: holder.id, confirmationCode: "MOBCAN1", totalAmount: 400, status: "CONFIRMED", submittedAt: new Date(),
          contactSnapshot: { firstName: "Dana", lastName: "Mobilecheck-Directorsson", email: `${P}.director@example.test`, phone: "" },
        },
      });
      for (const [index, name] of ["Alexandria Longnamington-Smythe", "Bo Kim"].entries()) {
        const person = await tx.person.create({ data: { id: `${P}_person_cancel_${index}`, firstName: name.split(" ")[0]!, lastName: name.split(" ").slice(1).join(" "), normalizedEmail: `${P}.cancel.${index}@example.test` } });
        await tx.registrationAttendee.create({
          data: { id: `${P}_cancel_attendee_${index}`, eventId: cancelEventId, registrationId, personId: person.id, attendeeType: "ADULT", position: index, profileSnapshot: { firstName: person.firstName, lastName: person.lastName } },
        });
      }
      await tx.publicRegistrationSubmission.create({
        data: {
          eventId: cancelEventId, formVersionId, registrationId, idempotencyKey: `${P}_cancel_idem`, requestHash: "hash", responses: {},
          pricingSnapshot: {
            currency: "USD", subtotalCents: 40_000, processingFeeCents: 0, totalCents: 40_000,
            lineItems: [
              { key: "attendees.0.registration_fee", label: "Registration, Alexandria", amountCents: 20_000, attendeeIndex: 0 },
              { key: "attendees.1.registration_fee", label: "Registration, Bo", amountCents: 20_000, attendeeIndex: 1 },
            ],
          },
        },
      });
      await tx.payment.create({ data: { eventId: cancelEventId, registrationId, amount: 400, status: "SUCCEEDED", method: "CHECK", receivedAt: new Date() } });
    });
    await createPolicyVersion(cancelEventId, admin.id, {
      rules: {
        windows: [{ id: "before-deadline", label: "Before the deadline", endsOn: addDays(today, 30), terms: { refund: { kind: "FULL" }, flatWithholdCents: 1000, flatWithholdLabel: "Processing fee", depositTreatment: "REFUND", creditAllowed: false } }],
        afterWindows: { label: "After the deadline", terms: { refund: { kind: "NONE" }, flatWithholdCents: 0, flatWithholdLabel: "Processing fee", depositTreatment: "FORFEIT", creditAllowed: false } },
        noShow: null, allowedScopes: ["FULL_REGISTRATION", "ATTENDEE"], supportedComponents: { categories: [], fieldKeys: [] }, classifications: [],
        nonrefundable: { categories: [], fieldKeys: [] }, cardFeeTreatment: "REFUNDABLE",
      },
    });
  }
  const target = { registrationId, eventId: cancelEventId };
  if ((await prisma.cancellationRequest.count({ where: { eventId: cancelEventId } })) === 0) {
    const attendees = await prisma.registrationAttendee.findMany({ where: { registrationId }, orderBy: { position: "asc" }, select: { id: true } });
    const longReason = "We have a family emergency and cannot travel, so we would like to cancel Alexandria's place and keep Bo's. ".repeat(3).trim();
    const send = (key: string, scope: "FULL_REGISTRATION" | "ATTENDEE", attendeeId?: string, expectedRefundCents = 39_000) => ({
      action: "submit" as const,
      selection: scope === "ATTENDEE" ? { scope, attendeeIds: [attendeeId!] } : { scope },
      reason: longReason, contactMethod: "EMAIL" as const, idempotencyKey: `${P}-cancel-key-${key}`, expectedRefundCents,
    });
    const whole = await requests.submitCancellationRequest(target, { via: "MANAGE_LINK" }, send("whole", "FULL_REGISTRATION"));
    await requests.withdrawCancellationRequest(target, whole.request.id);
    const first = await requests.submitCancellationRequest(target, { via: "MANAGE_LINK" }, send("one", "ATTENDEE", attendees[0]!.id, 19_000));
    await requests.reviewCancellationRequest(cancelEventId, first.request.id, { userId: admin.id }, { action: "REQUEST_INFORMATION", registrantNote: "Please send the date you need to cancel by and whether Bo is still coming. ".repeat(2).trim() });
    await requests.submitCancellationRequest(target, { via: "MANAGE_LINK" }, send("two", "ATTENDEE", attendees[1]!.id, 19_000));
  }
  const first = await prisma.cancellationRequest.findFirstOrThrow({ where: { eventId: cancelEventId, status: "INFORMATION_NEEDED" }, select: { id: true } });
  const issued = await createRegistrationAccessToken({ registrationId });

  // Approved requests (#171): one waiting to be carried out, one approved for attendees only, one already carried out.
  const execution = await import("../modules/cancellation-execution/repository");
  const approvedIds: Record<string, string> = {};
  for (const [code, label] of [["MOBCAN2", "carry-out"], ["MOBCAN3", "carried-out"]] as const) {
    const id = `${P}_reg_${label}`;
    if (!(await prisma.registration.findUnique({ where: { id }, select: { id: true } }))) {
      const holderData = { id: `${P}_person_${label}_holder`, firstName: "Casey", lastName: `Mobilecheck-${label}`, normalizedEmail: `${P}.${label}@example.test` };
      const holder = await prisma.person.upsert({ where: { id: holderData.id }, update: {}, create: holderData });
      await prisma.registration.create({
        data: { id, eventId: cancelEventId, accountHolderPersonId: holder.id, confirmationCode: code, totalAmount: 200, status: "CONFIRMED", submittedAt: new Date(), contactSnapshot: { firstName: "Casey", lastName: `Mobilecheck-${label}`, email: `${P}.${label}@example.test`, phone: "" } },
      });
      await prisma.registrationAttendee.create({
        data: { id: `${P}_${label}_attendee`, eventId: cancelEventId, registrationId: id, personId: holder.id, attendeeType: "ADULT", position: 0, profileSnapshot: { firstName: "Casey", lastName: `Mobilecheck-${label}` } },
      });
      await prisma.publicRegistrationSubmission.create({
        data: {
          eventId: cancelEventId, formVersionId, registrationId: id, idempotencyKey: `${P}_${label}_idem`, requestHash: "hash", responses: {},
          pricingSnapshot: { currency: "USD", subtotalCents: 20_000, processingFeeCents: 0, totalCents: 20_000, lineItems: [{ key: "attendees.0.registration_fee", label: "Registration, Casey", amountCents: 20_000, attendeeIndex: 0 }] },
        },
      });
      await prisma.payment.create({ data: { eventId: cancelEventId, registrationId: id, amount: 200, status: "SUCCEEDED", method: "CHECK", receivedAt: new Date() } });
      const asked = await requests.submitCancellationRequest({ registrationId: id, eventId: cancelEventId }, { via: "MANAGE_LINK" }, {
        action: "submit", selection: { scope: "FULL_REGISTRATION" }, reason: "A schedule conflict.", contactMethod: "EMAIL", idempotencyKey: `${P}-cancel-key-${label}`, expectedRefundCents: 19_000,
      });
      await requests.reviewCancellationRequest(cancelEventId, asked.request.id, { userId: admin.id }, { action: "APPROVE", reason: "Within the policy." });
    }
    approvedIds[label] = (await prisma.cancellationRequest.findFirstOrThrow({ where: { registrationId: id }, select: { id: true } })).id;
  }
  const done = await prisma.cancellationExecution.findUnique({ where: { requestId: approvedIds["carried-out"]! }, select: { id: true } });
  if (!done) await execution.carryOutCancellation(cancelEventId, approvedIds["carried-out"]!, { userId: admin.id }, { confirm: true, method: "OFFLINE" });
  const second = await prisma.cancellationRequest.findFirstOrThrow({ where: { registrationId, scope: "ATTENDEE", status: { in: ["REQUESTED", "APPROVED"] } }, select: { id: true, status: true } });
  if (second.status === "REQUESTED") await requests.reviewCancellationRequest(cancelEventId, second.id, { userId: admin.id }, { action: "APPROVE", reason: "Within the policy." });
  return [
    { name: "cancellation-manage-link", path: issued.managePath, role: "visitor", expectText: /Ask to cancel/ },
    { name: "cancellation-staff-queue", path: `/finance/cancellation-requests?event=${cancelEventId}`, role: "event-admin", expectText: /Cancellation requests/ },
    { name: "cancellation-staff-detail", path: `/finance/cancellation-requests?event=${cancelEventId}&request=${first.id}`, role: "event-admin", expectText: /Your decision/ },
    { name: "cancellation-staff-carry-out", path: `/finance/cancellation-requests?event=${cancelEventId}&status=APPROVED&request=${approvedIds["carry-out"]}`, role: "event-admin", expectText: /How is the refund made/ },
    { name: "cancellation-staff-carried-out", path: `/finance/cancellation-requests?event=${cancelEventId}&status=APPROVED&request=${approvedIds["carried-out"]}`, role: "event-admin", expectText: /Completed/ },
    { name: "cancellation-staff-attendees-approved", path: `/finance/cancellation-requests?event=${cancelEventId}&status=APPROVED&request=${second.id}`, role: "event-admin", expectText: /Carry out/ },
  ];
}

/** Removes the cancellation event and what hangs off it (requests, their timeline, calculations, the registration and its people). */
async function cleanupCancellationEvent(prisma: PrismaClient) {
  if (!(await prisma.event.findUnique({ where: { id: cancelEventId }, select: { id: true } }))) return;
  const { removeEventOwnedRows } = await import("../modules/events/deletion-repository");
  await prisma.auditLog.deleteMany({ where: { eventId: cancelEventId } });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`;
    await removeEventOwnedRows(tx, cancelEventId);
  }, { timeout: 30_000 });
}

/**
 * A published general event with a published form (attendee questions: a required choice, a multiple choice, a long label, a
 * note, a ticked box that reveals a note, plus a meal and a lodging question that must NOT be asked) and six personal staff
 * invitations in every list status, made through the real repository functions: not sent (the open link the form page uses), sent,
 * waiting, approved, declined (so Re-invite shows) and revoked. Idempotent. Returns the open link's token.
 */
async function seedStaffInviteEvent(prisma: PrismaClient) {
  const { addDays, calendarDateIn } = await import("../modules/calendar/domain");
  const repo = await import("../modules/staff-invitations/repository");
  const { invitationToken } = await import("../modules/staff-invitations/link");
  const today = calendarDateIn(new Date());
  const startsOn = addDays(today, 60);
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: "admin@imsda-events.test" }, select: { id: true } });
  if (!(await prisma.event.findUnique({ where: { id: staffInviteEventId }, select: { id: true } }))) {
    const field = (key: string, extra: Record<string, unknown> = {}) => ({ id: `fld-${key}`, key, label: key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()), helpText: "", type: "TEXT", scope: "ATTENDEE", required: false, options: [], ...extra });
    const form = await prisma.$transaction(async (tx) => {
      await tx.event.create({
        data: {
          id: staffInviteEventId, slug: staffInviteEventSlug, name: "Mobilecheck Staff Weekend",
          startsAt: new Date(`${startsOn}T15:00:00Z`), endsAt: new Date(`${addDays(startsOn, 3)}T20:00:00Z`), timezone: "America/Chicago", isPublished: true,
        },
      });
      await tx.eventMembership.create({ data: { eventId: staffInviteEventId, userId: admin.id, role: "EVENT_ADMIN", status: "ACTIVE" } });
      return tx.registrationForm.create({ data: { eventId: staffInviteEventId, createdByUserId: admin.id, name: "Mobilecheck staff form", slug: "mobilecheck-staff", status: "PUBLISHED" } });
    });
    await prisma.registrationFormVersion.create({
      data: {
        formId: form.id, createdByUserId: admin.id, versionNumber: 1, status: "PUBLISHED", publishedAt: new Date(),
        definition: {
          title: "Mobilecheck staff form", description: "", confirmationMessage: "Thanks, synthetic.",
          sections: [{
            id: "people", title: "People", description: "",
            fields: [
              field("first_name", { required: true }), field("last_name", { required: true }),
              field("shirt_size", { type: "SELECT", options: ["Small", "Medium", "Large", "Extra large"], required: true, label: "Which convention shirt size would this person like to receive for the weekend?" }),
              field("ministry_areas", { type: "MULTISELECT", options: ["Music", "Kitchen", "Grounds", "Welcome desk"], minSelections: 1, maxSelections: 2, required: true, label: "Where would this person like to help?" }),
              field("preferred_name", { helpText: "What we should print on a name badge, if different." }),
              field("rides_in_van", { type: "CHECKBOX", label: "Riding in the church van" }),
              field("van_seat_notes", { type: "LONG_TEXT", conditional: { fieldKey: "rides_in_van", operator: "EQUALS", value: "true" } }),
              field("meal_choice", { type: "RADIO", options: ["Regular", "Vegetarian"], required: true }),
              field("lodging_choice", { type: "RADIO", options: ["Dorm", "Cabin"], required: true }),
            ],
          }],
        },
      },
    });
    const { ensureEventMessagingDefaults } = await import("../modules/communications/messaging-repository");
    await ensureEventMessagingDefaults(staffInviteEventId);
    const csv = [
      "email,first name,last name,group",
      `${staffInviteEmail("open")},Octavia-Bartholomew,Mobilecheck-Longname-Synthetic,Staff`,
      `${staffInviteEmail("sent")},Pat,Mobilecheck-Pastor,Pastor`,
      `${staffInviteEmail("waiting")},Wendy,Mobilecheck-Waiting,Volunteer`,
      `${staffInviteEmail("approved")},Alex,Mobilecheck-Approved,Staff`,
      `${staffInviteEmail("declined")},Dana,Mobilecheck-Declined,Volunteer`,
      `${staffInviteEmail("revoked")},Rory,Mobilecheck-Revoked,Staff`,
    ].join("\n");
    const preview = await repo.previewInvitationImport(staffInviteEventId, { csv, defaultGroup: null });
    await repo.confirmInvitationImport(staffInviteEventId, admin.id, { csv, defaultGroup: null, digest: preview.digest });
    const row = (key: string) => prisma.staffInvitation.findFirstOrThrow({ where: { eventId: staffInviteEventId, email: staffInviteEmail(key), supersededAt: null } });
    const answers = (people: number) => Array.from({ length: people }, () => ({ shirt_size: "Medium", ministry_areas: ["Music"] }));
    const register = async (key: string, first: string, withChild: boolean) => repo.submitInvitationRegistration(invitationToken(await row(key)), {
      firstName: first, lastName: `Mobilecheck-${key}`, spouse: { firstName: "Sam", lastName: `Mobilecheck-${key}` },
      dependants: withChild ? [{ firstName: "Kit", lastName: `Mobilecheck-${key}`, age: 7 }] : [], answers: answers(withChild ? 3 : 2),
    });
    const sentRow = await row("sent");
    const sendPreview = await repo.previewInvitationSend(staffInviteEventId, [sentRow.id]);
    await repo.sendInvitations(staffInviteEventId, admin.id, { ids: [sentRow.id], digest: sendPreview.digest });
    await register("waiting", "Wendy", true);
    await register("approved", "Alex", false);
    await register("declined", "Dana", false);
    await repo.approveRegistrations(staffInviteEventId, admin.id, [(await row("approved")).id], { withoutMealCoverage: true });
    await repo.declineRegistrations(staffInviteEventId, admin.id, [(await row("declined")).id]);
    await repo.revokeInvitations(staffInviteEventId, admin.id, [(await row("revoked")).id]);
  }
  const open = await prisma.staffInvitation.findFirstOrThrow({ where: { eventId: staffInviteEventId, email: staffInviteEmail("open"), supersededAt: null } });
  return invitationToken(open);
}

/** Removes everything seedStaffInviteEvent made, children before parents (the registrations, mail and audit rows the repository wrote). */
async function cleanupStaffInviteEvent(prisma: PrismaClient) {
  const exists = await prisma.event.findUnique({ where: { id: staffInviteEventId }, select: { id: true } });
  if (!exists) return;
  const registrations = await prisma.registration.findMany({ where: { eventId: staffInviteEventId }, select: { id: true, accountHolderPersonId: true, attendees: { select: { personId: true } } } });
  const registrationIds = registrations.map((row) => row.id);
  const personIds = [...new Set(registrations.flatMap((row) => [row.accountHolderPersonId, ...row.attendees.map((attendee) => attendee.personId)]).filter((id): id is string => Boolean(id)))];
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`,
    prisma.messageOutbox.deleteMany({ where: { OR: [{ eventId: staffInviteEventId }, { registrationId: { in: registrationIds } }] } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" DISABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.registrationOperation.deleteMany({ where: { eventId: staffInviteEventId } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" ENABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.auditLog.deleteMany({ where: { eventId: staffInviteEventId } }),
    prisma.staffInvitation.deleteMany({ where: { eventId: staffInviteEventId } }),
    prisma.registrationAttendee.deleteMany({ where: { eventId: staffInviteEventId } }),
    prisma.registration.deleteMany({ where: { eventId: staffInviteEventId } }),
    prisma.event.deleteMany({ where: { id: staffInviteEventId } }),
    prisma.person.deleteMany({ where: { OR: [{ id: { in: personIds } }, { normalizedEmail: { startsWith: `${P}.staffinv.` } }] } }),
  ]);
}

/** Removes everything seedPbeEvent made, children before parents, including what the link code wrote (registrations, people, mail, audit). */
async function cleanupPbeEvent(prisma: PrismaClient) {
  const exists = await prisma.event.findUnique({ where: { id: pbeEventId }, select: { id: true } });
  if (!exists) return;
  const registrations = await prisma.registration.findMany({ where: { eventId: pbeEventId }, select: { id: true, accountHolderPersonId: true, attendees: { select: { personId: true } } } });
  const registrationIds = registrations.map((row) => row.id);
  const personIds = [...new Set(registrations.flatMap((row) => [row.accountHolderPersonId, ...row.attendees.map((attendee) => attendee.personId)]).filter((id): id is string => Boolean(id)))];
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`,
    prisma.messageOutbox.deleteMany({ where: { OR: [{ eventId: pbeEventId }, { registrationId: { in: registrationIds } }] } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" DISABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.registrationOperation.deleteMany({ where: { eventId: pbeEventId } }),
    prisma.$executeRawUnsafe('ALTER TABLE "RegistrationOperation" ENABLE TRIGGER "RegistrationOperation_immutable"'),
    prisma.auditLog.deleteMany({ where: { eventId: pbeEventId } }),
    prisma.clubRegistrationDraft.deleteMany({ where: { eventId: pbeEventId } }),
    prisma.generalLinkSubmission.deleteMany({ where: { eventId: pbeEventId } }),
    prisma.clubEventRegistration.deleteMany({ where: { eventId: pbeEventId } }),
    prisma.registrationAttendee.deleteMany({ where: { eventId: pbeEventId } }),
    prisma.registration.deleteMany({ where: { eventId: pbeEventId } }),
    prisma.event.deleteMany({ where: { id: pbeEventId } }),
    prisma.person.deleteMany({ where: { id: { in: personIds } } }),
  ]);
}

/**
 * The Emails editor with attachments (#824): on the blocks event, a published announcement template with two
 * attachments (one with a long unbroken name), an uploaded picture and a button in its body, and a draft
 * announcement with an attachment, all saved through the real repository functions.
 */
async function seedMessageFiles(prisma: PrismaClient) {
  const { createMessageFile } = await import("../modules/communications/message-files");
  const { ensureEventMessagingDefaults, publishMessageTemplateVersion } = await import("../modules/communications/messaging-repository");
  const { createAnnouncement } = await import("../modules/communications/repository");
  const existing = await prisma.messageFile.count({ where: { eventId: blocksEventId } });
  if (existing > 0) return;
  await ensureEventMessagingDefaults(blocksEventId);
  const template = await prisma.eventMessageTemplate.findUniqueOrThrow({
    where: { eventId_key: { eventId: blocksEventId, key: "EVENT_ANNOUNCEMENT" } },
    select: { id: true },
  });
  const long = "Supercalifragilisticexpialidocious-and-an-extremely-long-unbroken-synthetic-file-name";
  const pdf = (label: string) => Buffer.from(`%PDF-1.7\n% ${label}\n${" ".repeat(400)}`);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const upload = (bytes: Buffer, name: string, type: string, purpose: "attachment" | "inline-image") =>
    createMessageFile(blocksEventId, new File([new Uint8Array(bytes)], name, { type }), "usr_system_admin", purpose, prisma);
  const agenda = await upload(pdf("agenda"), `${long}.pdf`, "application/pdf", "attachment");
  const terms = await upload(pdf("terms"), "Terms and conditions.pdf", "application/pdf", "attachment");
  const picture = await upload(png, "mobilecheck-picture.png", "image/png", "inline-image");
  await publishMessageTemplateVersion(blocksEventId, template.id, {
    subjectTemplate: "{{event_name}}: {{announcement_title}}",
    bodyTemplate: `# {{announcement_title}}\n\n{{announcement_body}}\n\n![A synthetic picture](msgfile:${picture.id})\n\n[Open my check-in pass]({{checkin_qr_url}}){.button}\n\n![Check-in QR code]({{checkin_qr_image}})`,
    isEnabled: true,
    attachmentFileIds: [agenda.id, terms.id],
  }, "usr_system_admin");
  await createAnnouncement(blocksEventId, "usr_system_admin", {
    title: "Mobilecheck draft with attachments",
    body: "A draft announcement that carries two files.",
    priority: "NORMAL",
    attachmentFileIds: [agenda.id, terms.id],
  });
}

/**
 * The delivery log with a failed send (#860): five failed messages from one Email selected batch, one still queued,
 * so the Retry failed panel, its review and the queued notice are on the page. Plain rows with no registration, the
 * same shape the log shows for a detached message.
 */
async function seedFailedDeliveries(prisma: PrismaClient) {
  const { ensureEventMessagingDefaults } = await import("../modules/communications/messaging-repository");
  await ensureEventMessagingDefaults(blocksEventId);
  if (await prisma.messageOutbox.count({ where: { eventId: blocksEventId, correlationId: `${P}-failed-batch` } }) > 0) return;
  const batchId = `${P}-failed-batch`;
  const row = (index: number, status: "FAILED" | "SENT" | "PENDING") => ({
    eventId: blocksEventId,
    templateKey: "EVENT_ANNOUNCEMENT" as const,
    recipientKind: "REGISTRANT" as const,
    recipientEmail: `${P}.guest${index}@example.test`,
    recipientName: `Mobilecheck Guest ${index}`,
    senderNameSnapshot: "Mobilecheck Events",
    senderEmailSnapshot: `${P}.sender@example.test`,
    subjectSnapshot: "Welcome to the retreat",
    bodyTextSnapshot: "Welcome.",
    status,
    attemptCount: status === "FAILED" ? 5 : 0,
    lastError: status === "FAILED" ? "The email provider's sending limit was reached." : null,
    failedAt: status === "FAILED" ? new Date() : null,
    metadata: { batchId, trigger: "STAFF_SELECTED_AUDIENCE_BATCH" },
    idempotencyKey: `${P}-failed-delivery-${index}`,
    correlationId: batchId,
  });
  await prisma.messageOutbox.createMany({
    data: [row(1, "SENT"), row(2, "SENT"), row(3, "FAILED"), row(4, "FAILED"), row(5, "FAILED"), row(6, "FAILED"), row(7, "FAILED"), row(8, "PENDING")],
  });
}

/**
 * Scheduled email batches (#177): one waiting for approval, one approved with a daylight-saving note, and one paused with a
 * long unbroken name, so the list, its status chips, the label and value grid and the pause reason are on the page. Plain
 * rows written directly (no recipients), the same shape the page lists.
 */
async function seedScheduledEmails(prisma: PrismaClient) {
  if (await prisma.scheduledEmailBatch.count({ where: { eventId: blocksEventId } }) > 0) return;
  const common = {
    eventId: blocksEventId,
    createdByUserId: "usr_system_admin",
    templateKey: "BALANCE_REMINDER" as const,
    trigger: "ONE_TIME" as const,
    localTime: "09:00",
    eventTimezone: "America/Chicago",
    audienceQuery: { messageKind: "OPERATIONAL", roles: ["REGISTRATION_CONTACT"], search: "status=CONFIRMED&status=SUBMITTED", readinessStates: [] },
    audienceQueryVersion: "audience-query/2",
    audienceQueryHash: "0".repeat(64),
    audienceFingerprint: "1".repeat(64),
    eligibleCount: 12,
    excludedCount: 3,
  };
  const long = "Supercalifragilisticexpialidocious-reminder-with-an-extremely-long-unbroken-synthetic-name";
  await prisma.scheduledEmailBatch.createMany({
    data: [
      { ...common, id: `${P}-sched-1`, name: "Balance reminder before registration closes", localDate: "2099-05-01", sendAt: new Date("2099-05-01T14:00:00Z"), status: "SCHEDULED" },
      {
        ...common, id: `${P}-sched-2`, name: "Spring-forward reminder", localDate: "2099-03-08", localTime: "02:30", sendAt: new Date("2099-03-08T08:30:00Z"),
        dstBehavior: "GAP_SHIFTED", dstNote: "02:30 does not exist on 2099-03-08 in America/Chicago: the clocks skip forward that day. The email goes out at the first moment after the change, Sun, Mar 8, 2099, 3:30 AM CDT.",
        status: "ACTIVE", activatedByUserId: "usr_system_admin", activatedAt: new Date(),
      },
      {
        ...common, id: `${P}-sched-3`, name: long, localDate: "2099-06-01", sendAt: new Date("2099-06-01T14:00:00Z"), status: "PAUSED",
        pausedAt: new Date(), pauseReason: "The event's time zone or dates changed after this was approved, so its send time is no longer the one that was reviewed. Review the new time and approve it again.",
      },
    ],
  });
}

/**
 * The More launcher offers Turn off only for a module with a stored row that its data
 * does not keep on (#810). The seeded event has none, so this adds one switchable
 * module row (Attendee community, no data behind it) and the audit removes it again
 * at the end of the run, whether or not MOBILE_LAYOUT_CLEANUP is set.
 */
let launcherModuleCreated = false;
async function seedLauncherModule(prisma: PrismaClient) {
  const existing = await prisma.eventModule.findUnique({ where: { eventId_moduleKey: { eventId, moduleKey: "attendee-community" } }, select: { id: true } });
  if (existing) return;
  await prisma.eventModule.create({ data: { eventId, moduleKey: "attendee-community" } });
  launcherModuleCreated = true;
}

/** MOBILE_LAYOUT_CLEANUP=1: deletes every row the audit created, children before parents. */
async function cleanupSynthetic(prisma: PrismaClient) {
  const orgs = { organizationId: { in: [clubA, clubB] } };
  const accountIds = [`${P}_account_director`, `${P}_account_area`, `${P}_account_attendee`];
  // The message files' bytes (#824) live on disk, outside the database; their keys are read before the rows go.
  const messageFileKeys = (await prisma.messageFile.findMany({ where: { eventId: blocksEventId }, select: { storageKey: true } }))
    .map((file) => file.storageKey);
  const mine = { startsWith: `${P}_` };
  // The PBE event goes first; a failure there is reported and must not stop the rest of the cleanup.
  await cleanupPbeEvent(prisma).catch((error: Error) => console.error(`Could not remove the synthetic PBE event: ${error.message}`));
  await cleanupCancellationEvent(prisma).catch((error: Error) => console.error(`Could not remove the synthetic cancellation event: ${error.message}`));
  await cleanupStaffInviteEvent(prisma).catch((error: Error) => console.error(`Could not remove the synthetic staff invitation event: ${error.message}`));
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('imsda.event_deletion', 'on', true)`,
    prisma.assetDepositCover.deleteMany({ where: { issuanceId: mine } }),
    prisma.assetLedgerEntry.deleteMany({ where: { id: mine } }),
    prisma.facilityIssueHistory.deleteMany({ where: { issueId: mine } }),
    prisma.facilityIssue.deleteMany({ where: { id: mine } }),
    prisma.assetIssuanceHistory.deleteMany({ where: { issuanceId: mine } }),
    prisma.assetIssuance.deleteMany({ where: { id: mine } }),
    prisma.eventMealKitchenCount.deleteMany({ where: { id: mine } }),
    prisma.userSession.deleteMany({ where: { userId: mine } }),
    prisma.eventMembership.deleteMany({ where: { userId: mine } }),
    prisma.user.deleteMany({ where: { id: mine } }),
    prisma.issuedAsset.deleteMany({ where: { id: mine } }),
    prisma.issuedAssetType.deleteMany({ where: { id: mine } }),
    prisma.attendeeSession.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.clubInvite.deleteMany({ where: { OR: [orgs, { id: { startsWith: `${P}_` } }] } }),
    prisma.newClubApplication.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.newClubApplicationInvite.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.clubOrderNeed.deleteMany({ where: { OR: [orgs, { personId: { startsWith: `${P}_` } }] } }),
    prisma.memberClassCompletion.deleteMany({ where: { OR: [orgs, { personId: { startsWith: `${P}_` } }] } }),
    prisma.memberHonorEntry.deleteMany({ where: { OR: [orgs, { personId: { startsWith: `${P}_` } }] } }),
    prisma.honor.deleteMany({ where: { code: { startsWith: `${P}-honor-` } } }),
    prisma.registrationAttendee.deleteMany({ where: { registrationId: { startsWith: `${P}_reg_` } } }),
    prisma.registration.deleteMany({ where: { id: { startsWith: `${P}_reg_` } } }),
    prisma.scholarshipContribution.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.scholarshipFund.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.clubMonthlyReport.deleteMany({ where: orgs }),
    prisma.clubRosterMember.deleteMany({ where: orgs }),
    prisma.person.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.clubDirectorGrant.deleteMany({ where: { attendeeAccountId: { in: accountIds } } }),
    prisma.areaCoordinatorGrant.deleteMany({ where: { attendeeAccountId: { in: accountIds } } }),
    prisma.attendeeMfaEnrollment.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.attendeeAccount.deleteMany({ where: { id: { in: accountIds } } }),
    prisma.clubProfile.deleteMany({ where: orgs }),
    prisma.backgroundCheckEntry.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.backgroundCheckUpload.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.registrationFormVersion.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.registrationForm.deleteMany({ where: { id: { startsWith: `${P}_` } } }),
    prisma.honorOffering.deleteMany({ where: { id: multiHonorOfferingId } }),
    prisma.honorSession.deleteMany({ where: { id: multiHonorSessionId } }),
    prisma.honor.deleteMany({ where: { id: { in: multiHonorIds } } }),
    prisma.deadlineReminderBatch.deleteMany({ where: { title: { startsWith: "Mobilecheck" } } }),
    prisma.calendarEntry.deleteMany({ where: { id: { startsWith: `${P}_deadline_` } } }),
    prisma.calendarEntry.deleteMany({ where: { id: { startsWith: `${P}_calpair_` } } }),
    prisma.event.deleteMany({ where: { id: { startsWith: `${P}_calpair_` } } }),
    prisma.announcement.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.scheduledEmailBatch.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.messageOutbox.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.eventMessageTemplate.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.messageFile.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.eventContentSection.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.eventAsset.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.auditLog.deleteMany({ where: { eventId: blocksEventId } }),
    prisma.event.deleteMany({ where: { id: { in: [clubEventId, blocksEventId] } } }),
    prisma.organization.deleteMany({ where: { id: { in: [clubA, clubB] } } }),
    prisma.organization.deleteMany({ where: { id: { in: [churchA, churchB] } } }),
  ]);
  const { deleteAsset } = await import("../modules/events/asset-storage");
  for (const key of messageFileKeys) await deleteAsset(key).catch(() => undefined);
  console.log("Deleted the synthetic mobilecheck rows.");
}

/** Synthetic clubs, people, accounts and rows. Idempotent: safe to run twice. */
async function seedSynthetic(prisma: PrismaClient) {
  const { clubYearFor } = await import("../modules/club-rosters/domain");
  const clubYear = clubYearFor(new Date());
  const now = new Date();

  for (const [id, name] of [[churchA, "Mobilecheck Prairie Church"], [churchB, "Mobilecheck Riverside Seventh-day Adventist Church of the Valley"]] as const) {
    await prisma.organization.upsert({
      where: { id },
      update: {},
      create: { id, type: "CHURCH", name, normalizedName: name.toLowerCase(), city: "Testville", state: "IA" },
    });
  }
  for (const [id, name, church] of [[clubA, `Mobilecheck ${longName}`, churchA], [clubB, "Mobilecheck Eagles Club", churchB]] as const) {
    await prisma.organization.upsert({
      where: { id },
      update: {},
      create: { id, type: "CLUB", name, normalizedName: name.toLowerCase(), parentOrganizationId: church },
    });
    await prisma.clubProfile.upsert({
      where: { organizationId: id },
      update: {},
      create: { organizationId: id, meetingPlace: "Fellowship hall", meetingSchedule: "Saturdays after lunch", contactEmail: `${id}@example.test`, contactPhone: "555-0100" },
    });
  }

  // Accounts: a director (both clubs) and an Area Coordinator.
  const accounts = [
    { id: `${P}_account_director`, email: `${P}.director@example.test`, displayName: "Dana Mobilecheck-Directorsson", firstName: "Dana", lastName: "Mobilecheck-Directorsson" },
    { id: `${P}_account_area`, email: `${P}.area@example.test`, displayName: "Avery Mobilecheck-Coordinator", firstName: "Avery", lastName: "Mobilecheck-Coordinator" },
    // A plain attendee (#1175): no club, coordinator or staff grant and no registrations, so the Overview shows its empty state.
    { id: `${P}_account_attendee`, email: `${P}.attendee@example.test`, displayName: "Taylor Mobilecheck-Lane", firstName: "Taylor", lastName: "Mobilecheck-Lane" },
  ];
  for (const account of accounts) {
    await prisma.attendeeAccount.upsert({
      where: { id: account.id },
      update: { status: "ACTIVE", disabledAt: null },
      create: { ...account, status: "ACTIVE", emailVerifiedAt: now },
    });
  }
  // An enrolled authenticator (a placeholder secret: no code is ever checked, the minted
  // sessions are already marked second-step verified) opens the roster and registration pages.
  for (const account of accounts) {
    await prisma.attendeeMfaEnrollment.upsert({
      where: { accountId: account.id },
      update: { status: "ACTIVE" },
      create: { accountId: account.id, method: "TOTP", status: "ACTIVE", sealedSecret: `${P}-placeholder-not-a-secret`, confirmedAt: now },
    });
  }
  for (const organizationId of [clubA, clubB]) {
    const existing = await prisma.clubDirectorGrant.findFirst({ where: { organizationId, attendeeAccountId: `${P}_account_director`, revokedAt: null } });
    if (!existing) {
      await prisma.clubDirectorGrant.create({
        data: { organizationId, attendeeAccountId: `${P}_account_director`, role: "DIRECTOR", effectiveFrom: new Date("2026-01-01T00:00:00Z"), reason: "Synthetic mobile layout check" },
      });
    }
  }
  await prisma.areaCoordinatorGrant.upsert({
    where: { attendeeAccountId: `${P}_account_area` },
    update: { revokedAt: null, expiresAt: null },
    create: { attendeeAccountId: `${P}_account_area` },
  });

  // Roster: a mix of levels and long names, on both clubs.
  const levels = ["FRIEND", "COMPANION", "EXPLORER", "RANGER", "VOYAGER", "GUIDE"] as const;
  const surnames = ["Quillfeather-Hargreaves", "Ng", "Oyelaran-Whitcombe", "Smith", "Lindqvist", "de la Cruz-Montenegro"];
  for (const [clubId, count] of [[clubA, 14], [clubB, 4]] as const) {
    for (let index = 0; index < count; index += 1) {
      const n = String(index + 1).padStart(2, "0");
      const personId = `${P}_person_${clubId === clubA ? "a" : "b"}_${n}`;
      const person = await prisma.person.upsert({
        where: { id: personId },
        update: {},
        create: { id: personId, firstName: index % 4 === 0 ? "Bartholomew-Alexander" : `Pathy${n}`, lastName: surnames[index % surnames.length] },
      });
      const staffRole = index % 7 === 6;
      await prisma.clubRosterMember.upsert({
        where: { organizationId_clubYear_personId: { organizationId: clubId, clubYear, personId: person.id } },
        update: {},
        create: {
          organizationId: clubId,
          clubYear,
          personId: person.id,
          attendeeType: staffRole ? "STAFF" : "YOUTH",
          role: staffRole ? "Counselor" : "Pathfinder",
          classLevel: staffRole ? null : levels[index % levels.length],
          reportedAge: staffRole ? 34 : 10 + (index % 6),
          gender: index % 2 === 0 ? "FEMALE" : "MALE",
          source: "DIRECTOR",
        },
      });
      // One recorded class on the first person's history, so the class history page shows its Change date and Remove controls (#1011).
      if (index === 0) {
        await prisma.memberClassCompletion.upsert({
          where: { organizationId_personId_classLevel: { organizationId: clubId, personId: person.id, classLevel: "COMPANION" } },
          update: {},
          create: { organizationId: clubId, personId: person.id, classLevel: "COMPANION", completedOn: "2025-06-07", insigniaDismissedAt: new Date("2025-06-08T12:00:00Z") },
        });
      }
    }
  }

  // A filed monthly report and an invite for the staff lists. The saved answers add up to the stored total (#996): on time plus the picked points.
  const { pickedTotal, ON_TIME_POINTS } = await import("../modules/club-reports/domain");
  const reportPoints = { staffMeeting: 25, meetingsOutings: 50, ratio: 25, uniformMeetings: 20, uniformOutside: 40, devotions: 50, exercise: 0, outreach: 50, guest: 0, honors: 25, classLevel: 25, bonus: 0 };
  const filedReport = {
    organizationId: clubA, clubYear, reportMonth, meetingPlace: "Fellowship hall", meetingSchedule: "Saturdays",
    averageAttendance: 12, pathfinderCount: 12, tltCount: 1, staffCount: 3, classLevels: ["FRIEND" as const], points: reportPoints,
    honors: [{ name: "Camping Skills I", participants: 6 }],
    onTimePoints: ON_TIME_POINTS, totalPoints: ON_TIME_POINTS + pickedTotal(reportPoints), signatureName: "Dana Mobilecheck-Directorsson", signedOn: "2026-10-01",
    status: "SUBMITTED" as const, submittedAt: new Date("2026-10-01T15:00:00Z"), firstSubmittedAt: new Date("2026-10-01T15:00:00Z"),
  };
  await prisma.clubMonthlyReport.upsert({
    where: { organizationId_reportMonth: { organizationId: clubA, reportMonth } },
    update: filedReport,
    create: filedReport,
  });
  for (const [index, status] of (["PENDING", "SENT", "PENDING"] as const).entries()) {
    const id = `${P}_invite_${index}`;
    await prisma.clubInvite.upsert({
      where: { id },
      update: {},
      create: {
        id, organizationId: index === 2 ? clubB : clubA, email: `${P}.invite${index}.with-a-long-address@example.test`,
        name: index === 0 ? "Pat Mobilecheck-Longsurname-Invitee" : `Invitee ${index}`, role: index === 1 ? "DEPUTY" : "DIRECTOR", status,
        ...(status === "SENT" ? { sentAt: now, sentCount: 1, expiresAt: new Date(now.getTime() + 14 * 86_400_000) } : {}),
      },
    });
  }

  // New club applications (#817): one waiting at a church that already has a club (a duplicate flag), one typed church, one declined; plus a private link.
  const { hashOpaqueToken } = await import("../modules/access/tokens");
  await prisma.newClubApplicationInvite.upsert({
    where: { id: `${P}_application_invite` },
    update: { tokenHash: hashOpaqueToken(applicationLinkToken), usedAt: null, cancelledAt: null, expiresAt: new Date(now.getTime() + 30 * 86_400_000) },
    create: {
      id: `${P}_application_invite`, email: `${P}.invited.director-with-a-long-address@example.test`, name: "Ivy Mobilecheck-Invitee",
      tokenHash: hashOpaqueToken(applicationLinkToken), expiresAt: new Date(now.getTime() + 30 * 86_400_000),
    },
  });
  for (const [index, spec] of ([
    { status: "PENDING", church: churchA, other: null, name: "Mobilecheck Saint Bartholomew-Montgomery Trailblazers Pathfinder Club of the Western Prairie", type: "PATHFINDER" },
    { status: "PENDING", church: null, other: "Mobilecheck Fellowship of the Riverside Valley Congregation", name: "Mobilecheck Little Lambs Adventurers", type: "ADVENTURER" },
    { status: "DECLINED", church: churchB, other: null, name: "Mobilecheck Declined Club", type: "PATHFINDER" },
  ] as const).entries()) {
    await prisma.newClubApplication.upsert({
      where: { id: `${P}_application_${index}` },
      update: {},
      create: {
        id: `${P}_application_${index}`, status: spec.status, source: index === 1 ? "INVITE" : "PUBLIC", clubName: spec.name, clubType: spec.type,
        sponsoringChurchId: spec.church, sponsoringChurchOther: spec.other,
        pastorName: "Pat Mobilecheck-Pastorsson", directorName: "Dana Mobilecheck-Directorsson-Applicant",
        directorAddress: "1234 Mobilecheck Boulevard of the Extremely Long Street Name, Testville, ZZ 00000",
        directorEmail: `${P}.applicant.with-a-very-long-address-for-wrapping@example.test`,
        directorHomePhone: "555-0100", directorWorkPhone: "555-0101", philosophyAgreed: true,
        pastorSignature: "Pat Mobilecheck-Pastorsson", headElderSignature: "Hal Mobilecheck-Elder", clerkSignature: "Cleo Mobilecheck-Clerk", directorSignature: "Dana Mobilecheck-Directorsson-Applicant",
        otherBoardMembers: ["Ben Mobilecheck-Board", "Bea Mobilecheck-Board"], applicationDate: new Date("2026-10-07T00:00:00Z"),
        note: "A synthetic note long enough to wrap on a narrow phone screen without causing the page to scroll sideways.",
        ...(spec.status === "DECLINED" ? { decidedAt: now, decidedByUserId: "usr_system_admin", declineReason: "A synthetic reason." } : {}),
      },
    });
  }

  // A background-check list with a few entries (unmatched rows are enough to fill the page).
  const uploadId = `${P}_bg_upload`;
  await prisma.backgroundCheckUpload.upsert({
    where: { id: uploadId },
    update: {},
    create: { id: uploadId, format: "STERLING", rowCount: 4, added: 4, changed: 0, dropped: 0, uploadedByUserId: "usr_system_admin" },
  });
  for (let index = 0; index < 4; index += 1) {
    const id = `${P}_bg_entry_${index}`;
    await prisma.backgroundCheckEntry.upsert({
      where: { id },
      update: {},
      create: {
        id, uploadId, line: index + 2, firstName: index === 0 ? "Bartholomew-Alexander" : `Checked${index}`, lastName: surnames[index],
        normalizedName: `checked${index} ${surnames[index].toLowerCase()}`, identityKey: `${P}:${index}`,
        site: index % 2 === 0 ? "Mobilecheck Prairie Church" : null,
        checkedOn: "2025-08-01", expiresOn: index === 3 ? "2026-08-01" : "2027-08-01",
      },
    });
  }

  // A club-audience event with a one-section registration form, so the club's
  // registration page has something to render.
  const { registrationFormDefinitionSchema } = await import("../modules/forms/definition");
  await prisma.event.upsert({
    where: { id: clubEventId },
    update: {},
    create: {
      id: clubEventId, slug: clubEventSlug, name: "Mobilecheck Club Weekend",
      startsAt: new Date("2026-12-05T15:00:00Z"), endsAt: new Date("2026-12-06T22:00:00Z"), timezone: "America/Chicago",
      isPublished: true, registrationOpensOn: "2026-10-01", registrationClosesOn: "2026-11-30",
      billingMode: "DEFERRED_ORGANIZATION_INVOICE", audience: "CLUB",
    },
  });
  const formId = `${P}_form`;
  if (!(await prisma.registrationForm.findUnique({ where: { id: formId } }))) {
    const field = (id: string, key: string, label: string, type: string, scope: "ATTENDEE" | "REGISTRATION", required = false) =>
      ({ id: `${P}_${id}`, key, label, helpText: "", type, scope, required, options: [] });
    const definition = registrationFormDefinitionSchema.parse({
      title: "Mobilecheck club registration",
      description: "Fictitious club form.",
      confirmationMessage: "Your club is registered.",
      attendeeRoster: { enabled: true, minAttendees: 1, maxAttendees: 50, attendeeLabel: "Club member", addButtonLabel: "Add" },
      sections: [
        { id: `${P}_contact`, title: "Contact", description: "", fields: [
          field("c_first", "primary_contact_first_name", "First name", "TEXT", "REGISTRATION", true),
          field("c_last", "primary_contact_last_name", "Last name", "TEXT", "REGISTRATION", true),
          field("c_email", "email", "Email", "EMAIL", "REGISTRATION", true),
        ] },
        { id: `${P}_roster`, title: "Roster", description: "", fields: [
          field("a_first", "first_name", "First name", "TEXT", "ATTENDEE", true),
          field("a_last", "last_name", "Last name", "TEXT", "ATTENDEE", true),
          field("a_age", "attendee_age", "Age", "NUMBER", "ATTENDEE", true),
          field("a_fee", "registration_fee", "Registration fee", "CALCULATED", "ATTENDEE", false),
        ] },
      ],
    });
    await prisma.registrationForm.create({
      data: {
        id: formId, eventId: clubEventId, createdByUserId: "usr_system_admin", name: definition.title, slug: "club", status: "PUBLISHED",
        versions: { create: { id: `${P}_formver`, createdByUserId: "usr_system_admin", versionNumber: 1, status: "PUBLISHED", publishedAt: new Date(), definition } },
      },
    });
  }

  await seedHonorsAndRegistrations(prisma);
  await seedBlocksEvent(prisma);
  await seedMessageFiles(prisma);
  await seedFailedDeliveries(prisma);
  await seedScheduledEmails(prisma);
  await seedMultiHonorClass(prisma);
  await seedLauncherModule(prisma);
  await seedIssuedAssets(prisma);
  await seedKitchenCounts(prisma);
  await seedDeadlines(prisma);
  await seedCalendarEventPairs(prisma);
}

/**
 * Calendar items and registration events (#445), for the calendar admin's Entries list: an imported item flagged as a
 * possible match for a draft event (Link, Not the same, Add registration), an unmatched item (Add registration, Link to
 * existing event), and a linked item whose dates differ from its event's (Open event, Unlink event). Dates are relative
 * to today so the rows stay in the list's "upcoming" window. Idempotent.
 */
async function seedCalendarEventPairs(prisma: PrismaClient) {
  const { calendarDateIn, addDays } = await import("../modules/calendar/domain");
  const today = calendarDateIn(new Date());
  const actor = "usr_system_admin";
  const events = [
    { key: "match", name: "Mobilecheck Women's Retreat 2026 with a Long Registration Event Name", start: 20, end: 22 },
    { key: "linked", name: "Mobilecheck Spring Conference Registration", start: 40, end: 42 },
  ];
  for (const row of events) {
    const data = { name: row.name, slug: `${P}-calpair-${row.key}`, startsAt: new Date(`${addDays(today, row.start)}T12:00:00Z`), endsAt: new Date(`${addDays(today, row.end)}T12:00:00Z`), isPublished: row.key === "linked" };
    await prisma.event.upsert({ where: { id: `${P}_calpair_event_${row.key}` }, update: data, create: { id: `${P}_calpair_event_${row.key}`, ...data } });
  }
  const entries = [
    { key: "match", title: "Mobilecheck Womens Retreat", start: 20, end: 22, uid: "mobilecheck-uid-match", linked: null },
    { key: "open", title: "Mobilecheck Youth Rally with a Long Imported Title the Calendar Might Bring In", start: 25, end: 25, uid: "mobilecheck-uid-open", linked: null },
    { key: "linked", title: "Mobilecheck Spring Conference", start: 47, end: 49, uid: "mobilecheck-uid-linked", linked: `${P}_calpair_event_linked` },
    { key: "linked2", title: "Mobilecheck Spring Conference Second Site", start: 54, end: 56, uid: "mobilecheck-uid-linked2", linked: `${P}_calpair_event_linked` },
  ];
  for (const row of entries) {
    const data = {
      title: row.title, startsOn: addDays(today, row.start), endsOn: addDays(today, row.end), entryType: "STANDARD" as const, isPublished: true, isHiddenLocally: false,
      status: "SCHEDULED" as const, repeatRule: null, sourceUid: row.uid, sourceRecurrenceId: "", linkedEventId: row.linked, linkedAt: row.linked ? new Date() : null, linkedByUserId: row.linked ? actor : null,
    };
    await prisma.calendarEntry.upsert({ where: { id: `${P}_calpair_${row.key}` }, update: data, create: { id: `${P}_calpair_${row.key}`, ...data, createdByUserId: actor, updatedByUserId: actor } });
  }
}

/**
 * Two Deadlines (#910) so the club home's and the Area Coordinator overview's "Upcoming deadlines" list has
 * an upcoming row (with a link) and an overdue one, and one prepared reminder batch for the calendar admin's
 * "Deadline reminders" tab. Dates are relative to today, so the rows stay in the list's window.
 */
async function seedDeadlines(prisma: PrismaClient) {
  const { calendarDateIn, addDays } = await import("../modules/calendar/domain");
  const today = calendarDateIn(new Date());
  const rows = [
    { key: "soon", days: 9, title: "Mobilecheck Spring Camporee Registration Due and Every Other Long Title the Calendar Might Import", linkUrl: "https://calendar.mobilecheck.example.test/registration" },
    { key: "overdue", days: -2, title: "Mobilecheck Points and Investiture Reports are Due", linkUrl: null },
  ];
  for (const row of rows) {
    const date = addDays(today, row.days);
    const data = { title: row.title, startsOn: date, endsOn: date, entryType: "DEADLINE" as const, isPublished: true, isHiddenLocally: false, status: "SCHEDULED" as const, linkUrl: row.linkUrl, repeatRule: null };
    await prisma.calendarEntry.upsert({
      where: { id: `${P}_deadline_${row.key}` },
      update: data,
      create: { id: `${P}_deadline_${row.key}`, ...data, createdByUserId: "usr_system_admin", updatedByUserId: "usr_system_admin" },
    });
  }
  const soon = rows[0];
  const batchData = { title: soon.title, dueOn: addDays(today, soon.days), linkUrl: soon.linkUrl, status: "PENDING" as const, statusReason: null, decidedAt: null };
  const existing = await prisma.deadlineReminderBatch.findFirst({ where: { calendarEntryId: `${P}_deadline_soon`, daysBefore: 14 }, select: { id: true } });
  if (existing) await prisma.deadlineReminderBatch.update({ where: { id: existing.id }, data: batchData });
  else await prisma.deadlineReminderBatch.create({ data: { calendarEntryId: `${P}_deadline_soon`, daysBefore: 14, ...batchData } });
}

/**
 * Issued assets (#214): one person with two keys out under a held cash deposit, a lost key with a recorded charge and
 * a facility issue, so the check-out panel and the closeout have every kind of row to lay out. Inserted directly, the
 * way the services write them (an issuance always comes with its history row). Idempotent.
 */
/** Kitchen counts (#1029): two services with entries, one corrected, and a long note, so the entry cards and the table have content. */
async function seedKitchenCounts(prisma: PrismaClient) {
  const user = await prisma.user.findFirst({ where: { email: "admin@imsda-events.test" }, select: { id: true } });
  if (!user) return;
  // A Kitchen staff account on this event (#1029) for the audit page that opens the counts page as that role.
  const kitchen = await prisma.user.upsert({
    where: { email: `${P}.kitchen@example.test` }, update: {},
    create: { id: `${P}_user_kitchen`, email: `${P}.kitchen@example.test`, displayName: "Kim Mobilecheck-Kitchen" },
  });
  await prisma.eventMembership.upsert({
    where: { eventId_userId: { eventId, userId: kitchen.id } }, update: { role: "KITCHEN_STAFF", status: "ACTIVE" },
    create: { eventId, userId: kitchen.id, role: "KITCHEN_STAFF", status: "ACTIVE" },
  });
  // A session is only valid for an account with a credential row; this one can never sign in with a password.
  await prisma.authCredential.upsert({ where: { userId: kitchen.id }, update: {}, create: { userId: kitchen.id, passwordHash: "mobilecheck-never-a-real-hash" } });
  if (await prisma.eventMealKitchenCount.findUnique({ where: { id: `${P}_kc_1` }, select: { id: true } })) return;
  const base = { eventId, enteredByUserId: user.id };
  const longNote = "Second pan held back for the late serving line, then split between the vegetarian and the gluten-free lines";
  await prisma.eventMealKitchenCount.create({ data: { ...base, id: `${P}_kc_1`, serviceDate: "2026-10-15", mealType: "LUNCH", kind: "PREPARED", quantity: 120, note: "First count" } });
  await prisma.eventMealKitchenCount.create({ data: { ...base, id: `${P}_kc_2`, serviceDate: "2026-10-15", mealType: "LUNCH", kind: "PREPARED", quantity: 126, note: longNote, supersedesId: `${P}_kc_1` } });
  await prisma.eventMealKitchenCount.create({ data: { ...base, id: `${P}_kc_3`, serviceDate: "2026-10-15", mealType: "LUNCH", kind: "WASTED", quantity: 4 } });
  await prisma.eventMealKitchenCount.create({ data: { ...base, id: `${P}_kc_4`, serviceDate: "", mealType: "SUPPER", kind: "DONATED", quantity: 12, note: "Sent to the shelter" } });
}

async function seedIssuedAssets(prisma: PrismaClient) {
  const typeId = `${P}_asset_type`;
  if (await prisma.issuedAssetType.findUnique({ where: { id: typeId } })) return;
  const attendeeId = `${P}_reg_attendee_3_0`;
  const registrationId = `${P}_reg_3`;
  const actor = "usr_system_admin";
  const unit = await prisma.eventLodgingUnit.findFirst({ where: { eventId }, select: { id: true } });
  await prisma.issuedAssetType.create({
    data: {
      id: typeId, eventId, name: "Mobilecheck dorm room key with a long descriptive kind name", mode: "SERIALIZED", assigneeKinds: ["ATTENDEE", "REGISTRATION"],
      roomLinked: false, depositCents: 1000, depositShortfall: "KEEP_FEES", replacementFeeCents: 2500,
    },
  });
  const issuedAt = new Date("2026-09-24T15:00:00Z");
  const endedAt = new Date("2026-09-27T15:00:00Z");
  for (const [index, identifier] of ["MC-K-214", "MC-K-215", "MC-K-216"].entries()) {
    const assetId = `${P}_asset_${index}`;
    await prisma.issuedAsset.create({ data: { id: assetId, eventId, assetTypeId: typeId, identifier, scanCode: identifier, quantityTotal: 1 } });
    const issuanceId = `${P}_asset_issuance_${index}`;
    const lost = index === 2;
    await prisma.$transaction(async (tx) => {
      await tx.assetIssuance.create({
        data: { id: issuanceId, eventId, assetId, serialized: true, quantity: 1, assigneeKind: "ATTENDEE", attendeeId, purpose: "Issued at check-in", issuedAt, issuedByUserId: actor, entryMethod: "MANUAL", revision: 1 },
      });
      await tx.assetIssuanceHistory.create({
        data: { eventId, issuanceId, assetId, type: "ISSUED", at: issuedAt, actorUserId: actor, entryMethod: "MANUAL", quantity: 1, assigneeKind: "ATTENDEE", attendeeId, revision: 1 },
      });
      if (lost) {
        await tx.assetIssuance.update({ where: { id: issuanceId }, data: { endedAt, endReason: "LOST", endedByUserId: actor, endNote: "Not found in the room at check-out", endQuantity: 1, revision: 2 } });
        await tx.assetIssuanceHistory.create({
          data: { eventId, issuanceId, assetId, type: "LOST", at: endedAt, actorUserId: actor, reason: "Not found in the room at check-out", entryMethod: "MANUAL", quantity: 1, assigneeKind: "ATTENDEE", attendeeId, revision: 2 },
        });
      }
    });
    // A lost key is held out of stock (it could not be issued while unavailable, so it is marked after).
    if (lost) await prisma.issuedAsset.update({ where: { id: assetId }, data: { availability: "UNAVAILABLE" } });
  }
  await prisma.assetLedgerEntry.create({
    data: { id: `${P}_asset_deposit`, eventId, kind: "DEPOSIT_RECEIVED", amountCents: 800, assetTypeId: typeId, registrationId, settlement: "CASH_AT_DESK", depositShortfallSnapshot: "KEEP_FEES", replacementFeeSnapshotCents: 2500, reason: "Cash key deposit taken at check-in", actorUserId: actor, actorNameSnapshot: "System Administrator" },
  });
  for (const index of [0, 1, 2]) await prisma.assetDepositCover.create({ data: { eventId, issuanceId: `${P}_asset_issuance_${index}`, depositEntryId: `${P}_asset_deposit` } });
  await prisma.assetLedgerEntry.create({
    data: {
      id: `${P}_asset_charge`, eventId, kind: "CHARGE", amountCents: 2500, assetTypeId: typeId, issuanceId: `${P}_asset_issuance_2`, registrationId, chargeCategory: "REPLACEMENT",
      settlement: "RECORD_ONLY", reason: "Replacement fee for MC-K-216", actorUserId: actor, actorNameSnapshot: "System Administrator",
    },
  });
  await prisma.$transaction(async (tx) => {
    await tx.facilityIssue.create({
      data: {
        id: `${P}_asset_facility`, eventId, targetKind: unit ? "UNIT" : "OTHER", eventUnitId: unit?.id ?? null, targetLabel: unit ? null : "Mobilecheck dining hall",
        title: "Window will not close and the latch is bent beyond repair", description: "Found at check-out.", severity: "HIGH", source: "CHECKOUT_INSPECTION", reportedByUserId: actor, revision: 1,
      },
    });
    await tx.facilityIssueHistory.create({ data: { eventId, issueId: `${P}_asset_facility`, type: "REPORTED", actorUserId: actor, status: "OPEN", severity: "HIGH", revision: 1 } });
  });
}

/**
 * One class that teaches four honors with long names (#812), so the staff class
 * builder's chosen-honor chips and the honors column wrap. Inserted directly: the
 * database trigger writes the primary honor's row, the rest are added here.
 */
async function seedMultiHonorClass(prisma: PrismaClient) {
  const long = "Extraordinarily-Long-Synthetic-Honor-Name-For-Wrapping";
  for (const [index, id] of multiHonorIds.entries()) {
    await prisma.honor.upsert({
      where: { id },
      update: {},
      create: { id, code: `MOBILECHECK-${index + 1}`, name: `Mobilecheck ${long} ${index + 1}`, normalizedName: `mobilecheck honor ${index + 1}` },
    });
  }
  await prisma.honorSession.upsert({
    where: { id: multiHonorSessionId },
    update: {},
    create: { id: multiHonorSessionId, eventId, name: "Mobilecheck Sabbath afternoon", normalizedName: "mobilecheck sabbath afternoon", sortOrder: 90 },
  });
  if (!(await prisma.honorOffering.findUnique({ where: { id: multiHonorOfferingId } }))) {
    await prisma.honorOffering.create({
      data: { id: multiHonorOfferingId, eventId, honorId: multiHonorIds[0]!, sessionId: multiHonorSessionId, span: "SINGLE_SESSION", capacity: 12, teacherName: "Synthetic Teacher" },
    });
    await prisma.honorOfferingHonor.createMany({
      data: multiHonorIds.slice(1).map((honorId, index) => ({ offeringId: multiHonorOfferingId, honorId, eventId, position: index + 1 })),
    });
  }
}

/**
 * Table stress data (#811): members with many long honor names in mixed
 * statuses (one name is a single unbroken 90-character word), and one
 * registration in every status with long attendee names on the seeded
 * Women's Retreat event. All synthetic; ids start with "mobilecheck" so the
 * cleanup finds them.
 */
async function seedHonorsAndRegistrations(prisma: PrismaClient) {
  const unbroken = "Supercalifragilisticexpialidocious-Honor-With-An-Unbroken-Name-That-Never-Wraps-Ever-01";
  const honorNames = [
    "Advanced Wilderness Survival Skills and Emergency Preparedness for Large Groups",
    unbroken,
    "Knots", "Basketry", "Astronomy", "Cooking for a Crowd: Camp Kitchen Safety and Menus",
    "Stream and River Ecology of the Western Prairie Watershed Region",
    "First Aid - Standard", "Bird Study - Advanced", "Orienteering", "Cycling", "Swimming - Beginner",
    "Backpacking Across the Extremely Long-Named Mountain Range of Synthetic Testville",
    "Leatherwork", "Wildflowers", "Weather", "Camping Skills I", "Camping Skills II", "Camping Skills III", "Camping Skills IV",
  ];
  const honors: string[] = [];
  for (const [index, name] of honorNames.entries()) {
    const upserted = await prisma.honor.upsert({
      where: { code: `${P}-honor-${index + 1}` },
      update: {},
      create: { code: `${P}-honor-${index + 1}`, name: `Mobilecheck ${name}`, normalizedName: `mobilecheck ${name}`.toLowerCase() },
    });
    honors.push(upserted.id);
  }
  // Person 01 has 20 honors, 03 has 7 (more than the 6 shown collapsed), 02 has 3, 05 has one.
  const plan: Array<[string, number]> = [["a_01", 20], ["a_03", 7], ["a_02", 3], ["a_05", 1]];
  for (const [suffix, count] of plan) {
    const personId = `${P}_person_${suffix}`;
    for (let index = 0; index < count; index += 1) {
      const completed = index % 3 !== 1;
      await prisma.memberHonorEntry.upsert({
        where: { id: `${P}_honor_entry_${suffix}_${index}` },
        update: {},
        create: {
          id: `${P}_honor_entry_${suffix}_${index}`, personId, honorId: honors[index % honors.length], organizationId: clubA,
          status: completed ? "COMPLETED" : "IN_PROGRESS", completionDate: completed ? "2026-08-15" : "",
          recordedByUserId: "usr_system_admin",
        },
      });
    }
  }

  // One registration in every status on the Women's Retreat event, with long names.
  const statuses = ["DRAFT", "SUBMITTED", "CONFIRMED", "WAITLISTED", "CANCELLED"] as const;
  const firstNames = ["Bartholomew-Alexander", "Maria", "Lisa", "Wolfeschlegelsteinhausenbergerdorff", "Ng"];
  const lastNames = ["Quillfeather-Hargreaves-Montgomery", "de la Cruz-Montenegro", "Hickman", "Oyelaran-Whitcombe", "Smith"];
  for (const [index, status] of statuses.entries()) {
    const registrationId = `${P}_reg_${index + 1}`;
    const holderId = `${P}_reg_person_${index + 1}_0`;
    await prisma.person.upsert({
      where: { id: holderId }, update: {},
      create: { id: holderId, firstName: firstNames[index], lastName: lastNames[index], normalizedEmail: `${P}.reg${index + 1}.with-a-long-address-for-wrapping@example.test`, phone: "555-0100" },
    });
    await prisma.registration.upsert({
      where: { id: registrationId },
      update: {},
      create: {
        id: registrationId, eventId, accountHolderPersonId: holderId, confirmationCode: `MC-${index + 1}0${index}${index}`, status, totalAmount: 175 * (index + 1),
        submittedAt: status === "DRAFT" ? null : new Date("2026-09-20T15:00:00Z"), cancelledAt: status === "CANCELLED" ? new Date("2026-09-25T15:00:00Z") : null,
      },
    });
    if (status === "SUBMITTED" || status === "CANCELLED") {
      // A scholarship line that draws on the event's fund (#398), pledged on the submitted one.
      const fundId = `${P}_fund`;
      await prisma.scholarshipFund.upsert({ where: { id: fundId }, update: {}, create: { id: fundId, eventId } });
      const adjustmentId = `${P}_reg_adjustment_${index + 1}`;
      await prisma.registrationAdjustment.upsert({
        where: { id: adjustmentId }, update: {},
        create: { id: adjustmentId, eventId, registrationId, kind: "SCHOLARSHIP", amountCents: -2500, reason: "Mobile layout check scholarship", createdByNameSnapshot: "Layout Check" },
      });
      await prisma.scholarshipAward.upsert({
        where: { id: `${P}_reg_award_${index + 1}` }, update: {},
        create: {
          id: `${P}_reg_award_${index + 1}`, eventId, fundId, registrationId, adjustmentId, amountCents: 2500, pledged: status === "SUBMITTED",
          sponsorName: "Mobile Layout Check Sponsoring Church With A Very Long Name For Wrapping", sponsorKey: `name:${P}-long-sponsor`,
        },
      });
      await prisma.scholarshipContribution.upsert({
        where: { id: `${P}_contribution` }, update: {},
        create: {
          id: `${P}_contribution`, eventId, fundId, sponsorName: "Mobile Layout Check Sponsoring Church With A Very Long Name For Wrapping",
          sponsorKey: `name:${P}-long-sponsor`, amountCents: 10_000, receivedOn: new Date("2026-09-20T00:00:00Z"), method: "CHECK",
          note: "Check 1001 with a long note to check wrapping on a phone", createdByNameSnapshot: "Layout Check",
        },
      });
    }
    for (let slot = 0; slot < 3; slot += 1) {
      const personId = slot === 0 ? holderId : `${P}_reg_person_${index + 1}_${slot}`;
      if (slot > 0) {
        await prisma.person.upsert({
          where: { id: personId }, update: {},
          create: { id: personId, firstName: firstNames[(index + slot) % 5], lastName: lastNames[(index + slot * 2) % 5] },
        });
      }
      const person = await prisma.person.findUniqueOrThrow({ where: { id: personId } });
      await prisma.registrationAttendee.upsert({
        where: { registrationId_personId: { registrationId, personId } },
        update: {},
        create: {
          id: `${P}_reg_attendee_${index + 1}_${slot}`, eventId, registrationId, personId, position: slot,
          attendeeType: slot === 2 ? "WORKER" : "ATTENDEE",
          profileSnapshot: { firstName: person.firstName, lastName: person.lastName, email: person.normalizedEmail, phone: "555-0100" },
        },
      });
    }
  }
}

/** Sessions are minted directly (the second factor is skipped, as in verify-badge-print). */
async function mintSessions(prisma: PrismaClient, tokens: { staff: string[]; attendee: string[] }) {
  const staffSession = await import("../modules/access/session-store");
  const attendeeSession = await import("../modules/attendee-accounts/session-store");
  const cookie = async (role: SignedInRole) => {
    if (role === "director" || role === "area" || role === "attendee") {
      const accountId = role === "director" ? `${P}_account_director` : role === "area" ? `${P}_account_area` : `${P}_account_attendee`;
      const session = await attendeeSession.createAttendeeSession(accountId, null, { secondFactorVerifiedAt: new Date() });
      tokens.attendee.push(session.token);
      return { name: attendeeSession.ATTENDEE_SESSION_COOKIE_NAME, value: session.token, expires: Math.floor(session.expiresAt.getTime() / 1000) };
    }
    const email = role === "system-admin" ? "system@imsda-events.test" : role === "kitchen" ? `${P}.kitchen@example.test` : "admin@imsda-events.test";
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`The seeded account ${email} is missing. Run \`npm run db:seed\` first.`);
    const session = await staffSession.createDatabaseSession(user.id, null);
    tokens.staff.push(session.token);
    return { name: staffSession.SESSION_COOKIE_NAME, value: session.token, expires: Math.floor(session.expiresAt.getTime() / 1000) };
  };
  const cookies: Record<SignedInRole, { name: string; value: string; expires: number }> = {
    "event-admin": await cookie("event-admin"),
    "system-admin": await cookie("system-admin"),
    kitchen: await cookie("kitchen"),
    director: await cookie("director"),
    area: await cookie("area"),
    attendee: await cookie("attendee"),
  };
  return cookies;
}

/* ------------------------------------------------------- in-page audit */

/**
 * Runs in the page. Written as one self-contained function (no closures over
 * Node values) because Playwright serialises it. Returns plain data.
 */
function auditInPage(args: { touch: boolean; cards: boolean; minTarget: number; tolerance: number }) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const doc = document.documentElement;

  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : "";
    const classes = typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join("")
      : "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const label = el.getAttribute("aria-label");
    return `${el.tagName.toLowerCase()}${id}${classes}${label ? ` [${label.slice(0, 30)}]` : text ? ` "${text}"` : ""}`;
  };
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  /** True when an ancestor clips or scrolls the element sideways, so it cannot widen the page. */
  const inScroller = (el: Element) => {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (/(auto|scroll|hidden|clip)/.test(style.overflowX) && node.getBoundingClientRect().right <= w + 1) return true;
    }
    return false;
  };
  const inHiddenTree = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true" || (node as HTMLElement).hidden || node.hasAttribute("inert")) return true;
      if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open && node !== el && !(el.tagName === "SUMMARY" && el.parentElement === node)) return true;
    }
    return false;
  };

  // 1. Horizontal scroll, and who sticks out.
  const scrollWidth = doc.scrollWidth;
  const overflowers: string[] = [];
  if (scrollWidth > w) {
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (!visible(el) || inScroller(el)) continue;
      const style = getComputedStyle(el);
      if (style.position === "fixed") continue;
      const rect = el.getBoundingClientRect();
      if (rect.right > w + 1 || rect.left < -1) overflowers.push(`${describe(el)} (${Math.round(rect.left)}..${Math.round(rect.right)})`);
      if (overflowers.length >= 8) break;
    }
  }

  // 2. Tables that must be scrolled sideways on a phone.
  const scrollingTables: string[] = [];
  if (args.cards) {
    for (const table of Array.from(document.querySelectorAll("table"))) {
      if (!visible(table) || inHiddenTree(table)) continue;
      for (let node: HTMLElement | null = table.parentElement; node && node !== document.body; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) {
          scrollingTables.push(`${describe(table)} in ${describe(node)} (${node.scrollWidth}px in ${node.clientWidth}px)`);
          break;
        }
      }
    }
  }

  // 3. Tap targets.
  const smallTargets: string[] = [];
  if (args.touch) {
    const candidates = Array.from(document.querySelectorAll(
      "a[href], button, summary, select, textarea, input:not([type=hidden]), [role=button], [role=tab], [role=menuitem], [role=switch]",
    ));
    for (const el of candidates) {
      if (!visible(el) || inHiddenTree(el)) continue;
      const style = getComputedStyle(el);
      let target: Element = el;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        target = el.closest("label") ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null) ?? el;
      }
      if (el instanceof HTMLInputElement && el.type === "file") {
        target = el.closest("label") ?? el;
      }
      // A link in text being edited (the email editor's rich-text box) is text, not a control: tapping it places the caret.
      if (el.tagName === "A" && el.closest('[contenteditable="true"]')) continue;
      // A link inside a sentence is exempt (WCAG 2.5.8 inline exception).
      if (el.tagName === "A" && style.display === "inline") {
        const parent = el.parentElement;
        const ownText = parent ? Array.from(parent.childNodes).some((node) => node.nodeType === 3 && (node.textContent ?? "").trim().length > 2) : false;
        if (ownText) continue;
      }
      // A control that is clipped away or sits off screen (skip links) cannot be tapped.
      const rect = target.getBoundingClientRect();
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= w + 1000) continue;
      if (el.closest(".sr-only, .visually-hidden")) continue;
      // A visually hidden control (clipped to a pixel) cannot be tapped.
      if (rect.width <= 2 && rect.height <= 2) continue;
      if (rect.width + args.tolerance < args.minTarget || rect.height + args.tolerance < args.minTarget) {
        const parent = target.parentElement;
        const parentClass = parent && typeof parent.className === "string" ? parent.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
        smallTargets.push(`${describe(target)} ${Math.round(rect.width)}x${Math.round(rect.height)} in ${parent ? parent.tagName.toLowerCase() : "?"}${parentClass ? `.${parentClass}` : ""}`);
      }
    }
  }

  // 5. Table cells (#811): nothing overlaps its neighbour, nothing spills out of its cell,
  //    each card label matches its column header, and a header lines up over its column.
  const cellProblems: string[] = [];
  const contentRect = (cell: Element) => {
    // What a person sees in the cell: its text and its controls and images, not hidden or clipped text.
    const rects: DOMRect[] = [];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? "").trim()) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(".sr-only, .visually-hidden, [hidden]") || !visible(parent)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      // Text cut by an ancestor's overflow (an ellipsis) only shows inside that ancestor.
      let clipLeft = -Infinity;
      let clipRight = Infinity;
      for (let up: Element | null = parent; up && up !== cell.parentElement; up = up.parentElement) {
        if (up === cell) break;
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(up).overflowX)) {
          const box = up.getBoundingClientRect();
          clipLeft = Math.max(clipLeft, box.left);
          clipRight = Math.min(clipRight, box.right);
        }
      }
      for (const rect of Array.from(range.getClientRects())) {
        const left = Math.max(rect.left, clipLeft);
        const right = Math.min(rect.right, clipRight);
        if (right - left > 0 && rect.height > 0) rects.push(new DOMRect(left, rect.top, right - left, rect.height));
      }
      range.detach();
    }
    for (const el of Array.from(cell.querySelectorAll("button, input:not([type=hidden]), select, textarea, img, svg"))) {
      if (el.closest(".sr-only, .visually-hidden, [hidden]") || !visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width > 2 && rect.height > 2) rects.push(rect);
    }
    if (rects.length === 0) return null;
    return {
      left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)),
      top: Math.min(...rects.map((rect) => rect.top)), bottom: Math.max(...rects.map((rect) => rect.bottom)),
    };
  };
  const clean = (text: string | null) => (text ?? "").replace(/[▲▼↑↓]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const cellLabel = (table: HTMLTableElement, name: string) => `${describe(table)} ${name}`;
  for (const table of Array.from(document.querySelectorAll("table"))) {
    if (!visible(table) || inHiddenTree(table)) continue;
    const headerRow = table.tHead?.rows[0];
    const headers: Element[] = [];
    if (headerRow) for (const cell of Array.from(headerRow.cells)) for (let n = 0; n < cell.colSpan; n += 1) headers.push(cell);
    const rows = Array.from(table.rows).filter((row) => row.parentElement?.tagName === "TBODY");
    let reported = 0;
    const spanOf = (row: HTMLTableRowElement) => Array.from(row.cells).reduce((sum, cell) => sum + cell.colSpan, 0);
    // The first body row with one cell per header (a group heading row or an empty-state row spans the table).
    const firstFull = rows.find((row) => spanOf(row) === headers.length && row.cells.length > 1);
    if (headers.length > 1 && !firstFull && rows.some((row) => row.cells.length > 1)) {
      cellProblems.push(`${describe(table)}: no row has ${headers.length} cells to match the ${headers.length} headers`);
    }
    for (const row of rows.slice(0, 60)) {
      if (!visible(row) || reported >= 4) continue;
      const cells = Array.from(row.cells).filter((cell) => visible(cell));
      const boxes = cells.map((cell) => ({ cell, rect: cell.getBoundingClientRect(), text: contentRect(cell) }));
      for (const [index, box] of boxes.entries()) {
        const style = getComputedStyle(box.cell);
        const clipsX = /(auto|scroll|hidden|clip)/.test(style.overflowX);
        const name = clean(box.cell.getAttribute("data-label") ?? box.cell.textContent).slice(0, 24) || `cell ${index + 1}`;
        // Text that runs out of its own cell (it would draw over the next cell).
        if (box.text && !clipsX && (box.text.right > box.rect.right + 1 || box.text.left < box.rect.left - 1)) {
          const nested = Array.from(box.cell.querySelectorAll("*")).some((el) => /(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowX) && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().right <= box.rect.right + 1);
          if (!nested) { cellProblems.push(`${cellLabel(table, name)}: text runs ${Math.round(Math.max(box.text.right - box.rect.right, box.rect.left - box.text.left))}px outside its cell`); reported += 1; }
        }
        for (const other of boxes.slice(index + 1)) {
          if (!box.text || !other.text) continue;
          const across = Math.min(box.text.right, other.text.right) - Math.max(box.text.left, other.text.left);
          const down = Math.min(box.text.bottom, other.text.bottom) - Math.max(box.text.top, other.text.top);
          // Side by side with no gap at all ("CONFIRMEDLisa Hickman"): the text of one column touches the next.
          const touching = down > 1 && across <= 0 && across > -4 && getComputedStyle(box.cell).display.startsWith("table") && getComputedStyle(other.cell).display.startsWith("table") && other.cell === boxes[index + 1]?.cell;
          if (touching) {
            cellProblems.push(`${cellLabel(table, name)}: text touches "${clean(other.cell.getAttribute("data-label") ?? other.cell.textContent).slice(0, 24)}" with ${Math.round(-across)}px between them`);
            reported += 1;
          }
          if (across > 1 && down > 1) {
            cellProblems.push(`${cellLabel(table, name)}: overlaps "${clean(other.cell.getAttribute("data-label") ?? other.cell.textContent).slice(0, 24)}" by ${Math.round(across)}x${Math.round(down)}px (text at ${Math.round(box.text.left)}..${Math.round(box.text.right)} and ${Math.round(other.text.left)}..${Math.round(other.text.right)}; cells ${Math.round(box.rect.left)}..${Math.round(box.rect.right)} and ${Math.round(other.rect.left)}..${Math.round(other.rect.right)})`);
            reported += 1;
          }
        }
        // The card label is the column header (checked once per column: the first row).
        const label = box.cell.getAttribute("data-label");
        if (label !== null && row === firstFull && headers.length > 0) {
          let column = 0;
          for (const earlier of Array.from(row.cells)) { if (earlier === box.cell) break; column += earlier.colSpan; }
          const header = headers[column];
          const headerText = header ? clean(header.textContent) : "";
          if (header && clean(label) !== headerText && !headerText.startsWith(clean(label))) cellProblems.push(`${cellLabel(table, name)}: data-label "${label}" but the column header is "${header.textContent?.replace(/\s+/g, " ").trim()}"`);
        }
        // Headers sit over their column: in a real table layout the header's left edge is within the cell's.
        if (row === firstFull && style.display.startsWith("table") && headers.length > 0) {
          let column = 0;
          for (const earlier of Array.from(row.cells)) { if (earlier === box.cell) break; column += earlier.colSpan; }
          const header = headers[column];
          if (header && (header as HTMLTableCellElement).colSpan <= 1 && getComputedStyle(header).display.startsWith("table")) {
            const headRect = header.getBoundingClientRect();
            if (Math.abs(headRect.left - box.rect.left) > 2 || Math.abs(headRect.right - box.rect.right) > 2) cellProblems.push(`${cellLabel(table, name)}: header "${clean(header.textContent).slice(0, 20)}" is ${Math.round(headRect.left)}..${Math.round(headRect.right)}px over a column at ${Math.round(box.rect.left)}..${Math.round(box.rect.right)}px`);
          }
        }
      }
    }
  }
  // Honor pills: the status ("In progress" / "Completed") is never cut off, and a pill stays inside its cell.
  const pillProblems: string[] = [];
  for (const pill of Array.from(document.querySelectorAll(".honor-pill"))) {
    if (!visible(pill) || inHiddenTree(pill)) continue;
    const status = pill.querySelector(".honor-pill-status");
    const pillRect = pill.getBoundingClientRect();
    if (status) {
      const statusRect = status.getBoundingClientRect();
      if (statusRect.width <= 0 || statusRect.right > pillRect.right + 1 || (status as HTMLElement).scrollWidth > (status as HTMLElement).clientWidth + 1) {
        pillProblems.push(`${describe(pill)}: the status is cut off (${Math.round(statusRect.right)}px past a pill ending at ${Math.round(pillRect.right)}px)`);
      }
    }
    const cell = pill.closest("td, th");
    if (cell) {
      const cellRect = cell.getBoundingClientRect();
      if (pillRect.right > cellRect.right + 1) pillProblems.push(`${describe(pill)}: sticks out of its cell by ${Math.round(pillRect.right - cellRect.right)}px`);
    }
  }
  // A table marked data-fit-width fits its box without a sideways scroll (the honors table at 768-1024px).
  const fitProblems: string[] = [];
  for (const table of Array.from(document.querySelectorAll("table[data-fit-width]"))) {
    if (!visible(table) || inHiddenTree(table)) continue;
    const box = table.parentElement;
    if (box && box.scrollWidth > box.clientWidth + 1) fitProblems.push(`${describe(table)} is ${box.scrollWidth}px wide in a ${box.clientWidth}px box`);
  }

  // A data table is never wider than its box (#997). Where tables stay tables (tablet and desktop), a table that is wider than the
  // box around it is a finding: it is clipped, or the person scrolls sideways without knowing. A table may scroll sideways only
  // when its box opts in with `data-scroll-cue` AND really draws an edge fade or shadow (a gradient background, drawn by the
  // `.scroll-cue` class). A box that clips (overflow hidden) can never opt in: the cut-off columns cannot be reached.
  const wideTables: string[] = [];
  if (!args.cards) {
    for (const table of Array.from(document.querySelectorAll("table"))) {
      if (!visible(table) || inHiddenTree(table)) continue;
      let box: HTMLElement | null = null;
      for (let node: HTMLElement | null = table.parentElement; node && node !== document.body; node = node.parentElement) {
        if (getComputedStyle(node).overflowX !== "visible") { box = node; break; }
      }
      const tableRect = table.getBoundingClientRect();
      if (!box) {
        const parent = table.parentElement;
        if (parent && tableRect.right > parent.getBoundingClientRect().right + 1) {
          wideTables.push(`${describe(table)} is ${Math.round(tableRect.width)}px wide and sticks out of ${describe(parent)}`);
        }
        continue;
      }
      if (box.scrollWidth <= box.clientWidth + 1) continue;
      const style = getComputedStyle(box);
      const scrolls = /(auto|scroll)/.test(style.overflowX);
      const optedIn = box.hasAttribute("data-scroll-cue");
      // The shadow is the scroll-cue class's gradients, or a box that draws its own with both a scrolling and a local attachment.
      const attachment = style.backgroundAttachment;
      const drawn = style.backgroundImage.includes("gradient")
        && (box.classList.contains("scroll-cue") || (attachment.includes("scroll") && attachment.includes("local")));
      const alphaOf = (color: string) => {
        const match = /rgba?\(([^)]+)\)/.exec(color);
        if (!match) return 1;
        const parts = match[1]!.split(/[ ,/]+/).filter(Boolean);
        return parts.length >= 4 ? Number(parts[3]) : 1;
      };
      const detail = `${describe(table)} is ${box.scrollWidth}px wide in a ${box.clientWidth}px box (${describe(box)})`;
      if (!scrolls) wideTables.push(`${detail}: the box clips it, so the columns past the edge cannot be reached`);
      else if (!optedIn) wideTables.push(`${detail}: it scrolls sideways with no scroll cue (add data-scroll-cue and the scroll-cue class) or it should fit`);
      else if (!drawn) wideTables.push(`${detail}: data-scroll-cue is set but no edge fade or shadow is drawn (the box needs the scroll-cue class)`);
      else {
        // The shadow sits behind the table: a cell that paints a solid background over it hides it.
        // Cells, rows and row groups all count (an opaque row or footer would hide the cue just as a cell does).
        const covering = [table, ...Array.from(table.querySelectorAll("thead, thead tr, thead th, tbody, tbody tr:nth-child(-n+5), tbody tr:nth-child(-n+5) > *, tfoot, tfoot tr, tfoot > tr > *"))]
          .filter((cell) => alphaOf(getComputedStyle(cell).backgroundColor) > 0.5);
        if (covering.length > 0) wideTables.push(`${detail}: ${covering.length} element(s) (cells, rows or the table) such as ${describe(covering[0]!)} paint a solid background over the scroll cue, so the shadow cannot show`);
      }
    }
  }

  // 4. Fixed and sticky bars.
  const bars: Array<{ el: Element; top: number; bottom: number; kind: string }> = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < w * 0.6) continue; // a side column or a floating chip, not a horizontal bar
    if (rect.height >= h * 0.9 && rect.width >= w * 0.9) continue; // a backdrop or full-screen sheet
    bars.push({ el, top: rect.top, bottom: rect.bottom, kind: style.position });
  }
  const barNotes: string[] = [];
  let fixedTotal = 0;
  for (const bar of bars) {
    const rect = bar.el.getBoundingClientRect();
    if (bar.kind === "fixed" || (bar.kind === "sticky" && (rect.top <= 1 || rect.bottom >= h - 1))) fixedTotal += rect.height;
    if (rect.height > h / 3) barNotes.push(`${describe(bar.el)} is ${Math.round(rect.height)}px tall (viewport ${h}px)`);
  }
  if (fixedTotal > h / 3) barNotes.push(`fixed and sticky bars take ${Math.round(fixedTotal)}px of the ${h}px screen`);

  return {
    innerWidth: w,
    innerHeight: h,
    scrollWidth,
    overflowers,
    scrollingTables,
    smallTargets,
    barNotes,
    cellProblems,
    pillProblems,
    fitProblems,
    wideTables,
    barCount: bars.length,
  };
}

/**
 * Text and form layout (the PBE phone audit): problems a person sees that the other checks do not name. Runs in the page, one
 * self-contained function. Returns plain data.
 *
 *  - headings: an h1 or h2 drawn at body size or with a body weight is unstyled, and an icon in a heading sits on the
 *    heading's own line, not above it;
 *  - label-input: a label's text never runs into or touches the control it names (side by side with under 6px between, or
 *    stacked with under 2px between);
 *  - focus-ring: the focus outline of a text field never lands on the text of another element (the help text under it);
 *  - text-overlap: the text of two different elements never overlaps, and text that an `overflow: hidden` box cuts off sideways
 *    (with no ellipsis or line clamp) is reported;
 *  - disabled: a disabled button's label keeps at least 3:1 against its own fill, opacity included.
 * Text in fixed, sticky or absolutely placed boxes is left to the bar and dialog checks.
 */
function textLayoutInPage() {
  type Rgba = { r: number; g: number; b: number; a: number };
  const parse = (value: string): Rgba | null => {
    const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(value);
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
  };
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top.a + under.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a,
      g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a,
      b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a,
      a,
    };
  };
  const luminance = ({ r, g, b }: Rgba) => {
    const [lr, lg, lb] = [r, g, b].map((channel) => {
      const v = channel / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  };
  const ratio = (a: Rgba, b: Rgba) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : "";
    const classes = typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 2).map((name) => `.${name}`).join("")
      : "";
    const field = el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA"
      ? `[${(el as HTMLInputElement).type ?? ""}|${el.getAttribute("name") ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? ""}]`
      : "";
    return `${el.tagName.toLowerCase()}${id}${classes}${field} "${(el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 36)}"`;
  };
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const hiddenTree = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true" || (node as HTMLElement).hidden || node.hasAttribute("inert")) return true;
      if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open && !(node.firstElementChild?.tagName === "SUMMARY" && node.firstElementChild.contains(el))) return true;
      if (node.matches(".sr-only, .visually-hidden")) return true;
    }
    return false;
  };
  /** Fixed, sticky or absolutely placed boxes are checked by the bar and dialog rules, and overlap on purpose. */
  const placed = (el: Element) => {
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky" || position === "absolute") return true;
    }
    return false;
  };
  /** What a person sees of `rect`: cut by every box around `el` that clips (an ellipsis, a line clamp, a scroller). Null when none of it shows. */
  const shown = (el: Element, rect: DOMRect) => {
    let left = rect.left;
    let right = rect.right;
    let top = rect.top;
    let bottom = rect.bottom;
    for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const box = node.getBoundingClientRect();
      if (style.overflowX !== "visible") { left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (style.overflowY !== "visible") { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    return right - left > 0 && bottom - top > 0 ? new DOMRect(left, top, right - left, bottom - top) : null;
  };
  /** The rectangles of the text directly inside `el` (its own text nodes) that are shown. */
  const ownTextRects = (el: Element) => {
    const rects: DOMRect[] = [];
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType !== 3 || !(node.textContent ?? "").trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        const visibleRect = rect.width > 0 && rect.height > 0 ? shown(el, rect) : null;
        if (visibleRect) rects.push(visibleRect);
      }
      range.detach();
    }
    return rects;
  };
  const w = window.innerWidth;
  const problems = { headings: [] as string[], labelInput: [] as string[], focusRing: [] as string[], textOverlap: [] as string[], disabled: [] as string[] };

  // Headings.
  const bodySize = Number.parseFloat(getComputedStyle(document.body).fontSize) || 16;
  for (const heading of Array.from(document.querySelectorAll("h1, h2"))) {
    if (!visible(heading) || hiddenTree(heading)) continue;
    const style = getComputedStyle(heading);
    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10) || 400;
    if (size < bodySize * 1.1 && weight < 600) {
      problems.headings.push(`${describe(heading)} is drawn at ${Math.round(size)}px weight ${weight} against ${Math.round(bodySize)}px body text: unstyled`);
    }
  }
  for (const heading of Array.from(document.querySelectorAll("h1, h2, h3"))) {
    if (!visible(heading) || hiddenTree(heading)) continue;
    const icon = heading.querySelector(":scope > svg");
    if (!icon || !visible(icon)) continue;
    const text = ownTextRects(heading).concat(Array.from(heading.querySelectorAll(":scope > span, :scope > small")).flatMap((child) => ownTextRects(child)));
    if (text.length === 0) continue;
    const iconRect = icon.getBoundingClientRect();
    const top = Math.min(...text.map((rect) => rect.top));
    const bottom = Math.max(...text.map((rect) => rect.bottom));
    if (iconRect.bottom <= top + 1 || iconRect.top >= bottom - 1) {
      problems.headings.push(`${describe(heading)}: the icon sits on its own line (${Math.round(iconRect.top)}..${Math.round(iconRect.bottom)}px, text ${Math.round(top)}..${Math.round(bottom)}px)`);
    }
  }

  // Labels against their controls.
  const controls = Array.from(document.querySelectorAll("input, select, textarea")).filter((el) => {
    const type = (el as HTMLInputElement).type;
    return !["checkbox", "radio", "hidden", "range", "file", "button", "submit", "reset", "image", "color"].includes(type) && visible(el) && !hiddenTree(el);
  });
  for (const control of controls) {
    const labels = Array.from((control as HTMLInputElement).labels ?? []);
    const controlRect = control.getBoundingClientRect();
    for (const label of labels) {
      // The label's own words: text outside the control and outside other fields.
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      const rects: DOMRect[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!(node.textContent ?? "").trim() || !parent || control.contains(parent) || parent.closest("select, textarea, option, .sr-only")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of Array.from(range.getClientRects())) if (rect.width > 0 && rect.height > 0) rects.push(rect);
        range.detach();
      }
      for (const rect of rects) {
        const vertical = Math.min(rect.bottom, controlRect.bottom) - Math.max(rect.top, controlRect.top);
        const horizontal = Math.min(rect.right, controlRect.right) - Math.max(rect.left, controlRect.left);
        if (vertical > 1 && horizontal > 1) {
          problems.labelInput.push(`${describe(label)}: the label text overlaps its field by ${Math.round(horizontal)}x${Math.round(vertical)}px`);
          break;
        }
        if (vertical > 1 && horizontal <= 1 && -horizontal < 6) {
          problems.labelInput.push(`${describe(label)}: the label text runs into its field (${Math.round(-horizontal)}px between them on one line)`);
          break;
        }
        if (vertical <= 1 && horizontal > 1 && controlRect.top - rect.bottom < 2 && controlRect.top >= rect.top) {
          problems.labelInput.push(`${describe(label)}: the label text touches its field (${Math.round(controlRect.top - rect.bottom)}px between them)`);
          break;
        }
      }
    }
  }

  // Focus ring against other text.
  const textBoxes: Array<{ el: Element; rect: DOMRect }> = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (el.closest("select, textarea, option, script, style, noscript")) continue;
    if (!visible(el) || hiddenTree(el) || placed(el)) continue;
    for (const rect of ownTextRects(el)) textBoxes.push({ el, rect });
  }
  // Focusing a field can scroll the page (a page's own script, a sticky bar): compare in the snapshot's own coordinates.
  const scrollAtSnapshot = { x: window.scrollX, y: window.scrollY };
  for (const control of controls.slice(0, 12)) {
    (control as HTMLElement).focus({ preventScroll: true });
    const style = getComputedStyle(control);
    const width = style.outlineStyle === "none" ? 0 : Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    if (width > 0) {
      const box = control.getBoundingClientRect();
      const shiftX = window.scrollX - scrollAtSnapshot.x;
      const shiftY = window.scrollY - scrollAtSnapshot.y;
      const ring = { left: box.left + shiftX - width, right: box.right + shiftX + width, top: box.top + shiftY - width, bottom: box.bottom + shiftY + width };
      for (const text of textBoxes) {
        if (control.contains(text.el) || text.el.contains(control)) continue;
        const across = Math.min(ring.right, text.rect.right) - Math.max(ring.left, text.rect.left);
        const down = Math.min(ring.bottom, text.rect.bottom) - Math.max(ring.top, text.rect.top);
        if (across > 1 && down > 1) {
          problems.focusRing.push(`${describe(control)}: its focus outline (${width}px out, ${Math.round(ring.left)}..${Math.round(ring.right)} x ${Math.round(ring.top)}..${Math.round(ring.bottom)}) lands on ${describe(text.el)} (${Math.round(text.rect.left)}..${Math.round(text.rect.right)} x ${Math.round(text.rect.top)}..${Math.round(text.rect.bottom)}) by ${Math.round(down)}px`);
          break;
        }
      }
    }
    (control as HTMLElement).blur();
  }
  window.scrollTo(scrollAtSnapshot.x, scrollAtSnapshot.y);

  // Text over text, and text cut off sideways.
  const sorted = textBoxes.slice().sort((a, b) => a.rect.top - b.rect.top);
  let reported = 0;
  for (let i = 0; i < sorted.length && reported < 6; i += 1) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j]!;
      if (b.rect.top >= a.rect.bottom - 1) break;
      if (a.el === b.el || a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const across = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const down = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      // Lines that overlap by a few pixels at their edges are tight leading; text drawn over text is more than that.
      if (across > 2 && down > Math.min(a.rect.height, b.rect.height) * 0.35 && down > 3) {
        problems.textOverlap.push(`${describe(a.el)} overlaps ${describe(b.el)} by ${Math.round(across)}x${Math.round(down)}px`);
        reported += 1;
        break;
      }
    }
  }
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (reported >= 8) break;
    if (!visible(el) || hiddenTree(el)) continue;
    const style = getComputedStyle(el);
    const clamp = style.getPropertyValue("-webkit-line-clamp");
    if (!/(hidden|clip)/.test(style.overflowX) || style.textOverflow === "ellipsis" || (clamp !== "" && clamp !== "none")) continue;
    if (el.matches("body, html, table, [role=dialog]") || el.clientWidth === 0 || placed(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.right > w + 1) continue;
    // Text that would be drawn past this box, in a descendant that is not itself an ellipsis or scroll box.
    const cut = textBoxes.find((entry) => {
      if (!el.contains(entry.el)) return false;
      const start = entry.el.getBoundingClientRect();
      if (start.right <= box.right + 1 && start.left >= box.left - 1) return false;
      for (let node: Element | null = entry.el; node && node !== el; node = node.parentElement) {
        const inner = getComputedStyle(node);
        if (inner.textOverflow === "ellipsis" || inner.overflowX !== "visible") return false;
      }
      return true;
    });
    if (cut) {
      problems.textOverlap.push(`${describe(el)}: ${describe(cut.el)} is cut off sideways by the box (${Math.round(cut.el.getBoundingClientRect().right)}px in a box ending at ${Math.round(box.right)}px)`);
      reported += 1;
    }
  }

  // Disabled buttons keep a readable label.
  for (const button of Array.from(document.querySelectorAll("button:disabled, a[aria-disabled=true]"))) {
    if (!visible(button) || hiddenTree(button)) continue;
    let opacity = 1;
    let fill: Rgba | null = null;
    for (let node: Element | null = button; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      opacity *= Number(style.opacity);
      const colour = parse(style.backgroundColor);
      if (!fill && colour && colour.a > 0) fill = colour;
    }
    const style = getComputedStyle(button);
    const text = parse(style.color);
    if (!text) continue;
    // Opacity fades the finished button, so fill and label are each faded against the page behind it.
    const shownFill = over({ ...(fill ?? white), a: (fill?.a ?? 1) * opacity }, white);
    const shownText = over({ ...text, a: text.a * opacity }, white);
    const contrast = ratio(shownText, shownFill);
    if (contrast < 3) problems.disabled.push(`${describe(button)}: the disabled label has ${contrast.toFixed(2)}:1 against its fill (needs 3:1)`);
  }
  return problems;
}

/**
 * Text rules for staff pages (#981), run in the page:
 *  - text-too-small: every visible text node renders at the staff floor or larger (exceptions are listed above);
 *  - header-too-narrow: no table column header is narrower than its longest word (a header that breaks
 *    inside a word, "TYP E", is the symptom). A hyphenated word may wrap at its hyphen, so it counts as two.
 */
function textAuditInPage(args: { floor: number; upperFloor: number; exceptions: string[] }) {
  const describe = (el: Element) => {
    const classes = typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 2).map((name) => `.${name}`).join("")
      : "";
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
    return `${el.tagName.toLowerCase()}${classes} "${text}"`;
  };
  const visible = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      if (node.getAttribute("aria-hidden") === "true" || (node as HTMLElement).hidden) return false;
      if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open && node !== el) {
        // Only the summary of a closed details is shown.
        let child: Element | null = el;
        while (child && child.parentElement !== node) child = child.parentElement;
        if (child && child.tagName !== "SUMMARY") return false;
      }
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const exception = (el: Element) => args.exceptions.some((selector) => el.closest(selector));
  const small = new Map<string, { count: number; sample: string }>();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? "").trim();
    const parent = node.parentElement;
    if (!text || !parent || ["SCRIPT", "STYLE", "NOSCRIPT", "OPTION", "TEXTAREA"].includes(parent.tagName)) continue;
    if (parent.closest("svg") || !visible(parent)) continue;
    const style = getComputedStyle(parent);
    const size = parseFloat(style.fontSize);
    if (args.floor > 0 && !exception(parent)) {
      const upper = style.textTransform === "uppercase";
      const floor = upper ? args.upperFloor : args.floor;
      if (size + 0.01 < floor) {
        const firstClass = typeof parent.className === "string" ? parent.className.split(/\s+/).filter(Boolean)[0] : "";
        const key = `${parent.tagName.toLowerCase()}${firstClass ? `.${firstClass}` : ""} ${size.toFixed(1)}px${upper ? " (uppercase)" : ""}`;
        const entry = small.get(key) ?? { count: 0, sample: text.slice(0, 30) };
        entry.count += 1;
        small.set(key, entry);
      }
    }
  }

  // Table headers: each is at least as wide as its longest word.
  const narrowHeaders: string[] = [];
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0";
  document.body.appendChild(probe);
  // Column headers only (a row header holds data, such as an unbroken synthetic name, and is not a label).
  for (const th of Array.from(document.querySelectorAll("thead th"))) {
    if (narrowHeaders.length >= 6 || !visible(th) || !getComputedStyle(th).display.startsWith("table")) continue;
    const style = getComputedStyle(th);
    // A header the card layout hides collapses to its padding: it is not shown.
    if (th.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) <= 1) continue;
    probe.style.font = style.font;
    probe.style.letterSpacing = style.letterSpacing;
    probe.style.textTransform = style.textTransform;
    const room = th.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    let widest = 0; let word = "";
    // Only the words a person sees: visually hidden text (a "Select" or "Actions" label) is not laid out in the column.
    const shown = th.cloneNode(true) as Element;
    for (const hidden of Array.from(shown.querySelectorAll(".sr-only, .visually-hidden, [hidden], [aria-hidden='true']"))) hidden.remove();
    for (const candidate of (shown.textContent ?? "").replace(/[▲▼↑↓]/g, "").split(/[\s-]+/).filter(Boolean)) {
      probe.textContent = candidate;
      const width = probe.getBoundingClientRect().width;
      if (width > widest) { widest = width; word = candidate; }
    }
    if (widest > room + 1) narrowHeaders.push(`${describe(th)}: "${word}" is ${Math.round(widest)}px wide in ${Math.round(room)}px`);
  }
  probe.remove();

  return {
    small: Array.from(small, ([key, value]) => `${key} x${value.count}, for example "${value.sample}"`),
    narrowHeaders,
  };
}

/**
 * Squeezed text (#996), measured in the page. For every visible element that holds its own text:
 *  - "narrow": its container's content box is narrower than about four characters (2.2em) while the text is
 *    longer than four characters;
 *  - "one-per-line": the text wraps to about one character per line;
 *  - "split-word": an ordinary word of 6 to 15 letters is broken across lines. Emails, codes and anything with
 *    digits, punctuation or more than 15 letters are exempt: those may break anywhere.
 * Rotated text (the vertical ID-sleeve badges) and hidden or collapsed boxes are skipped.
 */
function squeezedTextInPage() {
  const problems: string[] = [];
  const seen = new Set<Element>();
  const describe = (el: Element) => {
    const cls = String((el as HTMLElement).className || "").split(/\s+/).filter(Boolean)[0];
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  };
  const skippedTags = /^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEXTAREA|INPUT|SELECT|SVG|PATH|CODE|PRE|TITLE|HEAD)$/i;
  const rotatedOrHidden = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.hasAttribute("hidden") || node.hasAttribute("inert") || node.getAttribute("aria-hidden") === "true") return true;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return true;
      if (style.writingMode !== "horizontal-tb") return true;
      if (style.transform !== "none") {
        const m = /matrix\(([^)]+)\)/.exec(style.transform);
        if (m) {
          const [a, b] = m[1]!.split(",").map(Number);
          if (Math.abs(b ?? 0) > 0.01 || Math.abs(a ?? 1) < 0.99) return true;
        } else return true;
      }
      if (/(^|\s)(sr-only|visually-hidden)(\s|$)/.test(String((node as HTMLElement).className || ""))) return true;
    }
    return false;
  };
  const box = (el: Element): HTMLElement => {
    let node: HTMLElement | null = el as HTMLElement;
    while (node && getComputedStyle(node).display === "inline") node = node.parentElement;
    return node ?? (el as HTMLElement);
  };
  const lineCount = (range: Range) => {
    const tops = new Set<number>();
    for (const rect of Array.from(range.getClientRects())) if (rect.width > 0) tops.add(Math.round(rect.top / 3));
    return tops.size;
  };
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (problems.length >= 8) break;
    if (skippedTags.test(el.tagName) || seen.has(el)) continue;
    const textNodes = Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0);
    if (textNodes.length === 0 || el.getClientRects().length === 0) continue;
    if (rotatedOrHidden(el)) continue;
    const style = getComputedStyle(el);
    // Text a style rule hides on purpose: font-size 0 (an icon-only badge) or the 1px visually-hidden box.
    if (Number.parseFloat(style.fontSize) < 1) continue;
    const own = el.getBoundingClientRect();
    if (own.width <= 2 && own.height <= 2) continue;
    const container = box(el);
    const containerStyle = getComputedStyle(container);
    const width = container.clientWidth - Number.parseFloat(containerStyle.paddingLeft) - Number.parseFloat(containerStyle.paddingRight);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const text = textNodes.map((node) => node.textContent ?? "").join(" ").replace(/\s+/g, " ").trim();
    const compact = text.replace(/\s/g, "");
    const label = `${describe(el)} "${text.slice(0, 40)}"`;
    // A box narrower than about four characters (2.2em) that holds longer text which then wraps or is cut off. A short label
    // that still fits on one line in a snug box ("City:") is not squeezed.
    if (compact.length > 4 && width < fontSize * 2.2) {
      const wraps = textNodes.some((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return lineCount(range) > 1;
      });
      if (wraps || container.scrollWidth > container.clientWidth + 1 || el.scrollWidth > el.clientWidth + 1 || width < fontSize) {
        seen.add(el);
        problems.push(`${label} sits in a box ${Math.round(width)}px wide, narrower than four characters (${compact.length} characters of text)`);
        continue;
      }
    }
    for (const node of textNodes) {
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines = lineCount(range);
      if (lines < 2) continue;
      const chars = (node.textContent ?? "").replace(/\s/g, "").length;
      if (chars >= 6 && lines >= chars * 0.75) {
        seen.add(el);
        problems.push(`${label} wraps one character per line (${lines} lines for ${chars} characters, box ${Math.round(width)}px wide)`);
        break;
      }
      if (style.hyphens === "auto") continue;
      const content = node.textContent ?? "";
      const wordPattern = /[^\s]+/g;
      let match: RegExpExecArray | null;
      while ((match = wordPattern.exec(content))) {
        const word = match[0].replace(/^[("'“‘]+|[)"'”’.,:;!?]+$/g, "");
        if (!/^[A-Za-z]{6,15}$/.test(word)) continue;
        const at = match.index + match[0].indexOf(word);
        const wordRange = document.createRange();
        wordRange.setStart(node, at);
        wordRange.setEnd(node, at + word.length);
        if (lineCount(wordRange) > 1) {
          seen.add(el);
          problems.push(`${label} breaks the word "${word}" across lines (box ${Math.round(width)}px wide)`);
          break;
        }
      }
      if (seen.has(el)) break;
    }
  }
  return problems;
}

/**
 * A sticky or fixed action bar that sits on top of text when the page opens (#996). Run at scroll 0. A bar is a
 * fixed or sticky element at least 60% of the window wide that holds a button; the top header does not count.
 * It is a finding when it overlaps any visible text outside the bar (a heading, the intro, a stepper, a label).
 */
function barOverTextInPage() {
  const h = window.innerHeight;
  const w = window.innerWidth;
  const bars: Array<{ el: Element; rect: DOMRect }> = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const style = getComputedStyle(el);
    if ((style.position !== "fixed" && style.position !== "sticky") || style.display === "none" || style.visibility === "hidden") continue;
    if (el.tagName === "HEADER" || el.closest("header, [role='dialog'], [aria-modal='true']")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < w * 0.6 || rect.height <= 0 || rect.height > h * 0.5 || rect.bottom <= 0 || rect.top >= h) continue;
    if (!el.querySelector("button, [type='submit'], [role='button']")) continue;
    bars.push({ el, rect });
  }
  const problems: string[] = [];
  if (bars.length === 0) return problems;
  const insideBar = (el: Element) => bars.some((bar) => bar.el.contains(el));
  const inFixed = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  };
  for (const { el: bar, rect } of bars) {
    const barName = `${bar.tagName.toLowerCase()}${String((bar as HTMLElement).className || "").split(/\s+/).filter(Boolean)[0] ? `.${String((bar as HTMLElement).className).split(/\s+/).filter(Boolean)[0]}` : ""}`;
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      if (problems.length >= 6) return problems;
      if (insideBar(el) || inFixed(el) || /^(SCRIPT|STYLE|SVG|PATH|OPTION|INPUT|SELECT|TEXTAREA|BUTTON|IMG)$/i.test(el.tagName)) continue;
      const own = Array.from(el.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 3);
      if (own.length === 0) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const rects = own.flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return Array.from(range.getClientRects());
      });
      for (const textRect of rects) {
        const overlapY = Math.min(textRect.bottom, rect.bottom) - Math.max(textRect.top, rect.top);
        const overlapX = Math.min(textRect.right, rect.right) - Math.max(textRect.left, rect.left);
        if (textRect.width > 0 && overlapY > 4 && overlapX > 4 && textRect.top < h) {
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
          problems.push(`${barName} (${Math.round(rect.top)}px to ${Math.round(rect.bottom)}px) sits on top of ${el.tagName.toLowerCase()} "${text}" when the page opens`);
          break;
        }
      }
    }
  }
  return problems;
}

/** True while the workspace shell's loading fallback ("Loading IMSDA Events…") is on the page. */
function shellLoadingInPage() {
  return Boolean(document.querySelector(".shell-loading")) || /Loading IMSDA Events/.test(document.body.innerText);
}

/** Runs in the page after scrolling to the bottom: is the last content under a fixed bar? */
function coveredByBarInPage() {
  const h = window.innerHeight;
  const w = window.innerWidth;
  const bars: DOMRect[] = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const style = getComputedStyle(el);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < w * 0.6 || rect.height <= 0 || rect.height >= h * 0.9) continue;
    if (rect.bottom >= h - 1 && rect.top > h / 2) bars.push(rect);
  }
  if (bars.length === 0) return null;
  const barTop = Math.min(...bars.map((rect) => rect.top));
  let lowest = 0;
  let lowestName = "";
  const inClosedDetails = (el: Element) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open) {
        const summary = node.querySelector(":scope > summary");
        if (!summary || !summary.contains(el)) return true;
      }
    }
    return false;
  };
  const inFixed = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  };
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (el.children.length > 0 && !/^(P|A|BUTTON|LABEL|SPAN|LI|TD|TH|H1|H2|H3|H4|SMALL|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(el.tagName)) continue;
    if (inFixed(el) || inClosedDetails(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const text = (el.textContent ?? "").trim();
    if (!text && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) continue;
    if (rect.bottom > lowest) {
      lowest = rect.bottom;
      lowestName = `${el.tagName.toLowerCase()} "${text.slice(0, 40)}"`;
    }
  }
  return lowest > barTop + 1 ? `${lowestName} ends at ${Math.round(lowest)}px, under a bar starting at ${Math.round(barTop)}px` : null;
}

/**
 * Form-field boundaries (WCAG 2.2 SC 1.4.11, 3:1): every visible text-like input, select, textarea and
 * search box has a boundary, either its own border or the border of its nearest wrapper within two
 * levels (the wrapper IS the field for `.search-field`, `.money-input` and the like), and that border
 * is at least `minRatio`:1 against the background behind it. Colours come from computed styles; a
 * translucent border is composited over that background first, and a gradient background (the sidebar)
 * is tested at each of its colour stops. With `dialogOnly`, only fields inside an open dialog
 * (`[role="dialog"], [aria-modal="true"]`) are scanned; the page behind it was already checked.
 *
 * Known blind spots (a pass is not a guarantee): the check measures the border against what is
 * behind the field, not the fill (a field whose white fill sits on a white page relies on the border
 * alone, which is the point, but a border that is fine against the page and weak against the fill is
 * not reported); `background-image: url(...)` backgrounds are ignored, only gradient colour stops
 * count; a field with only an underline (a bottom border) is reported as having no boundary rather
 * than measured; custom widgets that draw their own box with no input inside (a div acting as a
 * textbox) are not found because only input, select and textarea elements are scanned.
 */
function fieldBoundaryInPage(args: { minRatio: number; dialogOnly?: boolean }) {
  type Rgba = { r: number; g: number; b: number; a: number };
  const parse = (value: string): Rgba | null => {
    const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(value);
    if (!m) return null;
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number.parseFloat(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: alpha };
  };
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top.a + under.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (top.r * top.a + under.r * under.a * (1 - top.a)) / a,
      g: (top.g * top.a + under.g * under.a * (1 - top.a)) / a,
      b: (top.b * top.a + under.b * under.a * (1 - top.a)) / a,
      a,
    };
  };
  const luminance = ({ r, g, b }: Rgba) => {
    const [lr, lg, lb] = [r, g, b].map((channel) => {
      const v = channel / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  };
  const ratio = (a: Rgba, b: Rgba) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  /** The colours painted behind `el` (its ancestors, nearest first, until one is opaque): one per gradient stop. */
  const backdrops = (el: Element | null): Rgba[] => {
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const layers: Rgba[] = [];
      const image = style.backgroundImage;
      if (image && image !== "none") {
        for (const stop of image.match(/rgba?\([^)]*\)/g) ?? []) {
          const colour = parse(stop);
          if (colour) layers.push(colour);
        }
      }
      const colour = parse(style.backgroundColor);
      if (layers.length === 0 && colour && colour.a > 0) layers.push(colour);
      if (layers.length === 0) continue;
      const stack = layers.map((layer) => over(layer, white));
      if (layers.every((layer) => layer.a >= 1)) return stack;
      // A translucent layer: composite it over whatever is behind that element.
      const below = backdrops(node.parentElement);
      return stack.flatMap((_, index) => below.map((back) => over(layers[index], back)));
    }
    return [white];
  };
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    // Visually hidden inputs (sr-only, a custom switch's real checkbox) are not fields a person sees.
    return rect.width >= 8 && rect.height >= 8;
  };
  const hiddenTree = (el: Element) => {
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (node.getAttribute("aria-hidden") === "true" || (node as HTMLElement).hidden || node.hasAttribute("inert")) return true;
      if (node.tagName === "DETAILS" && !(node as HTMLDetailsElement).open && !(node.firstElementChild?.tagName === "SUMMARY" && node.firstElementChild.contains(el))) return true;
    }
    return false;
  };
  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : "";
    const classes = typeof (el as HTMLElement).className === "string"
      ? (el as HTMLElement).className.split(/\s+/).filter(Boolean).slice(0, 3).map((name) => `.${name}`).join("")
      : "";
    const type = el.tagName === "INPUT" ? `[type=${(el as HTMLInputElement).type}]` : "";
    const name = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? el.getAttribute("placeholder");
    return `${el.tagName.toLowerCase()}${type}${id}${classes}${name ? ` [${name.slice(0, 30)}]` : ""}`;
  };
  const sides = ["Top", "Right", "Bottom", "Left"] as const;
  /** The border colour when all four sides are drawn, else null. */
  const borderOf = (el: Element): Rgba | null => {
    const style = getComputedStyle(el);
    let first: Rgba | null = null;
    for (const side of sides) {
      const width = Number.parseFloat(style[`border${side}Width`]);
      const kind = style[`border${side}Style`];
      const colour = parse(style[`border${side}Color`]);
      if (!(width >= 1) || kind === "none" || kind === "hidden" || !colour || colour.a === 0) return null;
      first ??= colour;
    }
    return first;
  };
  const skipTypes = new Set(["checkbox", "radio", "range", "file", "color", "hidden", "button", "submit", "reset", "image"]);
  const problems: string[] = [];
  let checked = 0;
  const roots: ParentNode[] = args.dialogOnly ? Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')) : [document];
  const candidates = new Set<Element>();
  for (const root of roots) for (const found of Array.from(root.querySelectorAll("input, select, textarea"))) candidates.add(found);
  for (const el of Array.from(candidates)) {
    const field = el as HTMLInputElement;
    if (el.tagName === "INPUT" && skipTypes.has(field.type)) continue;
    if (field.disabled || !visible(el) || hiddenTree(el)) continue;
    checked += 1;
    // Its own border, else the nearest bordered wrapper within two levels.
    let holder: Element | null = null;
    let colour: Rgba | null = null;
    for (let node: Element | null = el, depth = 0; node && depth <= 2; node = node.parentElement, depth += 1) {
      colour = borderOf(node);
      if (colour) { holder = node; break; }
    }
    if (!holder || !colour) {
      problems.push(`${describe(el)}: no visible border on the field or on a wrapper within 2 levels`);
      continue;
    }
    // The border is drawn over what is behind the element that carries it (translucent borders too).
    const behind = backdrops(holder.parentElement);
    const worst = Math.min(...behind.map((back) => ratio(over(colour as Rgba, back), back)));
    if (worst < args.minRatio) {
      const where = holder === el ? "its border" : `the border of ${describe(holder)}`;
      problems.push(`${describe(el)}: ${where} is ${worst.toFixed(2)}:1 against the background behind it (needs ${args.minRatio}:1)`);
    }
  }
  return { checked, problems: problems.slice(0, 12) };
}

/**
 * Runs in the page with a dialog open (#918): every visible date, time and datetime-local input in an
 * open dialog must (1) sit inside its own label box and its own grid column, (2) be as tall as the
 * dialog's other single-line fields (a Safari date control renders as an empty tall box or a short
 * sliver), and (3) not overlap any other field, helper text or label in the dialog. The honor history
 * dialog's "Completion date" is the case that broke on an iPad.
 */
function dateFieldsInDialogInPage(args: { heightTolerance: number }) {
  const dateTypes = ["date", "time", "datetime-local", "month", "week"];
  const visible = (el: Element) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).filter(visible);
  const problems: string[] = [];
  let checked = 0;
  for (const dialog of dialogs) {
    const inputs = Array.from(dialog.querySelectorAll<HTMLInputElement>("input")).filter(visible);
    const dateInputs = inputs.filter((input) => dateTypes.includes(input.type));
    if (dateInputs.length === 0) continue;
    const referenceHeights = [
      ...inputs.filter((input) => ["text", "search", "email", "tel", "number", "url", ""].includes(input.type) || !input.getAttribute("type")),
      ...Array.from(dialog.querySelectorAll<HTMLElement>("select")).filter(visible),
    ].map((field) => field.getBoundingClientRect().height).filter((height) => height > 0);
    const referenceHeight = referenceHeights.length > 0 ? Math.min(...referenceHeights) : null;
    const others = [
      ...Array.from(dialog.querySelectorAll<HTMLElement>("input, select, textarea, small, .field-help, label")),
    ].filter(visible);
    for (const input of dateInputs) {
      checked += 1;
      const rect = input.getBoundingClientRect();
      const name = `${input.type} input "${input.name || input.id || "unnamed"}"`;
      const label = input.closest("label");
      const box = label ? label.getBoundingClientRect() : null;
      if (box && (rect.left < box.left - 1 || rect.right > box.right + 1)) {
        problems.push(`${name} spans ${Math.round(rect.left)}..${Math.round(rect.right)}px but its label box is ${Math.round(box.left)}..${Math.round(box.right)}px`);
      }
      if (box && (rect.top < box.top - 1 || rect.bottom > box.bottom + 1)) {
        problems.push(`${name} spans ${Math.round(rect.top)}..${Math.round(rect.bottom)}px but its label box is ${Math.round(box.top)}..${Math.round(box.bottom)}px`);
      }
      const grid = input.closest(".form-grid, .form-stack, form") ?? dialog;
      const gridBox = grid.getBoundingClientRect();
      if (rect.left < gridBox.left - 1 || rect.right > gridBox.right + 1) {
        problems.push(`${name} sticks out of its form (${Math.round(rect.left)}..${Math.round(rect.right)}px in ${Math.round(gridBox.left)}..${Math.round(gridBox.right)}px)`);
      }
      if (referenceHeight !== null && Math.abs(rect.height - referenceHeight) > args.heightTolerance) {
        problems.push(`${name} is ${Math.round(rect.height)}px tall, the dialog's other single-line fields are ${Math.round(referenceHeight)}px`);
      }
      for (const other of others) {
        if (other === input || other.contains(input) || input.contains(other)) continue;
        const o = other.getBoundingClientRect();
        const across = Math.min(rect.right, o.right) - Math.max(rect.left, o.left);
        const down = Math.min(rect.bottom, o.bottom) - Math.max(rect.top, o.top);
        if (across > 1 && down > 1) {
          const what = other.tagName.toLowerCase() === "label" ? `label "${(other.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30)}"` : `${other.tagName.toLowerCase()}${other.className ? `.${String(other.className).split(/\s+/)[0]}` : ""}`;
          problems.push(`${name} overlaps ${what} by ${Math.round(across)}x${Math.round(down)}px`);
        }
      }
    }
  }
  return { checked, problems };
}

/** Runs in the page with a dialog open: does it fit the screen, or scroll inside itself? */
function dialogFitInPage() {
  const h = window.innerHeight;
  const w = window.innerWidth;
  const dialogs = Array.from(document.querySelectorAll("[role=dialog], dialog[open], [aria-modal=true]"))
    .filter((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
  const out: string[] = [];
  for (const dialog of dialogs) {
    const rect = dialog.getBoundingClientRect();
    const name = `${dialog.tagName.toLowerCase()}${(dialog as HTMLElement).className ? `.${String((dialog as HTMLElement).className).split(/\s+/)[0]}` : ""}`;
    // The scrolling box is the dialog itself or its nearest scrolling ancestor/descendant.
    let scrolls = false;
    const chain: Element[] = [dialog, ...Array.from(dialog.querySelectorAll("*")), ...(dialog.parentElement ? [dialog.parentElement] : [])];
    for (const el of chain) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1) { scrolls = true; break; }
    }
    if (rect.top < -1 || rect.bottom > h + 1) {
      out.push(`${name} spans ${Math.round(rect.top)}..${Math.round(rect.bottom)}px of a ${h}px screen${scrolls ? " (backdrop scrolls, but the top or bottom is cut off)" : ""}`);
    }
    if (rect.left < -1 || rect.right > w + 1) out.push(`${name} spans ${Math.round(rect.left)}..${Math.round(rect.right)}px of a ${w}px screen`);
    // Its own contents must not overflow the box sideways either.
    if (dialog.scrollWidth > dialog.clientWidth + 1 && !/(auto|scroll)/.test(getComputedStyle(dialog).overflowX)) {
      out.push(`${name} content is ${dialog.scrollWidth}px wide in a ${dialog.clientWidth}px box`);
    }
  }
  return { count: dialogs.length, problems: out };
}

/**
 * Runs in the page: where every visible element sits on the page (document coordinates, so a
 * scroll between two snapshots does not count as a move), keyed by its place in the document.
 * The open list, its live-region text and anything visually hidden are left out: they are the
 * things that are allowed to change when a filter list opens.
 */
function layoutSnapshotInPage() {
  const rects: Record<string, [number, number, number, number]> = {};
  const all = Array.from(document.body.querySelectorAll("*"));
  all.forEach((el, index) => {
    if (el.closest('[role="listbox"], .sr-only, .back-to-top-button, script, style')) return;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.position === "fixed") return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
    rects[`${index}:${el.tagName.toLowerCase()}${id}`] = [rect.left + window.scrollX, rect.top + window.scrollY, rect.width, rect.height];
  });
  return { rects, scrollHeight: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth };
}

/** What moved between two snapshots (more than half a pixel), named for the report. */
function movedBetween(before: ReturnType<typeof layoutSnapshotInPage>, after: ReturnType<typeof layoutSnapshotInPage>) {
  const moved: string[] = [];
  for (const [key, a] of Object.entries(before.rects)) {
    const b = after.rects[key];
    if (!b) continue;
    if (a.some((value, i) => Math.abs(value - b[i]) > 0.5)) {
      moved.push(`${key.split(":")[1]} moved from ${a.map(Math.round).join(",")} to ${b.map(Math.round).join(",")}`);
    }
  }
  if (Math.abs(before.scrollHeight - after.scrollHeight) > 1) moved.push(`page height changed from ${before.scrollHeight} to ${after.scrollHeight}`);
  if (after.scrollWidth > before.scrollWidth + 1) moved.push(`page got wider, ${before.scrollWidth} to ${after.scrollWidth}`);
  return moved;
}

/** Runs in the page with a combobox list open: is the list a floating popover that fits the screen and the input? */
function openComboboxListInPage() {
  const input = document.querySelector<HTMLInputElement>('.club-roster-tools input[role="combobox"]');
  const listId = input?.getAttribute("aria-controls");
  const list = listId ? document.getElementById(listId) : null;
  if (!input || !list) return { problems: ["the combobox or its list is missing"] };
  const problems: string[] = [];
  const rect = list.getBoundingClientRect();
  const inputRect = input.getBoundingClientRect();
  const style = getComputedStyle(list);
  const viewport = window.visualViewport;
  const width = window.innerWidth;
  const height = viewport ? viewport.height : window.innerHeight;
  if (list.hidden || style.display === "none") problems.push("the list is hidden after the field was opened");
  if (style.position !== "absolute") problems.push(`the list is position:${style.position}, not a floating popover (absolute)`);
  if (rect.left < -0.5 || rect.right > width + 0.5) problems.push(`the list spans ${Math.round(rect.left)}..${Math.round(rect.right)}px of a ${width}px screen`);
  if (rect.top < -0.5 || rect.bottom > height + 0.5) problems.push(`the list spans ${Math.round(rect.top)}..${Math.round(rect.bottom)}px of a ${Math.round(height)}px screen`);
  if (Math.abs(rect.width - inputRect.width) > 1.5) problems.push(`the list is ${Math.round(rect.width)}px wide, the field ${Math.round(inputRect.width)}px`);
  if (Number(style.zIndex) < 1) problems.push(`the list has no z-index (${style.zIndex})`);
  if (rect.top < inputRect.bottom && rect.bottom > inputRect.top) problems.push("the list covers the field it belongs to");
  // It must not slide under a fixed bar along the bottom (the staff phone tab bar).
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    const barStyle = getComputedStyle(el);
    if ((barStyle.position !== "fixed" && barStyle.position !== "sticky") || barStyle.display === "none" || barStyle.visibility === "hidden") continue;
    const bar = el.getBoundingClientRect();
    if (bar.width < width * 0.5 || bar.height === 0 || bar.bottom < window.innerHeight - 1.5 || bar.top <= window.innerHeight / 2) continue;
    if (rect.bottom > bar.top + 0.5 && rect.top < bar.bottom) problems.push(`the list runs under a fixed bar at the bottom (${el.tagName.toLowerCase()}, from ${Math.round(bar.top)}px)`);
  }
  if (list.querySelectorAll('[role="option"]').length === 0) problems.push("the list has no options");
  if (input.getAttribute("aria-expanded") !== "true") problems.push("aria-expanded is not true while the list is open");
  return { problems, optionCount: list.querySelectorAll('[role="option"]').length };
}

/** Runs in the page: the other fixed or sticky controls a floating button must not sit on. */
function otherFixedRectsInPage() {
  const out: Array<{ name: string; left: number; top: number; right: number; bottom: number }> = [];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    if (el.closest(".back-to-top-button")) continue;
    const style = getComputedStyle(el);
    if ((style.position !== "fixed" && style.position !== "sticky") || style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
    out.push({ name: `${el.tagName.toLowerCase()}${(el as HTMLElement).className ? `.${String((el as HTMLElement).className).split(/\s+/)[0]}` : ""}`, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  }
  return out;
}

/** Self-test only: one defect of every kind the audit reports. Runs in the page. */
function injectDefects() {
  const box = document.createElement("div");
  box.innerHTML = [
    '<div style="width:2000px;height:4px;background:red"></div>',
    '<button type="button" style="width:20px;height:20px">x</button>',
    '<div style="max-width:100%;overflow-x:auto"><table><tbody><tr><td><div style="width:1500px">wide cell</div></td></tr></tbody></table></div>',
    // A cell whose text runs over the next cell, and a label that is not its column header (#811).
    '<table style="table-layout:fixed;width:200px"><thead><tr><th>One</th><th>Two</th></tr></thead><tbody><tr><td data-label="Uno" style="white-space:nowrap">AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</td><td data-label="Two">BBBBBBBB</td></tr></tbody></table>',
    '<div style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#ccc;z-index:30">self-test bar</div>',
    '<p style="margin:0 0 0 0">self-test last line</p>',
    // Text under the staff floor, and a column header narrower than its longest word (#981).
    '<p style="margin:0;font-size:10px">self-test tiny text</p>',
    '<table style="table-layout:fixed;width:60px"><thead><tr><th style="padding:0">Wordlongerthanthecolumn</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>',
    // A field whose border is as pale as the old #cbdbe2 (1.4:1), and one with no border at all.
    '<input aria-label="self-test pale field" style="display:block;width:200px;height:32px;border:1px solid #cbdbe2;background:#fff">',
    '<input aria-label="self-test borderless field" style="display:block;width:200px;height:32px;border:0;background:transparent">',
    // An unstyled heading, a label that runs into its field, text drawn over text, a focus ring on the help text under it, and a disabled button nobody can read.
    '<h2 style="margin:0;font:inherit">self-test unstyled heading</h2>',
    '<label style="display:block">self-test label<input style="display:inline-block;margin:0;width:120px;border:1px solid #333"></label>',
    '<p style="margin:0">self-test line one of two</p><p style="margin:-10px 0 0">self-test line two of two</p>',
    '<input aria-label="self-test ring" style="display:block;width:200px;height:32px;margin:0;border:1px solid #333;outline:3px solid red;outline-offset:6px"><p style="margin:-4px 0 0">self-test help under the ring</p>',
    '<button disabled type="button" style="min-width:44px;min-height:44px;background:#fff;color:#ddd;opacity:1">self-test disabled</button>',
    // A heading whose icon sits above its text, a label with its field right under it, and text that an overflow box cuts off sideways.
    '<h3 style="margin:0;display:block"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" style="display:block"><circle cx="10" cy="10" r="8"/></svg>self-test icon heading</h3>',
    '<label style="display:block;line-height:1;margin:0">self-test stacked label<input style="display:block;margin:0;width:160px;height:32px;border:1px solid #333"></label>',
    '<div style="width:80px;overflow:hidden;white-space:nowrap"><span>self-test text that is cut off sideways by its box</span></div>',
    // Text squeezed into a sliver, an ordinary word split in the middle (#996), a sticky action bar over text, and the shell's loading fallback.
    '<div style="width:14px;overflow:hidden"><span style="display:block">self-test squeezed text</span></div>',
    '<div style="width:50px;font:14px sans-serif;overflow-wrap:anywhere">Pathfinder Registration</div>',
    '<div style="position:fixed;left:0;right:0;top:140px;height:60px;z-index:30;background:#ccc"><button type="button" style="min-height:44px">self-test bar action</button></div><p style="position:absolute;top:150px;left:0;margin:0">self-test paragraph under an action bar</p>',
    '<div class="shell-loading">Loading IMSDA Events…</div>',
    // A table wider than its box (#997): one in a clipping box, one in a scrolling box that claims a scroll cue and draws none.
    '<div style="width:300px;overflow:hidden"><table><tbody><tr><td><div style="width:900px">self-test clipped wide table</div></td></tr></tbody></table></div>',
    '<div data-scroll-cue style="width:300px;overflow-x:auto"><table><tbody><tr><td><div style="width:900px">self-test cue claimed, none drawn</div></td></tr></tbody></table></div>',
  ].join("");
  document.body.appendChild(box);
  const opener = document.createElement("button");
  opener.id = "selftest-open";
  opener.type = "button";
  opener.setAttribute("aria-haspopup", "dialog");
  opener.setAttribute("style", "position:absolute;top:0;left:0;z-index:50;min-width:44px;min-height:44px");
  opener.textContent = "Open self-test dialog";
  document.body.appendChild(opener);
  opener.addEventListener("click", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("style", "position:fixed;left:0;top:0;width:100%;height:3000px;background:#fff;z-index:99");
    document.body.appendChild(dialog);
  });
}

/* ----------------------------------------------------------------- run */

function heightFor(width: number) {
  if (width <= 360) return 740;
  if (width <= 390) return 844;
  if (width <= 768) return 1024;
  return 768;
}

/** The club pages with a filter row that holds a type-to-search combobox (the Honor and Class filters). */
const filterComboboxPages: Record<string, string> = { "club-honors": "Honor", "club-class-tracking": "Class", "staff-club-as-director-honors": "Honor" };
/** Club pages that are long enough to scroll past one and a half screens, where Back to top must appear. */
const backToTopPages = ["club-orders", "club-honors", "club-class-tracking", "club-roster", "club-registration-form"];

/**
 * The Honor filter on Honors and the Class filter on Class tracking (the owner's Oct 13 request). Opened
 * in place on the page, twice: once with the field a third of the way down the screen, once with the field
 * pushed near the bottom so the list has to flip above it. Each time, nothing else on the page may move
 * (every element's bounding box is compared before and after), the list must be a floating popover that
 * fits the screen and is as wide as the field, and keyboard use (arrows, Escape, clicking elsewhere) keeps focus
 * in the field. Closed, every field of the filter row sits on one row on wide screens.
 */
async function auditFilterCombobox(page: Page, spec: PageSpec, width: number, prefix: string) {
  const labelText = filterComboboxPages[spec.name];
  if (!labelText) return;
  const name = `${spec.name} (${labelText} filter list)`;
  const combobox = page.locator('.club-roster-tools input[role="combobox"]:visible').first();
  if ((await combobox.count()) === 0) {
    record("dialog-open-failed", name, width, `no ${labelText} combobox in the filter row`);
    return;
  }
  const toolsBox = async () => page.evaluate(() => {
    const row = document.querySelector(".club-roster-tools:has(input[role=combobox])");
    if (!row) return null;
    return Array.from(row.children).map((child) => {
      const r = child.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, label: (child.textContent ?? "").trim().slice(0, 20) };
    });
  });
  const place = async (fromTop: number) => {
    await page.evaluate((offset: number) => {
      const input = document.querySelector('.club-roster-tools input[role="combobox"]') as HTMLElement;
      window.scrollBy(0, input.getBoundingClientRect().top - offset);
    }, fromTop);
    await page.waitForTimeout(80);
    // Did the field really end up where asked? A page too short to scroll it there leaves that case untested.
    const landed = await page.evaluate(() => (document.querySelector('.club-roster-tools input[role="combobox"]') as HTMLElement).getBoundingClientRect().top);
    if (Math.abs(landed - fromTop) > 24) {
      untestedNotes.push(`${name} @${width}: the field could not be scrolled to ${fromTop}px from the top (it sits at ${Math.round(landed)}px), so that placement was not tested`);
    }
  };
  try {
    // Closed: the filter row holds its fields side by side on a wide screen, and nothing sticks out.
    await place(Math.round(page.viewportSize().height * 0.3));
    const closed = await toolsBox();
    if (!closed || closed.length < 3) {
      record("dialog-open-failed", name, width, "the filter row has fewer than three fields");
    } else if (width >= 1024) {
      const tops = closed.map((box: { top: number }) => Math.round(box.top));
      const bottoms = closed.map((box: { bottom: number }) => Math.round(box.bottom));
      // Fields that share a line (a field may wrap to a second line on a narrow content area, such as beside the
      // staff sidebar) must share a baseline: same bottom edge.
      for (let i = 0; i < closed.length; i += 1) {
        for (let j = i + 1; j < closed.length; j += 1) {
          if (Math.abs(tops[i] - tops[j]) <= 20 && Math.abs(bottoms[i] - bottoms[j]) > 3) {
            record("filter-row-uneven", name, width, `filter fields on one line end at different heights (bottoms ${bottoms.join(", ")}px; tops ${tops.join(", ")}px)`);
          }
        }
      }
    }
    for (const [state, fromTop] of [["opened in the middle of the screen", Math.round(page.viewportSize().height * 0.3)], ["opened near the bottom of the screen", Math.round(page.viewportSize().height - 110)]] as const) {
      await place(fromTop);
      const before = await page.evaluate(layoutSnapshotInPage);
      await combobox.click({ timeout: 3000 });
      await page.waitForTimeout(200);
      const after = await page.evaluate(layoutSnapshotInPage);
      const moved = movedBetween(before, after);
      for (const move of moved.slice(0, 6)) record("filter-list-shifts-page", name, width, `${state}: ${move}`);
      if (moved.length > 6) record("filter-list-shifts-page", name, width, `${state}: ${moved.length - 6} more elements moved`);
      const open = await page.evaluate(openComboboxListInPage);
      for (const problem of open.problems) record("filter-list-position", name, width, `${state}: ${problem}`);
      if (takeShots) {
        const tag = state.includes("bottom") ? "bottom" : "middle";
        await page.screenshot({ path: `${prefix}-${labelText.toLowerCase()}-list-${tag}.png`, type: "png" });
      }
      // Keyboard: arrows move the active option, Escape closes with focus still in the field.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      const active = await combobox.getAttribute("aria-activedescendant");
      if (!active || (await page.locator(`[id="${active}"]`).count()) === 0) record("filter-list-keyboard", name, width, `${state}: no active option after the arrow keys (aria-activedescendant=${active})`);
      const controls = await combobox.getAttribute("aria-controls");
      if (!controls || (await page.locator(`[id="${controls}"][role="listbox"]`).count()) === 0) record("filter-list-keyboard", name, width, `${state}: aria-controls does not point at the listbox`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(80);
      if ((await combobox.getAttribute("aria-expanded")) !== "false") record("filter-list-keyboard", name, width, `${state}: Escape did not close the list`);
      if (!(await combobox.evaluate((el: HTMLElement) => document.activeElement === el))) record("filter-list-keyboard", name, width, `${state}: focus left the field when Escape closed the list`);
      const closedAgain = await page.evaluate(layoutSnapshotInPage);
      for (const move of movedBetween(before, closedAgain).slice(0, 3)) record("filter-list-shifts-page", name, width, `${state}, after closing: ${move}`);
      // Click elsewhere closes it too.
      await combobox.click({ timeout: 3000 });
      await page.waitForTimeout(100);
      await page.mouse.click(2, Math.max(2, Math.round(page.viewportSize().height / 2)));
      await page.waitForTimeout(100);
      if ((await combobox.getAttribute("aria-expanded")) !== "false") record("filter-list-keyboard", name, width, `${state}: clicking outside did not close the list`);
    }
  } catch (error) {
    record("dialog-open-failed", name, width, (error as Error).message.split("\n")[0] ?? "failed");
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Back to top on the club pages (the owner's Oct 13 request): absent at the top and a little way down,
 * present after scrolling past one and a half screens, a 44px button in the bottom corner that sits on
 * no other fixed control, and using it returns to the top, moves focus into the main content and hides it.
 * The audit browser asks for reduced motion, so the jump must be instant.
 */
async function auditBackToTop(page: Page, spec: PageSpec, width: number, prefix: string) {
  if (!backToTopPages.includes(spec.name)) return;
  const name = `${spec.name} (back to top)`;
  const button = page.locator('button[aria-label="Back to top"]');
  try {
    const innerHeight = page.viewportSize().height;
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
    if (scrollable < innerHeight * 1.7) {
      console.log(`  note  ${spec.name} @${width}: only ${Math.round(scrollable)}px to scroll, too short to need Back to top (not exercised on this page)`);
      return;
    }
    backToTopChecked.add(width);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);
    if ((await button.count()) !== 0) record("back-to-top", name, width, "the button shows at the top of the page");
    await page.evaluate((y: number) => window.scrollTo(0, y), Math.round(innerHeight * 1.2));
    await page.waitForTimeout(150);
    if ((await button.count()) !== 0) record("back-to-top", name, width, "the button shows after scrolling only 1.2 screens");
    await page.evaluate((y: number) => window.scrollTo(0, y), Math.round(innerHeight * 1.7));
    await button.first().waitFor({ state: "visible", timeout: 3000 });
    const box = await button.first().boundingBox();
    if (!box) {
      record("back-to-top", name, width, "the button has no box");
      return;
    }
    if (box.width < touchTarget - touchTolerance || box.height < touchTarget - touchTolerance) record("back-to-top", name, width, `the button is ${Math.round(box.width)}x${Math.round(box.height)}px, under ${touchTarget}`);
    if (box.x < 0 || box.y < 0 || box.x + box.width > width + 0.5 || box.y + box.height > innerHeight + 0.5) record("back-to-top", name, width, "the button is outside the screen");
    if (box.x + box.width < width * 0.6 || box.y + box.height < innerHeight * 0.6) record("back-to-top", name, width, `the button is not in the bottom corner (${Math.round(box.x)},${Math.round(box.y)})`);
    for (const other of await page.evaluate(otherFixedRectsInPage)) {
      if (box.x < other.right && box.x + box.width > other.left && box.y < other.bottom && box.y + box.height > other.top) record("back-to-top", name, width, `the button sits on top of ${other.name}`);
    }
    if ((await button.first().getAttribute("aria-label")) !== "Back to top") record("back-to-top", name, width, "the button has no Back to top name");
    if (takeShots) await page.screenshot({ path: `${prefix}-back-to-top.png`, type: "png" });
    await button.first().click({ timeout: 3000 });
    await page.waitForTimeout(150);
    const afterClick = await page.evaluate(() => ({
      y: window.scrollY,
      focus: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}` : "",
      inMain: Boolean(document.activeElement && document.activeElement.closest("main")),
    }));
    if (afterClick.y > 1) record("back-to-top", name, width, `the page is still ${Math.round(afterClick.y)}px down after using it (reduced motion should be instant)`);
    if (!afterClick.inMain || afterClick.focus === "body" || afterClick.focus === "button") record("back-to-top", name, width, `focus did not move to the top of the main content (it is on ${afterClick.focus})`);
    if ((await button.count()) !== 0) record("back-to-top", name, width, "the button is still there back at the top");
  } catch (error) {
    record("back-to-top", name, width, (error as Error).message.split("\n")[0] ?? "failed");
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/** The Orders page's four buttons each say, in a plain sentence, what that part is for. */
async function auditOrderDescriptions(page: Page, spec: PageSpec, width: number, prefix: string) {
  if (spec.name !== "club-orders") return;
  const name = `${spec.name} (button descriptions)`;
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('nav[aria-label="Jump to a part of this page"] a')).map((link) => ({
      label: (link.firstElementChild?.textContent ?? "").trim(),
      hint: (link.querySelector("small")?.textContent ?? "").trim(),
    })));
    const expected = ["Order list", "Supplies", "Ready to hand out", "Uniforms"];
    for (const label of expected) {
      const link = links.find((item: { label: string; hint: string }) => item.label === label);
      if (!link) record("orders-description", name, width, `no "${label}" button`);
      else if (link.hint.length < 30) record("orders-description", name, width, `"${label}" has no written description (${JSON.stringify(link.hint)})`);
    }
    if (takeShots) await page.screenshot({ path: `${prefix}-orders-top.png`, type: "png" });
  } catch (error) {
    record("orders-description", name, width, (error as Error).message.split("\n")[0] ?? "failed");
  }
}

/**
 * The text and form rules (heading-style, label-input, focus-ring-overlap, text-overlap, disabled-contrast) run on every page and
 * every state of its walkthroughs. They started on the Pathfinder Bible Experience pages and were extended to every page in #981,
 * once the older pages had been fixed; a finding is fixed on the page, never by loosening a rule. MOBILE_LAYOUT_TEXT_RULES=pbe
 * narrows them to the `pbe-*` and `staff-pbe-*` pages for a quick local run. CI and the pull request check never set it.
 */
const textRulesOnlyPbe = process.env.MOBILE_LAYOUT_TEXT_RULES === "pbe";
function textRulesApply(pageName: string) {
  return !textRulesOnlyPbe || /^(staff-)?pbe-/.test(pageName);
}

/**
 * The same measurements as a page's first look, for one state reached by clicking (a step of a form, an open sheet, the
 * confirmation page). `name` says which state, so a finding names the step.
 */
async function auditState(page: Page, name: string, width: number, prefix: string) {
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(150);
  const touch = width <= touchMaxWidth;
  const result = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
  if (result.scrollWidth > result.innerWidth) record("horizontal-scroll", name, width, `page is ${result.scrollWidth}px wide in a ${result.innerWidth}px window; sticking out: ${result.overflowers.join("; ") || "(nothing identified)"}`);
  for (const target of result.smallTargets) record("small-tap-target", name, width, target);
  for (const note of result.barNotes) record("sticky-bar-size", name, width, note);
  const fields = await page.evaluate(fieldBoundaryInPage, { minRatio: fieldBoundaryRatio });
  fieldsChecked += fields.checked;
  for (const problem of fields.problems) record("field-boundary", name, width, problem);
  await auditSqueezeAndBars(page, name, width);
  const text = await page.evaluate(textLayoutInPage);
  for (const problem of text.headings) record("heading-style", name, width, problem);
  for (const problem of text.labelInput) record("label-input", name, width, problem);
  for (const problem of text.focusRing) record("focus-ring-overlap", name, width, problem);
  for (const problem of text.textOverlap) record("text-overlap", name, width, problem);
  for (const problem of text.disabled) record("disabled-contrast", name, width, problem);
  const fit = await page.evaluate(dialogFitInPage);
  dialogsOpened += fit.count;
  for (const problem of fit.problems) record("dialog-too-tall", name, width, problem);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(60);
  // Behind an open sheet the page is not what a person reads, so the bar rule is for states with no dialog open.
  const covered = fit.count === 0 ? await page.evaluate(coveredByBarInPage) : null;
  if (covered) record("sticky-bar-covers-content", name, width, covered);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (takeShots) await page.screenshot({ path: `${prefix}.jpg`, type: "jpeg", quality: 60, fullPage: true }).catch(() => undefined);
}

/** Fills whatever the visible step of the public registration form requires with synthetic answers, never submitting. */
async function fillRequiredStep(page: Page, email: string) {
  const content = page.locator(".public-registration-step-content");
  const combos = content.locator('input[role="combobox"][required]:visible');
  for (let index = 0; index < (await combos.count()); index += 1) {
    const combo = combos.nth(index);
    if ((await combo.inputValue()) !== "") continue;
    await combo.click();
    await combo.fill("Mobilecheck Eagles");
    await page.waitForTimeout(200);
    await page.locator('[role="listbox"] [role="option"]:visible').first().click();
  }
  // A phone shows each searchable select as a trigger that opens a full-screen picker (#1046).
  const triggers = content.locator('button.searchable-select-trigger[data-required="true"]:visible');
  for (let index = 0; index < (await triggers.count()); index += 1) {
    const trigger = triggers.nth(index);
    if (!(await trigger.locator("span.is-placeholder").count())) continue;
    await trigger.click();
    const search = page.getByRole("dialog").getByRole("combobox");
    await search.fill("Mobilecheck Eagles");
    await page.waitForTimeout(200);
    await page.getByRole("dialog").getByRole("option").first().click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
  }
  const fields = content.locator("input[required]:not([role=combobox]):visible, textarea[required]:visible");
  for (let index = 0; index < (await fields.count()); index += 1) {
    const field = fields.nth(index);
    const type = await field.getAttribute("type");
    if (type === "checkbox" || type === "radio") { await field.check({ force: true }).catch(() => undefined); continue; }
    if ((await field.inputValue()) !== "") continue;
    await field.fill(type === "email" ? email : type === "tel" ? "515-555-0100" : type === "number" ? "14" : "Mobilecheck Synthetic");
  }
  const selects = content.locator("select[required]:visible");
  for (let index = 0; index < (await selects.count()); index += 1) {
    if ((await selects.nth(index).inputValue()) === "") await selects.nth(index).selectOption({ index: 1 });
  }
  // A choice nobody has made yet: the first option of each radio group with none chosen.
  const radios = content.locator("input[type=radio]:visible");
  const groups = new Set<string>();
  for (let index = 0; index < (await radios.count()); index += 1) {
    const radio = radios.nth(index);
    const group = (await radio.getAttribute("name")) ?? `radio-${index}`;
    if (groups.has(group)) continue;
    groups.add(group);
    if (!(await content.locator(`input[type=radio][name="${group}"]:checked`).count())) await radio.check({ force: true }).catch(() => undefined);
  }
}

/**
 * The phone picker (#1046), opened on the first searchable list on the step with a letter typed: it must cover the whole
 * window (nothing of the page behind shows), end where the window ends (a phone's window ends at the keyboard), have a
 * 44px Close, and give back the previous value and the focus on Escape. Does nothing off a phone or when the step has no
 * searchable list.
 */
async function auditPhonePicker(page: Page, label: string, width: number, shotPath: string) {
  const trigger = page.locator("button.searchable-select-trigger:visible").first();
  if ((await trigger.count()) === 0) return;
  const before = await trigger.innerText();
  try {
    await trigger.scrollIntoViewIfNeeded({ timeout: 3000 });
    await trigger.click({ timeout: 3000 });
    const dialog = page.getByRole("dialog");
    await dialog.waitFor({ timeout: 3000 });
    const search = dialog.getByRole("combobox");
    if ((await search.inputValue()) !== "") record("phone-picker", label, width, "the search box did not start empty");
    if (!(await search.evaluate((el: HTMLElement) => el === document.activeElement))) record("phone-picker", label, width, "the search box did not take focus");
    await search.pressSequentially("a");
    await page.waitForTimeout(200);
    const result = await page.evaluate(() => {
      const picker = document.querySelector<HTMLElement>(".searchable-select-picker");
      if (!picker) return { problems: ["no picker is open"] };
      const problems: string[] = [];
      const box = picker.getBoundingClientRect();
      if (Math.abs(box.left) > 0.5 || Math.abs(box.right - window.innerWidth) > 0.5) problems.push(`the picker is ${Math.round(box.width)}px wide in a ${window.innerWidth}px window`);
      if (Math.abs(box.top) > 0.5 || Math.abs(box.bottom - window.innerHeight) > 0.5) problems.push(`the picker spans ${Math.round(box.top)}..${Math.round(box.bottom)}px in a ${window.innerHeight}px window`);
      for (const [x, y] of [[2, 2], [window.innerWidth - 3, 2], [2, window.innerHeight - 3], [window.innerWidth - 3, window.innerHeight - 3], [window.innerWidth / 2, window.innerHeight / 2]]) {
        const top = document.elementFromPoint(x, y);
        if (!top || !picker.contains(top)) problems.push(`the page shows through at ${Math.round(x)},${Math.round(y)}`);
      }
      const listBox = picker.querySelector<HTMLElement>('[role="listbox"]')?.getBoundingClientRect();
      if (!listBox || Math.abs(listBox.bottom - window.innerHeight) > 1) problems.push(`the list ends at ${Math.round(listBox?.bottom ?? 0)}px, not at the bottom of the ${window.innerHeight}px window`);
      const close = picker.querySelector<HTMLElement>(".searchable-select-picker-close")?.getBoundingClientRect();
      if (!close || close.height < 43.5 || close.width < 43.5) problems.push(`Close is ${Math.round(close?.width ?? 0)}x${Math.round(close?.height ?? 0)}px`);
      const options = Array.from(picker.querySelectorAll<HTMLElement>('[role="option"]'));
      const small = options.filter((option) => option.getBoundingClientRect().height < 43.5).length;
      if (small) problems.push(`${small} options are shorter than 44px`);
      if (options.length === 0) problems.push("typing a letter left no options");
      if (document.documentElement.scrollWidth > window.innerWidth) problems.push("the page behind scrolls sideways");
      return { problems };
    });
    for (const problem of result.problems) record("phone-picker", label, width, problem);
    if (takeShots) await page.screenshot({ path: `${shotPath}.jpg`, type: "jpeg", quality: 60 }).catch(() => undefined);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached", timeout: 3000 });
    if ((await trigger.innerText()) !== before) record("phone-picker", label, width, "Escape changed the value");
    if (!(await trigger.evaluate((el: HTMLElement) => el === document.activeElement))) record("phone-picker", label, width, "focus did not return to the field after Escape");
  } catch (error) {
    record("phone-picker", label, width, (error as Error).message.split("\n")[0]);
  }
}

/**
 * The general registration link as a director walks it (a PBE team without an account): the start step filled in, every step of the
 * form, a team member's sheet, the review, and the confirmation after submitting a synthetic team (named for the width, so each
 * run adds its own waiting team). Each state is measured like a page of its own.
 */
async function auditGeneralLinkFlow(page: Page, spec: PageSpec, width: number, prefix: string) {
  const name = (state: string) => `${spec.name} (${state})`;
  const shot = (state: string) => `${prefix}-${state.replace(/[^a-z0-9]+/gi, "-")}`;
  const email = `${P}.walkthrough.${width}@example.test`;
  try {
    await page.locator("input[type=radio][name=club-location]").first().check({ force: true });
    await page.fill("#general-link-team-name", `Mobilecheck Walkthrough Team ${width}`);
    await auditState(page, name("start, filled in"), width, shot("start-filled"));
    await page.click("button:has-text('Continue')");
    await page.waitForTimeout(400);
    for (let step = 0; step < 8; step += 1) {
      const heading = ((await page.locator("#public_registration_step_heading").innerText().catch(() => "")) || `step ${step + 1}`).replace(/\s+/g, " ").trim();
      await auditState(page, name(heading), width, shot(heading));
      if (/review/i.test(heading)) break;
      // The team members step: each person is edited in a sheet. Audit the first one open, then fill them all.
      const toggles = page.locator('.public-registration-step-content button[id^="public_attendee_"][id$="_toggle"]:visible');
      const people = await toggles.count();
      for (let person = 0; person < people; person += 1) {
        // A card that is already open (a desktop keeps it so) is not toggled shut.
        if ((await toggles.nth(person).getAttribute("aria-expanded")) !== "true") await toggles.nth(person).click();
        await page.waitForTimeout(300);
        if (person === 0) await auditState(page, name(`${heading}, a team member's sheet`), width, shot(`${heading}-sheet`));
        const sheet = page.locator(`#public_attendee_initial-attendee-${person + 1}`);
        for (const [suffix, value] of [["pbe_member_first", `Walker${person + 1}`], ["pbe_member_last", "Mobilecheck-Synthetic"], ["pbe_member_age", "14"]] as const) {
          await sheet.locator(`input[id$="_${suffix}"]`).fill(value);
        }
        // A phone edits a person in a sheet that is closed with Done; a desktop edits in place.
        const done = sheet.locator('button:has-text("Done with"):visible');
        if ((await done.count()) > 0) await done.first().click({ timeout: 5000 });
        await page.waitForTimeout(250);
      }
      await auditPhonePicker(page, name(`${heading}, searchable list open`), width, shot(`${heading}-picker`));
      await fillRequiredStep(page, email);
      await page.click("button.is-continue");
      await page.waitForTimeout(450);
      const problem = await page.locator(".public-registration-error-summary").innerText().catch(() => "");
      if (problem) {
        record("audit-failed", name(heading), width, `could not move past this step with synthetic answers: ${problem.replace(/\s+/g, " ").slice(0, 200)}`);
        return;
      }
    }
    // The card's own submit button is hidden on a phone, where the sticky bar carries it.
    await page.locator('button[type=submit]:has-text("Submit team registration"):visible').first().click({ timeout: 5000 });
    await page.waitForSelector(".public-registration-confirmation", { timeout: 20_000 });
    await auditState(page, name("confirmation after submitting"), width, shot("confirmation"));
  } catch (error) {
    record("audit-failed", name("walkthrough"), width, (error as Error).message.split("\n").slice(0, 3).join(" | ").slice(0, 400));
  }
}

/** The waiting teams page with a team's Reject form open (never submitted) and the club list focused. */
async function auditPendingTeamsFlow(page: Page, spec: PageSpec, width: number, prefix: string) {
  const name = `${spec.name} (reject form open)`;
  try {
    await page.goto(`${baseUrl}${spec.path}`, { waitUntil: "load" });
    await page.locator(".pending-team-reject:visible").first().click({ timeout: 5000 });
    await page.waitForTimeout(200);
    await auditState(page, name, width, `${prefix}-reject-open`);
    // The add-club form (#1031), for a role that sees its button: open it and choose a church so the similar-clubs check runs.
    const addClub = page.locator("button:has-text('Add this club to the directory'):visible").first();
    if (await addClub.count() > 0) {
      await addClub.click({ timeout: 5000 });
      await page.locator(".pending-team-add-club select").first().selectOption({ index: 1 });
      await page.waitForTimeout(600);
      await auditState(page, `${spec.name} (add club form open)`, width, `${prefix}-add-club-open`);
    }
  } catch (error) {
    record("audit-failed", name, width, (error as Error).message.split("\n")[0] ?? "failed");
  }
}

/** Waits for the shell's "Loading IMSDA Events…" fallback to go away (#996); true when it did. */
async function waitForShell(page: Page) {
  return page.waitForFunction(() => !document.querySelector(".shell-loading") && !/Loading IMSDA Events/.test(document.body.innerText), undefined, { timeout: 20_000 })
    .then(() => true, () => false);
}

/** The #996 rules: squeezed text, an action bar over text when the page opens (scroll 0), and the loading screen. */
async function auditSqueezeAndBars(page: Page, name: string, width: number) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(60);
  if (await page.evaluate(shellLoadingInPage)) record("loading-screen", name, width, 'the page still shows "Loading IMSDA Events…" when it is measured');
  for (const problem of await page.evaluate(squeezedTextInPage)) record("squeezed-text", name, width, problem);
  for (const problem of await page.evaluate(barOverTextInPage)) record("bar-over-text", name, width, problem);
}

async function auditPage(page: Page, spec: PageSpec, width: number, prefix: string) {
  const url = `${baseUrl}${spec.path}`;
  // "load", then a bounded wait for quiet: Next prefetches every visible link, so
  // the network is not always idle on a busy page.
  const response = await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  const status = response?.status() ?? 0;
  const finalPath = new URL(page.url()).pathname;
  const label = `${spec.name} @${width}`;
  if (status >= 500) {
    record("http-error", spec.name, width, `${url} answered ${status}`);
    return;
  }
  if (status === 404 && !spec.allow404) {
    record("not-found", spec.name, width, `${url} answered 404 (the page or its synthetic data is missing)`);
    return;
  }
  const sentToSignIn = /\/(login|account\/sign-in|account\/two-step|no-access)/.test(finalPath);
  if (sentToSignIn && !spec.signInPage) {
    record("signed-out", spec.name, width, `${url} sent the synthetic user to ${finalPath}`);
    return;
  }
  if (finalPath !== spec.path.split("?")[0]) {
    console.log(`  note  ${label}: redirected to ${finalPath}`);
    // A sign-in page must be the page itself: a broken route that redirects to /login would otherwise pass as the sign-in page (#996).
    if (spec.signInPage) record("redirected", spec.name, width, `${url} ended at ${finalPath}, not on the page itself`);
  }
  // Let late client effects (fonts, hydration) settle before measuring, and wait out the shell's loading fallback (#996).
  await waitForShell(page);
  if (spec.expectText) {
    const shown: string = await page.evaluate(() => document.body.innerText);
    if (!spec.expectText.test(shown)) record("wrong-page", spec.name, width, `${url} (status ${status}) does not show the expected copy ${spec.expectText}`);
  }
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(150);
  if (spec.prepare) await spec.prepare(page, width);

  if (selfTest) await page.evaluate(injectDefects);
  const touch = width <= touchMaxWidth;
  const result = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });

  if (result.scrollWidth > result.innerWidth) {
    record("horizontal-scroll", spec.name, width, `page is ${result.scrollWidth}px wide in a ${result.innerWidth}px window; sticking out: ${result.overflowers.join("; ") || "(nothing identified)"}`);
  }
  for (const table of result.scrollingTables) record("table-scrolls-sideways", spec.name, width, table);
  for (const target of result.smallTargets) record("small-tap-target", spec.name, width, target);
  for (const note of result.barNotes) record("sticky-bar-size", spec.name, width, note);
  for (const problem of result.cellProblems) record("table-cell", spec.name, width, problem);
  for (const problem of result.pillProblems) record("honor-pill", spec.name, width, problem);
  for (const problem of result.fitProblems) record("table-too-wide", spec.name, width, problem);
  for (const problem of result.wideTables) record("table-wider-than-box", spec.name, width, problem);
  const fields = await page.evaluate(fieldBoundaryInPage, { minRatio: fieldBoundaryRatio });
  fieldsChecked += fields.checked;
  for (const problem of fields.problems) record("field-boundary", spec.name, width, problem);
  // Text floor and cramped table headers (#981). Staff pages hold the text floor; every page is checked for headers.
  // Overlapping text, headings, labels, focus rings and disabled contrast belong to the text-rules set below.
  const floorText = await page.evaluate(textAuditInPage, {
    floor: spec.name.startsWith("staff-") ? staffTextFloorPx : 0,
    upperFloor: spec.name.startsWith("staff-") ? upperLabelFloorPx : 0,
    exceptions: staffTextFloorExceptions.map((entry) => entry.selector),
  });
  for (const problem of floorText.small) record("text-too-small", spec.name, width, problem);
  for (const problem of floorText.narrowHeaders) record("header-too-narrow", spec.name, width, problem);
  // Squeezed text, an action bar over text, the loading screen (#996): every page, every width, at the top of the page.
  await auditSqueezeAndBars(page, spec.name, width);
  if (textRulesApply(spec.name)) {
    const text = await page.evaluate(textLayoutInPage);
    for (const problem of text.headings) record("heading-style", spec.name, width, problem);
    for (const problem of text.labelInput) record("label-input", spec.name, width, problem);
    for (const problem of text.focusRing) record("focus-ring-overlap", spec.name, width, problem);
    for (const problem of text.textOverlap) record("text-overlap", spec.name, width, problem);
    for (const problem of text.disabled) record("disabled-contrast", spec.name, width, problem);
  }

  // Scroll to the bottom: is the last content hidden behind a fixed bar?
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(60);
  const covered = await page.evaluate(coveredByBarInPage);
  if (covered) record("sticky-bar-covers-content", spec.name, width, covered);
  await page.evaluate(() => window.scrollTo(0, 0));

  // Dialogs: open every dialog button, check it fits, close it unsubmitted.
  const selectors = [
    ...Array.from({ length: Math.min(await page.locator('button[aria-haspopup="dialog"]:visible').count(), 4) },
      (_, index) => ({ label: `dialog button ${index + 1}`, locator: page.locator('button[aria-haspopup="dialog"]:visible').nth(index) })),
    ...dialogOpeners.map((selector) => ({ label: selector, locator: page.locator(`${selector}:visible`).first() })),
  ];
  let dialogShots = 0;
  for (const { label: openerLabel, locator: trigger } of selectors) {
    if ((await trigger.count()) === 0) continue;
    const name = ((await trigger.innerText().catch(() => "")) || openerLabel).replace(/\s+/g, " ").trim().slice(0, 30);
    const before = page.url();
    try {
      await trigger.scrollIntoViewIfNeeded({ timeout: 3000 });
      await trigger.click({ timeout: 3000 });
      await page.waitForTimeout(250);
      const fit = await page.evaluate(dialogFitInPage);
      dialogsOpened += fit.count;
      if (fit.count === 0) console.log(`  note  ${label}: "${name}" opened no dialog`);
      for (const problem of fit.problems) record("dialog-too-tall", spec.name, width, `"${name}": ${problem}`);
      if (fit.count > 0) {
        const dialogFields = await page.evaluate(fieldBoundaryInPage, { minRatio: fieldBoundaryRatio, dialogOnly: true });
        fieldsChecked += dialogFields.checked;
        for (const problem of dialogFields.problems) record("field-boundary", `${spec.name} (dialog "${name}")`, width, problem);
        // Date fields (#918): inside their box, as tall as the other fields, overlapping nothing.
        const dates = await page.evaluate(dateFieldsInDialogInPage, { heightTolerance: dateFieldHeightTolerance });
        dateFieldsChecked += dates.checked;
        if (dates.checked > 0) dateFieldWidths.add(width);
        for (const problem of dates.problems) record("date-field-layout", `${spec.name} (dialog "${name}")`, width, problem);
      }
      if (takeShots && fit.count > 0) {
        dialogShots += 1;
        await page.screenshot({ path: `${prefix}-dialog${dialogShots}.jpg`, type: "jpeg", quality: 60 });
      }
    } catch (error) {
      record("dialog-open-failed", spec.name, width, `"${name}": ${(error as Error).message.split("\n")[0]}`);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    if (page.url() !== before) await page.goto(before, { waitUntil: "load" });
  }

  // The bulk honor popup (#819), with its type-to-search list open and narrowed and
  // the member list showing: the dialog must fit, nothing may stick out sideways and
  // every control in it must be a big enough tap target.
  const bulkOpener = page.locator('button:has-text("Add honors to several members"):visible').first();
  if ((await bulkOpener.count()) > 0) {
    const bulkBefore = page.url();
    try {
      await bulkOpener.scrollIntoViewIfNeeded({ timeout: 3000 });
      await bulkOpener.click({ timeout: 3000 });
      await page.waitForTimeout(250);
      const combobox = page.locator('[role="dialog"] input[role="combobox"]:visible').first();
      await combobox.click({ timeout: 3000 });
      await combobox.fill("ab");
      await page.waitForTimeout(150);
      const bulkName = `${spec.name} (bulk honor popup)`;
      const fit = await page.evaluate(dialogFitInPage);
      dialogsOpened += fit.count;
      if (fit.count === 0) record("dialog-open-failed", bulkName, width, "the bulk honor popup did not open");
      for (const problem of fit.problems) record("dialog-too-tall", bulkName, width, problem);
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", bulkName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", bulkName, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-bulk-honor.jpg`, type: "jpeg", quality: 60 });
    } catch (error) {
      record("dialog-open-failed", `${spec.name} (bulk honor popup)`, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    // First Escape closes the open list, the second closes the dialog.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    if (page.url() !== bulkBefore) await page.goto(bulkBefore, { waitUntil: "load" });
  }

  // The More launcher's Turn off confirm (#810): open the launcher, press the first Turn off, and the
  // confirm must fit, say the data is kept, and every control in it must be a big enough tap target.
  // It is cancelled, never confirmed, so no module is changed.
  if (spec.name === "staff-more-launcher-admin") {
    const launcherName = `${spec.name} (turn off confirm)`;
    try {
      await page.locator('a[aria-haspopup="dialog"]:visible').first().click({ timeout: 3000 });
      await page.waitForTimeout(250);
      const toggle = page.locator(".more-launcher [data-module-toggle]:visible").first();
      if ((await toggle.count()) === 0) {
        record("dialog-open-failed", launcherName, width, "a system administrator sees no Turn off control in the More launcher");
      } else {
        await toggle.scrollIntoViewIfNeeded({ timeout: 3000 });
        await toggle.click({ timeout: 3000 });
        await page.waitForTimeout(250);
        const confirmText = await page.locator(".more-launcher-confirm:visible").innerText({ timeout: 3000 }).catch(() => "");
        if (!/data is kept/i.test(confirmText)) record("dialog-open-failed", launcherName, width, "the Turn off confirm did not say the data is kept");
        const fit = await page.evaluate(dialogFitInPage);
        dialogsOpened += fit.count;
        for (const problem of fit.problems) record("dialog-too-tall", launcherName, width, problem);
        const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
        if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", launcherName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
        for (const target of open.smallTargets) record("small-tap-target", launcherName, width, target);
        if (takeShots) await page.screenshot({ path: `${prefix}-launcher-confirm.jpg`, type: "jpeg", quality: 60 });
      }
    } catch (error) {
      record("dialog-open-failed", launcherName, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    // First Escape cancels the confirm, the second closes the launcher.
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
  }

  // The meeting-note popup after a save (#810): the green Saved banner is pinned at the top of the popup.
  if (spec.name === "club-meeting-notes") {
    const savedName = `${spec.name} (saved popup)`;
    try {
      const opener = page.locator("[data-meeting-note-add]:visible").first();
      await opener.scrollIntoViewIfNeeded({ timeout: 3000 });
      await opener.click({ timeout: 3000 });
      await page.waitForTimeout(250);
      await page.locator('[role="dialog"] textarea:visible').first().fill(layoutNoteText);
      await page.locator('[role="dialog"] button[type="submit"]:visible').first().click({ timeout: 3000 });
      const banner = page.locator("[data-meeting-note-saved]:visible").first();
      await banner.waitFor({ state: "visible", timeout: 8000 });
      const box = await banner.boundingBox();
      if (!box || box.y < -1 || box.y > 120) record("dialog-too-tall", savedName, width, `the Saved banner is not at the top of the popup (y=${box ? Math.round(box.y) : "none"})`);
      if (!/^Saved$/.test((await banner.innerText()).trim())) record("dialog-open-failed", savedName, width, "the banner does not say Saved");
      const fit = await page.evaluate(dialogFitInPage);
      dialogsOpened += fit.count;
      for (const problem of fit.problems) record("dialog-too-tall", savedName, width, problem);
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", savedName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", savedName, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-note-saved.jpg`, type: "jpeg", quality: 60 });
    } catch (error) {
      record("dialog-open-failed", savedName, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    await deleteLayoutNotes().catch((error: Error) => record("dialog-open-failed", savedName, width, `could not delete the synthetic note: ${error.message.split("\n")[0]}`));
  }

  // The calendar admin's Deadline reminders tab (#910): a prepared batch with its recipient chips, the opened email
  // preview, and the Send and Don't send buttons. Nothing is sent: the buttons are only measured.
  if (spec.name === "staff-calendar-admin") {
    const stateName = `${spec.name} (deadline reminders)`;
    try {
      await page.getByRole("tab", { name: /Deadline reminders/ }).click({ timeout: 3000 });
      await page.waitForTimeout(150);
      const card = page.locator(".deadline-reminder-row:visible").first();
      await card.waitFor({ state: "visible", timeout: 5000 });
      const audit = async (state: string, shot: string) => {
        const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
        const name = `${stateName} ${state}`;
        if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", name, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
        for (const target of open.smallTargets) record("small-tap-target", name, width, target);
        if (takeShots) await page.screenshot({ path: `${prefix}-${shot}.jpg`, type: "jpeg", quality: 60 });
      };
      await audit("closed", "deadline-reminders");
      await card.locator("summary").first().click({ timeout: 3000 });
      await page.waitForTimeout(150);
      await audit("preview open", "deadline-reminders-preview");
    } catch (error) {
      record("dialog-open-failed", stateName, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
  }

  // The class builder with several honors chosen (#812): the add form with its honor search narrowed and
  // three honors ticked, then the edit form of a class that teaches four. Nothing may stick out sideways,
  // and every checkbox, chip button and search box must be a big enough tap target.
  if (spec.name === "staff-honors") {
    const builderBefore = page.url();
    const auditBuilder = async (state: string, shot: string) => {
      const stateName = `${spec.name} (${state})`;
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", stateName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", stateName, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-${shot}.jpg`, type: "jpeg", quality: 60 });
    };
    try {
      // Scoped to the honors-taught widget: the prerequisite honors widget (#832) sits in the same form.
      const taught = page.locator('[data-testid="honor-multi-taught"]:visible').first();
      const search = taught.locator('input[placeholder="Type to search honors"]');
      await search.scrollIntoViewIfNeeded({ timeout: 3000 });
      await search.fill("mobilecheck");
      await page.waitForTimeout(150);
      const boxes = taught.locator('[data-testid="honor-multi-options"] input[type="checkbox"]:visible');
      const listed = await boxes.count();
      if (listed < 4) record("dialog-open-failed", `${spec.name} (several honors)`, width, `the honor search listed ${listed} synthetic honors, expected 4`);
      for (let index = 0; index < Math.min(listed, 3); index += 1) await boxes.nth(index).check({ timeout: 3000 });
      await page.waitForTimeout(150);
      const chosen = await taught.locator('ul[aria-label^="Chosen honors"] li:visible').count();
      if (chosen !== 3) record("dialog-open-failed", `${spec.name} (several honors)`, width, `expected 3 chosen honors, found ${chosen}`);
      await auditBuilder("add form, several honors chosen", "several-honors-add");
      // The prerequisite honors widget (#832) fits and works too: search, tick one, and it is the only chosen prerequisite.
      const prerequisite = page.locator('[data-testid="honor-multi-prerequisite"]:visible').first();
      const prerequisiteSearch = prerequisite.locator('input[placeholder="Type to search prerequisite honors"]');
      await prerequisiteSearch.scrollIntoViewIfNeeded({ timeout: 3000 });
      await prerequisiteSearch.fill("mobilecheck");
      await page.waitForTimeout(150);
      await prerequisite.locator('[data-testid="honor-multi-prerequisite-options"] input[type="checkbox"]:visible').first().check({ timeout: 3000 });
      const prerequisiteChosen = await prerequisite.locator('ul[aria-label^="Chosen prerequisite honors"] li:visible').count();
      if (prerequisiteChosen !== 1) record("dialog-open-failed", `${spec.name} (several honors)`, width, `expected 1 chosen prerequisite honor, found ${prerequisiteChosen}`);
      await auditBuilder("add form, a prerequisite honor chosen", "prerequisite-add");
      const edit = page.locator('button[aria-label^="Edit Mobilecheck"]:visible').first();
      await edit.scrollIntoViewIfNeeded({ timeout: 3000 });
      await edit.click({ timeout: 3000 });
      await page.waitForTimeout(250);
      const editChosen = await page.locator('[data-testid="honor-multi-taught"]:visible').first().locator('ul[aria-label^="Chosen honors"] li:visible').count();
      if (editChosen < 4) record("dialog-open-failed", `${spec.name} (several honors)`, width, `the edit form listed ${editChosen} chosen honors, expected the class's 4`);
      await auditBuilder("edit form, class with four honors", "several-honors-edit");
    } catch (error) {
      record("dialog-open-failed", `${spec.name} (several honors)`, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    if (page.url() !== builderBefore) await page.goto(builderBefore, { waitUntil: "load" });
  }

  // The template editor with attachments (#824): the attachments list, the picture picker and the button form each
  // open, and with each open nothing may stick out sideways and every control must be a big enough tap target.
  if (spec.name === "staff-communications-editor") {
    const editorBefore = page.url();
    const auditEditor = async (state: string, shot: string) => {
      const stateName = `${spec.name} (${state})`;
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", stateName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", stateName, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-${shot}.jpg`, type: "jpeg", quality: 60 });
    };
    try {
      // The page opens on the first template; the one with attachments is the event announcement.
      await page.locator('.message-template-list button:has-text("Event announcement"):visible').first().click({ timeout: 5000 });
      await page.waitForTimeout(300);
      const attachments = page.locator(".message-attachments-field:visible").first();
      await attachments.scrollIntoViewIfNeeded({ timeout: 5000 });
      const listed = await attachments.locator("li").count();
      if (listed !== 2) record("dialog-open-failed", `${spec.name} (attachments)`, width, `the attachments list showed ${listed} files, expected the template's 2`);
      await auditEditor("attachments listed", "attachments");
      await page.locator('button[aria-label="Insert image"]:visible').first().click({ timeout: 5000 });
      await page.waitForTimeout(150);
      const pictures = await page.locator(".message-editor-image-list li:visible").count();
      if (pictures < 1) record("dialog-open-failed", `${spec.name} (picture picker)`, width, "the picker listed no uploaded picture");
      await auditEditor("picture picker open", "picture-picker");
      await page.locator('button[aria-label="Insert image"]:visible').first().click({ timeout: 5000 });
      await page.locator('button[aria-label="Button link"]:visible').first().click({ timeout: 5000 });
      await page.waitForTimeout(150);
      await page.locator('.message-editor-panel input:visible').first().fill("A long button label that has to wrap on a very small phone screen");
      await auditEditor("button form open", "button-form");
    } catch (error) {
      record("dialog-open-failed", `${spec.name} (attachments editor)`, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    if (page.url() !== editorBefore) await page.goto(editorBefore, { waitUntil: "load" });
  }

  // The Custom message template (#850) starts blank and unpublished: its explanation, empty fields and the shorter token
  // list fit the screen, and the token picker opens without anything sticking out.
  if (spec.name === "staff-communications-editor") {
    const customBefore = page.url();
    const auditCustom = async (state: string, shot: string) => {
      const stateName = `${spec.name} (${state})`;
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", stateName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", stateName, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-${shot}.jpg`, type: "jpeg", quality: 60 });
    };
    try {
      await page.locator('.message-template-list button:has-text("Custom message"):visible').first().click({ timeout: 5000 });
      await page.waitForTimeout(300);
      const subject = await page.locator('.message-template-editor label:has-text("Subject") input:visible').first().inputValue({ timeout: 5000 });
      if (subject !== "") record("dialog-open-failed", `${spec.name} (custom message)`, width, `the custom message should start blank, its subject was "${subject}"`);
      await auditCustom("custom message blank", "custom-message");
    } catch (error) {
      record("dialog-open-failed", `${spec.name} (custom message)`, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    if (page.url() !== customBefore) await page.goto(customBefore, { waitUntil: "load" });
  }

  // Email selected (#850): tick a registration, open the dialog, and look at Custom message (not yet published for
  // this event) and Event announcement (with its formatting hint). Nothing is sent.
  if (spec.name === "staff-people-email-selected") {
    const peopleBefore = page.url();
    const auditDialog = async (state: string, shot: string) => {
      const stateName = `${spec.name} (${state})`;
      const fit = await page.evaluate(dialogFitInPage);
      dialogsOpened += fit.count;
      for (const problem of fit.problems) record("dialog-too-tall", stateName, width, problem);
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", stateName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", stateName, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-${shot}.jpg`, type: "jpeg", quality: 60 });
    };
    try {
      await page.locator(".record-select input:visible").first().check({ timeout: 5000 });
      await page.locator('button:has-text("Email selected"):visible').first().click({ timeout: 5000 });
      await page.waitForTimeout(400);
      const select = page.locator('[role="dialog"] select').first();
      await select.selectOption("CUSTOM_MESSAGE", { timeout: 5000 });
      await page.waitForTimeout(600);
      const notice = await page.locator('[role="dialog"]:has-text("Custom message template has not been published")').count();
      if (notice === 0) record("dialog-open-failed", `${spec.name} (custom message)`, width, "the dialog did not say the custom message is unpublished");
      const sendDisabled = await page.locator('[role="dialog"] button.primary-button').first().isDisabled();
      if (!sendDisabled) record("dialog-open-failed", `${spec.name} (custom message)`, width, "Send is enabled while the custom message is unpublished");
      await auditDialog("custom message unpublished", "email-selected-custom");
      await select.selectOption("EVENT_ANNOUNCEMENT", { timeout: 5000 });
      await page.waitForTimeout(400);
      if ((await page.locator('[role="dialog"]:has-text("Formatting:")').count()) === 0) record("dialog-open-failed", `${spec.name} (announcement)`, width, "the announcement message has no formatting hint");
      await auditDialog("event announcement hint", "email-selected-announcement");
    } catch (error) {
      record("dialog-open-failed", `${spec.name} (email selected)`, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    if (page.url() !== peopleBefore) await page.goto(peopleBefore, { waitUntil: "load" });
  }

  // Scanner name search (#889): open the scanner, search a first name several registrations share, and the pick list
  // (names, Open buttons) fits the phone and the camera button is still there. Nothing is checked in.
  if (spec.name === "staff-check-in") {
    const checkInBefore = page.url();
    try {
      await page.locator("button.scan-card:visible").first().click({ timeout: 5000 });
      await page.locator('[role="dialog"] .check-in-manual-form input').first().fill("Lisa", { timeout: 5000 });
      await page.locator('[role="dialog"] .check-in-manual-form button[type="submit"]').first().click({ timeout: 5000 });
      await page.locator("#check-in-candidates-title").first().waitFor({ state: "visible", timeout: 10000 });
      const stateName = `${spec.name} (scanner name search)`;
      const fit = await page.evaluate(dialogFitInPage);
      dialogsOpened += fit.count;
      for (const problem of fit.problems) record("dialog-too-tall", stateName, width, problem);
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", stateName, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", stateName, width, target);
      if ((await page.locator('[role="dialog"] button:has-text("Start camera"):visible').count()) === 0) record("dialog-open-failed", stateName, width, "the camera button is missing after a name search");
      if (takeShots) await page.screenshot({ path: `${prefix}-scanner-name-search.jpg`, type: "jpeg", quality: 60 });
    } catch (error) {
      const seen = await page.locator('[role="dialog"]').first().innerText({ timeout: 1000 }).catch(() => "(no dialog)");
      record("dialog-open-failed", `${spec.name} (scanner name search)`, width, `${(error as Error).message.split("\n")[0] ?? "failed"}; the scanner showed: ${seen.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    if (page.url() !== checkInBefore) await page.goto(checkInBefore, { waitUntil: "load" });
  }

  // Retry failed (#860): the review is open (scope picker, counts, skip reasons, confirm) and fits the screen.
  if (spec.name === "staff-communications-deliveries") {
    const deliveriesBefore = page.url();
    try {
      const open = page.locator('button:has-text("Retry failed"):visible').first();
      await open.scrollIntoViewIfNeeded({ timeout: 5000 });
      await open.click({ timeout: 5000 });
      await page.locator(".retry-failed-counts").first().waitFor({ state: "visible", timeout: 10000 });
      const audit = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      const stateName = `${spec.name} (retry failed review)`;
      if (audit.scrollWidth > audit.innerWidth) record("horizontal-scroll", stateName, width, `page is ${audit.scrollWidth}px wide in a ${audit.innerWidth}px window; sticking out: ${audit.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of audit.smallTargets) record("small-tap-target", stateName, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-retry-failed-review.jpg`, type: "jpeg", quality: 60 });
    } catch (error) {
      record("dialog-open-failed", `${spec.name} (retry failed review)`, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    if (page.url() !== deliveriesBefore) await page.goto(deliveriesBefore, { waitUntil: "load" });
  }

  // A draft announcement with attachments (#824): the edit dialog lists them and fits the screen.
  if (spec.name === "staff-communications-announcement-attachments") {
    const draftBefore = page.url();
    try {
      // Edit draft sits in the card's More menu (#981 batch 3): open that menu first.
      const menu = page.locator('.announcement-card:has(button:has-text("Edit draft")) summary.actions-menu-trigger').first();
      await menu.scrollIntoViewIfNeeded({ timeout: 5000 });
      await menu.click({ timeout: 5000 });
      const edit = page.locator('button:has-text("Edit draft"):visible').first();
      await edit.click({ timeout: 5000 });
      await page.waitForTimeout(250);
      const listed = await page.locator('[role="dialog"] .message-attachments-field li:visible').count();
      if (listed !== 2) record("dialog-open-failed", `${spec.name} (draft attachments)`, width, `the draft's dialog listed ${listed} attachments, expected 2`);
      const fit = await page.evaluate(dialogFitInPage);
      dialogsOpened += fit.count;
      for (const problem of fit.problems) record("dialog-too-tall", `${spec.name} (draft attachments)`, width, problem);
      const open = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });
      if (open.scrollWidth > open.innerWidth) record("horizontal-scroll", `${spec.name} (draft attachments)`, width, `page is ${open.scrollWidth}px wide in a ${open.innerWidth}px window; sticking out: ${open.overflowers.join("; ") || "(nothing identified)"}`);
      for (const target of open.smallTargets) record("small-tap-target", `${spec.name} (draft attachments)`, width, target);
      if (takeShots) await page.screenshot({ path: `${prefix}-draft-attachments.jpg`, type: "jpeg", quality: 60 });
    } catch (error) {
      record("dialog-open-failed", `${spec.name} (draft attachments)`, width, (error as Error).message.split("\n")[0] ?? "failed");
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(100);
    if (page.url() !== draftBefore) await page.goto(draftBefore, { waitUntil: "load" });
  }

  // The floating Honor and Class filter lists, the Orders button descriptions and Back to top (the owner's Oct 13 request).
  await auditOrderDescriptions(page, spec, width, prefix);
  await auditFilterCombobox(page, spec, width, prefix);
  await auditBackToTop(page, spec, width, prefix);

  if (takeShots) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${prefix}.jpg`, type: "jpeg", quality: 60, fullPage: true }).catch(async () => {
      await page.screenshot({ path: `${prefix}.jpg`, type: "jpeg", quality: 60 });
    });
  }
  if (spec.flow === "general-link") await auditGeneralLinkFlow(page, spec, width, prefix);
  if (spec.flow === "pending-teams") await auditPendingTeamsFlow(page, spec, width, prefix);
  pagesVisited.push(`${spec.name}@${width}`);
}


async function main() {
  // Hard guard first: nothing below may load Prisma or the session store
  // until this has passed.
  assertLocalDatabase(process.env, "write synthetic clubs and accounts and mint sessions");
  assertLocalUrl(baseUrl, "MOBILE_LAYOUT_BASE_URL");

  const { PrismaClient: Prisma } = await import("@prisma/client");
  let chromium;
  try {
    // Dynamic import by variable name so tsc and eslint do not need the package.
    const name = "playwright-core";
    ({ chromium } = await import(/* webpackIgnore: true */ name));
  } catch {
    console.error("Missing playwright-core. Run: npm i --no-save playwright-core@1.56.1");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const prisma: PrismaClient = new Prisma();
  noteCleanup = prisma;
  // Declared before the first thing that can fail, so the finally below always
  // revokes the sessions and disconnects.
  const tokens: { staff: string[]; attendee: string[] } = { staff: [], attendee: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  // Cleanup only touches a database that passed the seeded-database check.
  let seeded = false;
  try {
    await assertSeededDatabase(prisma);
    seeded = true;
    await seedSynthetic(prisma);
    pages.push(...pbePages(await seedPbeEvent(prisma)));
    pages.push(...await seedCancellationEvent(prisma));
    pages.push(...staffInvitePages(await seedStaffInviteEvent(prisma)));
    const cookies = await mintSessions(prisma, tokens);
    console.log(`Auditing ${pages.length} pages at ${widths.join(", ")} px; output in ${outDir}`);
    browser = await chromium.launch({
      executablePath: process.env.MOBILE_LAYOUT_BROWSER || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    for (const width of widths) {
      const height = heightFor(width);
      for (const role of ["visitor", "director", "area", "attendee", "event-admin", "system-admin", "kitchen"] as Role[]) {
        const specs = pages.filter((spec) => spec.role === role && (!only || spec.name.includes(only)));
        if (specs.length === 0) continue;
        const context: Context = await browser.newContext({
          viewport: { width, height },
          hasTouch: width <= 768,
          deviceScaleFactor: 1,
          reducedMotion: "reduce",
        });
        // tsx compiles with esbuild's keepNames, which wraps functions in __name();
        // the page has no such helper, so give it a no-op one.
        await context.addInitScript("window.__name = (target) => target;");
        if (role !== "visitor") {
          await context.addCookies([{
            name: cookies[role].name, value: cookies[role].value, url: baseUrl, httpOnly: true, expires: cookies[role].expires,
          }]);
        }
        const page = await context.newPage();
        page.on("pageerror", (error: Error) => pageErrors.push(`${page.url()}: ${error.message.slice(0, 160)}`));
        for (const spec of specs) {
          const prefix = path.join(outDir, `${width}`, spec.name);
          mkdirSync(path.dirname(prefix), { recursive: true });
          console.log(`${spec.name} @${width}`);
          try {
            await auditPage(page, spec, width, prefix);
          } catch (error) {
            record("audit-failed", spec.name, width, (error as Error).message.split("\n")[0]);
          }
        }
        await context.close();
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    const { revokeDatabaseSession } = await import("../modules/access/session-store");
    const { revokeAttendeeSession } = await import("../modules/attendee-accounts/session-store");
    for (const token of tokens.staff) await revokeDatabaseSession(token).catch(() => undefined);
    for (const token of tokens.attendee) await revokeAttendeeSession(token).catch(() => undefined);
    if (launcherModuleCreated) {
      await prisma.eventModule.deleteMany({ where: { eventId, moduleKey: "attendee-community" } }).catch((error: Error) => console.error(`Could not remove the synthetic module row: ${error.message}`));
      await prisma.auditLog.deleteMany({ where: { eventId, action: { startsWith: "EVENT_MODULE_" }, entityId: "attendee-community" } }).catch(() => undefined);
    }
    if (seeded && process.env.MOBILE_LAYOUT_CLEANUP === "1") {
      await cleanupSynthetic(prisma).catch((error: Error) => console.error(`Cleanup failed: ${error.message}`));
    }
    await prisma.$disconnect();
  }

  // Back to top is only exercised on a page long enough to scroll past 1.5 screens, so a width where no page was
  // that long is reported as a note (not a failure: page length depends on the synthetic data), as are comboboxes
  // that could not be scrolled into position for the flip case. A note means that case went untested.
  if (!only) {
    for (const width of widths) {
      if (!backToTopChecked.has(width)) untestedNotes.push(`Back to top was not exercised at ${width}px: no club page was long enough to scroll`);
    }
  }
  for (const note of untestedNotes) console.log(`  NOTE (untested): ${note}`);
  // The honor history dialog's Completion date (#918) is a required part of this audit: at the phone (360) and
  // desktop (1024) widths it must have been opened and measured, or the run fails rather than pass without it.
  if (!only) {
    for (const width of [360, 1024].filter((required) => widths.includes(required))) {
      if (!dateFieldWidths.has(width)) record("date-field-layout", "honor history dialog", width, "no dialog date field was found to check (is the roster Honors button reachable?)");
    }
  }

  writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ widths, pages: pages.map((spec) => spec.name), findings, accepted, pageErrors }, null, 2));
  const byKind = new Map<string, Finding[]>();
  for (const finding of findings) byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
  console.log(`\n${pagesVisited.length} page/width combinations audited, ${dialogsOpened} dialogs opened, ${fieldsChecked} form fields checked for a 3:1 boundary, ${dateFieldsChecked} dialog date fields checked for overlap and height, ${accepted.length} accepted findings, ${pageErrors.length} page script errors (informational).`);
  if (findings.length > 0) {
    console.error(`\n${findings.length} layout finding(s):`);
    for (const [kind, rows] of byKind) {
      console.error(`\n${kind} (${rows.length})`);
      for (const row of rows) console.error(`  - ${row.page} @${row.width}: ${row.detail}`);
    }
    process.exit(1);
  }
  console.log("All mobile layout checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
