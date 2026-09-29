import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Printer } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { RevokeClubFormLinkButton, SendClubFormLink } from "@/components/club-forms-actions";
import { clubLeaderViewerFromAccess } from "@/modules/club-forms/access";
import { CLUB_FORM_LINK_DEFAULT_DAYS, isClubFormsRole } from "@/modules/club-forms/domain";
import { listClubFormLinks } from "@/modules/club-forms/links";
import { listRosterChoices, listSubmissionsForViewer } from "@/modules/club-forms/submissions";
import { listEnabledClubFormTemplates } from "@/modules/club-forms/templates";
import { getRosterAccessStateForPage } from "@/modules/club-rosters/access";

export const metadata: Metadata = { title: "Club forms" };
export const dynamic = "force-dynamic";

function formatDate(value: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
}

const emailDeliveryLabel = {
  QUEUED: "Sending",
  SENT: "Sent",
  DELIVERED: "Delivered",
  NOT_DELIVERED: "Not delivered: link withdrawn, send a new one",
  UNKNOWN: "",
} as const;

const linkStateLabel = { OPEN: "Waiting", USED: "Submitted", REVOKED: "Withdrawn", EXPIRED: "Expired" } as const;

/**
 * A club's forms (#610): the forms the conference has turned on, filling one
 * in for a member, sending a single-use private link, and the club's filled
 * forms by form and by member. Only the club's director and deputy see it.
 */
export default async function ClubFormsPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationId: string }>;
  searchParams: Promise<{ member?: string }>;
}) {
  const [{ organizationId }, { member }] = await Promise.all([params, searchParams]);
  const access = await getRosterAccessStateForPage(organizationId);
  if (access.state !== "OPEN") return null;
  const back = <BackLink href={`/account/clubs/${organizationId}`}>Back to {access.club.name}</BackLink>;
  if (!isClubFormsRole(access.club.role)) {
    return (
      <>
        {back}
        <p className="public-manage-empty">Club forms are kept by the club&apos;s director and deputy.</p>
      </>
    );
  }
  const viewer = clubLeaderViewerFromAccess(access);
  const [templates, rosterMembers, submissions, links] = await Promise.all([
    listEnabledClubFormTemplates(),
    listRosterChoices(organizationId),
    listSubmissionsForViewer(viewer, member ? { rosterMemberId: member } : {}),
    listClubFormLinks(viewer, organizationId),
  ]);
  const base = `/account/clubs/${organizationId}/forms`;

  return (
    <>
      {back}
      <section className="public-manage-card club-forms-intro">
        <p className="public-registration-eyebrow">Club forms</p>
        <h2>Forms for your club&apos;s files</h2>
        <p>
          Fill a form in for a member, or email a private link so a parent or staff person can fill it in
          themselves. These files can hold health, conduct and contact details, so only your club&apos;s director
          and deputy and the conference office can open them.
        </p>
      </section>

      {templates.length === 0 ? (
        <p className="public-manage-empty">No forms are available yet. The conference turns each form on when it is needed.</p>
      ) : (
        templates.map((template) => (
          <section className="public-manage-card club-form-template" key={template.key}>
            <div>
              <h3>{template.name}</h3>
              <p className="field-help">{template.description}</p>
            </div>
            <div className="club-form-template-actions">
              <Link className="primary-button" href={`${base}/${template.key}/new`}>
                <FileText aria-hidden="true" size={14} /> Fill in for a member
              </Link>
              <SendClubFormLink
                defaultDays={CLUB_FORM_LINK_DEFAULT_DAYS}
                formName={template.name}
                organizationId={organizationId}
                rosterMembers={rosterMembers}
                templateKey={template.key}
              />
            </div>
          </section>
        ))
      )}

      <section className="public-manage-card">
        <h3>Filled forms</h3>
        {rosterMembers.length > 0 && (
          <form action={base} className="club-form-filter" method="get">
            <label>
              Show forms for
              <select defaultValue={member ?? ""} name="member">
                <option value="">Everyone</option>
                {rosterMembers.map((choice) => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
              </select>
            </label>
            <button className="secondary-button" type="submit">Show</button>
          </form>
        )}
        {submissions.length === 0 ? (
          <p className="quiet-copy">No forms have been filled in yet.</p>
        ) : (
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Filled forms</caption>
              <thead>
                <tr><th scope="col">Form</th><th scope="col">Member or subject</th><th scope="col">Status</th><th scope="col">Date</th><th scope="col"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {submissions.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.templateName}</th>
                    <td translate="no">{row.subjectName || "Not named"}</td>
                    <td>{row.status === "DRAFT" ? "Draft" : "Submitted"}{row.enteredVia === "LINK" ? " · private link" : ""}</td>
                    <td>{formatDate(row.submittedAt ?? row.updatedAt)}</td>
                    <td>
                      <Link className="secondary-button" href={`${base}/submissions/${row.id}`}>
                        {row.status === "DRAFT" ? "Open" : <><Printer aria-hidden="true" size={13} /> View and print</>}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {links.length > 0 && (
        <section className="public-manage-card">
          <h3>Private links you sent</h3>
          <p className="field-help">A link works once. After it is used, the form appears above.</p>
          <div className="report-table-wrap">
            <table className="report-table">
              <caption className="sr-only">Private links</caption>
              <thead>
                <tr><th scope="col">Form</th><th scope="col">Sent to</th><th scope="col">Status</th><th scope="col">Email</th><th scope="col">Expires</th><th scope="col"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {links.map((link) => (
                  <tr key={link.id}>
                    <th scope="row">{link.templateName}</th>
                    <td translate="no">{link.recipientEmail}{link.subjectName ? ` · ${link.subjectName}` : ""}</td>
                    <td>{linkStateLabel[link.state]}</td>
                    <td>{emailDeliveryLabel[link.delivery]}</td>
                    <td>{formatDate(link.expiresAt)}</td>
                    <td>
                      {link.state === "OPEN" && <RevokeClubFormLinkButton linkId={link.id} organizationId={organizationId} />}
                      {link.submissionId && <Link className="text-button" href={`${base}/submissions/${link.submissionId}`}>Open form</Link>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
