import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, GraduationCap } from "lucide-react";
import { InstructorInviteAccept } from "@/components/instructor-invite-accept";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { requireAttendeeSecondStep } from "@/modules/attendee-accounts/portal-second-step";
import { STERLING_REQUIRED_MESSAGE } from "@/modules/honors/instructor-domain";
import { listInstructorClasses, listInstructorInvitesForAccount } from "@/modules/honors/instructor-repository";

export const metadata: Metadata = { title: "Your classes", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * An Honors Weekend instructor's own classes (#833). Class names only here; a
 * roster opens from its own page, and only for a class the account was
 * assigned. Only the person themselves, never a staff member switched into the
 * account.
 */
export default async function InstructorClassesPage() {
  await requireAttendeeSecondStep();
  const { account, via } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");
  if (via !== "attendee") redirect("/account");
  const [invites, { classes, sterlingCurrent }] = await Promise.all([
    listInstructorInvitesForAccount(account.verifiedEmail),
    listInstructorClasses(account.id),
  ]);

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Honors Weekend</p>
          <h1>Your classes</h1>
        </div>
      </section>
      <div className="account-page-body">
        {invites.length > 0 && <InstructorInviteAccept invites={invites} />}
        <section className="public-manage-card">
          {classes.length === 0 ? (
            <p className="public-manage-empty"><GraduationCap size={17} aria-hidden="true" /> You aren&apos;t teaching any classes yet. Conference staff invite instructors by email.</p>
          ) : (
            <>
              {sterlingCurrent === false && <div className="inline-notice error" role="status">{STERLING_REQUIRED_MESSAGE}</div>}
              <ul className="public-manage-club-list">
                {classes.map((item) => (
                  <li key={item.offeringId}>
                    <Link href={`/account/instructor/${encodeURIComponent(item.offeringId)}`}>
                      <span>
                        <strong translate="no">{item.honorName}</strong>
                        <small>{[item.eventName, item.session, item.room && `Room ${item.room}`].filter(Boolean).join(" · ")}{item.editable ? "" : " · roster closed"}</small>
                      </span>
                      <ArrowRight size={15} aria-hidden="true" />
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}
