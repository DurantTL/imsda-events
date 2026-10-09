import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { InstructorRoster } from "@/components/instructor-roster";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { HonorInstructorError, getInstructorRoster } from "@/modules/honors/instructor-repository";

export const metadata: Metadata = { title: "Class roster", robots: { index: false, follow: false, nocache: true } };
export const dynamic = "force-dynamic";

/**
 * One class roster for the instructor it was assigned to (#833): name and club
 * only. A class that isn't theirs is a 404 exactly like one that doesn't exist.
 * Without a current Sterling Volunteers check the page shows the reason and no
 * names.
 */
export default async function InstructorRosterPage({ params }: { params: Promise<{ offeringId: string }> }) {
  const { account, via } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");
  if (via !== "attendee") redirect("/account");
  const { offeringId } = await params;
  let view;
  try {
    view = await getInstructorRoster(account.id, offeringId);
  } catch (error) {
    if (error instanceof HonorInstructorError && error.code === "NOT_ASSIGNED") notFound();
    throw error;
  }

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">{view.header.eventName} · {view.header.session}</p>
          <h1 translate="no">{view.header.honorName}</h1>
          {view.header.room && <p>Room {view.header.room}</p>}
        </div>
      </section>
      <div className="account-page-body">
        <p><Link href="/account/instructor">Back to your classes</Link></p>
        {view.status === "STERLING_REQUIRED" ? (
          <section className="public-manage-card">
            <p className="public-manage-empty"><ShieldAlert size={17} aria-hidden="true" /> {view.message}</p>
          </section>
        ) : (
          <InstructorRoster
            editable={view.header.editable}
            editDeadline={view.header.editDeadline}
            initialRows={view.rows}
            offeringId={view.header.offeringId}
          />
        )}
      </div>
    </>
  );
}
