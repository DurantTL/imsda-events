"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Creates a club form (#712): blank, or as a copy of an existing form's
 * published version. The new form starts off, and opens in the builder.
 */
export function ClubFormCreate({ templates }: { templates: Array<{ key: string; name: string }> }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [copyFromKey, setCopyFromKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/club-forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...(copyFromKey ? { copyFromKey } : {}) }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string; key?: string };
      if (!response.ok || !result.key) {
        setError(result.message ?? "The form could not be created.");
        return;
      }
      router.push(`/admin/club-forms/${encodeURIComponent(result.key)}`);
    } catch {
      setError("The form could not be created. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel form-stack" onSubmit={create}>
      <h3>New form</h3>
      <p className="field-help">A new form starts off. Build it, publish it, then turn it on when it is ready.</p>
      <div className="form-grid two-column">
        <label>Name
          <input maxLength={120} onChange={(event) => setName(event.target.value)} required value={name} />
        </label>
        <label>Start from
          <select onChange={(event) => setCopyFromKey(event.target.value)} value={copyFromKey}>
            <option value="">A blank form</option>
            {templates.map((template) => <option key={template.key} value={template.key}>A copy of {template.name}</option>)}
          </select>
        </label>
      </div>
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <div>
        <button className="primary-button" disabled={saving || name.trim().length < 2} type="submit">Create form</button>
      </div>
    </form>
  );
}
