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
 *   MOBILE_LAYOUT_SELF_TEST set to 1 to inject one defect of every kind into each page;
 *                           the run must then FAIL with all of them reported
 *   DATABASE_URL            the local database the app uses (read from .env when not exported)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { PrismaClient } from "@prisma/client";
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
const churchA = `${P}_church_a`;
const churchB = `${P}_church_b`;
const reportMonth = "2026-09";
const touchTarget = 44;
/** Tolerance for sub-pixel rounding only; a 43 px control is a failure. */
const touchTolerance = 0.5;
/**
 * Widths at or under this are phones: the 44px tap-target rule and the
 * tables-become-cards rule apply. Tablets (768 and up) keep the denser desktop
 * sizes, and are still checked for page scroll, dialogs and bars.
 */
const touchMaxWidth = 600;
const cardsMaxWidth = 600;

type Role = "event-admin" | "system-admin" | "director" | "area";

type PageSpec = {
  name: string;
  path: string;
  role: Role;
  /** Why the page is skipped at every width (kept in the report so nobody wonders). */
  note?: string;
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
  // Club portal (a director of two clubs).
  { name: "account-registrations", path: "/account/registrations", role: "director" },
  { name: "account-profile", path: "/account/profile", role: "director" },
  { name: "club-all-clubs", path: "/account/clubs", role: "director" },
  club("home", ""),
  club("roster", "/roster"),
  club("roster-inactive", "/roster?inactive=1"),
  club("registration-events", "/events"),
  club("registration-form", `/events/${clubEventId}`),
  club("class-tracking", "/class-tracking"),
  club("honors", "/honors"),
  club("monthly-records", "/records"),
  club("monthly-report-form", `/records?month=${reportMonth}`),
  club("orders", "/orders"),
  club("club-info", "/club-info"),
  club("forms", "/forms"),
  club("health", "/health"),
  // Area Coordinator.
  area("overview", "/account/area-clubs/overview"),
  area("events", "/account/area-clubs/events"),
  area("points", "/account/area-clubs/points"),
  area("reports", "/account/area-clubs/reports"),
  area("club-home", `/account/area/${clubA}`),
  area("club-report", `/account/area/${clubA}/reports/${reportMonth}`),
  area("club-orders", `/account/area/${clubA}/orders`),
  area("club-honors", `/account/area/${clubA}/honors`),
  area("club-forms", `/account/area/${clubA}/forms`),
  area("club-awards", `/account/area/${clubA}/awards`),
  area("health", "/account/area/health"),
  // Staff, as an event administrator.
  staff("overview", "/overview"),
  staff("people-registrations", "/people"),
  staff("attendee-listing", "/people/attendees"),
  staff("duplicates", "/people/duplicates"),
  staff("finance", "/finance"),
  staff("finance-invoices", "/finance/invoices"),
  staff("finance-church-owed", "/finance/church-owed"),
  staff("finance-square-payments", "/finance/square-payments"),
  staff("lodging", "/more/lodging"),
  staff("lodging-requests", "/more/lodging/requests"),
  staff("lodging-assignments", "/more/lodging/assignments"),
  staff("kitchen-report", "/more/kitchen-report"),
  staff("more-menu", "/more"),
  staff("reports", "/more/reports"),
  staff("reports-clubs", "/more/reports/clubs"),
  staff("clubs-oversight", "/more/clubs"),
  staff("clubs-oversight-club", `/more/clubs/${clubA}`),
  staff("clubs-oversight-reports", "/more/clubs/reports"),
  staff("honors", "/more/honors"),
  staff("promo-codes", "/more/promo-codes"),
  staff("tags", "/more/tags"),
  staff("event-settings", "/more/event-settings"),
  staff("check-in", "/check-in"),
  staff("communications", "/communications"),
  staff("registration-builder", "/registration-builder"),
  // Staff, as a system administrator.
  staff("system-home", "/admin", "system-admin"),
  staff("calendar-admin", "/admin/calendar", "system-admin"),
  staff("churches-clubs", "/admin/organizations", "system-admin"),
  staff("churches-clubs-directory", "/admin/organizations/directory", "system-admin"),
  staff("club-invites", "/admin/clubs/invites", "system-admin"),
  staff("club-reports-summary", "/admin/clubs/summary", "system-admin"),
  staff("club-reports", "/admin/clubs/reports", "system-admin"),
  staff("club-transfers", "/admin/clubs/transfers", "system-admin"),
  staff("background-checks", "/admin/organizations/background-checks", "system-admin"),
  staff("club-as-director", `/admin/organizations/${clubA}/club`, "system-admin"),
  staff("team", "/admin/team", "system-admin"),
  staff("accounts", "/admin/accounts", "system-admin"),
  staff("system-settings", "/admin/settings", "system-admin"),
  staff("club-supplies", "/admin/club-supplies", "system-admin"),
  staff("club-forms", "/admin/club-forms", "system-admin"),
];

