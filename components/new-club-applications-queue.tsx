"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Paperclip, Send } from "lucide-react";
import {
  DECLINE_REASON_MAX,
  directorBackgroundLabels,
  newClubApplicationStatusLabels,
  newClubTypeLabels,
  type DirectorBackgroundState,
} from "@/modules/club-applications/domain";
import type { NewClubApplicationRecord, NewClubInviteRecord } from "@/modules/club-applications/repository";

const sterlingTone: Record<DirectorBackgroundState, string> = { CLEAR: "green", FLAGGED: "gold", NOT_COMPLIANT: "coral", NO_RECORD: "neutral" };
const statusTone = { PENDING: "gold", APPROVED: "green", DECLINED: "coral" } as const;
const inviteStateLabels = { OPEN: "Not used yet", USED: "Used", CANCELLED: "Withdrawn", EXPIRED: "Expired" } as const;

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-US", { dateStyle: "medium" });
}

function formatSize(bytes: number) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type Props = {
  applications: NewClubApplicationRecord[];
  /** System administrators decide and send links; Area Coordinators only read. */
  canDecide: boolean;
  churches: Array<{ id: string; name: string }>;
  invites?: NewClubInviteRecord[];
  emailConfigured?: boolean;
};

/**
 * The new club application queue (#817). One list for both audiences: a system
 * administrator sees Approve and Decline and the invite-link panel; an Area
 * Coordinator sees the same applications, view only. The server checks again on
 * every action.
 */
