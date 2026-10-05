"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AlertTriangle, Award, CheckCircle2, Download, Eye, GraduationCap, Plus, Search, Sparkles, Trash2, Trophy, X } from "lucide-react";
import styles from "@/components/club-orders.module.css";
import { clubClassLevelLabels, clubClassLevels, type ClubClassLevel } from "@/modules/club-rosters/domain";
import { awardEntryTooLarge, awardStatusLabels, MAX_AWARD_NEEDS_PER_ENTRY } from "@/modules/earned-awards/domain";
import type { EarnedAwardsWorkspaceData } from "@/modules/earned-awards/order-source";

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

/** The same bulk limit the order routes accept. */
const BULK_LIMIT = 500;

/** Every word typed appears in the member's name or class, ignoring case. A blank search matches everyone. */
export function memberMatchesSearch(member: { firstName: string; lastName: string; classLabel?: string | null }, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${member.firstName} ${member.lastName} ${member.classLabel ?? ""}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

type SearchableMember = { personId: string; firstName: string; lastName: string; classLabel?: string | null };

/** Members the search currently shows. */
export function shownMembers<T extends SearchableMember>(members: readonly T[], query: string): T[] {
  return members.filter((member) => memberMatchesSearch(member, query));
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
}: {
  organizationId: string;
  initial: ClubEarnedAwardsData;
  ordersHref: string;
  /** The class tracking CSV and printable report (#701); omitted where the export isn't offered. */
  exportCsvHref?: string;
  exportPrintHref?: string;
  readOnly?: boolean;
}) {
  const [data, setData] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/awards`;

  // Suggestions: every item and member is ticked to start with; unticking leaves it out.
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  // Mark a class completed.
  const [classMembers, setClassMembers] = useState<Set<string>>(new Set());
  const [classLevel, setClassLevel] = useState<ClubClassLevel>("FRIEND");
  const [completedOn, setCompletedOn] = useState(today);
  // Add by hand.
  const [itemId, setItemId] = useState("");
  const [chosen, setChosen] = useState<Array<{ itemId: string; label: string }>>([]);
  const [handMembers, setHandMembers] = useState<Set<string>>(new Set());
  const [alreadyHasIt, setAlreadyHasIt] = useState(false);
  // Open items.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Master Awards: members ticked per rule.
  const [masterPicked, setMasterPicked] = useState<Record<string, Set<string>>>({});
  // Member search per list (Mark a class completed, Add by hand), so one list's search never filters the other.
  const [memberQueries, setMemberQueries] = useState<Record<string, string>>({});

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
      const result = await post(`${base}/completions`, completionPayload(data.members, classMembers, classQuery, classLevel, completedOn));
      const created = result.created ?? 0;
      return `Marked ${plural(created, "member", "members")} as having completed ${clubClassLevelLabels[classLevel]}.${skippedNote(result.skipped)} Their insignia is suggested above; nothing is added until you confirm.`;
    });
    if (ok) setClassMembers(new Set());
  }

  // ---- add by hand
  const group = data.catalog.find((entry) => entry.itemId === itemId);
  const sections = useMemo(() => {
    const bySection = new Map<string, { label: string; items: ClubEarnedAwardsData["catalog"] }>();
    for (const row of data.catalog) {
      const section = bySection.get(row.section) ?? { label: row.sectionLabel, items: [] };
      section.items.push(row);
      bySection.set(row.section, section);
    }
    return [...bySection.entries()];
  }, [data.catalog]);

  function addItem() {
    if (!group || chosen.some((entry) => entry.itemId === group.itemId)) return;
    setChosen((current) => [...current, { itemId: group.itemId, label: group.name }]);
    setItemId("");
  }

  async function record() {
    const ok = await act(async () => {
      const result = await post(base, recordPayload(data.members, handMembers, handQuery, chosen.map((entry) => entry.itemId), alreadyHasIt));
      const created = result.created ?? 0;
      const marked = result.marked ?? 0;
      const what = alreadyHasIt
        ? `Recorded ${created} as already awarded${marked > 0 ? ` and marked ${marked} existing ${marked === 1 ? "item" : "items"} as awarded` : ""}. Stock wasn't changed.`
        : `Recorded ${plural(created, "earned item", "earned items")}.`;
      return `${what}${skippedNote(result.skipped)}`;
    });
    if (ok) {
      setChosen([]);
      setHandMembers(new Set());
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

  // Bulk actions count and send only members that are selected and shown (search can hide ticked ones).
  const classQuery = memberQueries.class ?? "";
  const handQuery = memberQueries.hand ?? "";
  const classCount = visibleSelectedIds(data.members, classMembers, classQuery).length;
  const handCount = visibleSelectedIds(data.members, handMembers, handQuery).length;
  const entryCount = chosen.length * handCount;
  const tooMany = awardEntryTooLarge(handCount, chosen.length);
  const canRecord = !busy && chosen.length > 0 && handCount > 0 && !tooMany;
  const suggestionCount = data.insignia.length + data.patches.length;

  const memberList = (selected: ReadonlySet<string>, setSelected: (next: Set<string>) => void, label: string, listKey: string) => {
    const query = memberQueries[listKey] ?? "";
    const shown = shownMembers(data.members, query);
    const hiddenSelected = selected.size - visibleSelectedIds(data.members, selected, query).length;
    return (
    <>
      <div className={styles.groupHead}>
        <strong>{label}</strong>
        <span className={styles.actions}>
          <button className="text-button" onClick={() => setSelected(selectShown(data.members, selected, query))} type="button">{query.trim() ? `Select ${shown.length} shown` : "Select all"}</button>
          <button className="text-button" onClick={() => setSelected(new Set())} type="button">Clear</button>
        </span>
      </div>
      {data.members.length > 8 && (
        <div className="earned-member-search">
          <label className="search-field" htmlFor={`earned-search-${listKey}`}>
            <Search aria-hidden="true" size={15} />
            <span className="sr-only">Find a member</span>
            <input
              autoComplete="off"
              id={`earned-search-${listKey}`}
              onChange={(event) => setMemberQueries((current) => ({ ...current, [listKey]: event.target.value }))}
              placeholder="Find a member by name or class"
              type="search"
              value={query}
            />
          </label>
          <small aria-live="polite" className={styles.muted} role="status">{query.trim() ? `${shown.length} of ${data.members.length} members` : ""}</small>
        </div>
      )}
      {hiddenSelected > 0 && (
        <p className={styles.flag} role="status">
          {hiddenSelected} selected {hiddenSelected === 1 ? "member is" : "members are"} hidden by the search and won&apos;t be included.
        </p>
      )}
      {data.members.length === 0 ? (
        <p className="quiet-copy">No active members are on this year&apos;s roster yet.</p>
      ) : shown.length === 0 ? (
        <p className="quiet-copy">No member matches &ldquo;{query.trim()}&rdquo;.</p>
      ) : (
        <ul className={`${styles.people} earned-scroll-list`}>
          {shown.map((member) => (
            <li key={member.personId}>
              <label className={styles.check}>
                <input checked={selected.has(member.personId)} onChange={(event) => setSelected(toggled(selected, member.personId, event.target.checked))} type="checkbox" />
                <span>
                  <span translate="no">{member.firstName} {member.lastName}</span>
                  {member.classLabel && <small className={styles.muted}> · {member.classLabel}</small>}
                </span>
              </label>
              <Link className="text-button" href={`/account/clubs/${organizationId}/class-tracking/${encodeURIComponent(member.personId)}`}>
                Class history<span className="sr-only"> for {member.firstName} {member.lastName}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
    );
  };

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p className="public-registration-eyebrow">Club supplies</p>
          <h2>Class tracking</h2>
        </div>
        <span className="count-badge">{data.needs.length} open</span>
      </div>
      {(exportCsvHref || exportPrintHref) && (
        <div className="report-actions" role="group" aria-label="Export class tracking">
          {exportCsvHref && <a className="secondary-button" href={exportCsvHref}><Download aria-hidden="true" size={14} /> Export CSV</a>}
          {exportPrintHref && <Link className="secondary-button" href={exportPrintHref}>Print report</Link>}
        </div>
      )}
      {readOnly ? (
        <p className="inline-notice" role="status"><Eye aria-hidden="true" size={14} /> View only. Shows what&apos;s on file. The club director or deputy records and confirms awards.</p>
      ) : (
        <p className={`field-help earned-help ${styles.helpText}`}>Class insignia, event patches, Good Conduct and TLT items, and Master Awards. They join the order list on <Link href={ordersHref}>Orders</Link> with honors and uniforms.</p>
      )}
      {notice && <p className="inline-notice success" role="status">{notice}</p>}
      {error && <p className="inline-notice error" role="alert">{error}</p>}

      {!readOnly && (
        <section aria-labelledby="earned-suggestions" className={styles.block}>
          <h3 id="earned-suggestions"><Sparkles aria-hidden="true" size={14} /> Suggested ({suggestionCount})</h3>
          <p className={`field-help ${styles.helpText}`}>Nothing here is added until you confirm it. Untick anything a member already has.</p>
          {suggestionCount === 0 && (
            <p className="quiet-copy">No suggestions right now. Mark a class completed below to suggest its insignia. Event patches appear after a club event that staff linked a patch to.</p>
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

      {!readOnly && (
        <section aria-labelledby="earned-classes" className={styles.block}>
          <h3 id="earned-classes"><GraduationCap aria-hidden="true" size={14} /> Mark a class completed</h3>
          <p className={`field-help ${styles.helpText}`}>Records that members finished a class, which suggests that class&apos;s insignia above. It orders nothing by itself.</p>
          <div className={styles.pickerRow}>
            <span className={styles.pickerField}>
              <label htmlFor="earned-class-level">Class</label>
              <select className={styles.select} id="earned-class-level" onChange={(event) => setClassLevel(event.target.value as ClubClassLevel)} value={classLevel}>
                {clubClassLevels.map((level) => <option key={level} value={level}>{clubClassLevelLabels[level]}</option>)}
              </select>
            </span>
            <span className={styles.pickerField}>
              <label htmlFor="earned-class-date">Completed on</label>
              <input className={styles.date} id="earned-class-date" onChange={(event) => setCompletedOn(event.target.value)} type="date" value={completedOn} />
            </span>
          </div>
          <div className={styles.group}>
            {memberList(classMembers, setClassMembers, "Members", "class")}
          </div>
          <div className={styles.actions}>
            <button className="primary-button" disabled={busy || classCount === 0 || !completedOn} onClick={markClass} type="button">
              <GraduationCap aria-hidden="true" size={16} /> Mark completed{classCount > 0 ? ` (${classCount})` : ""}
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
                <span className={styles.pickerField}>
                  <label htmlFor="earned-item">Item</label>
                  <select className={styles.select} id="earned-item" onChange={(event) => setItemId(event.target.value)} value={itemId}>
                    <option value="">Choose an item</option>
                    {sections.map(([section, { label, items }]) => (
                      <optgroup key={section} label={label}>
                        {items.map((row) => <option key={row.itemId} value={row.itemId}>{row.name}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </span>
                <button className="secondary-button" disabled={!itemId} onClick={addItem} type="button">
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
              {memberList(handMembers, setHandMembers, "Members", "hand")}
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

      <section aria-labelledby="earned-open" className={styles.block}>
        <h3 id="earned-open"><Award aria-hidden="true" size={14} /> Open earned items ({data.needs.length})</h3>
        {data.awardedCount > 0 && <small className={styles.muted}>{data.awardedCount} awarded so far</small>}
        {data.needs.length === 0 ? (
          <p className="quiet-copy">No open earned items.</p>
        ) : (
          <ul className={`${styles.people} earned-scroll-list`}>
            {data.needs.map((need) => {
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
                  <Link className="text-button" href={`/account/clubs/${organizationId}/class-tracking/${encodeURIComponent(need.personId)}`}>
                    Class history<span className="sr-only"> for {need.firstName} {need.lastName}</span>
                  </Link>
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
