import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { ClubRosterWorkspace } from "@/components/club-roster-workspace";
import { RosterUnlockForm } from "@/components/roster-unlock-form";
import { getRosterAccessState } from "@/modules/club-rosters/access";
import { clubYearFor } from "@/modules/club-rosters/domain";
import { listRoster } from "@/modules/club-rosters/repository";
import { clubDirectorRoleLabels } from "@/modules/organizations/director-grants-domain";

export const metadata: Metadata = { title: "Club roster" };

function Gate({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="public-manage-card">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Protected roster</p>
        <h2>{title}</h2>
      </div>
      <div className="public-manage-security-note">
        <ShieldCheck size={20} aria-hidden="true" />
        <div>{children}</div>
      </div>
    </section>
  );
}

export default async function ClubRosterPage({ params }: { params: Promise<{ organizationId: string }> }) {
  const { organizationId } = await params;
  const access = await getRosterAccessState(organizationId);
  if (access.state === "SIGN_IN") redirect("/account/sign-in");
  if (access.state === "NOT_FOUND") notFound();

  const clubYear = clubYearFor(new Date());
  const members = access.state === "OPEN" ? await listRoster(organizationId, clubYear) : [];

  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/account">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
          <Link className="text-button" href="/account">Back to my account</Link>
        </div>
      </header>

      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow">
            {clubDirectorRoleLabels[access.club.role]} · Club year {clubYear}
          </p>
          <h1 translate="no">{access.club.name}</h1>
          {access.club.sponsoringChurch && <p translate="no">{access.club.sponsoringChurch}</p>}
        </div>
      </section>

      <div className="club-roster-layout">
        {access.state === "OWN_SESSION_REQUIRED" && (
          <Gate title="Sign in with your own account">
            <p>Club rosters open only in your own attendee sign-in, not from the staff workspace.</p>
          </Gate>
        )}
        {access.state === "MFA_SETUP" && (
          <Gate title="Set up an authenticator first">
            <p>
              Rosters hold birth dates for young people, so they need two-step sign-in.{" "}
              <Link href="/account">Set up an authenticator on your account</Link>, then come back.
            </p>
          </Gate>
        )}
        {access.state === "MFA_UNLOCK" && (
          <Gate title="Enter your authenticator code">
            <p>Enter the six-digit code from your authenticator app to open the roster for this session.</p>
            <RosterUnlockForm />
          </Gate>
        )}
        {access.state === "OPEN" && (
          <ClubRosterWorkspace clubYear={clubYear} initialMembers={members} organizationId={organizationId} />
        )}
      </div>
    </main>
  );
}
