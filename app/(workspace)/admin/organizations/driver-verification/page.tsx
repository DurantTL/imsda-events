import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { DriverVerificationQueue } from "@/components/driver-verification-queue";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "Driver verification" };
export const dynamic = "force-dynamic";

/**
 * The conference-wide driver verification queue (Q1, #491): every club's
 * willing drivers, for a system administrator to review.
 */
export default async function DriverVerificationPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <section className="page-stack">
      <BackLink href="/admin/organizations" variant="staff">Back to churches and clubs</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Churches and clubs</p>
          <h2>Driver verification</h2>
          <p>
            Background checks already cover driver clearance status (y, n, or expiring soon, with an issue note for
            limits like &quot;can&apos;t drive&quot;). This is the extra step: confirming a willing driver&apos;s
            license and insurance were checked, and recording whether they&apos;re cleared to transport youth.
            Nothing here stores a license or insurance number or file.
          </p>
        </div>
      </div>
      <DriverVerificationQueue
        clearEndpointBase="/api/admin/driver-verification"
        listEndpoint="/api/admin/driver-verification"
        showClub
      />
    </section>
  );
}
