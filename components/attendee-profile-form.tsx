"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Save } from "lucide-react";
import type { AttendeeProfileInput } from "@/modules/attendee-accounts/profile-service";

export function AttendeeProfileForm({
  initialProfile,
}: {
  initialProfile: AttendeeProfileInput;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  function field(name: keyof AttendeeProfileInput, value: string) {
    setProfile((current) => ({ ...current, [name]: value }));
    setState("idle");
    setMessage("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("saving");
    setMessage("Saving profile…");
    try {
      const response = await fetch("/api/attendee/profile", {
        method: "PATCH",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(profile),
      });
      const payload = await response.json().catch(() => null) as {
        profile?: AttendeeProfileInput;
        message?: string;
      } | null;
      if (!response.ok || !payload?.profile) {
        throw new Error(payload?.message ?? "Your profile could not be saved.");
      }
      setProfile(payload.profile);
      setState("saved");
      setMessage("Profile saved. New registration forms can use these details.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Your profile could not be saved.");
    }
  }

  return (
    <form className="public-manage-contact-card" onSubmit={save}>
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Reusable profile</p>
        <h2>Your usual details</h2>
        <p>These values prefill matching fields on new registrations. You can still change them per event.</p>
      </div>
      <div className="public-manage-contact-grid">
        <label className="public-registration-field">
          <span className="public-registration-field-label">First name</span>
          <input autoComplete="given-name" maxLength={80} value={profile.firstName} onChange={(event) => field("firstName", event.target.value)} />
        </label>
        <label className="public-registration-field">
          <span className="public-registration-field-label">Last name</span>
          <input autoComplete="family-name" maxLength={80} value={profile.lastName} onChange={(event) => field("lastName", event.target.value)} />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Phone</span>
          <input autoComplete="tel" inputMode="tel" maxLength={40} value={profile.phone} onChange={(event) => field("phone", event.target.value)} />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Shirt size</span>
          <input maxLength={80} value={profile.shirtSize} onChange={(event) => field("shirtSize", event.target.value)} />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Dietary needs</span>
          <textarea maxLength={1000} rows={3} value={profile.dietaryNeeds} onChange={(event) => field("dietaryNeeds", event.target.value)} />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Accessibility needs</span>
          <textarea maxLength={1000} rows={3} value={profile.accessibilityNeeds} onChange={(event) => field("accessibilityNeeds", event.target.value)} />
        </label>
      </div>
      <div className="public-manage-contact-actions">
        <button disabled={state === "saving"} type="submit">
          <Save size={17} aria-hidden="true" />
          {state === "saving" ? "Saving…" : "Save profile"}
        </button>
        <p className={state === "error" ? "is-error" : state === "saved" ? "is-saved" : ""} role={state === "error" ? "alert" : "status"} aria-live="polite">
          {state === "error" && <AlertCircle size={16} aria-hidden="true" />}
          {state === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}
          {message}
        </p>
      </div>
    </form>
  );
}
