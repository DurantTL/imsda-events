"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Plus, Shirt, Trash2, X } from "lucide-react";
import styles from "@/components/club-orders.module.css";
import { entryTooLarge, MAX_UNIFORM_NEEDS_PER_ENTRY, uniformStatusLabels, variantLabel, type UniformItemGroup } from "@/modules/uniforms/domain";
import type { UniformWorkspaceData } from "@/modules/uniforms/order-source";

export type ClubUniformData = UniformWorkspaceData;

export const emptyUniformData: ClubUniformData = { catalog: [], members: [], needs: [], issuedCount: 0 };

type Chosen = { itemId: string; label: string };

/**
 * The Uniforms section of a club's Orders screen (#497). A director or
 * deputy picks an item and a size (sizes are grouped under the base item),
 * adds as many items as needed, ticks the members, and records the needs in
 * one go: "these 12 members each need a scarf and slide". "They already have
 * one" (the spreadsheet's 2) records them as issued without touching stock.
 * Open needs list below with "Already has one" and "Remove" for the ones not
 * yet ordered. Everything goes through the same order list, batches and hand-
 * out flow as honors. Only names, items and sizes appear; a registrar or
 * Area Coordinator (`readOnly`) sees the list and no controls.
 */
export function ClubUniformSection({
  data,
  readOnly,
  busy,
  onRecord,
  onRemove,
  onAlreadyHasOne,
}: {
  data: ClubUniformData;
  readOnly: boolean;
  busy: boolean;
  onRecord: (input: { personIds: string[]; itemIds: string[]; alreadyHasOne: boolean }) => Promise<boolean>;
  onRemove: (needIds: string[]) => Promise<boolean>;
  onAlreadyHasOne: (needIds: string[]) => Promise<boolean>;
}) {
  const [groupKey, setGroupKey] = useState("");
  const [variantId, setVariantId] = useState("");
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [alreadyHasOne, setAlreadyHasOne] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const group: UniformItemGroup | undefined = data.catalog.find((entry) => entry.key === groupKey);
  const sections = useMemo(() => {
    const bySection = new Map<string, { label: string; groups: UniformItemGroup[] }>();
    for (const entry of data.catalog) {
      const section = bySection.get(entry.section) ?? { label: entry.sectionLabel, groups: [] };
      section.groups.push(entry);
      bySection.set(entry.section, section);
    }
    return [...bySection.entries()];
  }, [data.catalog]);
  const editableNeedIds = data.needs.filter((need) => need.status === "NEEDED").map((need) => need.needId);
  const pickedNeeded = [...picked].filter((id) => editableNeedIds.includes(id));

  function chooseGroup(key: string) {
    setGroupKey(key);
    const next = data.catalog.find((entry) => entry.key === key);
    // A single variant (one size, or no size) is chosen for you.
    setVariantId(next && next.variants.length === 1 ? next.variants[0].itemId : "");
  }

  function addItem() {
    const variant = group?.variants.find((entry) => entry.itemId === variantId);
    if (!group || !variant || chosen.some((entry) => entry.itemId === variant.itemId)) return;
    const size = variantLabel(variant);
    setChosen((current) => [...current, { itemId: variant.itemId, label: variant.size ? `${group.baseName} · ${size}` : group.baseName }]);
    setGroupKey("");
    setVariantId("");
  }

  function toggle(setter: typeof setMemberIds, id: string, on: boolean) {
    setter((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function record() {
    const ok = await onRecord({ personIds: [...memberIds], itemIds: chosen.map((entry) => entry.itemId), alreadyHasOne });
    if (ok) {
      setChosen([]);
      setMemberIds(new Set());
      setAlreadyHasOne(false);
    }
  }

  const entryCount = chosen.length * memberIds.size;
  const tooMany = entryTooLarge(memberIds.size, chosen.length);
  const canRecord = !busy && chosen.length > 0 && memberIds.size > 0 && !tooMany;
  const openCount = data.needs.length;

  return (
    <section aria-labelledby="club-uniforms" className={styles.block}>
      <h3 id="club-uniforms"><Shirt aria-hidden="true" size={14} /> Uniforms</h3>
      <p className="field-help">
        {readOnly
          ? "Who needs which uniform items. Needs join the order list above with the honors."
          : "Record who needs which uniform items. They join the order list above with the honors, and stock is subtracted there."}
      </p>

      {!readOnly && (
        <div className={styles.group}>
          <strong>Record uniform needs</strong>
          {data.catalog.length === 0 ? (
            <p className="quiet-copy">No uniform items are in the supply catalog yet. Conference staff add them in the catalog.</p>
          ) : (
            <>
              <div className={styles.pickerRow}>
                <span className={styles.pickerField}>
                  <label htmlFor="club-uniform-item">Item</label>
                  <select className={styles.select} id="club-uniform-item" onChange={(event) => chooseGroup(event.target.value)} value={groupKey}>
                    <option value="">Choose an item</option>
                    {sections.map(([section, { label, groups }]) => (
                      <optgroup key={section} label={label}>
                        {groups.map((entry) => <option key={entry.key} value={entry.key}>{entry.baseName}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </span>
                <span className={styles.pickerField}>
                  <label htmlFor="club-uniform-size">Size</label>
                  <select className={styles.select} disabled={!group} id="club-uniform-size" onChange={(event) => setVariantId(event.target.value)} value={variantId}>
                    <option value="">{group ? "Choose a size" : "Pick an item first"}</option>
                    {group?.variants.map((variant) => <option key={variant.itemId} value={variant.itemId}>{variantLabel(variant)}</option>)}
                  </select>
                </span>
                <button className="secondary-button" disabled={!variantId} onClick={addItem} type="button">
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
              <div className={styles.groupHead}>
                <strong>Members</strong>
                <span className={styles.actions}>
                  <button className="text-button" onClick={() => setMemberIds(new Set(data.members.map((member) => member.personId)))} type="button">Select all</button>
                  <button className="text-button" onClick={() => setMemberIds(new Set())} type="button">Clear</button>
                </span>
              </div>
              {data.members.length === 0 ? (
                <p className="quiet-copy">No active members are on this year&apos;s roster yet.</p>
              ) : (
                <ul className={styles.people}>
                  {data.members.map((member) => (
                    <li key={member.personId}>
                      <label className={styles.check}>
                        <input checked={memberIds.has(member.personId)} onChange={(event) => toggle(setMemberIds, member.personId, event.target.checked)} type="checkbox" />
                        <span translate="no">{member.firstName} {member.lastName}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <label className={styles.check}>
                <input checked={alreadyHasOne} onChange={(event) => setAlreadyHasOne(event.target.checked)} type="checkbox" />
                <span>They already have one <small className={styles.muted}>· recorded as issued; nothing is ordered and stock isn&apos;t changed</small></span>
              </label>
              {tooMany && (
                <p className={styles.flag} role="status">
                  That is {entryCount} needs, and {MAX_UNIFORM_NEEDS_PER_ENTRY} is the most to record at once. Choose fewer members or items.
                </p>
              )}
              <div className={styles.actions}>
                <button className="primary-button" disabled={!canRecord} onClick={record} type="button">
                  <CheckCircle2 aria-hidden="true" size={16} /> {alreadyHasOne ? "Record as already issued" : "Record needs"}
                  {chosen.length > 0 && memberIds.size > 0 ? ` (${entryCount})` : ""}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className={styles.group}>
        <div className={styles.groupHead}>
          <strong>Open uniform needs ({openCount})</strong>
          {data.issuedCount > 0 && <small className={styles.muted}>{data.issuedCount} issued so far</small>}
        </div>
        {openCount === 0 ? (
          <p className="quiet-copy">No open uniform needs.</p>
        ) : (
          <ul className={styles.people}>
            {data.needs.map((need) => {
              const label = (
                <span>
                  <span translate="no">{need.firstName} {need.lastName}</span>
                  {" · "}<span translate="no">{need.itemName}{need.size ? `, ${need.size}` : ""}</span>
                  <small className={styles.muted}> · {uniformStatusLabels[need.status]}</small>
                </span>
              );
              return (
                <li key={need.needId}>
                  {readOnly || need.status !== "NEEDED" ? <span className={styles.rowStatic}>{label}</span> : (
                    <label className={styles.check}>
                      <input checked={picked.has(need.needId)} onChange={(event) => toggle(setPicked, need.needId, event.target.checked)} type="checkbox" />
                      {label}
                    </label>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {!readOnly && editableNeedIds.length > 0 && (
          <div className={styles.actions}>
            <button
              className="secondary-button"
              disabled={busy || pickedNeeded.length === 0}
              onClick={async () => { if (await onAlreadyHasOne(pickedNeeded)) setPicked(new Set()); }}
              type="button"
            >
              <CheckCircle2 aria-hidden="true" size={14} /> Already has one{pickedNeeded.length > 0 ? ` (${pickedNeeded.length})` : ""}
            </button>
            <button
              className="secondary-button"
              disabled={busy || pickedNeeded.length === 0}
              onClick={async () => { if (await onRemove(pickedNeeded)) setPicked(new Set()); }}
              type="button"
            >
              <Trash2 aria-hidden="true" size={14} /> Remove{pickedNeeded.length > 0 ? ` (${pickedNeeded.length})` : ""}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
