"use client";

import { useRef, useState } from "react";
import { CalendarDays, Eye, EyeOff, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { calendarStatusLabels, formatDateRange } from "@/modules/calendar/domain";
import type { CalendarAdminEntry, CalendarAdminEvent } from "@/modules/calendar/repository";

type ApiResponse = {
  entries?: CalendarAdminEntry[];
  events?: CalendarAdminEvent[];
  message?: string;
  issues?: Array<{ message?: string }>;
};

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
  const formRef = useRef<HTMLFormElement>(null);

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
    };
    const ok = editing
      ? await call(`/api/admin/calendar/entries/${encodeURIComponent(editing.id)}`, "PATCH", body, "Saved.")
      : await call("/api/admin/calendar/entries", "POST", body, body.isPublished ? "Added to the public calendar." : "Saved as a draft.");
    if (ok) {
      setEditing(null);
      formElement.reset();
    }
  }

  async function remove(entry: CalendarAdminEntry) {
    if (!window.confirm(`Remove "${entry.title}" from the calendar? This can't be undone.`)) return;
    await call(`/api/admin/calendar/entries/${encodeURIComponent(entry.id)}`, "DELETE", undefined, "Removed.");
    if (editing?.id === entry.id) setEditing(null);
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
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      {tab === "entries" && (
        <>
          <form className="panel form-stack" key={editing?.id ?? "new"} onSubmit={save} ref={formRef}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">{editing ? "Edit entry" : "New entry"}</p>
                <h2>{editing ? editing.title : "Add a date to the calendar"}</h2>
              </div>
              {editing && (
                <button className="secondary-button" onClick={() => setEditing(null)} type="button">
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
                <input defaultValue={editing?.startsOn ?? ""} name="startsOn" required type="date" />
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
                Status
                <select defaultValue={editing?.status ?? "SCHEDULED"} name="status">
                  {Object.entries(calendarStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
            </div>
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
                      </small>
                      <span className="calendar-admin-chips">
                        <span className={`status-chip ${entry.isPublished ? "green" : "gold"}`}>{entry.isPublished ? "On calendar" : "Draft"}</span>
                        {entry.status !== "SCHEDULED" && <span className="status-chip coral">{calendarStatusLabels[entry.status]}</span>}
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
    </section>
  );
}
