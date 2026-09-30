import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountAnnouncementBanner } from "@/components/account-announcement-banner";
import { AccountSectionNav, type AccountNavItem } from "@/components/account-section-nav";
import { ActAsBanner } from "@/components/act-as-banner";
import { AttendeeAuthReturn } from "@/components/attendee-sign-in-form";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { BrandMark } from "@/components/brand-mark";
import { getCurrentSession } from "@/modules/access/current-session";
import { otherWorkspaceContextsForAttendee } from "@/modules/access/workspace-contexts";
import { listAccountBannerAnnouncements } from "@/modules/communications/account-banner";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { attendeeSignInRedirectPath, twoStepRedirectPath } from "@/modules/attendee-accounts/return-redirect";
import { accountNeedsSecondStep } from "@/modules/attendee-accounts/sign-in-gate";
import { isAreaCoordinator } from "@/modules/organizations/area-coordinators";
import { listDirectedClubs } from "@/modules/organizations/director-access";
import { currentStaffActingContext } from "@/modules/organizations/staff-act-as";

/**
 * The signed-in attendee area: one header and one row of tabs, with each
 * job (registrations, clubs, profile, sign-in security) on its own page.
 * Every page still checks the session itself; this layout is only chrome,
 * except that it sends club roles to /account/two-step until this session has
 * passed a second step.
 *
 * A staff member "acting as" a club role (#442) reaches this portal with no
 * attendee account at all — the accounts stay separate. Chrome that assumes
 * one (registrations, profile, security, the attendee sign-out button) is
 * left out for them; the banner and "Clubs"/"Area" tabs come from the
 * act-as record instead.
 */
export default async function AccountPortalLayout({ children }: { children: React.ReactNode }) {
  const [{ account, via, sessionId }, staffSession, acting] = await Promise.all([
    getCurrentAttendee(),
    getCurrentSession(),
    currentStaffActingContext(),
  ]);
  if (!account && !acting) redirect(await attendeeSignInRedirectPath());
  // Club roles pass a second step before any account page (staff viewing an account use their own).
  const secondStepPending = Boolean(account && via === "attendee" && (await accountNeedsSecondStep(account.id, sessionId)) !== "OK");
  // While a staff "act as" is active (#442), act-as pages resolve purely from
  // the staff session: an unrelated attendee cookie on this browser that
  // hasn't passed its second step doesn't send them to /account/two-step.
  // Its account chrome is left out instead, and each page that shows the
  // attendee account checks the second step itself.
  if (secondStepPending && !acting) redirect(await twoStepRedirectPath());
  const chromeAccount = secondStepPending ? null : account;
  // The one other workspace this attendee identity may switch into (#108):
  // the staff workspace, only when this browser also carries a live staff
  // session — the same decision `app-shell.tsx` makes in the other direction.
  const [workspaceContext] = otherWorkspaceContextsForAttendee({ hasStaffSession: Boolean(staffSession.user) });
  // Banner announcements are account-session only: a staff "act as" with no
  // attendee account (or a second step still pending) gets none. The banner
  // query starts as soon as the clubs load, alongside the coordinator check.
  const clubsPromise = chromeAccount ? listDirectedClubs(chromeAccount.id) : Promise.resolve([]);
  const [clubs, areaCoordinator, bannerAnnouncements] = chromeAccount
    ? await Promise.all([
      clubsPromise,
      isAreaCoordinator(chromeAccount.id),
      clubsPromise.then((directed) => listAccountBannerAnnouncements(chromeAccount, directed)),
    ])
    : [[], false, []];

  const actingAsAreaCoordinator = acting?.role === "AREA_COORDINATOR";
  const actingAsDirector = acting?.role === "CLUB_DIRECTOR";

  const items: AccountNavItem[] = [
    ...(chromeAccount ? [{ href: "/account", label: "Overview" }, { href: "/account/registrations", label: "Registrations" }] : []),
    // Area Coordinators see every club (#387), so the tab is just "Clubs".
    ...(areaCoordinator || actingAsAreaCoordinator
      ? [{ href: "/account/clubs", label: "Clubs", matchChildren: true, alsoMatchPrefix: "/account/area" }]
      : clubs.length > 0 || actingAsDirector
        ? [{ href: "/account/clubs", label: clubs.length === 1 || actingAsDirector ? "My club" : "My clubs", matchChildren: true }]
        : []),
    // An Area Coordinator sees the clubs waitlisted at the locations they coordinate (#599).
    ...(areaCoordinator ? [{ href: "/account/waitlists", label: "Waitlists" }] : []),
    ...(chromeAccount ? [{ href: "/account/profile", label: "Profile" }] : []),
  ];

  return (
    <main className="public-registration-page public-manage-page account-portal">
      <AttendeeAuthReturn />
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
          {workspaceContext
            ? <Link className="text-button" href={workspaceContext.href}>Back to staff workspace</Link>
            : <AttendeeSignOutButton />}
        </div>
      </header>
      <ActAsBanner acting={acting} />
      <AccountSectionNav items={items} label="Your account" />
      {chromeAccount && <AccountAnnouncementBanner accountId={chromeAccount.id} announcements={bannerAnnouncements} />}
      {children}
    </main>
  );
}
