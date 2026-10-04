import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { OrganizationBillingContact } from "@/components/organization-billing-contact";
import { getCurrentSession } from "@/modules/access/current-session";
import { getOrganizationBillingContactAdminView } from "@/modules/billing-responsibility/repository";

export const metadata: Metadata = { title: "Billing contact" };

/**
 * Conference staff enter a church's billing contact (#165), usually its treasurer. It is kept
 * with effective dates and history and reused for every event that bills the organization.
 * System administrators only: event finance staff read it, never change it.
 */
export default async function StaffOrganizationBillingContactPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { organizationId } = await params;
  const view = await getOrganizationBillingContactAdminView(organizationId, { id: user.id, globalRole: user.globalRole });
  if (!view) notFound();
  return (
    <section className="page-stack">
      <BackLink href="/admin/organizations" variant="staff">Back to Clubs and churches</BackLink>
      <div className="page-intro">
        <div>
          <p className="eyebrow">Billing</p>
          <h2>Billing contact for {view.organization.name}</h2>
          <p>
            Where invoices for this organization are sent after an event. Entered here by conference staff, never taken from a form
            answer, an email address, the club director, or whoever submitted a registration. Event finance staff can see the current
            contact&apos;s name, role and email, but only you can change it.
          </p>
        </div>
      </div>
      <OrganizationBillingContact active={view.active} history={view.history} organizationId={view.organization.id} />
    </section>
  );
}
