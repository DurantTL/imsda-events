import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { HealthRecordForm } from "@/components/health-record-form";
import { HealthRecordError } from "@/modules/health-records/errors";
import { healthRecordsEnabled } from "@/modules/health-records/flag";
import { resolveHealthLinkForFill } from "@/modules/health-records/repository";
import { checkClubFormLinkRateLimit } from "@/modules/rate-limit/service";

export const dynamic = "force-dynamic";

// The token is in the path, so nothing about this page may be cached, indexed,
// or leaked through a referrer (next.config.ts sets the matching headers).
export const metadata: Metadata = {
  title: "Health record",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * The page a Health Record private link opens (#611). Switched off, it is a
 * 404. It shows the club, the child's first name and an empty form, never a
 * stored value. Opening it does not use the link up; submitting does.
 */
export default async function PublicHealthRecordPage({ params }: { params: Promise<{ token: string }> }) {
  if (!healthRecordsEnabled()) notFound();
  await connection();
  const { token } = await params;
  const requestLike = new Request("http://health-records.invalid/", { headers: await headers() });
  const rateLimit = await checkClubFormLinkRateLimit(requestLike, token, "read");
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
  const view = await resolveHealthLinkForFill(token).catch((error: unknown) => {
    if (error instanceof HealthRecordError && (error.code === "LINK_UNAVAILABLE" || error.code === "NOT_FOUND")) return null;
    throw error;
  });
  if (!view) notFound();

  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
          <span className="public-registration-secure">
            <LockKeyhole size={15} aria-hidden="true" />
            Private health record link
          </span>
        </div>
      </header>
      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow" translate="no">{view.clubName}</p>
          <h1>Pathfinder Health Record</h1>
          <p>This link works once. After you submit, it stops working. What you enter is stored encrypted and is seen only by the club&apos;s director and deputy.</p>
        </div>
      </section>
      <div className="public-manage-layout club-form-public">
        <HealthRecordForm
          clubName={view.clubName}
          consentText={view.consentText}
          initialValues={{}}
          memberName={view.memberFirstName}
          mode={{ kind: "link", token }}
        />
      </div>
    </main>
  );
}
