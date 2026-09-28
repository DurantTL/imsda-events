"use client";

import { useState } from "react";
import { ArrowRight, UserRoundCog } from "lucide-react";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * "Act as" for system administrators (#442): acts inside the current staff
 * session for a couple of hours, never touching the staff member's own
 * attendee account. Audited, ends by itself, and "Stop acting" (shown while
 * it's active) ends it early.
 *
 * Confirms through an in-page dialog rather than `window.confirm()` (#466):
 * on at least one physical iPhone, `window.confirm()` showed no popup at
 * all — no "Setting up…" state, no error, nothing. The dialog names the
 * role, the club (when there is one), the time limit, and that starting is
 * audited, exactly what the browser confirm text used to say in one string.
 * On success the button is replaced by a persistent, action-oriented link
 * rather than a small notice, so it stays easy to find and use again.
 */
export function ActAsButton({
  access,
  club,
  endpoint,
  label,
  resultAction,
  role,
}: {
  /** What the role can do while acting, e.g. "Full director powers" or "View only". */
  access: string;
  /** The club's name, for club-director acting only. */
  club?: string;
  endpoint: string;
  label: string;
  /** The call to action shown once acting has started, e.g. "Open the club portal". */
  resultAction: string;
  role: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ message: string; href: string } | null>(null);

  async function act() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => ({})) as { message?: string; href?: string };
      if (!response.ok || !body.href) throw new Error(body.message ?? "That didn't work. Try again.");
      setResult({ message: body.message ?? "", href: body.href });
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setOpen(false);
    setError("");
  }

  return (
    <div className="act-as">
      {result ? (
        <p className="inline-notice success" role="status">
          {result.message}{" "}
          <a href={result.href}>{resultAction} <ArrowRight aria-hidden="true" size={13} /></a>.
        </p>
      ) : (
        <button className="secondary-button" onClick={() => setOpen(true)} type="button">
          <UserRoundCog aria-hidden="true" size={14} /> {label}
        </button>
      )}
      <ConfirmDialog
        busy={busy}
        busyLabel="Setting up…"
        confirmLabel="Start acting"
        error={error}
        onCancel={cancel}
        onConfirm={() => void act()}
        open={open}
        title={club ? `Act as ${role} of ${club}?` : `Act as ${role}?`}
      >
        <dl className="confirm-dialog-facts">
          <div><dt>Role</dt><dd>{role}</dd></div>
          {club && <div><dt>Club</dt><dd translate="no">{club}</dd></div>}
          <div><dt>Access</dt><dd>{access}</dd></div>
          <div><dt>Time limit</dt><dd>2 hours, or until you choose Stop acting</dd></div>
        </dl>
        <p className="field-help">
          This is recorded, and never touches your own attendee account. Starting this ends any other role you&apos;re currently acting as.
        </p>
      </ConfirmDialog>
    </div>
  );
}
