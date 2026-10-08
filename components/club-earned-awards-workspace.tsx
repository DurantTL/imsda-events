"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AlertTriangle, Award, CheckCircle2, Download, Eye, GraduationCap, Plus, Search, Sparkles, Trash2, Trophy, UsersRound, X } from "lucide-react";
import { HonorCombobox } from "@/components/honor-combobox";
import styles from "@/components/club-orders.module.css";
import { clubClassLevelLabels, clubClassLevels, type ClubClassLevel } from "@/modules/club-rosters/domain";
import { awardEntryTooLarge, awardStatusLabels, MAX_AWARD_NEEDS_PER_ENTRY } from "@/modules/earned-awards/domain";
import type { EarnedAwardsWorkspaceData } from "@/modules/earned-awards/order-source";
import { cardCell } from "@/components/table-card-labels";
import { SortOrderNote, SortableHeader } from "@/components/list-sort";
import { flipDirection, nameSortLabel, sortByName, sortOrderText, type SortDirection } from "@/lib/list-sort";
import { effectiveChoice, makeSearchMatcher, matchesSearch } from "@/lib/search-match";

export type ClubEarnedAwardsData = EarnedAwardsWorkspaceData;

export const emptyEarnedAwardsData: ClubEarnedAwardsData = {
  catalog: [], members: [], needs: [], awardedCount: 0, insignia: [], patches: [], masterAwards: [],
};

type ApiResult = {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
  created?: number;
  skipped?: number;
  marked?: number;
  removed?: number;
  dismissed?: number;
};

/** The class levels as picker options (#827): the id is the level, the name its label. */
const classLevelOptions = clubClassLevels.map((level) => ({ id: level, name: clubClassLevelLabels[level] }));

/** The same bulk limit the order routes accept. */
const BULK_LIMIT = 500;

/** Every word typed appears in the member's name or class, ignoring case. A blank search matches everyone. */
export function memberMatchesSearch(member: { firstName: string; lastName: string; classLabel?: string | null }, query: string) {
  // "Last, First" works too, and accents and punctuation never get in the way (#799).
  return matchesSearch([member.firstName, member.lastName, member.classLabel], query);
}

type SearchableMember = {
  personId: string;
  firstName: string;
  lastName: string;
  classLabel?: string | null;
  /** Recorded completions by class level, to the calendar date. */
  completed?: Partial<Record<ClubClassLevel, string>>;
};

/** The members table's status filter: everyone, or who has / has not completed the chosen class. */
export type ClassStatusFilter = "" | "COMPLETED" | "NOT_COMPLETED";

export const classStatusFilterLabels = { COMPLETED: "Completed", NOT_COMPLETED: "Not completed" } as const;

/** The members the table shows: the search, then the status of the chosen class. */
export function filterMembers<T extends SearchableMember>(members: readonly T[], query: string, status: ClassStatusFilter, classLevel: ClubClassLevel): T[] {
  return shownMembers(members, query).filter((member) => {
    if (!status) return true;
    const done = Boolean(member.completed?.[classLevel]);
    return status === "COMPLETED" ? done : !done;
  });
}

