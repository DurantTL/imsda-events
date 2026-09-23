import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { MfaManager } from "@/components/mfa-manager";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { getAttendeeMfaStatus } from "@/modules/attendee-accounts/mfa-service";
import { listDirectedClubs } from "@/modules/organizations/director-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign-in and security",
  robots: { index: false, follow: false, nocache: true },
};

export default async function AttendeeSecurityPage() {
  const { account } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");
  const [mfaStatus, clubs] = await Promise.all([getAttendeeMfaStatus(account.id), listDirectedClubs(account.id)]);

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Your account</p>
          <h1>Sign-in &amp; security</h1>
          <p>Signed in as <strong>{account.verifiedEmail}</strong></p>
        </div>
      </section>
      <div className="account-page-body account-security-grid">
        <MfaManager initialStatus={mfaStatus} endpoint="/api/attendee/mfa" attendee />
        {clubs.length > 0 && (
          <section className="public-manage-security-note">
            <ShieldCheck size={20} aria-hidden="true" />
            <div>
              <strong>Why club directors need this</strong>
              <p>
                Club rosters hold young people&apos;s birth dates. You&apos;ll enter a code from your
                authenticator once per sign-in before your club opens.
              </p>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
