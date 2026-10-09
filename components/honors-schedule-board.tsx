"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import Link from "next/link";
import { GripVertical, MoveRight, Pencil, Plus, Save, Trash2, TriangleAlert, Users, X } from "lucide-react";
import { staffPageTitles } from "@/components/staff-navigation";
import {
  ALL_SESSIONS_COLUMN,
  type BoardCard,
  type BoardRoom,
  type BoardSection,
  type MoveTarget,
  type ScheduleBoardData,
  buildBoardSections,
  instructorClashes,
  moveTargetProblem,
  seatStatus,
  seatStatusLabels,
} from "@/modules/honors/schedule-board";

type ApiResult = Partial<ScheduleBoardData> & { message?: string; issues?: Array<{ message?: string }> };

/**
 * The Honors Weekend schedule board (#834): rooms down the side, sessions across
 * the top, one card per class. A class moves by dragging (a mouse) or by
 * choosing "Move" on its card and then "Move here" on a cell (a phone, a
 * keyboard, a screen reader): both send the same request, and the server
 * decides. The grid scrolls inside its own region so the page never does.
 */
export function HonorsScheduleBoard({ eventId, initialBoard }: { eventId: string; initialBoard: ScheduleBoardData }) {
  const [board, setBoard] = useState(initialBoard);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const requestRef = useRef(0);
  const base = `/api/events/${encodeURIComponent(eventId)}/honors`;

  const sections = useMemo(() => buildBoardSections(board), [board]);
  const clashes = useMemo(() => instructorClashes(board.cards, board.sessions), [board.cards, board.sessions]);
  const cardById = useMemo(() => new Map(board.cards.map((card) => [card.id, card])), [board.cards]);
  const sessionName = useMemo(() => new Map(board.sessions.map((session) => [session.id, session.name])), [board.sessions]);
  const roomName = useMemo(() => new Map(board.rooms.map((room) => [room.id, room.name])), [board.rooms]);
  const selected = selectedId ? cardById.get(selectedId) ?? null : null;
  const hasSites = board.sites.length > 0;

  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedId(null);
        focusMove(selected.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  /** Puts keyboard focus back on a class's Move button once the board has re-rendered. */
  function focusMove(id: string) {
    window.setTimeout(() => document.getElementById(`sb-move-${id}`)?.focus(), 0);
  }

  async function call(url: string, method: string, body: unknown) {
    const request = (requestRef.current += 1);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const result = await response.json().catch(() => ({})) as ApiResult;
      if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "The change could not be saved.");
      if (request === requestRef.current && result.cards && result.rooms && result.sessions && result.sites) {
        setBoard({ sites: result.sites, sessions: result.sessions, rooms: result.rooms, cards: result.cards });
      }
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The change could not be saved.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function targetProblem(card: BoardCard, target: MoveTarget) {
    return moveTargetProblem(card, target, board.rooms, board.cards);
  }

  async function move(card: BoardCard, target: MoveTarget) {
    const problem = targetProblem(card, target);
    if (problem) {
      setError(problem);
      return;
    }
    const sessionChange = card.span === "SINGLE_SESSION" && target.column !== card.sessionId ? { sessionId: target.column } : {};
    setSelectedId(null);
    const ok = await call(`${base}/offerings/${encodeURIComponent(card.id)}/move`, "POST", { roomId: target.roomId, ...sessionChange });
    if (ok) {
      const where = [
        target.column === ALL_SESSIONS_COLUMN ? null : sessionName.get(target.column),
        target.roomId ? roomName.get(target.roomId) : "no room",
      ].filter(Boolean).join(", ");
      setNotice(`Moved ${card.title} to ${where}.`);
    }
    focusMove(card.id);
  }

  function dragOver(event: DragEvent, target: MoveTarget, key: string) {
    const card = dragId ? cardById.get(dragId) : null;
    if (!card || targetProblem(card, target)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (overKey !== key) setOverKey(key);
  }

  function drop(event: DragEvent, target: MoveTarget) {
    event.preventDefault();
    const card = dragId ? cardById.get(dragId) : null;
    setDragId(null);
    setOverKey(null);
    if (card) void move(card, target);
  }

  async function addRoom(event: FormEvent<HTMLFormElement>, section: BoardSection) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const siteRooms = board.rooms.filter((room) => room.locationId === section.siteId);
    const ok = await call(`${base}/rooms`, "POST", {
      name: String(data.get("name") ?? ""),
      capacity: Number(data.get("capacity")),
      locationId: section.siteId,
      sortOrder: Math.min(99, siteRooms.length),
    });
    if (ok) {
      form.reset();
      setNotice("Room added.");
    }
  }

  async function saveRoom(event: FormEvent<HTMLFormElement>, room: BoardRoom) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const ok = await call(`${base}/rooms/${encodeURIComponent(room.id)}`, "PATCH", { name: String(data.get("name") ?? ""), capacity: Number(data.get("capacity")) });
    if (ok) {
      setEditingRoomId(null);
      setNotice("Room saved.");
    }
  }

  async function removeRoom(room: BoardRoom) {
    if (!window.confirm(`Remove the room ${room.name}?`)) return;
    if (await call(`${base}/rooms/${encodeURIComponent(room.id)}`, "DELETE", undefined)) setNotice("Room removed.");
  }

  return (
    <section className="page-stack schedule-board">
      <div className="page-intro">
        <div>
          <p className="eyebrow">Honors Weekend</p>
          <h2 className="duplicate-page-title">{staffPageTitles.honorsSchedule}</h2>
          <p>
            Rooms down the side, sessions across the top. Drag a class to another room or session, or choose Move on a class and then Move
            here. A move never changes who is enrolled: it is refused if the room is too small or busy, or if enrolled people would land in a session
            where they already hold another class.
          </p>
        </div>
        <div className="intro-actions">
          <span className="count-badge">{board.cards.length} classes</span>
        </div>
      </div>

      <ul className="schedule-legend" aria-label="What the colors and labels mean">
        <li><span className="schedule-chip is-nearly">Nearly full</span> 80% of the seats or more</li>
        <li><span className="schedule-chip is-full">Full</span> every seat taken</li>
        <li><span className="schedule-chip is-clash"><TriangleAlert aria-hidden="true" size={12} /> Clash</span> an instructor in two classes at once</li>
      </ul>

      <div aria-live="polite" role="status">
        {notice && <div className="inline-notice success">{notice}</div>}
        {selected && (
          <div className="inline-notice schedule-picking">
            Choose where to move <strong>{selected.title}</strong>. A place that can&apos;t take it says why.
            <button className="secondary-button" onClick={() => { setSelectedId(null); focusMove(selected.id); }} type="button">
              <X aria-hidden="true" size={14} /> Cancel move
            </button>
          </div>
        )}
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}

      {sections.map((section) => {
        const siteKey = section.siteId ?? "none";
        const columns = [...section.sessions.map((session) => ({ key: session.id, name: session.name })), { key: ALL_SESSIONS_COLUMN, name: "All sessions" }];
        const sectionRooms = board.rooms.filter((room) => room.locationId === section.siteId);
        return (
          <section className="panel schedule-section" key={siteKey}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">{hasSites ? "Site" : "Schedule"}</p>
                <h2 translate="no">{section.name}</h2>
              </div>
              <span className="count-badge">{sectionRooms.length} rooms</span>
            </div>
            {section.sessions.length === 0 && <p className="field-help">This site has no sessions yet. Add them on the class setup page.</p>}
            <div
              aria-label={`Schedule for ${section.name}. Scrolls sideways.`}
              className="schedule-scroll"
              role="region"
              tabIndex={0}
            >
              <div className="schedule-grid" style={{ gridTemplateColumns: `minmax(120px, 150px) repeat(${columns.length}, minmax(210px, 1fr))` }}>
                <div className="schedule-corner" />
                {columns.map((column) => (
                  <div className="schedule-colhead" key={column.key}>{column.name}</div>
                ))}
                {section.rows.map((row) => (
                  <RowCells
                    busy={busy}
                    clashes={clashes}
                    columns={columns}
                    dragId={dragId}
                    key={row.room?.id ?? "none"}
                    onDragEnd={() => { setDragId(null); setOverKey(null); }}
                    onDragOver={dragOver}
                    onDragStart={(card) => { setDragId(card.id); setSelectedId(null); setError(""); }}
                    onDrop={drop}
                    onMove={move}
                    onSelect={(card) => { setSelectedId(selectedId === card.id ? null : card.id); setError(""); }}
                    overKey={overKey}
                    row={row}
                    section={section}
                    selected={selected}
                    targetProblem={targetProblem}
                  />
                ))}
              </div>
            </div>

            <details className="schedule-rooms">
              <summary>Rooms at {section.name}</summary>
              <ul className="honor-session-list">
                {sectionRooms.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)).map((room) => (
                  <li key={room.id}>
                    <strong>{room.name}</strong>
                    <small>seats {room.capacity}</small>
                    <button aria-label={`Edit room ${room.name}`} className="text-button" disabled={busy} onClick={() => setEditingRoomId(editingRoomId === room.id ? null : room.id)} type="button">
                      <Pencil aria-hidden="true" size={13} /> Edit
                    </button>
                    <button aria-label={`Remove room ${room.name}`} className="text-button" disabled={busy} onClick={() => removeRoom(room)} type="button">
                      <Trash2 aria-hidden="true" size={13} /> Remove
                    </button>
                    {editingRoomId === room.id && (
                      <form className="honor-inline-form schedule-room-form" key={`${room.id}-${room.capacity}-${room.name}`} onSubmit={(event) => saveRoom(event, room)}>
                        <label>Room name<input defaultValue={room.name} maxLength={80} name="name" required /></label>
                        <label>Seats<input defaultValue={room.capacity} max={10000} min={1} name="capacity" required type="number" /></label>
                        <button className="primary-button" disabled={busy} type="submit"><Save aria-hidden="true" size={14} /> Save room</button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
              <form className="honor-inline-form schedule-room-form" onSubmit={(event) => addRoom(event, section)}>
                <label>Room name<input maxLength={80} name="name" placeholder="e.g. Fellowship hall" required /></label>
                <label>Seats<input defaultValue={20} max={10000} min={1} name="capacity" required type="number" /></label>
                <button className="secondary-button" disabled={busy} type="submit"><Plus aria-hidden="true" size={14} /> Add room</button>
              </form>
              <p className="field-help">A class can&apos;t have more seats than its room. To seat more, raise the room first, then the class.</p>
            </details>
          </section>
        );
      })}

      <p className="field-help">
        Add or edit sessions and classes on <Link href={`/more/honors?event=${encodeURIComponent(eventId)}`}>{staffPageTitles.honors}</Link>.
      </p>
    </section>
  );
}

type RowProps = {
  row: BoardSection["rows"][number];
  section: BoardSection;
  columns: Array<{ key: string; name: string }>;
  clashes: Map<string, string[]>;
  selected: BoardCard | null;
  dragId: string | null;
  overKey: string | null;
  busy: boolean;
  targetProblem: (card: BoardCard, target: MoveTarget) => string | null;
  onSelect: (card: BoardCard) => void;
  onMove: (card: BoardCard, target: MoveTarget) => void;
  onDragStart: (card: BoardCard) => void;
  onDragEnd: () => void;
  onDragOver: (event: DragEvent, target: MoveTarget, key: string) => void;
  onDrop: (event: DragEvent, target: MoveTarget) => void;
};

// Reasons that hold for a whole column or row of cells are not repeated in every cell.
const quietProblems = ["An all-sessions class stays", "A single-session class can't move into", "It is already here"];

function RowCells({ row, section, columns, clashes, selected, dragId, overKey, busy, targetProblem, onSelect, onMove, onDragStart, onDragEnd, onDragOver, onDrop }: RowProps) {
  return (
    <>
      <div className="schedule-rowhead">
        <strong translate="no">{row.room ? row.room.name : "No room yet"}</strong>
        <small>{row.room ? `seats ${row.room.capacity}` : "not placed"}</small>
      </div>
      {columns.map((column) => {
        const target: MoveTarget = { siteId: section.siteId, roomId: row.room?.id ?? null, column: column.key };
        const key = `${row.room?.id ?? "none"}:${column.key}`;
        const cards = row.cells.get(column.key) ?? [];
        const problem = selected ? targetProblem(selected, target) : null;
        const canDrop = dragId !== null && overKey === key;
        return (
          <div
            className={`schedule-cell${canDrop ? " is-over" : ""}${selected && !problem ? " is-target" : ""}`}
            key={key}
            onDragOver={(event) => onDragOver(event, target, key)}
            onDrop={(event) => onDrop(event, target)}
          >
            {cards.map((card) => {
              const status = seatStatus(card.seatsTaken, card.capacity);
              const clash = clashes.get(card.id) ?? [];
              const people = card.instructors.map((instructor) => instructor.name);
              return (
                <article
                  className={`schedule-card is-${status.toLowerCase().replace("_", "-")}${selected?.id === card.id ? " is-selected" : ""}${card.isActive ? "" : " is-inactive"}`}
                  draggable={!busy}
                  key={card.id}
                  onDragEnd={onDragEnd}
                  onDragStart={(event) => { event.dataTransfer.setData("text/plain", card.id); event.dataTransfer.effectAllowed = "move"; onDragStart(card); }}
                >
                  <h3><GripVertical aria-hidden="true" className="schedule-grip" size={14} /> {card.title}</h3>
                  <p className="schedule-seats">
                    <Users aria-hidden="true" size={13} />
                    <span>{card.seatsTaken} / {card.capacity} seats</span>
                    {status !== "OPEN" && <span className={`schedule-chip is-${status === "FULL" ? "full" : "nearly"}`}>{seatStatusLabels[status]}</span>}
                    {!card.isActive && <span className="schedule-chip">Inactive</span>}
                  </p>
                  {/* #833 extension point: assigned instructors, when the data exists; otherwise the legacy free-text teacher. */}
                  {people.length > 0
                    ? <p className="schedule-teacher">Instructor{people.length === 1 ? "" : "s"}: <span translate="no">{people.join(", ")}</span></p>
                    : card.teacherName && <p className="schedule-teacher">Teacher: <span translate="no">{card.teacherName}</span></p>}
                  {clash.map((message) => (
                    <p className="schedule-clash" key={message}><TriangleAlert aria-hidden="true" size={13} /> <span className="schedule-chip is-clash">Clash</span> {message}</p>
                  ))}
                  <button
                    aria-label={selected?.id === card.id ? `Cancel moving ${card.title}` : `Move ${card.title}`}
                    aria-pressed={selected?.id === card.id}
                    className="secondary-button schedule-move"
                    disabled={busy}
                    id={`sb-move-${card.id}`}
                    onClick={() => onSelect(card)}
                    type="button"
                  >
                    <MoveRight aria-hidden="true" size={14} /> {selected?.id === card.id ? "Cancel move" : "Move"}
                  </button>
                </article>
              );
            })}
            {selected && !cards.some((card) => card.id === selected.id) && (
              problem
                ? (quietProblems.some((prefix) => problem.startsWith(prefix)) ? null : <p className="schedule-blocked">{problem}</p>)
                : (
                  <button
                    aria-label={`Move ${selected.title} to ${row.room?.name ?? "no room"}, ${column.name}`}
                    className="primary-button schedule-here"
                    disabled={busy}
                    onClick={() => onMove(selected, target)}
                    type="button"
                  >
                    Move here
                  </button>
                )
            )}
          </div>
        );
      })}
    </>
  );
}
