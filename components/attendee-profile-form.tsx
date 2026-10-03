"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Save } from "lucide-react";
import type { AttendeeProfileInput } from "@/modules/attendee-accounts/profile-service";

export function AttendeeProfileForm({
  email = null,
  initialProfile,
}: {
  email?: string | null;
  initialProfile: AttendeeProfileInput;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const [needsSecondStep, setNeedsSecondStep] = useState(false);

  function field(name: keyof AttendeeProfileInput, value: string) {
    setProfile((current) => ({ ...current, [name]: value }));
    setState("idle");
    setMessage("");
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("saving");
    setMessage("Saving profile…");
    setNeedsSecondStep(false);
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
        code?: string;
      } | null;
      if (payload?.code === "SECOND_STEP_REQUIRED") setNeedsSecondStep(true);
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
    <form aria-busy={state === "saving"} className="public-manage-contact-card profile-details-form" onSubmit={save}>
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Reusable profile</p>
        <h2>Your usual details</h2>
        <p>These values prefill matching fields on new registrations. You can still change them per event.</p>
      </div>
      {email && (
        <label className="public-registration-field profile-readonly-field">
          <span className="public-registration-field-label">Sign-in email <em>(read-only)</em></span>
          <input aria-describedby="profile-email-note" readOnly value={email} />
          <small className="field-help" id="profile-email-note">This is the verified email you sign in with. It cannot be changed here.</small>
        </label>
      )}
      <fieldset className="profile-form-group">
        <legend>Contact</legend>
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
        </div>
      </fieldset>
      <fieldset className="profile-form-group">
        <legend>Mailing address <em>(optional)</em></legend>
        <p className="field-help">Only used to prefill address questions on your own registrations. Staff see an address only if you submit it on a registration. Clear every box to remove it.</p>
        <div className="public-manage-contact-grid">
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Address line 1</span>
          <input autoComplete="address-line1" maxLength={200} value={profile.mailingLine1} onChange={(event) => field("mailingLine1", event.target.value)} />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Address line 2</span>
          <input autoComplete="address-line2" maxLength={200} value={profile.mailingLine2} onChange={(event) => field("mailingLine2", event.target.value)} />
        </label>
        <label className="public-registration-field">
          <span className="public-registration-field-label">City</span>
          <input autoComplete="address-level2" maxLength={200} value={profile.mailingCity} onChange={(event) => field("mailingCity", event.target.value)} />
        </label>
        <label className="public-registration-field">
          <span className="public-registration-field-label">State / province / region</span>
          <input autoComplete="address-level1" maxLength={200} value={profile.mailingRegion} onChange={(event) => field("mailingRegion", event.target.value)} />
        </label>
        <label className="public-registration-field">
          <span className="public-registration-field-label">ZIP / postal code</span>
          <input autoComplete="postal-code" maxLength={200} value={profile.mailingPostalCode} onChange={(event) => field("mailingPostalCode", event.target.value)} />
        </label>
        <label className="public-registration-field">
          <span className="public-registration-field-label">Country</span>
          <input autoComplete="country-name" maxLength={200} value={profile.mailingCountry} onChange={(event) => field("mailingCountry", event.target.value)} />
        </label>
        </div>
      </fieldset>
      <fieldset className="profile-form-group">
        <legend>Emergency contact <em>(optional)</em></legend>
        <p className="field-help">Someone we can reach if you need help at an event. Used only to prefill your registrations; you can change it on each form.</p>
        <div className="public-manage-contact-grid">
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Name</span>
          <input autoComplete="section-emergency name" maxLength={120} value={profile.emergencyContactName} onChange={(event) => field("emergencyContactName", event.target.value)} />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Relationship</span>
          <input autoComplete="off" maxLength={80} value={profile.emergencyContactRelationship} onChange={(event) => field("emergencyContactRelationship", event.target.value)} />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Phone</span>
          <input autoComplete="section-emergency tel" inputMode="tel" maxLength={40} value={profile.emergencyContactPhone} onChange={(event) => field("emergencyContactPhone", event.target.value)} />
        </label>
        </div>
      </fieldset>
      <fieldset className="profile-form-group">
        <legend>Event preferences</legend>
        <div className="public-manage-contact-grid">
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
      </fieldset>
      <div className="public-manage-contact-actions">
        <button disabled={state === "saving"} type="submit">
          <Save size={17} aria-hidden="true" />
          {state === "saving" ? "Saving…" : "Save profile"}
        </button>
        <p className={state === "error" ? "is-error" : state === "saved" ? "is-saved" : ""} role={state === "error" ? "alert" : "status"} aria-live="polite">
          {state === "error" && <AlertCircle size={16} aria-hidden="true" />}
          {state === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}
          {message}
          {state === "error" && needsSecondStep && (
            <>
              {" "}
              <Link href="/account/two-step">Finish two-step sign-in</Link>
            </>
          )}
        </p>
      </div>
    </form>
  );
}
