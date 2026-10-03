"use client";

import { useRef, useState } from "react";
import { CalendarDays, Eye, EyeOff, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { calendarStatusLabels, closureLabel, formatDateRange } from "@/modules/calendar/domain";
import { describeRepeat, previewOccurrences, weekdayLabels, type RepeatRule } from "@/modules/calendar/recurrence";
import type { CalendarAdminEntry, CalendarAdminEvent } from "@/modules/calendar/repository";

type ApiResponse = {
  entries?: CalendarAdminEntry[];
  events?: CalendarAdminEvent[];
  message?: string;
  issues?: Array<{ message?: string }>;
};

/** The "Repeats" control's state: what the staff member has picked, before it becomes a rule. */
export type RepeatDraft = {
  frequency: "NEVER" | RepeatRule["frequency"];
  interval: number;
  weekdays: number[];
  endMode: "never" | "until" | "count";
  until: string;
  count: number;
  weekStart: RepeatRule["weekStart"];
};

export const noRepeat: RepeatDraft = { frequency: "NEVER", interval: 1, weekdays: [], endMode: "never", until: "", count: 10, weekStart: 0 };

/** 0 = Sunday ... 6 = Saturday for a YYYY-MM-DD date, or null while the date is blank. */
function weekdayOf(calendarDate: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(calendarDate) ? new Date(`${calendarDate}T00:00:00Z`).getUTCDay() : null;
}

/** A hint for repeats that land on a day some months lack, or null. */
export function shortMonthHint(draft: RepeatDraft, startsOn: string) {
  const day = Number(startsOn.slice(8, 10));
  const month = Number(startsOn.slice(5, 7));
  const risky = (draft.frequency === "MONTHLY" && day >= 29) || (draft.frequency === "YEARLY" && month === 2 && day === 29);
  return risky
    ? "Some calendar apps (e.g. Outlook) may show this on the last day of shorter months."
    : null;
}

export function repeatToDraft(repeat: RepeatRule | null): RepeatDraft {
  if (!repeat) return noRepeat;
  return {
    frequency: repeat.frequency,
    interval: repeat.interval,
    weekdays: repeat.weekdays,
    endMode: repeat.until ? "until" : repeat.count ? "count" : "never",
    until: repeat.until ?? "",
    count: repeat.count ?? 10,
    weekStart: repeat.weekStart,
  };
}

/** The rule sent to the API, or null for "never". A weekly repeat with no weekday follows the start date's. */
export function draftToRepeat(draft: RepeatDraft, startsOn = ""): RepeatRule | null {
  if (draft.frequency === "NEVER") return null;
  const startDay = weekdayOf(startsOn);
  // The start date's weekday is always part of a weekly repeat.
  const picked = draft.weekdays.length > 0 && startDay !== null && !draft.weekdays.includes(startDay)
    ? [...draft.weekdays, startDay].sort()
    : draft.weekdays;
  return {
    frequency: draft.frequency,
    interval: Math.max(1, Math.floor(draft.interval) || 1),
    weekdays: draft.frequency === "WEEKLY" ? picked : [],
    weekStart: draft.weekStart,
    until: draft.endMode === "until" && draft.until ? draft.until : null,
    count: draft.endMode === "count" ? Math.max(1, Math.floor(draft.count) || 1) : null,
  };
}

/**
 * What the public calendar shows (#107): which published events appear, and
 * the informational dates staff add for things managed elsewhere.
 */
export function CalendarAdminWorkspace({
  initialEntries,
  initialEvents,
}: {
  initialEntries: CalendarAdminEntry[];
  initialEvents: CalendarAdminEvent[];
}) {
  const [tab, setTab] = useState<"entries" | "events">("entries");
  const [entries, setEntries] = useState(initialEntries);
  const [events, setEvents] = useState(initialEvents);
  const [editing, setEditing] = useState<CalendarAdminEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  // Review before removing a calendar entry (#471): the shared in-page
  // confirm dialog replaces `window.confirm()`.
  const [removeTarget, setRemoveTarget] = useState<CalendarAdminEntry | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The repeat control and its start date are controlled so the skip list can preview occurrences.
  const [startsOn, setStartsOn] = useState("");
  const [repeat, setRepeat] = useState<RepeatDraft>(noRepeat);
  const [skipped, setSkipped] = useState<string[]>([]);

  async function call(url: string, method: string, body: unknown, success: string) {
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as ApiResponse;
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "The calendar could not be updated.");
      if (result.entries) setEntries(result.entries);
      if (result.events) setEvents(result.events);
      setNotice(success);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The calendar could not be updated.");
      return false;
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(entry: CalendarAdminEntry) {
    setEditing(entry);
    setStartsOn(entry.startsOn);
    setRepeat(repeatToDraft(entry.repeat));
    setSkipped(entry.repeatExceptions);
    setNotice("");
    setError("");
    window.requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      formRef.current?.querySelector<HTMLInputElement>("input[name=title]")?.focus({ preventScroll: true });
    });
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const startsOn = String(form.get("startsOn") ?? "");
    const body = {
      title: String(form.get("title") ?? ""),
      description: String(form.get("description") ?? ""),
      startsOn,
      endsOn: String(form.get("endsOn") ?? "") || startsOn,
      timeLabel: String(form.get("timeLabel") ?? ""),
      location: String(form.get("location") ?? ""),
      category: String(form.get("category") ?? ""),
      linkUrl: String(form.get("linkUrl") ?? ""),
      status: String(form.get("status") ?? "SCHEDULED"),
      isPublished: form.get("isPublished") === "on",
      entryType: form.get("entryType") === "CLOSURE" ? "CLOSURE" : "STANDARD",
      repeat: draftToRepeat(repeat, startsOn),
      repeatExceptions: repeat.frequency === "NEVER" ? [] : skipped,
    };
    const ok = editing
      ? await call(`/api/admin/calendar/entries/${encodeURIComponent(editing.id)}`, "PATCH", body, "Saved.")
      : await call("/api/admin/calendar/entries", "POST", body, body.isPublished ? "Added to the public calendar." : "Saved as a draft.");
    if (ok) {
      setEditing(null);
      setStartsOn("");
      setRepeat(noRepeat);
      setSkipped([]);
      formElement.reset();
    }
  }

  function remove(entry: CalendarAdminEntry) {
    // A leftover page error must not appear inside the new dialog.
    setError("");
    setRemoveTarget(entry);
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    const ok = await call(`/api/admin/calendar/entries/${encodeURIComponent(removeTarget.id)}`, "DELETE", undefined, "Removed.");
    if (ok) {
      if (editing?.id === removeTarget.id) setEditing(null);
      setRemoveTarget(null);
    }
  }

  const categoryOptions = [...new Set([
    ...entries.map((entry) => entry.category),
    ...events.map((event) => event.calendarCategory),
  ].filter(Boolean))].sort();

  return (
    <section className="page-stack calendar-admin">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Public website</p>
          <h2>Conference calendar</h2>
          <p>
            Published events appear on the public calendar automatically. Hide any that
            shouldn&apos;t, give them a category, and add dates for things registered elsewhere.
          </p>
        </div>
        <a className="secondary-button" href="/calendar" rel="noreferrer" target="_blank">
          <CalendarDays aria-hidden="true" size={15} /> View public calendar
        </a>
      </div>

      <datalist id="calendar-categories">
        {categoryOptions.map((category) => <option key={category} value={category} />)}
      </datalist>

      <div className="communications-tabs" role="tablist" aria-label="Calendar settings">
        <button aria-selected={tab === "entries"} className={tab === "entries" ? "active" : ""} onClick={() => setTab("entries")} role="tab" type="button">
          Calendar entries <span>{entries.length}</span>
        </button>
        <button aria-selected={tab === "events"} className={tab === "events" ? "active" : ""} onClick={() => setTab("events")} role="tab" type="button">
          Events <span>{events.filter((event) => event.isPublished && event.showOnCalendar).length}</span>
        </button>
      </div>

      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {/* While the remove dialog is open, its own alert shows the error; one announcement, not two. */}
      {error && !removeTarget && <div className="inline-notice error" role="alert">{error}</div>}

      {tab === "entries" && (
        <>
          <form className="panel form-stack" key={editing?.id ?? "new"} onSubmit={save} ref={formRef}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">{editing ? "Edit entry" : "New entry"}</p>
                <h2>{editing ? editing.title : "Add a date to the calendar"}</h2>
              </div>
              {editing && (
                <button className="secondary-button" onClick={() => { setEditing(null); setStartsOn(""); setRepeat(noRepeat); setSkipped([]); }} type="button">
                  <X aria-hidden="true" size={14} /> Cancel
                </button>
              )}
            </div>
            <label>
              Title
              <input defaultValue={editing?.title ?? ""} maxLength={140} name="title" placeholder="e.g. Pathfinder Bible Experience" required />
            </label>
            <div className="form-grid two-column">
              <label>
                Starts
                <input name="startsOn" onChange={(event) => setStartsOn(event.target.value)} required type="date" value={startsOn} />
              </label>
              <label>
                Ends (blank for one day)
                <input defaultValue={editing && editing.endsOn !== editing.startsOn ? editing.endsOn : ""} name="endsOn" type="date" />
              </label>
              <label>
                Time (optional)
                <input defaultValue={editing?.timeLabel ?? ""} maxLength={80} name="timeLabel" placeholder="e.g. 7:00–9:00 PM" />
              </label>
              <label>
                Location (optional)
                <input defaultValue={editing?.location ?? ""} maxLength={160} name="location" />
              </label>
              <label>
                Category (optional)
                <input defaultValue={editing?.category ?? ""} list="calendar-categories" maxLength={40} name="category" placeholder="e.g. Youth" />
              </label>
              <label>
                Type
                <select defaultValue={editing?.entryType ?? "STANDARD"} name="entryType">
                  <option value="STANDARD">Conference date</option>
                  <option value="CLOSURE">{closureLabel} (e.g. conference office closed)</option>
                </select>
              </label>
              <label>
                Status
                <select defaultValue={editing?.status ?? "SCHEDULED"} name="status">
                  {Object.entries(calendarStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
            <RepeatEditor draft={repeat} onChange={setRepeat} onSkippedChange={setSkipped} skipped={skipped} startsOn={startsOn} />
            <label>
              Link for more information (optional)
              <input defaultValue={editing?.linkUrl ?? ""} maxLength={500} name="linkUrl" placeholder="https://" type="url" />
            </label>
            <label>
              Description (optional)
              <textarea defaultValue={editing?.description ?? ""} maxLength={2000} name="description" rows={3} />
            </label>
            <label className="checkbox-label">
              <input defaultChecked={editing?.isPublished ?? true} name="isPublished" type="checkbox" /> Show on the public calendar
            </label>
            <div>
              <button className="primary-button" disabled={saving} type="submit">
                {editing ? <Save aria-hidden="true" size={16} /> : <Plus aria-hidden="true" size={16} />}
                {editing ? " Save entry" : " Add to calendar"}
              </button>
            </div>
          </form>

          <section className="panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Entries</p>
                <h2>Dates added by staff</h2>
              </div>
            </div>
            {entries.length === 0 ? (
              <div className="empty-state">
                <CalendarDays aria-hidden="true" size={27} />
                <h3>No entries yet</h3>
                <p>Add dates for events that aren&apos;t registered here, such as rallies or camporees.</p>
              </div>
            ) : (
              <ul className="calendar-admin-list">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <div>
                      <strong>{entry.title}</strong>
                      <small>
                        {formatDateRange(entry.startsOn, entry.endsOn)}
                        {entry.category ? ` · ${entry.category}` : ""}
                        {entry.location ? ` · ${entry.location}` : ""}
                        {entry.repeat ? ` · ${describeRepeat(entry.repeat)}` : ""}
                      </small>
                      <span className="calendar-admin-chips">
                        <span className={`status-chip ${entry.isPublished ? "green" : "gold"}`}>{entry.isPublished ? "On calendar" : "Draft"}</span>
                        {entry.status !== "SCHEDULED" && <span className="status-chip coral">{calendarStatusLabels[entry.status]}</span>}
                        {entry.entryType === "CLOSURE" && <span className="status-chip gold">{closureLabel}</span>}
                      </span>
                    </div>
                    <div className="calendar-admin-actions">
                      <button
                        className="secondary-button"
                        disabled={saving}
                        onClick={() => call(
                          `/api/admin/calendar/entries/${encodeURIComponent(entry.id)}`,
                          "PATCH",
                          { isPublished: !entry.isPublished },
                          entry.isPublished ? "Hidden from the public calendar." : "Shown on the public calendar.",
                        )}
                        type="button"
                      >
                        {entry.isPublished ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
                        {entry.isPublished ? " Hide" : " Show"}
                      </button>
                      <button aria-label={`Edit ${entry.title}`} className="secondary-button" disabled={saving} onClick={() => beginEdit(entry)} type="button">
                        <Pencil aria-hidden="true" size={14} />
                      </button>
                      <button aria-label={`Remove ${entry.title}`} className="secondary-button" disabled={saving} onClick={() => remove(entry)} type="button">
                        <Trash2 aria-hidden="true" size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {tab === "events" && (
        <section className="panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Events</p>
              <h2>Events on the calendar</h2>
              <p>Only published events can appear. Unpublished events stay off the calendar whatever is set here.</p>
            </div>
          </div>
          {events.length === 0 ? (
            <div className="empty-state"><CalendarDays aria-hidden="true" size={27} /><h3>No upcoming events</h3></div>
          ) : (
            <ul className="calendar-admin-list">
              {events.map((event) => {
                const visible = event.isPublished && event.showOnCalendar;
                return (
                  <li key={event.id}>
                    <div>
                      <strong>{event.name}</strong>
                      <small>{formatDateRange(event.startsOn, event.endsOn)}</small>
                      <span className="calendar-admin-chips">
                        <span className={`status-chip ${visible ? "green" : "gold"}`}>
                          {!event.isPublished ? "Not published" : event.showOnCalendar ? "On calendar" : "Hidden"}
                        </span>
                      </span>
                    </div>
                    <form
                      className="calendar-admin-actions"
                      onSubmit={(submitEvent) => {
                        submitEvent.preventDefault();
                        const category = String(new FormData(submitEvent.currentTarget).get("category") ?? "");
                        void call(`/api/admin/calendar/events/${encodeURIComponent(event.id)}`, "PATCH", { calendarCategory: category }, "Category saved.");
                      }}
                    >
                      <label>
                        <span className="sr-only">Category for {event.name}</span>
                        <input defaultValue={event.calendarCategory} list="calendar-categories" maxLength={40} name="category" placeholder="Category" />
                      </label>
                      <button className="secondary-button" disabled={saving} type="submit"><Save aria-hidden="true" size={14} /><span className="sr-only">Save category</span></button>
                      <button
                        className="secondary-button"
                        disabled={saving || !event.isPublished}
                        onClick={() => call(
                          `/api/admin/calendar/events/${encodeURIComponent(event.id)}`,
                          "PATCH",
                          { showOnCalendar: !event.showOnCalendar },
                          event.showOnCalendar ? `${event.name} is hidden from the calendar.` : `${event.name} is on the calendar.`,
                        )}
                        type="button"
                      >
                        {event.showOnCalendar ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
                        {event.showOnCalendar ? " Hide" : " Show"}
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <ConfirmDialog
        busy={saving}
        confirmLabel={removeTarget ? `Remove "${removeTarget.title}"` : "Remove entry"}
        destructive
        error={error}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => void confirmRemove()}
        open={removeTarget !== null}
        title={removeTarget ? `Remove "${removeTarget.title}" from the calendar?` : "Remove entry?"}
      >
        <p>The entry disappears from the calendar for everyone right away. This can&apos;t be undone.</p>
      </ConfirmDialog>
    </section>
  );
}

/** "Repeats": never, daily, weekly (on chosen weekdays), monthly or yearly, with an end and skipped dates. */
function RepeatEditor({
  draft,
  onChange,
  skipped,
  onSkippedChange,
  startsOn,
}: {
  draft: RepeatDraft;
  onChange: (draft: RepeatDraft) => void;
  skipped: string[];
  onSkippedChange: (skipped: string[]) => void;
  startsOn: string;
}) {
  const update = (patch: Partial<RepeatDraft>) => onChange({ ...draft, ...patch });
  const rule = draftToRepeat(draft, startsOn);
  const startDay = weekdayOf(startsOn);
  const hint = shortMonthHint(draft, startsOn);
  const preview = rule && startsOn ? previewOccurrences({ startsOn }, rule, skipped, 12) : [];
  const unit = { DAILY: "day(s)", WEEKLY: "week(s)", MONTHLY: "month(s)", YEARLY: "year(s)" };

  function toggleSkip(date: string) {
    onSkippedChange(skipped.includes(date) ? skipped.filter((value) => value !== date) : [...skipped, date].sort());
  }

  return (
    <fieldset className="calendar-repeat-editor">
      <legend>Repeats</legend>
      <div className="form-grid two-column">
        <label>
          Repeat
          <select name="repeatFrequency" onChange={(event) => update({ frequency: event.target.value as RepeatDraft["frequency"] })} value={draft.frequency}>
            <option value="NEVER">Never</option>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly (same day of the month)</option>
            <option value="YEARLY">Yearly</option>
          </select>
        </label>
        {draft.frequency !== "NEVER" && (
          <label>
            Every
            <span className="calendar-admin-actions">
              <input
                aria-label="Repeat interval"
                max={99}
                min={1}
                name="repeatInterval"
                onChange={(event) => update({ interval: Number(event.target.value) })}
                type="number"
                value={draft.interval}
              />
              <span>{unit[draft.frequency]}</span>
            </span>
          </label>
        )}
      </div>

      {hint && <p className="calendar-repeat-hint" role="note">{hint}</p>}

      {draft.frequency === "WEEKLY" && (
        <div role="group" aria-label="Repeat on these weekdays">
          <div className="calendar-weekday-picks">
            {weekdayLabels.map((label, day) => (
              <label key={label}>
                <input
                  checked={draft.weekdays.includes(day) || day === startDay}
                  disabled={day === startDay}
                  onChange={(event) => update({
                    weekdays: event.target.checked ? [...draft.weekdays, day].sort() : draft.weekdays.filter((value) => value !== day),
                  })}
                  type="checkbox"
                />
                {label}
              </label>
            ))}
          </div>
          <small>The start date&apos;s weekday is always included.</small>
        </div>
      )}

      {draft.frequency !== "NEVER" && (
        <>
          <div className="form-grid two-column">
            <label>
              Ends
              <select name="repeatEnd" onChange={(event) => update({ endMode: event.target.value as RepeatDraft["endMode"] })} value={draft.endMode}>
                <option value="never">Never</option>
                <option value="until">On a date</option>
                <option value="count">After a number of times</option>
              </select>
            </label>
            {draft.endMode === "until" && (
              <label>
                Last date
                <input name="repeatUntil" onChange={(event) => update({ until: event.target.value })} required type="date" value={draft.until} />
              </label>
            )}
            {draft.endMode === "count" && (
              <label>
                Number of times
                <input max={500} min={1} name="repeatCount" onChange={(event) => update({ count: Number(event.target.value) })} type="number" value={draft.count} />
              </label>
            )}
          </div>

          {preview.length > 0 && (
            <div>
              <p><strong>Upcoming dates</strong> <small>Skip a date to leave that one off the calendar.</small></p>
              <ul className="calendar-repeat-dates">
                {preview.map(({ startsOn: date, skipped: isSkipped }) => (
                  <li className={isSkipped ? "is-skipped" : ""} key={date}>
                    <span>{formatDateRange(date, date)}{isSkipped ? " (skipped)" : ""}</span>
                    <button
                      aria-label={`${isSkipped ? "Restore" : "Skip"} ${formatDateRange(date, date)}`}
                      className="secondary-button"
                      onClick={() => toggleSkip(date)}
                      type="button"
                    >
                      {isSkipped ? "Restore" : "Skip"}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
