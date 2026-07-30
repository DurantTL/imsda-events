"use client";

import { useState } from "react";
import { Eye, Flag, MessageSquareWarning, Save, ShieldCheck, UsersRound } from "lucide-react";

type StaffCommunity = {
  eventId: string;
  eventSlug: string;
  eventName: string;
  settings: {
    isEnabled: boolean;
    allowNewPosts: boolean;
    allowReplies: boolean;
    conductVersion: number;
    conductText: string;
    retentionDays: number;
  };
  participantCount: number;
  posts: Array<{
    id: string;
    parentId: string | null;
    body: string;
    status: "PUBLISHED" | "HIDDEN" | "REMOVED";
    moderationNote: string | null;
    createdAt: string;
    authorName: string;
    authorEmail: string;
    openReports: number;
    replies: Array<{
      id: string;
      parentId: string | null;
      body: string;
      status: "PUBLISHED" | "HIDDEN" | "REMOVED";
      moderationNote: string | null;
      createdAt: string;
      authorName: string;
      authorEmail: string;
      openReports: number;
    }>;
  }>;
  reports: Array<{
    id: string;
    postId: string;
    reason: string;
    detail: string | null;
    createdAt: string;
    reporterName: string;
    reporterEmail: string;
    authorName: string;
    authorEmail: string;
    postBody: string;
    postStatus: string;
  }>;
};

function when(value: string) {
  return new Date(value).toLocaleString();
}

