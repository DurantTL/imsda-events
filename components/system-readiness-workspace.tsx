"use client";

import { useState } from "react";
import type { SystemReadiness, ManualReadinessRow } from "@/modules/system-admin/readiness-repository";
import styles from "./system-readiness-workspace.module.css";

const statusLabel = {
  ok: "Checked: OK",
  attention: "Needs attention",
  info: "For information",
  unknown: "Could not check",
} as const;

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
}

export function SystemReadinessWorkspace({ initialReadiness }: { initialReadiness: SystemReadiness }) {
  const [readiness, setReadiness] = useState(initialReadiness);
  // The item whose tick or untick form is open, and which one.
  const [open, setOpen] = useState<{ key: string; mode: "tick" | "untick" } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(item: ManualReadinessRow, mode: "tick" | "untick") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/admin/system-readiness", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "tick"
            ? { action: "tick", key: item.key, note: text }
            : { action: "untick", key: item.key, reason: text },
        ),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.readiness) {
        throw new Error(result.message ?? "The checklist could not be updated.");
      }
      setReadiness(result.readiness);
      setOpen(null);
      setText("");
      setNotice(mode === "tick" ? "Ticked and recorded in the audit log." : "Unticked and recorded in the audit log.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The checklist could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  const { summary } = readiness;

  return (
    <section className="page-stack">
      <div className="page-intro">
        <div>
          <p className="eyebrow">System administration</p>
          <h2>System readiness</h2>
          <p>
            What the app can check by itself, and what a person has to confirm before real club data and the next
            event. Ticking an item only records that someone did the work. It never deploys, migrates, sends or
            unlocks anything.
          </p>
          <p>
            {summary.automaticAttention === 0
              ? "No automatic check needs attention."
              : `${summary.automaticAttention} automatic ${summary.automaticAttention === 1 ? "check needs" : "checks need"} attention.`}{" "}
            {readiness.ticksAvailable
              ? `${summary.manualDone} of ${summary.manualTotal} manual items ticked.`
              : "Manual ticks could not be read."}
          </p>
        </div>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && <p className="inline-notice" role="status">{notice}</p>}

      <section className="panel" aria-labelledby="readiness-automatic">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Checked automatically</p>
            <h2 id="readiness-automatic">What the app can verify</h2>
          </div>
        </div>
        <ul className={styles.list}>
          {readiness.automatic.map((row) => (
            <li className={styles.row} key={row.key}>
              <div className={styles.head}>
                <p className={styles.title}>{row.title}</p>
                <span className={`${styles.badge} ${styles[row.status]}`}>{statusLabel[row.status]}</span>
              </div>
              <p className={styles.detail}>{row.summary}</p>
              {row.people.length > 0 && (
                <ul className={styles.people} aria-label="Accounts to fix">
                  {row.people.map((name) => <li key={name}>{name}</li>)}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <p className={styles.meta}>Checked {formatDate(readiness.generatedAt)}. Reload the page to check again.</p>
      </section>

      {readiness.groups.map((group) => (
        <section className="panel" key={group.id} aria-labelledby={`readiness-${group.id}`}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">Ticked by a person</p>
              <h2 id={`readiness-${group.id}`}>{group.title}</h2>
            </div>
          </div>
          <ul className={styles.list}>
            {group.items.map((item) => {
              const isOpen = open?.key === item.key;
              return (
                <li className={styles.row} key={item.key}>
                  <div className={styles.head}>
                    <p className={styles.title}>{item.title}</p>
                    <span className={`${styles.badge} ${item.tick ? styles.ok : styles.unknown}`}>
                      {!readiness.ticksAvailable ? "Could not read ticks" : item.tick ? "Ticked" : "Not ticked"}
                    </span>
                  </div>
                  <p className={styles.detail}>{item.detail}</p>
                  <p className={styles.meta}>{item.reference}</p>
                  {item.tick && (
                    <p className={styles.meta}>
                      Ticked by {item.tick.tickedByName} on {formatDate(item.tick.tickedAt)}
                      {item.tick.note ? `. Note: ${item.tick.note}` : "."}
                    </p>
                  )}
                  {isOpen ? (
                    <form
                      className={styles.form}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submit(item, open.mode);
                      }}
                    >
                      <label>
                        {open.mode === "tick" ? "Note (optional). Never paste keys, passwords or addresses." : "Why is this being unticked?"}
                        <textarea
                          maxLength={300}
                          required={open.mode === "untick"}
                          rows={2}
                          value={text}
                          onChange={(event) => setText(event.target.value)}
                        />
                      </label>
                      <div className={styles.actions}>
                        <button className="primary-button" disabled={busy} type="submit">
                          {open.mode === "tick" ? "Confirm tick" : "Confirm untick"}
                        </button>
                        <button
                          className="secondary-button"
                          disabled={busy}
                          type="button"
                          onClick={() => { setOpen(null); setText(""); }}
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  ) : readiness.ticksAvailable ? (
                    <div className={styles.actions}>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => {
                          setError("");
                          setNotice("");
                          setText("");
                          setOpen({ key: item.key, mode: item.tick ? "untick" : "tick" });
                        }}
                      >
                        {item.tick ? "Untick" : "Tick"}
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </section>
  );
}
