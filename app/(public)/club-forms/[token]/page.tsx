import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { ClubFormFillIn } from "@/components/club-form-fill-in";
import { ClubFormError } from "@/modules/club-forms/errors";
import { resolveClubFormLinkForFill } from "@/modules/club-forms/links";
import { checkClubFormLinkRateLimit } from "@/modules/rate-limit/service";

export const dynamic = "force-dynamic";

// The token is in the path, so nothing about this page may be cached, indexed,
// or leaked through a referrer (next.config.ts sets the matching headers).
export const metadata: Metadata = {
  title: "Fill in a club form",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/**
 * The page a private club form link opens (#610). It shows the club's name
 * and the form, and nothing else about the club. Opening it does not use the
 * link up; only submitting does. Rate limited like the link's API.
 */
export default async function PublicClubFormPage({ params }: { params: Promise<{ token: string }> }) {
  await connection();
  const { token } = await params;
  const requestLike = new Request("http://club-forms.invalid/", { headers: await headers() });
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
  const view = await resolveClubFormLinkForFill(token).catch((error: unknown) => {
    if (error instanceof ClubFormError && error.code === "LINK_UNAVAILABLE") return null;
    throw error;
  });
  if (!view) notFound();
  const { form } = view;

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
            Private form link
          </span>
        </div>
      </header>
      <section className="public-registration-hero public-manage-hero">
        <div>
          <p className="public-registration-eyebrow" translate="no">{view.clubName}</p>
          <h1>{form.definition.title}</h1>
          {form.definition.description && <p>{form.definition.description}</p>}
          <p>This link works once. After you submit, it stops working.</p>
        </div>
      </section>
      <div className="public-manage-layout club-form-public">
        <ClubFormFillIn
          definition={form.definition}
          mode="link"
          sectionNotes={form.sectionNotes}
          sensitiveFieldKeys={form.sensitiveFieldKeys}
          token={token}
        />
      </div>
    </main>
  );
}
