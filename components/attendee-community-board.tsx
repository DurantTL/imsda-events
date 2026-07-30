"use client";

import { useState } from "react";
import {
  Bell,
  BellOff,
  CheckCircle2,
  Flag,
  MessageCircle,
  MessagesSquare,
  Send,
  ShieldCheck,
} from "lucide-react";

type CommunityPost = {
  id: string;
  parentId: string | null;
  body: string;
  status: "PUBLISHED" | "HIDDEN" | "REMOVED";
  createdAt: string;
  authorName: string;
  isOwn: boolean;
  isReported: boolean;
  replies: CommunityPost[];
};

export type AttendeeCommunityBoardData = {
  eventId: string;
  eventName: string;
  settings: {
    isEnabled: boolean;
    allowNewPosts: boolean;
    allowReplies: boolean;
    conductVersion: number;
    conductText: string;
    retentionDays: number;
  };
  participation: {
    conductAccepted: boolean;
    notificationPreference: "NONE" | "REPLIES" | "ALL";
  };
  posts: CommunityPost[];
  notifications: Array<{
    id: string;
    kind: "NEW_POST" | "REPLY";
    read: boolean;
    createdAt: string;
    actorName: string;
    postId: string;
    excerpt: string;
  }>;
};

function dateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AttendeeCommunityBoard({
  community,
}: {
  community: AttendeeCommunityBoardData;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endpoint = `/api/attendee/events/${encodeURIComponent(community.eventId)}/community`;
  const unread = community.notifications.filter((notification) => !notification.read);

  async function action(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The community action failed.");
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The community action failed.");
      setBusy(false);
    }
  }

  function submitPost(event: React.FormEvent<HTMLFormElement>, parentId?: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action({
      action: "CREATE_POST",
      body: String(form.get("body") ?? ""),
      parentId: parentId ?? null,
    });
  }

  function submitReport(event: React.FormEvent<HTMLFormElement>, postId: string) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action({
      action: "REPORT_POST",
      postId,
      reason: String(form.get("reason") ?? "OTHER"),
      detail: String(form.get("detail") ?? ""),
    });
  }

  if (!community.settings.isEnabled) {
    return (
      <section className="public-manage-card attendee-community-board">
        <div className="public-manage-card-heading">
          <MessagesSquare size={21} aria-hidden="true" />
          <div><p className="public-registration-eyebrow">Community</p><h2>Retreat community</h2></div>
        </div>
        <p className="public-manage-empty">The event team has not opened attendee discussion yet.</p>
      </section>
    );
  }

  return (
    <section className="public-manage-card attendee-community-board" id="community">
      <header className="attendee-community-heading">
        <div className="public-manage-card-heading">
          <MessagesSquare size={21} aria-hidden="true" />
          <div>
            <p className="public-registration-eyebrow">Community</p>
            <h2>{community.eventName} Community</h2>
          </div>
        </div>
        <span>{community.posts.length} {community.posts.length === 1 ? "conversation" : "conversations"}</span>
      </header>

      {error && <p className="inline-notice error" role="alert">{error}</p>}

      {!community.participation.conductAccepted ? (
        <div className="attendee-community-conduct">
          <ShieldCheck size={24} aria-hidden="true" />
          <div>
            <h3>Community conduct agreement</h3>
            <p>{community.settings.conductText}</p>
            <small>Posts are retained for {community.settings.retentionDays} days after the event ends.</small>
          </div>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void action({ action: "ACCEPT_CONDUCT" })}
            type="button"
          >
            <CheckCircle2 size={16} aria-hidden="true" />
            Accept and join
          </button>
        </div>
      ) : (
        <>
          <div className="attendee-community-controls">
            <label>
              <span><Bell size={15} aria-hidden="true" /> In-app notifications</span>
              <select
                disabled={busy}
                value={community.participation.notificationPreference}
                onChange={(event) => void action({
                  action: "UPDATE_NOTIFICATIONS",
                  preference: event.target.value,
                })}
              >
                <option value="NONE">None</option>
                <option value="REPLIES">Replies to my posts</option>
                <option value="ALL">All new activity</option>
              </select>
            </label>
            {unread.length > 0 ? (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void action({ action: "MARK_NOTIFICATIONS_READ" })}
                type="button"
              >
                Mark {unread.length} read
              </button>
            ) : <span><BellOff size={14} aria-hidden="true" /> No unread activity</span>}
          </div>

          {unread.length > 0 && (
            <details className="attendee-community-notifications">
              <summary>{unread.length} new community {unread.length === 1 ? "notification" : "notifications"}</summary>
              <ul>
                {unread.map((notification) => (
                  <li key={notification.id}>
                    <strong>{notification.actorName}</strong>
                    <span>{notification.kind === "REPLY" ? " replied" : " posted"} · {notification.excerpt}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {community.settings.allowNewPosts && (
            <form className="attendee-community-compose" onSubmit={submitPost}>
              <label htmlFor="community-post-body">Start a conversation</label>
              <textarea
                id="community-post-body"
                maxLength={1500}
                name="body"
                placeholder="Share a helpful update, question, encouragement, or retreat moment."
                required
                rows={3}
              />
              <button className="primary-button" disabled={busy} type="submit">
                <Send size={15} aria-hidden="true" /> Post
              </button>
            </form>
          )}

          <div className="attendee-community-posts">
            {community.posts.map((post) => (
              <article className={`attendee-community-post is-${post.status.toLowerCase()}`} key={post.id}>
                <header>
                  <div><strong>{post.authorName}</strong>{post.isOwn && <small>You</small>}</div>
                  <time dateTime={post.createdAt}>{dateTime(post.createdAt)}</time>
                </header>
                <p>{post.body}</p>
                {post.status === "PUBLISHED" && (
                  <div className="attendee-community-post-actions">
                    {community.settings.allowReplies && (
                      <details>
                        <summary><MessageCircle size={14} aria-hidden="true" /> Reply</summary>
                        <form onSubmit={(event) => submitPost(event, post.id)}>
                          <textarea maxLength={1500} name="body" required rows={2} aria-label={`Reply to ${post.authorName}`} />
                          <button className="secondary-button" disabled={busy} type="submit">Post reply</button>
                        </form>
                      </details>
                    )}
                    {!post.isOwn && !post.isReported && (
                      <details>
                        <summary><Flag size={14} aria-hidden="true" /> Report</summary>
                        <form onSubmit={(event) => submitReport(event, post.id)}>
                          <select aria-label="Report reason" defaultValue="CONDUCT" name="reason">
                            <option value="CONDUCT">Conduct concern</option>
                            <option value="HARASSMENT">Harassment</option>
                            <option value="PRIVACY">Privacy concern</option>
                            <option value="SPAM">Spam or unrelated</option>
                            <option value="OTHER">Other</option>
                          </select>
                          <textarea maxLength={500} name="detail" placeholder="Optional detail for the event team" rows={2} />
                          <button className="secondary-button" disabled={busy} type="submit">Send private report</button>
                        </form>
                      </details>
                    )}
                    {post.isReported && <small><Flag size={13} aria-hidden="true" /> Report sent privately</small>}
                  </div>
                )}
                {post.replies.length > 0 && (
                  <div className="attendee-community-replies">
                    {post.replies.map((reply) => (
                      <article className={`is-${reply.status.toLowerCase()}`} key={reply.id}>
                        <header>
                          <div><strong>{reply.authorName}</strong>{reply.isOwn && <small>You</small>}</div>
                          <time dateTime={reply.createdAt}>{dateTime(reply.createdAt)}</time>
                        </header>
                        <p>{reply.body}</p>
                        {reply.status === "PUBLISHED" && !reply.isOwn && !reply.isReported && (
                          <details>
                            <summary><Flag size={13} aria-hidden="true" /> Report reply</summary>
                            <form onSubmit={(event) => submitReport(event, reply.id)}>
                              <select aria-label="Report reason" defaultValue="CONDUCT" name="reason">
                                <option value="CONDUCT">Conduct concern</option>
                                <option value="HARASSMENT">Harassment</option>
                                <option value="PRIVACY">Privacy concern</option>
                                <option value="SPAM">Spam or unrelated</option>
                                <option value="OTHER">Other</option>
                              </select>
                              <textarea maxLength={500} name="detail" placeholder="Optional detail" rows={2} />
                              <button className="secondary-button" disabled={busy} type="submit">Send report</button>
                            </form>
                          </details>
                        )}
                      </article>
                    ))}
                  </div>
                )}
              </article>
            ))}
            {community.posts.length === 0 && (
              <p className="public-manage-empty">No conversations yet. Start the first one when the retreat team opens posting.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
