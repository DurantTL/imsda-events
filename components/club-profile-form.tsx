"use client";

import { useState } from "react";
import { Save } from "lucide-react";
import type { ClubProfileRecord } from "@/modules/organizations/club-profile-repository";

type ProfileResponse = { profile?: ClubProfileRecord; message?: string; issues?: Array<{ message?: string }> };

/**
 * The club profile (#375), for the club's director or deputy and for
 * conference staff. The same form posts to whichever endpoint the page gives.
 */
export function ClubProfileForm({
  churches,
  endpoint,
  initialProfile,
  variant = "account",
}: {
  churches: Array<{ id: string; name: string }>;
  endpoint: string;
  initialProfile: ClubProfileRecord;
  variant?: "account" | "staff";
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: String(form.get("name") ?? ""),
          sponsoringChurchId: String(form.get("sponsoringChurchId") ?? "") || null,
          meetingPlace: String(form.get("meetingPlace") ?? ""),
          meetingSchedule: String(form.get("meetingSchedule") ?? ""),
          contactEmail: String(form.get("contactEmail") ?? ""),
          contactPhone: String(form.get("contactPhone") ?? ""),
          publicDescription: String(form.get("publicDescription") ?? ""),
          listPublicly: form.get("listPublicly") === "on",
        }),
      });
      const result = await response.json().catch(() => ({})) as ProfileResponse;
      if (!response.ok || !result.profile) {
        throw new Error(result.message ?? result.issues?.[0]?.message ?? "The club profile could not be saved.");
      }
      setProfile(result.profile);
      setNotice("Club profile saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The club profile could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const card = variant === "account" ? "public-manage-card form-stack" : "panel form-stack";

  return (
    <form className={card} key={profile.updatedAt ?? "new"} onSubmit={save}>
      <div className={variant === "account" ? "public-manage-card-heading" : "section-heading"}>
        <div>
          <p className={variant === "account" ? "public-registration-eyebrow" : "eyebrow"}>Club profile</p>
          <h2>About the club</h2>
        </div>
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <div className="form-grid two-column">
        <label>
          Club name
          <input defaultValue={profile.name} maxLength={120} minLength={2} name="name" required translate="no" />
        </label>
        <label>
          Sponsoring church
          <select defaultValue={profile.sponsoringChurchId ?? ""} name="sponsoringChurchId" required>
            <option disabled value="">Choose a church</option>
            {churches.map((church) => <option key={church.id} value={church.id}>{church.name}</option>)}
          </select>
        </label>
        <label>
          Meeting place
          <input defaultValue={profile.meetingPlace} maxLength={200} name="meetingPlace" placeholder="e.g. Church fellowship hall" />
        </label>
        <label>
          Meeting day and time
          <input defaultValue={profile.meetingSchedule} maxLength={120} name="meetingSchedule" placeholder="e.g. Sundays, 2:00–4:00 PM" />
        </label>
        <label>
          Contact email
          <input defaultValue={profile.contactEmail} maxLength={254} name="contactEmail" type="email" />
        </label>
        <label>
          Contact phone
          <input defaultValue={profile.contactPhone} maxLength={40} name="contactPhone" type="tel" />
        </label>
      </div>
      <label>
        Short description
        <textarea defaultValue={profile.publicDescription} maxLength={1000} name="publicDescription" rows={4} />
      </label>
      <label className="checkbox-label">
        <input defaultChecked={profile.listPublicly} name="listPublicly" type="checkbox" />
        List this club publicly when &ldquo;find a club&rdquo; opens
      </label>
      <p className="field-help">
        The contact email and phone are for families looking for a club. Use a club or church contact, not a
        young person&apos;s. Every change is recorded.
      </p>
      <div>
        <button className="primary-button" disabled={saving} type="submit">
          <Save aria-hidden="true" size={16} /> Save profile
        </button>
      </div>
    </form>
  );
}
