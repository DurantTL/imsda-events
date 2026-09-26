import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountSectionNav, type AccountNavItem } from "@/components/account-section-nav";
import { ActAsBanner } from "@/components/act-as-banner";
import { AttendeeAuthReturn } from "@/components/attendee-sign-in-form";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { BrandMark } from "@/components/brand-mark";
import { getCurrentSession } from "@/modules/access/current-session";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
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
  if (!account && !acting) redirect("/account/sign-in");
  // Club roles pass a second step before any account page (staff viewing an account use their own).
  if (account && via === "attendee" && (await accountNeedsSecondStep(account.id, sessionId)) !== "OK") redirect("/account/two-step");
  const [clubs, areaCoordinator] = account
    ? await Promise.all([listDirectedClubs(account.id), isAreaCoordinator(account.id)])
    : [[], false];

  const actingAsAreaCoordinator = acting?.role === "AREA_COORDINATOR";
  const actingAsDirector = acting?.role === "CLUB_DIRECTOR";

  const items: AccountNavItem[] = [
    ...(account ? [{ href: "/account", label: "Overview" }, { href: "/account/registrations", label: "Registrations" }] : []),
    // Area Coordinators see every club (#387), so the tab is just "Clubs".
    ...(areaCoordinator || actingAsAreaCoordinator
      ? [{ href: "/account/clubs", label: "Clubs", matchChildren: true, alsoMatchPrefix: "/account/area/" }]
      : clubs.length > 0 || actingAsDirector
        ? [{ href: "/account/clubs", label: clubs.length === 1 || actingAsDirector ? "My club" : "My clubs", matchChildren: true }]
        : []),
    ...(account ? [{ href: "/account/profile", label: "Profile" }, { href: "/account/security", label: "Security" }] : []),
  ];

  return (
    <main className="public-registration-page public-manage-page account-portal">
      <AttendeeAuthReturn />
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <a className="public-registration-brand public-event-brand-link" href="https://imsda.org/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </a>
          {staffSession.user
            ? <Link className="text-button" href="/overview">Back to staff workspace</Link>
            : <AttendeeSignOutButton />}
        </div>
      </header>
      <ActAsBanner acting={acting} />
      <AccountSectionNav items={items} label="Your account" />
      {children}
    </main>
  );
}
