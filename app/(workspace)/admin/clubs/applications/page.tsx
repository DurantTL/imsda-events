import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { NewClubApplicationsQueue } from "@/components/new-club-applications-queue";
import { getCurrentSession } from "@/modules/access/current-session";
import { listNewClubApplications, listNewClubInvites, listPublicChurchOptions } from "@/modules/club-applications/repository";
import { isAccountEmailConfigured } from "@/modules/communications/account-email";

export const metadata: Metadata = { title: "New club applications" };
export const dynamic = "force-dynamic";

/**
 * The new club application queue (#817) for system administrators, who approve
 * and decline. Area Coordinators read the same list, view only, from their
 * Clubs menu.
 */
export default async function NewClubApplicationsAdminPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const [applications, invites, churches] = await Promise.all([
    listNewClubApplications("SYSTEM_ADMIN"),
    listNewClubInvites("SYSTEM_ADMIN"),
    listPublicChurchOptions(),
  ]);
  return (
    <>
      <div className="intro-actions club-admin-links">
        <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
        <Link className="secondary-button" href="/clubs/register">View the public form</Link>
        <Link className="secondary-button" href="/admin/settings">Notification address</Link>
      </div>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs</p>
          <h2>New club applications</h2>
          <p>
            Directors apply from the public &ldquo;Register a new club&rdquo; page or a private link you send. Approving creates the club under its
            sponsoring church and emails the director the club invite. The Sterling Volunteers status is a flag to review, not a block.
          </p>
        </div>
      </div>
      <NewClubApplicationsQueue
        applications={applications}
        canDecide
        churches={churches}
        emailConfigured={isAccountEmailConfigured()}
        invites={invites}
      />
    </>
  );
}
