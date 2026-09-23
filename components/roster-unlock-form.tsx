"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { KeyRound } from "lucide-react";

export function RosterUnlockForm({ label = "Open roster" }: { label?: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/attendee/roster-unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "That code didn't work.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That code didn't work.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="roster-unlock-form" onSubmit={submit}>
      <label>
        <span className="sr-only">Authenticator code</span>
        <input
          autoComplete="one-time-code"
          inputMode="numeric"
          maxLength={20}
          onChange={(event) => setCode(event.target.value)}
          placeholder="123456"
          required
          value={code}
        />
      </label>
      <button className="primary-button" disabled={saving} type="submit">
        <KeyRound aria-hidden="true" size={15} /> {label}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  );
}
