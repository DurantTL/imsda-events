"use client";

import { useState } from "react";
import { Download, Eye, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { closureLabel, formatDateRange } from "@/modules/calendar/domain";
import type { FeedPreview } from "@/modules/calendar/feed-plan";
import type { CalendarAdminFeed } from "@/modules/calendar/feeds";
import { describeRepeat, parseRepeatRule } from "@/modules/calendar/recurrence";
import type { CalendarAdminEntry } from "@/modules/calendar/repository";

type FeedResponse = {
  feeds?: CalendarAdminFeed[];
  entries?: CalendarAdminEntry[];
  preview?: FeedPreview;
  summary?: { create: number; update: number; revive: number; relink: number; remove: number; unchanged: number; warnings: string[] };
  message?: string;
};

const actionLabels = { CREATE: "New", UPDATE: "Updated", REVIVE: "Back in feed", RELINK: "Re-linked", REMOVE: "Left the feed" } as const;
const fieldLabels: Record<string, string> = {
  title: "title", description: "description", location: "location", linkUrl: "link", status: "status", startsOn: "start date",
  endsOn: "end date", timeLabel: "time", repeatRule: "repeat", repeatExceptions: "skipped dates",
};

function when(value: string | null) {
  return value ? new Date(value).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "Never";
}

/**
 * The body of the sync request for a preview being applied. An empty feed is only
 * applied (which unpublishes everything it imported) when the preview staff just
 * reviewed was itself empty, with its warning shown; otherwise the server's guard stays on.
 */
export function syncBodyForPreview(preview: { totalInFeed: number }) {
  return preview.totalInFeed === 0 ? { allowEmpty: true } : undefined;
}

/**
 * Imported calendars (#444 part B): a Google Calendar (or any ICS) address
 * staff add, review with Preview, and Import. The address is write-only: once
 * saved, only its host and last four characters are ever shown.
 */
export function CalendarFeedsPanel({
  initialFeeds,
  onEntriesChange,
}: {
  initialFeeds: CalendarAdminFeed[];
  onEntriesChange: (entries: CalendarAdminEntry[]) => void;
}) {
  const [feeds, setFeeds] = useState(initialFeeds);
  const [editing, setEditing] = useState<CalendarAdminFeed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ feedId: string; data: FeedPreview } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CalendarAdminFeed | null>(null);

  async function call(url: string, method: string, body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as FeedResponse;
      if (!response.ok) throw new Error(result.message ?? "That could not be completed.");
      if (result.feeds) setFeeds(result.feeds);
      if (result.entries) onEntriesChange(result.entries);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be completed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const body = {
      name: String(form.get("name") ?? ""),
      // Blank on an edit keeps the saved address.
      url: String(form.get("url") ?? ""),
      defaultCategory: String(form.get("defaultCategory") ?? ""),
      defaultEntryType: form.get("defaultEntryType") === "CLOSURE" ? "CLOSURE" : "STANDARD",
      publishNewItems: form.get("publishNewItems") === "on",
      isEnabled: form.get("isEnabled") === "on",
      refreshMinutes: Number(form.get("refreshMinutes") ?? 60),
    };
    const result = editing
      ? await call(`/api/admin/calendar/feeds/${encodeURIComponent(editing.id)}`, "PATCH", body)
      : await call("/api/admin/calendar/feeds", "POST", body);
    if (result) {
      setNotice(editing ? "Saved." : "Added. Preview it, then import.");
      setEditing(null);
      formElement.reset();
    }
  }

  async function runPreview(feed: CalendarAdminFeed) {
    setPreview(null);
    const result = await call(`/api/admin/calendar/feeds/${encodeURIComponent(feed.id)}/preview`, "POST", undefined);
    if (result?.preview) setPreview({ feedId: feed.id, data: result.preview });
  }

  async function runSync(feed: CalendarAdminFeed, body?: { allowEmpty: boolean }) {
    const result = await call(`/api/admin/calendar/feeds/${encodeURIComponent(feed.id)}/sync`, "POST", body);
    if (result?.summary) {
      const { create, update, revive, relink, remove, unchanged } = result.summary;
      setNotice(`Imported: ${create} new, ${update + revive} updated, ${relink} re-linked, ${remove} removed, ${unchanged} unchanged.`);
      setPreview(null);
    }
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const result = await call(`/api/admin/calendar/feeds/${encodeURIComponent(removeTarget.id)}`, "DELETE", undefined);
    if (result) {
      if (editing?.id === removeTarget.id) setEditing(null);
      if (preview?.feedId === removeTarget.id) setPreview(null);
      setRemoveTarget(null);
      setNotice("Imported calendar removed. Its items stay on the calendar.");
    }
  }

  const previewFeed = preview ? feeds.find((feed) => feed.id === preview.feedId) : null;

  return (
    <>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && !removeTarget && <div className="inline-notice error" role="alert">{error}</div>}

      <form className="panel form-stack" key={editing?.id ?? "new"} onSubmit={save}>
        <div className="section-heading">
          <div>
            <p className="eyebrow">{editing ? "Edit imported calendar" : "Import a calendar"}</p>
            <h2>{editing ? editing.name : "Add a Google Calendar"}</h2>
            <p>
              Paste the calendar&apos;s public or &quot;secret address in iCal format&quot; (Google Calendar settings, Integrate calendar).
              It is read-only: nothing is written back to Google. The address is stored encrypted and never shown again.
            </p>
          </div>
          {editing && (
            <button className="secondary-button" onClick={() => setEditing(null)} type="button">
              <X aria-hidden="true" size={14} /> Cancel
            </button>
          )}
        </div>
        <div className="form-grid two-column">
          <label>
            Name
            <input defaultValue={editing?.name ?? ""} maxLength={80} name="name" placeholder="e.g. Conference Google Calendar" required />
          </label>
          <label>
            Calendar address (https:// or webcal://)
            <input
              autoComplete="off"
              name="url"
              placeholder={editing ? `Saved (${editing.urlHint}). Leave blank to keep it.` : "https://calendar.google.com/calendar/ical/…/basic.ics"}
              required={!editing}
              spellCheck={false}
              type="password"
            />
          </label>
          <label>
            Category for new items (optional)
            <input defaultValue={editing?.defaultCategory ?? ""} maxLength={40} name="defaultCategory" placeholder="e.g. Conference" />
          </label>
          <label>
            Show new items as
            <select defaultValue={editing?.defaultEntryType ?? "STANDARD"} name="defaultEntryType">
              <option value="STANDARD">Conference dates</option>
              <option value="CLOSURE">{closureLabel}</option>
            </select>
          </label>
          <label>
            Refresh every (minutes)
            <input defaultValue={editing?.refreshMinutes ?? 60} max={10080} min={15} name="refreshMinutes" type="number" />
          </label>
        </div>
        <label className="checkbox-label">
          <input defaultChecked={editing?.publishNewItems ?? false} name="publishNewItems" type="checkbox" /> Publish new items automatically (otherwise they arrive as drafts)
        </label>
        <label className="checkbox-label">
          <input defaultChecked={editing?.isEnabled ?? true} name="isEnabled" type="checkbox" /> Refresh automatically
        </label>
        <div>
          <button className="primary-button" disabled={busy} type="submit">
            {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
            {editing ? " Save calendar" : " Add calendar"}
          </button>
        </div>
      </form>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Imported calendars</p>
            <h2>Calendars you import</h2>
          </div>
        </div>
        {feeds.length === 0 ? (
          <div className="empty-state"><Download aria-hidden="true" size={27} /><h3>No imported calendars</h3><p>Add a Google Calendar above to bring its events onto the public calendar.</p></div>
        ) : (
          <ul className="calendar-admin-list">
            {feeds.map((feed) => (
              <li key={feed.id}>
                <div>
                  <strong>{feed.name}</strong>
                  <small>
                    {feed.urlHint} · Last refresh: {when(feed.lastFetchedAt)} · {feed.lastItemCount ?? 0} items · every {feed.refreshMinutes} min
                  </small>
                  <span className="calendar-admin-chips">
                    {!feed.imported && <span className="status-chip gold">Not imported yet</span>}
                    {feed.lastStatus === "OK" && <span className="status-chip green">Up to date</span>}
                    {feed.lastStatus === "FAILED" && <span className="status-chip coral">Last refresh failed</span>}
                    <span className={`status-chip ${feed.isEnabled ? "green" : "gold"}`}>{feed.isEnabled ? "Refreshing automatically" : "Paused"}</span>
                  </span>
                  {feed.lastStatus === "FAILED" && feed.lastError && <small role="note">{feed.lastError}</small>}
                </div>
                <div className="calendar-admin-actions">
                  <button className="secondary-button" disabled={busy} onClick={() => void runPreview(feed)} type="button">
                    <Eye aria-hidden="true" size={14} /> Preview
                  </button>
                  <button className="secondary-button" disabled={busy} onClick={() => void runSync(feed)} type="button">
                    {feed.imported ? <RefreshCw aria-hidden="true" size={14} /> : <Download aria-hidden="true" size={14} />}
                    {feed.imported ? " Refresh now" : " Import"}
                  </button>
                  <button className="secondary-button" disabled={busy} onClick={() => { setEditing(feed); setNotice(""); setError(""); }} type="button">Edit</button>
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={async () => {
                      const result = await call(`/api/admin/calendar/feeds/${encodeURIComponent(feed.id)}`, "PATCH", { isEnabled: !feed.isEnabled });
                      if (result) setNotice(feed.isEnabled ? "Automatic refresh paused." : "Automatic refresh resumed.");
                    }}
                    type="button"
                  >
                    {feed.isEnabled ? "Pause" : "Resume"}
                  </button>
                  <button aria-label={`Delete ${feed.name}`} className="secondary-button" disabled={busy} onClick={() => { setError(""); setRemoveTarget(feed); }} type="button">
                    <Trash2 aria-hidden="true" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {preview && previewFeed && (
        <section className="panel" aria-label="Import preview">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Preview, nothing saved yet</p>
              <h2>{previewFeed.name}</h2>
              <p>
                {preview.data.totalInFeed} items in the feed: {preview.data.counts.create} new, {preview.data.counts.update + preview.data.counts.revive} updated, {preview.data.counts.relink} re-linked,{" "}
                {preview.data.counts.remove} leaving, {preview.data.counts.unchanged} unchanged.
                {" "}New items arrive as {previewFeed.publishNewItems ? "published items" : "drafts"}.
              </p>
            </div>
            <button className="primary-button" disabled={busy} onClick={() => void runSync(previewFeed, syncBodyForPreview(preview.data))} type="button">
              <Download aria-hidden="true" size={15} /> {previewFeed.imported ? "Apply refresh" : "Import"}
            </button>
          </div>
          {preview.data.warnings.length > 0 && (
            <div className="inline-notice" role="note">
              <strong>Check these</strong>
              <ul>{preview.data.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
            </div>
          )}
          {preview.data.rows.length === 0 ? (
            <p>Nothing would change.</p>
          ) : (
            <div className="table-wrap">
              <table className="table-cards">
                <thead>
                  <tr><th scope="col">What</th><th scope="col">Title</th><th scope="col">Dates</th><th scope="col">Time</th><th scope="col">Repeats</th></tr>
                </thead>
                <tbody>
                  {preview.data.rows.map((row, index) => {
                    const rule = parseRepeatRule(row.repeatRule);
                    return (
                      <tr key={`${row.action}-${index}`}>
                        <td data-label="What">
                          {actionLabels[row.action]}
                          {row.changedFields.length > 0 && <small> ({row.changedFields.map((name) => fieldLabels[name] ?? name).join(", ")})</small>}
                        </td>
                        <td data-label="Title">{row.title}</td>
                        <td data-label="Dates">{row.startsOn ? formatDateRange(row.startsOn, row.endsOn || row.startsOn) : ""}</td>
                        <td data-label="Time">{row.timeLabel}</td>
                        <td data-label="Repeats">{rule ? describeRepeat(rule) : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        busy={busy}
        confirmLabel={removeTarget ? `Delete "${removeTarget.name}"` : "Delete calendar"}
        destructive
        error={error}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemove()}
        open={removeTarget !== null}
        title={removeTarget ? `Delete the imported calendar "${removeTarget.name}"?` : "Delete calendar?"}
      >
        <p>
          The saved address is removed and the calendar stops refreshing. Its {removeTarget?.entryCount ?? 0} imported items are
          kept and become ordinary calendar entries that you manage by hand. Nothing changes in Google.
        </p>
      </ConfirmDialog>
    </>
  );
}
