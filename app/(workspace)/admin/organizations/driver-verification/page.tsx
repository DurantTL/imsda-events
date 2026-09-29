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
      <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Clubs and churches</p>
          <h2>Driver verification</h2>
          <p>
            A willing driver is cleared automatically from the background-check list: a current check (y) and no
            Non-Driver in the issues column. Only the exceptions are listed here. You can override one person with a
            note, and the override is audited. Nothing here stores a license or insurance number or file.
          </p>
        </div>
      </div>
      <DriverVerificationQueue
        clearEndpointBase="/api/admin/driver-verification"
        listEndpoint="/api/admin/driver-verification"
      />
    </section>
  );
}
