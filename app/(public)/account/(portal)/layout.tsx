import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountSectionNav, type AccountNavItem } from "@/components/account-section-nav";
import { AttendeeAuthReturn } from "@/components/attendee-sign-in-form";
import { AttendeeSignOutButton } from "@/components/attendee-sign-out-button";
import { BrandMark } from "@/components/brand-mark";
import { getCurrentSession } from "@/modules/access/current-session";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { accountNeedsSecondStep } from "@/modules/attendee-accounts/sign-in-gate";
import { listDirectedClubs } from "@/modules/organizations/director-access";

/**
 * The signed-in attendee area: one header and one row of tabs, with each
 * job (registrations, clubs, profile, sign-in security) on its own page.
 * Every page still checks the session itself; this layout is only chrome,
 * except that it sends club roles to /account/two-step until this session has
 * passed a second step.
 */
export default async function AccountPortalLayout({ children }: { children: React.ReactNode }) {
  const [{ account, via, sessionId }, staffSession] = await Promise.all([getCurrentAttendee(), getCurrentSession()]);
  if (!account) redirect("/account/sign-in");
  // Club roles pass a second step before any account page (staff viewing an account use their own).
  if (via === "attendee" && (await accountNeedsSecondStep(account.id, sessionId)) !== "OK") redirect("/account/two-step");
  const clubs = await listDirectedClubs(account.id);

  const items: AccountNavItem[] = [
    { href: "/account", label: "Overview" },
    { href: "/account/registrations", label: "Registrations" },
    ...(clubs.length > 0 ? [{ href: "/account/clubs", label: clubs.length === 1 ? "My club" : "My clubs", matchChildren: true }] : []),
    { href: "/account/profile", label: "Profile" },
    { href: "/account/security", label: "Security" },
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
      <AccountSectionNav items={items} label="Your account" />
      {children}
    </main>
  );
}