const dateLabel = (value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** Members the search currently shows. */
export function shownMembers<T extends SearchableMember>(members: readonly T[], query: string): T[] {
  const matches = makeSearchMatcher(query);
  return members.filter((member) => matches([member.firstName, member.lastName, member.classLabel]));
}

/**
 * The ids a bulk action acts on: selected AND currently shown. A member hidden by
 * the search stays ticked but is never included, so nobody is acted on out of sight.
 */
export function visibleSelectedIds(members: readonly SearchableMember[], selected: ReadonlySet<string>, query: string): string[] {
  return shownMembers(members, query).map((member) => member.personId).filter((id) => selected.has(id));
}

/** "Select all" with a search active ticks only the members shown, keeping earlier ticks. */
export function selectShown(members: readonly SearchableMember[], selected: ReadonlySet<string>, query: string): Set<string> {
  return new Set([...selected, ...shownMembers(members, query).map((member) => member.personId)]);
}

/** The request bodies the two bulk actions post, built from visible selected members only. */
export function completionPayload(members: readonly SearchableMember[], selected: ReadonlySet<string>, query: string, classLevel: ClubClassLevel, completedOn: string) {
  return { personIds: visibleSelectedIds(members, selected, query), classLevel, completedOn };
}
export function recordPayload(members: readonly SearchableMember[], selected: ReadonlySet<string>, query: string, itemIds: string[], alreadyHasIt: boolean) {
  return { personIds: visibleSelectedIds(members, selected, query), itemIds, alreadyHasIt };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function toggled<T>(current: ReadonlySet<T>, value: T, on: boolean) {
  const next = new Set(current);
  if (on) next.add(value);
  else next.delete(value);
  return next;
}

/**
 * A club's Earned awards screen (#532): class insignia, event patches, Good
 * Conduct and TLT items, and Master Award progress, all as needs on the same
 * order list as honors and uniforms (Orders). Insignia and patches are only
 * ever *suggested*: nothing is added until a director or deputy confirms.
 * Only names, item names and counts appear; no birth date or medical field is
 * loaded. A registrar or Area Coordinator (`readOnly`) sees the open items and
 * Master Award progress with no controls.
 */
export function ClubEarnedAwardsWorkspace({
  organizationId,
  initial,
  ordersHref,
  exportCsvHref,
  exportPrintHref,
  readOnly = false,
  classHistoryBase,
}: {
  organizationId: string;
  initial: ClubEarnedAwardsData;
  ordersHref: string;
  /** The class tracking CSV and printable report (#701); omitted where the export isn't offered. */
  exportCsvHref?: string;
  exportPrintHref?: string;
  readOnly?: boolean;
  /** The club portal's class tracking address (#791); omitted on the area view, where the history page does not open. */
  classHistoryBase?: string;
}) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/awards`;

  // Suggestions: every item and member is ticked to start with; unticking leaves it out.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  // One member selection, shared by Mark completed and Add by hand: the members table is listed once.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [memberQuery, setMemberQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<ClassStatusFilter>("");
  const [nameDirection, setNameDirection] = useState<SortDirection>("asc");
  const [classLevel, setClassLevel] = useState<ClubClassLevel>("FRIEND");
  const [completedOn, setCompletedOn] = useState(today);
  // Add by hand.
  const [itemId, setItemId] = useState("");
  const [itemQuery, setItemQuery] = useState("");
  const [chosen, setChosen] = useState<Array<{ itemId: string; label: string }>>([]);
  const [alreadyHasIt, setAlreadyHasIt] = useState(false);
  // Open items.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Master Awards: members ticked per rule.
  const [masterPicked, setMasterPicked] = useState<Record<string, Set<string>>>({});

  async function refresh() {
    const response = await fetch(base, { cache: "no-store" });
    const result = await response.json().catch(() => ({})) as Partial<ClubEarnedAwardsData>;
    if (response.ok && result.needs && result.masterAwards && result.catalog && result.members && result.insignia && result.patches) {
      setData({
        catalog: result.catalog, members: result.members, needs: result.needs, awardedCount: result.awardedCount ?? 0,
        insignia: result.insignia, patches: result.patches, masterAwards: result.masterAwards,
      });
    }
  }

  async function post(url: string, body: unknown) {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json().catch(() => ({})) as ApiResult;
    if (!response.ok) {
      throw new Error(
        result.error === "MFA_UNLOCK_REQUIRED"
          ? "Confirm it's you again: reload this page and enter your authenticator code."
          : result.message ?? result.issues?.[0]?.message ?? "That could not be saved.",
      );
    }
    return result;
  }

  async function act(run: () => Promise<string>) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      setNotice(await run());
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That could not be saved.");
      return false;
    } finally {
      await refresh().catch(() => undefined);
      setBusy(false);
    }
  }

  const skippedNote = (skipped: number | undefined) => (skipped ? ` ${skipped} already on file, so ${skipped === 1 ? "it was" : "they were"} skipped.` : "");

  // ---- suggestions
  const insigniaKey = (completionId: string, id: string) => `i:${completionId}:${id}`;
  const patchKey = (eventId: string, id: string, personId: string) => `p:${eventId}:${id}:${personId}`;

  async function addInsignia(completionId: string, itemIds: string[]) {
    return act(async () => {
      const result = await post(`${base}/insignia/confirm`, { confirmations: [{ completionId, itemIds }] });
      return `Added ${plural(result.created ?? 0, "insignia item", "insignia items")} to the order list.${skippedNote(result.skipped)}`;
    });
  }

  async function skipInsignia(completionId: string) {
    return act(async () => {
      await post(`${base}/insignia/dismiss`, { completionIds: [completionId] });
      return "Skipped. This class's insignia won't be suggested again.";
    });
  }

  async function addPatches(eventId: string, patchItemId: string, personIds: string[]) {
    return act(async () => {
      const result = await post(`${base}/patches/confirm`, { eventId, itemId: patchItemId, personIds });
      return `Added ${plural(result.created ?? 0, "patch", "patches")} to the order list.${skippedNote(result.skipped)}`;
    });
  }

  // ---- classes
  async function markClass() {
    const ok = await act(async () => {
      const result = await post(`${base}/completions`, completionPayload(tableMembers, selected, "", classLevel, completedOn));
      const created = result.created ?? 0;
      return `Marked ${plural(created, "member", "members")} as having completed ${clubClassLevelLabels[classLevel]}.${skippedNote(result.skipped)} Their insignia is suggested below; nothing is added until you confirm.`;
    });
    if (ok) setSelected(new Set());
  }

  // ---- add by hand
  const matchingCatalog = useMemo(() => (() => {
    const matches = makeSearchMatcher(itemQuery);
    // An item already chosen to record is not offered again.
    return data.catalog.filter((row) => matches([row.name]) && !chosen.some((entry) => entry.itemId === row.itemId));
  })(), [data.catalog, itemQuery, chosen]);
  // One match needs no second click, and a search never leaves a hidden item chosen (#799).
  const chosenItemId = effectiveChoice(itemId, matchingCatalog.map((row) => ({ id: row.itemId })), itemQuery);
  const group = data.catalog.find((entry) => entry.itemId === chosenItemId);
  const sections = useMemo(() => {
    const bySection = new Map<string, { label: string; items: ClubEarnedAwardsData["catalog"] }>();
    for (const row of matchingCatalog) {
      const section = bySection.get(row.section) ?? { label: row.sectionLabel, items: [] };
      section.items.push(row);
      bySection.set(row.section, section);
    }
    return [...bySection.entries()];
  }, [matchingCatalog]);

  function addItem() {
    if (!group || chosen.some((entry) => entry.itemId === group.itemId)) return;
    setChosen((current) => [...current, { itemId: group.itemId, label: group.name }]);
    setItemId("");
    setItemQuery("");
  }

  async function record() {
    const ok = await act(async () => {
      const result = await post(base, recordPayload(tableMembers, selected, "", chosen.map((entry) => entry.itemId), alreadyHasIt));
      const created = result.created ?? 0;
      const marked = result.marked ?? 0;
      const what = alreadyHasIt
        ? `Recorded ${created} as already awarded${marked > 0 ? ` and marked ${marked} existing ${marked === 1 ? "item" : "items"} as awarded` : ""}. Stock wasn't changed.`
        : `Recorded ${plural(created, "earned item", "earned items")}.`;
      return `${what}${skippedNote(result.skipped)}`;
    });
    if (ok) {
      setChosen([]);
      setSelected(new Set());
      setAlreadyHasIt(false);
    }
  }

  // ---- open items
  const editableNeedIds = data.needs.filter((need) => need.status === "NEEDED").map((need) => need.needId);
  const pickedNeeded = [...picked].filter((id) => editableNeedIds.includes(id));

  async function inChunks(ids: string[], url: string, key: "marked" | "removed") {
    let total = 0;
    for (let start = 0; start < ids.length; start += BULK_LIMIT) {
      total += (await post(url, { needIds: ids.slice(start, start + BULK_LIMIT) }))[key] ?? 0;
    }
    return total;
  }

  async function alreadyHaveIt() {
    const ids = pickedNeeded;
    const ok = await act(async () => {
      const marked = await inChunks(ids, `/api/attendee/clubs/${encodeURIComponent(organizationId)}/orders/already-awarded`, "marked");
      return `Marked ${marked} as already awarded. Stock wasn't changed.`;
    });
    if (ok) setPicked(new Set());
  }

  async function remove() {
    const ids = pickedNeeded;
    const ok = await act(async () => {
      const removed = await inChunks(ids, `${base}/remove`, "removed");
      return `Removed ${plural(removed, "earned item", "earned items")}.`;
    });
    if (ok) setPicked(new Set());
  }

  // ---- Master Awards
  async function addMaster(ruleId: string) {
    const personIds = [...(masterPicked[ruleId] ?? [])];
    const ok = await act(async () => {
      const result = await post(`${base}/master`, { ruleId, personIds });
      return `Added ${plural(result.created ?? 0, "Master Award", "Master Awards")} to the order list.${skippedNote(result.skipped)}`;
    });
    if (ok) setMasterPicked((current) => ({ ...current, [ruleId]: new Set() }));
  }

  // The one members table: search, then the chosen class's status, sorted by name. Bulk actions count and
  // send only members that are selected and shown (a filter can hide ticked ones).
  const tableMembers = sortByName(filterMembers(data.members, memberQuery, statusFilter, classLevel), nameDirection);
  const selectedCount = visibleSelectedIds(tableMembers, selected, "").length;
  const knownSelected = data.members.filter((member) => selected.has(member.personId)).length;
  const hiddenSelected = knownSelected - selectedCount;
  const classCount = selectedCount;
  const handCount = selectedCount;
  const entryCount = chosen.length * handCount;
  const tooMany = awardEntryTooLarge(handCount, chosen.length);
  const canRecord = !busy && chosen.length > 0 && handCount > 0 && !tooMany;
  const suggestionCount = data.insignia.length + data.patches.length;

  return (
    <section aria-labelledby="class-tracking-heading" className="public-manage-card">
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Club supplies</p>
          <h2 id="class-tracking-heading">Class tracking</h2>
        </div>
        <div className="club-roster-heading-actions">
          <span className="count-badge">{data.needs.length} open</span>
          {(exportCsvHref || exportPrintHref) && (
            <div className="report-actions" role="group" aria-label="Export class tracking">
              {exportCsvHref && <a className="secondary-button" href={exportCsvHref}><Download aria-hidden="true" size={14} /> Export CSV</a>}
              {exportPrintHref && <Link className="secondary-button" href={exportPrintHref}>Print report</Link>}
            </div>
          )}
        </div>
      </div>
      {readOnly ? (
        <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only. Shows what&apos;s on file. The club director or deputy records and confirms awards.</p>
      ) : (
        <p className={`field-help earned-help ${styles.helpText}`}>Class insignia, event patches, Good Conduct and TLT items, and Master Awards. They join the order list on <Link href={ordersHref}>Orders</Link> with honors and uniforms.</p>
      )}
      {notice && <p className="inline-notice success" role="status">{notice}</p>}
      {error && <p className="inline-notice error" role="alert">{error}</p>}

      {!readOnly && (
        <section aria-labelledby="earned-members" className={styles.block}>
          <h3 id="earned-members"><UsersRound aria-hidden="true" size={14} /> Members ({data.members.length})</h3>
          {data.members.length === 0 ? (
            <p className="public-manage-empty" role="status"><UsersRound aria-hidden="true" size={17} /> No active members are on this year&apos;s roster yet.</p>
          ) : (
            <>
              <div className="club-roster-tools">
                <label className="honor-name-search" htmlFor="earned-search">
                  Find a member
                  <span className="honor-name-search-field">
                    <Search aria-hidden="true" size={14} />
                    <input
                      autoComplete="off"
                      id="earned-search"
                      onChange={(event) => setMemberQuery(event.target.value)}
                      placeholder="Search by name or class"
                      type="search"
                      value={memberQuery}
                    />
                  </span>
                </label>
                <HonorCombobox
                  label="Class"
                  noun="class"
                  nounPlural="classes"
                  onChange={(id) => {
                    // With a status filter on, the shown members depend on the class: a changed class starts a fresh selection.
                    if (statusFilter && id !== classLevel && selected.size > 0) {
                      setSelected(new Set());
                      setNotice("The selection was cleared because the class changed while a status filter is on. Select the members again.");
                    }
                    setClassLevel(id as ClubClassLevel);
                  }}
                  options={classLevelOptions}
                  value={classLevel}
                />
                <label>
                  Status for {clubClassLevelLabels[classLevel]}
                  <select onChange={(event) => setStatusFilter(event.target.value as ClassStatusFilter)} value={statusFilter}>
                    <option value="">All members</option>
                    {Object.entries(classStatusFilterLabels).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className={styles.groupHead}>
                <small aria-live="polite" className={styles.muted} role="status">
                  {selectedCount} selected{memberQuery.trim() || statusFilter ? ` · ${tableMembers.length} of ${data.members.length} members shown` : ` · ${data.members.length} members`}
                </small>
                <span className={styles.actions}>
                  <button className="text-button" disabled={tableMembers.length === 0} onClick={() => setSelected(selectShown(tableMembers, selected, ""))} type="button">{memberQuery.trim() || statusFilter ? `Select ${tableMembers.length} shown` : "Select all"}</button>
                  <button className="text-button" disabled={selected.size === 0} onClick={() => setSelected(new Set())} type="button">Clear</button>
                </span>
              </div>
              {hiddenSelected > 0 && (
                <p className={styles.flag} role="status">
                  {hiddenSelected} selected {hiddenSelected === 1 ? "member is" : "members are"} hidden by the filters and won&apos;t be included.
                </p>
              )}
              {tableMembers.length === 0 ? (
                <p className="public-manage-empty" role="status"><UsersRound aria-hidden="true" size={17} /> No member matches these filters.</p>
              ) : (
                <div className="report-table-wrap">
                  <SortOrderNote>{sortOrderText(nameSortLabel, nameDirection)}</SortOrderNote>
                  <table aria-labelledby="earned-members" className="report-table table-cards class-tracking-table" data-fit-width role="table">
                    <thead role="rowgroup">
                      <tr role="row">
                        <SortableHeader active className="class-col-name" direction={nameDirection} label="Name" onSort={() => setNameDirection(flipDirection(nameDirection))} />
                        <th className="class-col-class" role="columnheader" scope="col">Current class</th>
                        <th className="class-col-status" role="columnheader" scope="col">{`${clubClassLevelLabels[classLevel]} status`}</th>
                        <th className="class-col-history" role="columnheader" scope="col"><span className="sr-only">Class history</span></th>
                      </tr>
                    </thead>
                    <tbody role="rowgroup">
                      {tableMembers.map((member) => {
                        const completedOnDate = member.completed?.[classLevel];
                        return (
                          <tr key={member.personId} role="row">
                            <th role="rowheader" scope="row">
                              <label className={styles.check}>
                                <input checked={selected.has(member.personId)} onChange={(event) => setSelected(toggled(selected, member.personId, event.target.checked))} type="checkbox" />
                                <strong translate="no">{member.lastName}, {member.firstName}</strong>
                              </label>
                            </th>
                            <td {...cardCell("Current class")}>{member.classLabel || "—"}</td>
                            <td {...cardCell(`${clubClassLevelLabels[classLevel]} status`)}>{completedOnDate ? `Completed ${dateLabel(completedOnDate)}` : "Not recorded"}</td>
                            <td {...cardCell(null)}>
                              {classHistoryBase && (
                                <Link className="secondary-button class-history-button" href={`${classHistoryBase}/${encodeURIComponent(member.personId)}`}>
                                  Class history<span className="sr-only"> for {member.firstName} {member.lastName}</span>
                                </Link>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {!readOnly && (
        <section aria-labelledby="earned-classes" className={styles.block}>
          <h3 id="earned-classes"><GraduationCap aria-hidden="true" size={14} /> Mark a class completed</h3>
          <p className={`field-help ${styles.helpText}`}>Records that the selected members finished <strong>{clubClassLevelLabels[classLevel]}</strong> (change the class above), which suggests that class&apos;s insignia below. It orders nothing by itself.</p>
          <div className={styles.pickerRow}>
            <span className={styles.pickerField}>
              <label htmlFor="earned-class-date">Completed on</label>
              <input className={styles.date} id="earned-class-date" onChange={(event) => setCompletedOn(event.target.value)} type="date" value={completedOn} />
            </span>
            <button className="primary-button" disabled={busy || classCount === 0 || !completedOn} onClick={markClass} type="button">
              <GraduationCap aria-hidden="true" size={16} /> {`Mark ${clubClassLevelLabels[classLevel]} completed${classCount > 0 ? ` (${classCount})` : ""}`}
            </button>
          </div>
        </section>
      )}

      {!readOnly && (
        <section aria-labelledby="earned-hand" className={styles.block}>
          <h3 id="earned-hand"><Plus aria-hidden="true" size={14} /> Add by hand</h3>
          <p className={`field-help ${styles.helpText}`}>For Good Conduct bars and stars, TLT items, and anything else from the supply catalog.</p>
          {data.catalog.length === 0 ? (
            <p className="quiet-copy">No earned-award items are in the supply catalog yet. Conference staff add them in the catalog.</p>
          ) : (
            <div className={styles.group}>
              <div className={styles.pickerRow}>
                {data.catalog.length > 8 && (
                  <span className={styles.pickerField}>
                    <label htmlFor="earned-item-search">Find an item</label>
                    <input autoComplete="off" className={styles.select} id="earned-item-search" onChange={(event) => { setItemQuery(event.target.value); setItemId(""); }} placeholder="Item name" type="search" value={itemQuery} />
                  </span>
                )}
                <span className={styles.pickerField}>
                  <label htmlFor="earned-item">Item</label>
                  <select className={styles.select} id="earned-item" onChange={(event) => setItemId(event.target.value)} value={chosenItemId}>
                    <option value="">Choose an item</option>
                    {sections.map(([section, { label, items }]) => (
                      <optgroup key={section} label={label}>
                        {items.map((row) => <option key={row.itemId} value={row.itemId}>{row.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </span>
                <button className="secondary-button" disabled={!chosenItemId} onClick={addItem} type="button">
                  <Plus aria-hidden="true" size={14} /> Add item
                </button>
              </div>
              {chosen.length > 0 && (
                <ul aria-label="Items to record" className={styles.chips}>
                  {chosen.map((entry) => (
                    <li key={entry.itemId}>
                      <span translate="no">{entry.label}</span>
                      <button aria-label={`Remove ${entry.label}`} className={styles.chipRemove} onClick={() => setChosen((current) => current.filter((other) => other.itemId !== entry.itemId))} type="button">
                        <X aria-hidden="true" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className={`field-help ${styles.helpText}`}>
                Applies to the {handCount} {handCount === 1 ? "member" : "members"} selected in the table above.
              </p>
              <label className={styles.check}>
                <input checked={alreadyHasIt} onChange={(event) => setAlreadyHasIt(event.target.checked)} type="checkbox" />
                <span>They already have it <small className={styles.muted}>· recorded as awarded; nothing is ordered and stock isn&apos;t changed</small></span>
              </label>
              {tooMany && (
                <p className={styles.flag} role="status">
                  That is {entryCount} items, and {MAX_AWARD_NEEDS_PER_ENTRY} is the most to record at once. Choose fewer members or items.
                </p>
              )}
              <div className={styles.actions}>
                <button className="primary-button" disabled={!canRecord} onClick={record} type="button">
                  <CheckCircle2 aria-hidden="true" size={16} /> {alreadyHasIt ? "Record as already awarded" : "Record items"}
                  {chosen.length > 0 && handCount > 0 ? ` (${entryCount})` : ""}
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {!readOnly && (
        <section aria-labelledby="earned-suggestions" className={styles.block}>
          <h3 id="earned-suggestions"><Sparkles aria-hidden="true" size={14} /> Suggested ({suggestionCount})</h3>
          <p className={`field-help ${styles.helpText}`}>Nothing here is added until you confirm it. Untick anything a member already has.</p>
          {suggestionCount === 0 && (
            <p className="quiet-copy">No suggestions right now. Mark a class completed above to suggest its insignia. Event patches appear after a club event that staff linked a patch to.</p>
          )}
          {data.insignia.map((entry) => {
            const ticked = entry.items.filter((item) => !unticked.has(insigniaKey(entry.completionId, item.itemId)));
            return (
              <div className={styles.group} key={entry.completionId}>
                <div className={styles.groupHead}>
                  <strong><span translate="no">{entry.firstName} {entry.lastName}</span> · {entry.classLabel} insignia</strong>
                  <small className={styles.muted}>Completed {entry.completedOn}</small>
                </div>
                <ul className={styles.people}>
                  {entry.items.map((item) => (
                    <li key={item.itemId}>
                      <label className={styles.check}>
                        <input
                          checked={!unticked.has(insigniaKey(entry.completionId, item.itemId))}
                          onChange={(event) => setUnticked((current) => toggled(current, insigniaKey(entry.completionId, item.itemId), !event.target.checked))}
                          type="checkbox"
                        />
                        <span translate="no">{item.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                {entry.missing.length > 0 && (
                  <p className={styles.flag} role="status">
                    <AlertTriangle aria-hidden="true" size={14} /> Not in the supply catalog yet, so not suggested: {entry.missing.join(", ")}.
                  </p>
                )}
                <div className={styles.actions}>
                  <button className="primary-button" disabled={busy || ticked.length === 0} onClick={() => addInsignia(entry.completionId, ticked.map((item) => item.itemId))} type="button">
                    <CheckCircle2 aria-hidden="true" size={16} /> Add to order list ({ticked.length})
                  </button>
                  <button className="text-button" disabled={busy} onClick={() => skipInsignia(entry.completionId)} type="button">Not now</button>
                </div>
              </div>
            );
          })}
          {data.patches.map((entry) => {
            const ticked = entry.people.filter((person) => !unticked.has(patchKey(entry.eventId, entry.itemId, person.personId)));
            return (
              <div className={styles.group} key={`${entry.eventId}:${entry.itemId}`}>
                <div className={styles.groupHead}>
                  <strong><span translate="no">{entry.itemName}</span> · <span translate="no">{entry.eventName}</span></strong>
                  <small className={styles.muted}>{entry.eventDate}</small>
                </div>
                <p className={styles.promptCopy}>
                  {entry.basis === "CHECK_IN" ? "Members who were checked in at the event." : "Members who were registered. The event has no check-ins."}
                </p>
                {!entry.catalogNumber && (
                  <p className={styles.flag} role="status">
                    <AlertTriangle aria-hidden="true" size={14} /> No AdventSource number (conference-made). It goes on your order list but is left out of the AdventSource file.
                  </p>
                )}
                <ul className={`${styles.people} earned-scroll-list`}>
                  {entry.people.map((person) => (
                    <li key={person.personId}>
                      <label className={styles.check}>
                        <input
                          checked={!unticked.has(patchKey(entry.eventId, entry.itemId, person.personId))}
                          onChange={(event) => setUnticked((current) => toggled(current, patchKey(entry.eventId, entry.itemId, person.personId), !event.target.checked))}
                          type="checkbox"
                        />
                        <span translate="no">{person.firstName} {person.lastName}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className={styles.actions}>
                  <button className="primary-button" disabled={busy || ticked.length === 0} onClick={() => addPatches(entry.eventId, entry.itemId, ticked.map((person) => person.personId))} type="button">
                    <CheckCircle2 aria-hidden="true" size={16} /> Add to order list ({ticked.length})
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section aria-labelledby="earned-open" className={styles.block}>
        <h3 id="earned-open"><Award aria-hidden="true" size={14} /> Open earned items ({data.needs.length})</h3>
        {data.awardedCount > 0 && <small className={styles.muted}>{data.awardedCount} awarded so far</small>}
        {data.needs.length === 0 ? (
          <p className="quiet-copy">No open earned items.</p>
        ) : (
          <ul className={`${styles.people} earned-scroll-list`}>
            {data.needs.map((need, index) => {
              // One link per person: needs are sorted by name, so only a person's first row carries it.
              const firstForPerson = data.needs.findIndex((other) => other.personId === need.personId) === index;
              const label = (
                <span>
                  <span translate="no">{need.firstName} {need.lastName}</span>
                  {" · "}<span translate="no">{need.itemName}</span>
                  <small className={styles.muted}> · {awardStatusLabels[need.status]} · {need.origin}{need.missingCatalogNumber ? " · no AdventSource number" : ""}</small>
                </span>
              );
              return (
                <li key={need.needId}>
                  {readOnly || need.status !== "NEEDED" ? <span className={styles.rowStatic}>{label}</span> : (
                    <label className={styles.check}>
                      <input checked={picked.has(need.needId)} onChange={(event) => setPicked(toggled(picked, need.needId, event.target.checked))} type="checkbox" />
                      {label}
                    </label>
                  )}
                  {classHistoryBase && firstForPerson && !need.classHistoryHidden && (
                    <Link className="text-button" href={`${classHistoryBase}/${encodeURIComponent(need.personId)}`}>
                      Class history<span className="sr-only"> for {need.firstName} {need.lastName}</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!readOnly && editableNeedIds.length > 0 && (
          <div className={styles.actions}>
            <button className="secondary-button" disabled={busy || pickedNeeded.length === 0} onClick={alreadyHaveIt} type="button">
              <CheckCircle2 aria-hidden="true" size={14} /> Already has it{pickedNeeded.length > 0 ? ` (${pickedNeeded.length})` : ""}
            </button>
            <button className="secondary-button" disabled={busy || pickedNeeded.length === 0} onClick={remove} type="button">
              <Trash2 aria-hidden="true" size={14} /> Remove{pickedNeeded.length > 0 ? ` (${pickedNeeded.length})` : ""}
            </button>
          </div>
        )}
      </section>

      <section aria-labelledby="earned-master" className={styles.block}>
        <h3 id="earned-master"><Trophy aria-hidden="true" size={14} /> Master Award progress</h3>
        {data.masterAwards.length === 0 ? (
          <p className="quiet-copy">No Master Award rules are active yet. Conference staff review and activate them.</p>
        ) : (
          data.masterAwards.map((rule) => {
            const selected = masterPicked[rule.ruleId] ?? new Set<string>();
            return (
              <div className={styles.group} key={rule.ruleId}>
                <div className={styles.groupHead}>
                  <strong translate="no">{rule.name}</strong>
                  <small className={styles.muted}>Needs {rule.requirement}</small>
                </div>
                {rule.missingItem && (
                  <p className={styles.flag} role="status">
                    <AlertTriangle aria-hidden="true" size={14} /> Not linked to a catalog item yet, so it can&apos;t be added to an order.
                  </p>
                )}
                <strong className={styles.muted}>Eligible, not yet awarded ({rule.eligible.length})</strong>
                {rule.eligible.length === 0 ? <p className="quiet-copy">No one right now.</p> : (
                  <ul className={styles.people}>
                    {rule.eligible.map((person) => (
                      <li key={person.personId}>
                        {readOnly ? <span className={styles.rowStatic} translate="no">{person.firstName} {person.lastName}</span> : (
                          <label className={styles.check}>
                            <input
                              checked={selected.has(person.personId)}
                              onChange={(event) => setMasterPicked((current) => ({ ...current, [rule.ruleId]: toggled(selected, person.personId, event.target.checked) }))}
                              type="checkbox"
                            />
                            <span translate="no">{person.firstName} {person.lastName}</span>
                          </label>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!readOnly && rule.eligible.length > 0 && !rule.missingItem && (
                  <div className={styles.actions}>
                    <button className="primary-button" disabled={busy || selected.size === 0} onClick={() => addMaster(rule.ruleId)} type="button">
                      <CheckCircle2 aria-hidden="true" size={16} /> Add to order list{selected.size > 0 ? ` (${selected.size})` : ""}
                    </button>
                  </div>
                )}
                {rule.onOrder.length > 0 && (
                  <small className={styles.muted}>On the order list: {rule.onOrder.map((person) => `${person.firstName} ${person.lastName}`).join(", ")}</small>
                )}
                {rule.givenElsewhere.length > 0 && (
                  <small className={styles.muted}>Already given (another club): {rule.givenElsewhere.map((person) => `${person.firstName} ${person.lastName}`).join(", ")}</small>
                )}
                {rule.awardedCount > 0 && <small className={styles.muted}>{rule.awardedCount} awarded</small>}
                {rule.closest.length > 0 && (
                  <>
                    <strong className={styles.muted}>Closest</strong>
                    <ul className={styles.people}>
                      {rule.closest.map((person) => (
                        <li className={styles.rowStatic} key={person.personId}>
                          <span><span translate="no">{person.firstName} {person.lastName}</span> · {person.label}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            );
          })
        )}
      </section>
    </section>
  );
}