export function CommunityModerationWorkspace({ community }: { community: StaffCommunity }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/events/${encodeURIComponent(community.eventId)}/community`;

  async function action(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The community change failed.");
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The community change failed.");
      setBusy(false);
    }
  }

  function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action({
      action: "UPDATE_SETTINGS",
      isEnabled: form.get("isEnabled") === "on",
      allowNewPosts: form.get("allowNewPosts") === "on",
      allowReplies: form.get("allowReplies") === "on",
      conductText: String(form.get("conductText") ?? ""),
      retentionDays: Number(form.get("retentionDays")),
    });
  }

  function moderationForm(
    event: React.FormEvent<HTMLFormElement>,
    postId: string,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action({
      action: "MODERATE_POST",
      postId,
      status: String(form.get("status")),
      note: String(form.get("note") ?? ""),
    });
  }

  function reportForm(
    event: React.FormEvent<HTMLFormElement>,
    reportId: string,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action({
      action: "RESOLVE_REPORT",
      reportId,
      status: String(form.get("status")),
      note: String(form.get("note") ?? ""),
    });
  }

  return (
    <div className="community-moderation-stack">
      {error && <p className="inline-notice error" role="alert">{error}</p>}

      <section className="panel community-settings-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Safety and availability</p>
            <h2>Community controls</h2>
            <p>Discussion remains private to verified attendees with active registrations.</p>
          </div>
          <span className={`status-chip ${community.settings.isEnabled ? "green" : "gold"}`}>
            {community.settings.isEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <form onSubmit={saveSettings}>
          <div className="community-toggle-grid">
            <label><input defaultChecked={community.settings.isEnabled} name="isEnabled" type="checkbox" /> Enable attendee community</label>
            <label><input defaultChecked={community.settings.allowNewPosts} name="allowNewPosts" type="checkbox" /> Allow new conversations</label>
            <label><input defaultChecked={community.settings.allowReplies} name="allowReplies" type="checkbox" /> Allow replies</label>
          </div>
          <label>
            <span>Conduct agreement · version {community.settings.conductVersion}</span>
            <textarea defaultValue={community.settings.conductText} maxLength={4000} minLength={40} name="conductText" required rows={5} />
            <small>Changing this text requires every participant to accept the new version before posting again.</small>
          </label>
          <label>
            <span>Delete discussion after the event</span>
            <select defaultValue={String(community.settings.retentionDays)} name="retentionDays">
              <option value="7">7 days after</option>
              <option value="14">14 days after</option>
              <option value="30">30 days after</option>
              <option value="60">60 days after</option>
              <option value="90">90 days after</option>
              <option value="180">180 days after</option>
              <option value="365">1 year after</option>
            </select>
          </label>
          <button className="primary-button" disabled={busy} type="submit"><Save size={16} aria-hidden="true" /> Save controls</button>
        </form>
      </section>

      <section className="community-staff-summary" aria-label="Community summary">
        <article><UsersRound size={20} aria-hidden="true" /><strong>{community.participantCount}</strong><span>participants</span></article>
        <article><MessageSquareWarning size={20} aria-hidden="true" /><strong>{community.posts.length}</strong><span>conversations</span></article>
        <article className={community.reports.length ? "is-warning" : ""}><Flag size={20} aria-hidden="true" /><strong>{community.reports.length}</strong><span>open reports</span></article>
      </section>

      <section className="panel community-reports-panel">
        <div className="section-heading">
          <div><p className="eyebrow">Private moderation queue</p><h2>Open attendee reports</h2></div>
          <ShieldCheck size={21} aria-hidden="true" />
        </div>
        {community.reports.length === 0 ? (
          <p className="empty-state">There are no open community reports.</p>
        ) : community.reports.map((report) => (
          <article className="community-report-card" key={report.id}>
            <header><strong>{report.reason.toLowerCase()}</strong><time>{when(report.createdAt)}</time></header>
            <p>“{report.postBody}”</p>
            <dl>
              <div><dt>Post author</dt><dd>{report.authorName} · {report.authorEmail}</dd></div>
              <div><dt>Reported by</dt><dd>{report.reporterName} · {report.reporterEmail}</dd></div>
            </dl>
            {report.detail && <p><strong>Reporter detail:</strong> {report.detail}</p>}
            <form onSubmit={(event) => reportForm(event, report.id)}>
              <select defaultValue="RESOLVED" name="status">
                <option value="RESOLVED">Resolve after review</option>
                <option value="DISMISSED">Dismiss report</option>
              </select>
              <input maxLength={500} name="note" placeholder="Private resolution note" />
              <button className="secondary-button" disabled={busy} type="submit">Close report</button>
            </form>
          </article>
        ))}
      </section>

      <section className="panel community-post-review">
        <div className="section-heading">
          <div><p className="eyebrow">Discussion review</p><h2>Posts and replies</h2></div>
          <a className="secondary-button" href={`/account/events/${encodeURIComponent(community.eventSlug)}?preview=staff`}>
            <Eye size={15} aria-hidden="true" /> Preview attendee view
          </a>
        </div>
        {community.posts.length === 0 ? (
          <p className="empty-state">No attendee conversations have been posted.</p>
        ) : community.posts.map((post) => (
          <article className="community-staff-post" key={post.id}>
            <header>
              <div><strong>{post.authorName}</strong><small>{post.authorEmail}</small></div>
              <span className={`status-chip ${post.status === "PUBLISHED" ? "green" : "gold"}`}>{post.status.toLowerCase()}</span>
            </header>
            <p>{post.body}</p>
            <small>{when(post.createdAt)} · {post.openReports} open reports</small>
            <form onSubmit={(event) => moderationForm(event, post.id)}>
              <select defaultValue={post.status} name="status">
                <option value="PUBLISHED">Visible</option>
                <option value="HIDDEN">Hide pending review</option>
                <option value="REMOVED">Remove</option>
              </select>
              <input defaultValue={post.moderationNote ?? ""} maxLength={500} name="note" placeholder="Private moderation note" />
              <button className="secondary-button" disabled={busy} type="submit">Apply</button>
            </form>
            {post.replies.map((reply) => (
              <article className="community-staff-reply" key={reply.id}>
                <header><div><strong>{reply.authorName}</strong><small>{reply.authorEmail}</small></div><span>{reply.status.toLowerCase()}</span></header>
                <p>{reply.body}</p>
                <form onSubmit={(event) => moderationForm(event, reply.id)}>
                  <select defaultValue={reply.status} name="status">
                    <option value="PUBLISHED">Visible</option>
                    <option value="HIDDEN">Hide</option>
                    <option value="REMOVED">Remove</option>
                  </select>
                  <input defaultValue={reply.moderationNote ?? ""} maxLength={500} name="note" placeholder="Private note" />
                  <button className="secondary-button" disabled={busy} type="submit">Apply</button>
                </form>
              </article>
            ))}
          </article>
        ))}
      </section>
    </div>
  );
}