export function NewClubApplicationsQueue({ applications, canDecide, churches, invites = [], emailConfigured = true }: Props) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mode, setMode] = useState<{ id: string; kind: "approve" | "decline" } | null>(null);
  const [reason, setReason] = useState("");
  const [churchChoice, setChurchChoice] = useState("");
  const [message, setMessage] = useState<{ id: string; text: string; tone: "error" | "success" } | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<{ text: string; tone: "error" | "success" } | null>(null);

  async function decide(application: NewClubApplicationRecord, body: object) {
    setBusyId(application.id);
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/club-applications/${encodeURIComponent(application.id)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The decision could not be saved.");
      setMode(null);
      setReason("");
      setChurchChoice("");
      router.refresh();
    } catch (caught) {
      setMessage({ id: application.id, text: caught instanceof Error ? caught.message : "The decision could not be saved.", tone: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function sendInvite(event: React.FormEvent) {
    event.preventDefault();
    setInviteBusy(true);
    setInviteMessage(null);
    try {
      const response = await fetch("/api/admin/club-applications/invites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, name: inviteName }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The link could not be sent.");
      setInviteMessage({ text: `A private link was emailed to ${inviteEmail.trim().toLowerCase()}.`, tone: "success" });
      setInviteEmail("");
      setInviteName("");
      router.refresh();
    } catch (caught) {
      setInviteMessage({ text: caught instanceof Error ? caught.message : "The link could not be sent.", tone: "error" });
    } finally {
      setInviteBusy(false);
    }
  }

  async function withdrawInvite(invite: NewClubInviteRecord) {
    if (!window.confirm(`Withdraw the link sent to ${invite.email}?`)) return;
    setInviteBusy(true);
    setInviteMessage(null);
    try {
      const response = await fetch(`/api/admin/club-applications/invites/${encodeURIComponent(invite.id)}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The link could not be withdrawn.");
      router.refresh();
    } catch (caught) {
      setInviteMessage({ text: caught instanceof Error ? caught.message : "The link could not be withdrawn.", tone: "error" });
    } finally {
      setInviteBusy(false);
    }
  }

  const waiting = applications.filter((application) => application.status === "PENDING");
  const decided = applications.filter((application) => application.status !== "PENDING");

  function renderApplication(application: NewClubApplicationRecord) {
    const busy = busyId === application.id;
    const open = mode?.id === application.id ? mode.kind : null;
    return (
      <article className="nca-card" data-application={application.id} key={application.id}>
        <header className="nca-head">
          <div>
            <h3 translate="no">{application.clubName}</h3>
            <p>
              {newClubTypeLabels[application.clubType]} · sponsored by{" "}
              {application.church.unavailable && !application.church.name
                ? <em>the church is no longer in the directory</em>
                : <span translate="no">{application.church.name}</span>}
              {application.church.isOther && " (typed by the applicant, not in the directory)"}
              {application.church.unavailable && application.church.name && " (no longer an active church in the directory)"}
            </p>
          </div>
          <span className={`status-chip ${statusTone[application.status]}`}>{newClubApplicationStatusLabels[application.status]}</span>
        </header>

        <div className="nca-flags">
          <span className={`status-chip ${sterlingTone[application.sterling]}`} title="Sterling Volunteers status of the applying director. A flag to review, not a block.">
            Sterling Volunteers: {directorBackgroundLabels[application.sterling]}
          </span>
          {application.sterlingAmbiguous && (
            <span className="status-chip gold" title="The director's email matches more than one person; the least favorable status is shown.">Email matches more than one person</span>
          )}
          {application.sterlingNameMismatch && (
            <span className="status-chip gold" title="A person was found by the director's email, but with a different name. Check before relying on the status.">Matched by email to a different name</span>
          )}
          {application.source === "INVITE" && (
            <span className="status-chip purple">
              {application.invitedEmail ? <>Came by private link sent to <span translate="no">{application.invitedEmail}</span></> : "Came from a private link"}
            </span>
          )}
          {application.invitedEmailDiffers && <span className="status-chip gold">Director email differs from the invited address</span>}
        </div>
        {application.duplicates.length > 0 && (
          <ul className="nca-duplicates" aria-label="Possible duplicates">
            {application.duplicates.map((flag) => <li key={flag.kind}>Possible duplicate: {flag.message}</li>)}
          </ul>
        )}

        <dl className="nca-details">
          <div><dt>Director</dt><dd translate="no">{application.director.name}</dd></div>
          <div><dt>Email</dt><dd translate="no">{application.director.email}</dd></div>
          <div><dt>Mailing address</dt><dd translate="no">{application.director.address}</dd></div>
          <div><dt>Home phone</dt><dd translate="no">{application.director.homePhone ?? "Not given"}</dd></div>
          <div><dt>Work phone</dt><dd translate="no">{application.director.workPhone ?? "Not given"}</dd></div>
          <div><dt>Pastor</dt><dd translate="no">{application.pastorName}</dd></div>
          <div>
            <dt>Typed signatures</dt>
            <dd translate="no">
              Pastor {application.signatures.pastor}; Head elder {application.signatures.headElder}; Clerk {application.signatures.clerk}; Director {application.signatures.director}
            </dd>
          </div>
          {application.otherBoardMembers.length > 0 && (
            <div><dt>Other church board members</dt><dd translate="no">{application.otherBoardMembers.join(", ")}</dd></div>
          )}
          {application.note && <div><dt>Note</dt><dd translate="no">{application.note}</dd></div>}
          <div><dt>Submitted</dt><dd>{formatDate(application.submittedAt)} (application dated {application.applicationDate})</dd></div>
          {application.attachment && (
            <div>
              <dt>Attachment</dt>
              <dd>
                <a href={`/api/admin/club-applications/${encodeURIComponent(application.id)}/attachment`}>
                  <Paperclip aria-hidden="true" size={13} /> {application.attachment.name}
                </a>{" "}
                <small>({formatSize(application.attachment.byteSize)})</small>
              </dd>
            </div>
          )}
          {application.status === "DECLINED" && application.declineReason && <div><dt>Reason given</dt><dd translate="no">{application.declineReason}</dd></div>}
          {application.decidedAt && <div><dt>Decided</dt><dd>{formatDate(application.decidedAt)}{application.decidedByName ? ` by ${application.decidedByName}` : ""}</dd></div>}
          {application.createdOrganizationId && (
            <div><dt>Club</dt><dd><a href={`/admin/organizations/${encodeURIComponent(application.createdOrganizationId)}/profile`}>Open the new club</a></dd></div>
          )}
        </dl>

        {application.status === "PENDING" && canDecide && (
          open === null ? (
            <div className="nca-actions">
              <button className="primary-button" disabled={busy} onClick={() => { setMode({ id: application.id, kind: "approve" }); setMessage(null); }} type="button">Approve</button>
              <button className="secondary-button" disabled={busy} onClick={() => { setMode({ id: application.id, kind: "decline" }); setReason(""); setMessage(null); }} type="button">Decline</button>
            </div>
          ) : open === "approve" ? (
            <form
              className="nca-decision"
              onSubmit={(event) => {
                event.preventDefault();
                void decide(application, application.church.needsChoice ? { decision: "approve", sponsoringChurchId: churchChoice } : { decision: "approve" });
              }}
            >
              <p>
                Approving creates the club and emails <strong translate="no">{application.director.email}</strong> the club director invite. It can&apos;t be undone from here.
              </p>
              {application.church.needsChoice && (
                <label>
                  Sponsoring church from the directory
                  <select required value={churchChoice} onChange={(event) => setChurchChoice(event.target.value)}>
                    <option value="">Choose a church…</option>
                    {churches.map((church) => <option key={church.id} value={church.id}>{church.name}</option>)}
                  </select>
                  <small>
                    {application.church.name
                      ? <>The applicant&apos;s church, &ldquo;{application.church.name}&rdquo;, isn&apos;t an active church in the directory. </>
                      : "The applicant's church is no longer in the directory. "}
                    Every club needs one.
                  </small>
                </label>
              )}
              <div className="nca-actions">
                <button className="primary-button" disabled={busy || (application.church.needsChoice && !churchChoice)} type="submit">Approve and send invite</button>
                <button className="secondary-button" disabled={busy} onClick={() => setMode(null)} type="button">Cancel</button>
              </div>
            </form>
          ) : (
            <form
              className="nca-decision"
              onSubmit={(event) => {
                event.preventDefault();
                void decide(application, { decision: "decline", declineReason: reason });
              }}
            >
              <label>
                Reason (optional). The applicant is emailed this.
                <textarea maxLength={DECLINE_REASON_MAX} onChange={(event) => setReason(event.target.value)} rows={3} value={reason} />
              </label>
              <div className="nca-actions">
                <button className="primary-button" disabled={busy} type="submit">Decline application</button>
                <button className="secondary-button" disabled={busy} onClick={() => setMode(null)} type="button">Cancel</button>
              </div>
            </form>
          )
        )}
        {message?.id === application.id && <p className={`inline-notice ${message.tone}`} role="alert">{message.text}</p>}
      </article>
    );
  }

  return (
    <section className="page-stack nca-queue">
      {canDecide && (
        <div className="panel">
          <div className="section-heading"><div><h2>Send a private link</h2></div></div>
          <p className="field-help">
            Email a prospective director a private link to the application. It opens the same form with their email filled in, works once, and creates nothing until you approve it.
          </p>
          {!emailConfigured && <div className="inline-notice error" role="status">Account email isn&apos;t set up on this server, so links can&apos;t be sent yet.</div>}
          <form className="nca-invite-form" onSubmit={(event) => void sendInvite(event)}>
            <label>
              Director&apos;s email
              <input autoComplete="off" onChange={(event) => setInviteEmail(event.target.value)} required type="email" value={inviteEmail} />
            </label>
            <label>
              Name (optional)
              <input autoComplete="off" maxLength={120} onChange={(event) => setInviteName(event.target.value)} value={inviteName} />
            </label>
            <button className="primary-button" disabled={inviteBusy || !emailConfigured || !inviteEmail.trim()} type="submit">
              <Send aria-hidden="true" size={15} /> Send link
            </button>
          </form>
          {inviteMessage && <p className={`inline-notice ${inviteMessage.tone}`} role="status">{inviteMessage.text}</p>}
          {invites.length > 0 && (
            <ul className="club-invite-list">
              {invites.map((invite) => (
                <li key={invite.id}>
                  <span><strong translate="no">{invite.name || invite.email}</strong><small translate="no">{invite.email}</small></span>
                  <span className={`status-chip ${invite.state === "OPEN" ? "purple" : invite.state === "USED" ? "green" : "neutral"}`}>{inviteStateLabels[invite.state]}</span>
                  {invite.state === "OPEN" && (
                    <button className="secondary-button" disabled={inviteBusy} onClick={() => void withdrawInvite(invite)} type="button">Withdraw</button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="panel">
        <div className="section-heading"><div><h2>Waiting for a decision ({waiting.length})</h2></div></div>
        {waiting.length === 0 ? <p className="report-empty">No applications are waiting.</p> : <div className="nca-list">{waiting.map(renderApplication)}</div>}
      </div>

      {decided.length > 0 && (
        <div className="panel">
          <div className="section-heading"><div><h2>Recently decided</h2></div></div>
          <div className="nca-list">{decided.map(renderApplication)}</div>
        </div>
      )}
    </section>
  );
}
