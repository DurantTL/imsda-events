import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/back-link";
import { ClubFormFillIn } from "@/components/club-form-fill-in";
import { clubLeaderViewerFromAccess } from "@/modules/club-forms/access";
import { fillDefinition, isClubFormsRole } from "@/modules/club-forms/domain";
import { ClubFormError } from "@/modules/club-forms/errors";
import { listRosterChoices } from "@/modules/club-forms/submissions";
import { getEnabledClubFormTemplate, withLiveDirectory } from "@/modules/club-forms/templates";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Fill in a club form" };
export const dynamic = "force-dynamic";

/** Fill a form in for a roster member, or for no one (#610). A disabled or unknown form is "not found". */
export default async function NewClubFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string; templateKey: string }>;
  searchParams: Promise<{ member?: string }>;
}) {
  const [{ organizationId, templateKey }, { member }] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  if (!isClubFormsRole(access.club.role)) notFound();
  clubLeaderViewerFromAccess(access);
  const template = await getEnabledClubFormTemplate(templateKey).catch((error: unknown) => {
    if (error instanceof ClubFormError) return null;
    throw error;
  });
  if (!template) notFound();
  const [definition, rosterMembers] = await Promise.all([withLiveDirectory(fillDefinition(template)), listRosterChoices(organizationId)]);
  const base = `/account/clubs/${organizationId}/forms`;

  return (
    <>
      <BackLink href={base}>Back to club forms</BackLink>
      <section className="public-manage-card">
        <p className="public-registration-eyebrow">{access.club.name}</p>
        <h2>{definition.title}</h2>
        {definition.description && <p>{definition.description}</p>}
      </section>
      <ClubFormFillIn
        definition={definition}
        doneHref={base}
        initialRosterMemberId={rosterMembers.some((choice) => choice.id === member) ? member : null}
        mode="club"
        organizationId={organizationId}
        rosterMembers={rosterMembers}
        sectionNotes={template.sectionNotes}
        sensitiveFieldKeys={template.sensitiveFieldKeys}
        templateKey={template.key}
      />
    </>
  );
}
