import { staffLoginRedirectPath } from "@/modules/access/login-redirect";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BuilderPhoneNotice } from "@/components/builder-phone-notice";
import { ClubFormBuilder } from "@/components/club-form-builder";
import { getCurrentSession } from "@/modules/access/current-session";
import { getClubFormBuilderView } from "@/modules/club-forms/builder";
import { ClubFormError } from "@/modules/club-forms/errors";

export const metadata: Metadata = { title: "Club form builder" };
export const dynamic = "force-dynamic";

/**
 * The club form builder (#712). System administrators only, checked here and
 * again on every route the builder calls. It shows the form's definition and
 * never a submission or an answer.
 */
export default async function ClubFormBuilderPage({ params }: { params: Promise<{ templateKey: string }> }) {
  const { user } = await getCurrentSession();
  if (!user) redirect(await staffLoginRedirectPath());
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");
  const { templateKey } = await params;
  const view = await getClubFormBuilderView(templateKey).catch((error: unknown) => {
    if (error instanceof ClubFormError && error.code === "TEMPLATE_NOT_FOUND") return null;
    throw error;
  });
  if (!view) notFound();

  return (
    <section className="page-stack">
      <Link className="secondary-button more-back-link" href="/admin/club-forms">Back to club forms</Link>
      <div className="page-intro">
        <div>
          <p className="eyebrow">System administration</p>
          <h2>{view.published.name}</h2>
          <p>
            Changes are saved as a draft. Publishing creates a new version for new fills. Forms already filled in keep the
            version they were filled in on. A field that was ever sensitive or a birth date keeps that setting for good; hide it
            from new forms instead of deleting it.
          </p>
        </div>
      </div>
      <BuilderPhoneNotice backHref="/admin/club-forms" backLabel="Back to club forms" builderName="club form builder" />
      <div className="builder-phone-hidden">
        {view.needsSync ? (
          <div className="inline-notice error" role="alert">
            This form is behind the code and needs a sync first. An operator must run <code>npm run club-forms:sync</code>, then reload this page.
          </div>
        ) : (
          <ClubFormBuilder
            draftUpdatedAt={view.draftUpdatedAt}
            enabled={view.enabled}
            hasDraft={view.draft !== null}
            initial={view.draft ?? view.published}
            key={`${view.key}-${view.version}-${view.draftUpdatedAt ?? "published"}`}
            lockedBirthDateKeys={view.lockedBirthDateKeys}
            lockedSensitiveKeys={view.lockedSensitiveKeys}
            publishedKeys={view.published.definition.sections.flatMap((section) => section.fields.map((field) => field.key))}
            submissionCount={view.submissionCount}
            templateKey={view.key}
            version={view.version}
            versions={view.versions}
          />
        )}
      </div>
    </section>
  );
}