/**
 * Buttons that open a dialog or sheet without `aria-haspopup`. Each is tried on every
 * page (the first visible match); opening is harmless, and Escape closes it unsubmitted.
 */
const dialogOpeners = [
  "[data-monthly-report-open]",
  "[data-meeting-note-add]",
  'button:has-text("Add to roster")',
  'button:has-text("Upload CSV")',
  'button:has-text("Add club admin")',
  'button:has-text("New announcement")',
  'button[aria-label^="Add or view honors"]',
  'button[aria-label^="Edit "]',
  "button.record-card",
  ".finance-record",
];

/**
 * Findings someone has looked at and accepted. Key: `<kind>|<page name>|<selector or text>`
 * with `*` allowed as a suffix. Each needs a reason. Empty on purpose: fix, do not accept.
 */
const acceptedFindings: Array<{ match: string; reason: string }> = [];

type Finding = { kind: string; page: string; width: number; detail: string };
const findings: Finding[] = [];
const accepted: Finding[] = [];
const pagesVisited: string[] = [];
let dialogsOpened = 0;
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

/** MOBILE_LAYOUT_CLEANUP=1: deletes every row the audit created, children before parents. */
async function cleanupSynthetic(prisma: PrismaClient) {
  const orgs = { organizationId: { in: [clubA, clubB] } };
  const accountIds = [`${P}_account_director`, `${P}_account_area`];
  await prisma.$transaction([
    prisma.attendeeSession.deleteMany({ where: { accountId: { in: accountIds } } }),
    prisma.clubInvite.deleteMany({ where: { OR: [orgs, { id: { startsWith: `${P}_` } }] } }),
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
    prisma.event.deleteMany({ where: { id: clubEventId } }),
    prisma.organization.deleteMany({ where: { id: { in: [clubA, clubB] } } }),
    prisma.organization.deleteMany({ where: { id: { in: [churchA, churchB] } } }),
  ]);
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
    }
  }

  // A filed monthly report and an invite for the staff lists.
  await prisma.clubMonthlyReport.upsert({
    where: { organizationId_reportMonth: { organizationId: clubA, reportMonth } },
    update: {},
    create: {
      organizationId: clubA, clubYear, reportMonth, meetingPlace: "Fellowship hall", meetingSchedule: "Saturdays",
      averageAttendance: 12, pathfinderCount: 12, tltCount: 1, staffCount: 3, points: {}, honors: [],
      onTimePoints: 10, totalPoints: 81, signatureName: "Dana Mobilecheck-Directorsson", signedOn: "2026-10-01",
      status: "SUBMITTED", submittedAt: new Date("2026-10-01T15:00:00Z"), firstSubmittedAt: new Date("2026-10-01T15:00:00Z"),
    },
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
}

/** Sessions are minted directly (the second factor is skipped, as in verify-badge-print). */
async function mintSessions(prisma: PrismaClient, tokens: { staff: string[]; attendee: string[] }) {
  const staffSession = await import("../modules/access/session-store");
  const attendeeSession = await import("../modules/attendee-accounts/session-store");
  const cookie = async (role: Role) => {
    if (role === "director" || role === "area") {
      const accountId = role === "director" ? `${P}_account_director` : `${P}_account_area`;
      const session = await attendeeSession.createAttendeeSession(accountId, null, { secondFactorVerifiedAt: new Date() });
      tokens.attendee.push(session.token);
      return { name: attendeeSession.ATTENDEE_SESSION_COOKIE_NAME, value: session.token, expires: Math.floor(session.expiresAt.getTime() / 1000) };
    }
    const email = role === "system-admin" ? "system@imsda-events.test" : "admin@imsda-events.test";
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error(`The seeded account ${email} is missing. Run \`npm run db:seed\` first.`);
    const session = await staffSession.createDatabaseSession(user.id, null);
    tokens.staff.push(session.token);
    return { name: staffSession.SESSION_COOKIE_NAME, value: session.token, expires: Math.floor(session.expiresAt.getTime() / 1000) };
  };
  const cookies: Record<Role, { name: string; value: string; expires: number }> = {
    "event-admin": await cookie("event-admin"),
    "system-admin": await cookie("system-admin"),
    director: await cookie("director"),
    area: await cookie("area"),
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
    barCount: bars.length,
  };
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

/** Self-test only: one defect of every kind the audit reports. Runs in the page. */
function injectDefects() {
  const box = document.createElement("div");
  box.innerHTML = [
    '<div style="width:2000px;height:4px;background:red"></div>',
    '<button type="button" style="width:20px;height:20px">x</button>',
    '<div style="max-width:100%;overflow-x:auto"><table><tbody><tr><td><div style="width:1500px">wide cell</div></td></tr></tbody></table></div>',
    '<div style="position:fixed;left:0;right:0;bottom:0;height:90px;background:#ccc;z-index:30">self-test bar</div>',
    '<p style="margin:0 0 0 0">self-test last line</p>',
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
  if (status === 404) {
    record("not-found", spec.name, width, `${url} answered 404 (the page or its synthetic data is missing)`);
    return;
  }
  const sentToSignIn = /\/(login|account\/sign-in|account\/two-step|no-access)/.test(finalPath);
  if (sentToSignIn) {
    record("signed-out", spec.name, width, `${url} sent the synthetic user to ${finalPath}`);
    return;
  }
  if (finalPath !== spec.path.split("?")[0]) {
    console.log(`  note  ${label}: redirected to ${finalPath}`);
  }
  // Let late client effects (fonts, hydration) settle before measuring.
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.waitForTimeout(150);

  if (selfTest) await page.evaluate(injectDefects);
  const touch = width <= touchMaxWidth;
  const result = await page.evaluate(auditInPage, { touch, cards: width <= cardsMaxWidth, minTarget: touchTarget, tolerance: touchTolerance });

  if (result.scrollWidth > result.innerWidth) {
    record("horizontal-scroll", spec.name, width, `page is ${result.scrollWidth}px wide in a ${result.innerWidth}px window; sticking out: ${result.overflowers.join("; ") || "(nothing identified)"}`);
  }
  for (const table of result.scrollingTables) record("table-scrolls-sideways", spec.name, width, table);
  for (const target of result.smallTargets) record("small-tap-target", spec.name, width, target);
  for (const note of result.barNotes) record("sticky-bar-size", spec.name, width, note);

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

  if (takeShots) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${prefix}.jpg`, type: "jpeg", quality: 60, fullPage: true }).catch(async () => {
      await page.screenshot({ path: `${prefix}.jpg`, type: "jpeg", quality: 60 });
    });
  }
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
  // Declared before the first thing that can fail, so the finally below always
  // revokes the sessions and disconnects.
  const tokens: { staff: string[]; attendee: string[] } = { staff: [], attendee: [] };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  try {
    await assertSeededDatabase(prisma);
    await seedSynthetic(prisma);
    const cookies = await mintSessions(prisma, tokens);
    console.log(`Auditing ${pages.length} pages at ${widths.join(", ")} px; output in ${outDir}`);
    browser = await chromium.launch({
      executablePath: process.env.MOBILE_LAYOUT_BROWSER || undefined,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    for (const width of widths) {
      const height = heightFor(width);
      for (const role of ["director", "area", "event-admin", "system-admin"] as Role[]) {
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
        await context.addCookies([{
          name: cookies[role].name, value: cookies[role].value, url: baseUrl, httpOnly: true, expires: cookies[role].expires,
        }]);
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
    if (process.env.MOBILE_LAYOUT_CLEANUP === "1") {
      await cleanupSynthetic(prisma).catch((error: Error) => console.error(`Cleanup failed: ${error.message}`));
    }
    await prisma.$disconnect();
  }

  writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ widths, pages: pages.map((spec) => spec.name), findings, accepted, pageErrors }, null, 2));
  const byKind = new Map<string, Finding[]>();
  for (const finding of findings) byKind.set(finding.kind, [...(byKind.get(finding.kind) ?? []), finding]);
  console.log(`\n${pagesVisited.length} page/width combinations audited, ${dialogsOpened} dialogs opened, ${accepted.length} accepted findings, ${pageErrors.length} page script errors (informational).`);
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
