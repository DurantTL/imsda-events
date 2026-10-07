import type { Metadata } from "next";
import { headers } from "next/headers";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { NewClubApplicationPage } from "@/components/new-club-application-page";
import { resolveNewClubInvite } from "@/modules/club-applications/repository";
import { checkNewClubApplicationLinkRateLimit } from "@/modules/rate-limit/service";

export const dynamic = "force-dynamic";

// The token is in the path, so nothing about this page may be cached, indexed, or leaked through a referrer.
export const metadata: Metadata = {
  title: "Register a new club",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * A private link a system administrator sent (#817): the same application,
 * with the invited email filled in. Opening it does not use it up; submitting
 * does. Every unusable link (unknown, used, withdrawn, expired) gets the same 404.
 */
export default async function InvitedNewClubPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const requestLike = new Request("http://club-applications.invalid/", { headers: await headers() });
  const rateLimit = await checkNewClubApplicationLinkRateLimit(requestLike, token);
  if (!rateLimit.allowed) {
    return (
      <main className="public-registration-page public-manage-page">
        <section className="public-registration-not-found">
          <p className="public-registration-eyebrow">Please wait</p>
          <h1>Too many attempts</h1>
          <p>Try this link again in a few minutes.</p>
        </section>
      </main>
    );
  }
  const invite = await resolveNewClubInvite(token);
  if (!invite) notFound();
  return <NewClubApplicationPage invite={{ token, email: invite.email, name: invite.name }} />;
}
