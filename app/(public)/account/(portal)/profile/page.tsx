import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AttendeeProfileForm } from "@/components/attendee-profile-form";
import { getCurrentAttendee } from "@/modules/attendee-accounts/current-attendee";
import { getAttendeeProfile } from "@/modules/attendee-accounts/profile-service";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your profile",
  robots: { index: false, follow: false, nocache: true },
};

export default async function AttendeeProfilePage() {
  const { account, via } = await getCurrentAttendee();
  if (!account) redirect("/account/sign-in");
  const profile = await getAttendeeProfile(account.id);

  return (
    <>
      <section className="public-registration-hero public-manage-hero account-page-hero">
        <div>
          <p className="public-registration-eyebrow">Your account</p>
          <h1>Profile</h1>
          <p>Saved details fill in new registration forms for you.</p>
        </div>
      </section>
      <div className="account-page-body">
        {via === "attendee"
          ? <AttendeeProfileForm initialProfile={profile} />
          : (
            <section className="public-manage-card">
              <p className="public-manage-empty">
                Your profile can be changed only when you sign in with your own attendee account, not from the staff workspace.
              </p>
            </section>
          )}
      </div>
    </>
  );
}
