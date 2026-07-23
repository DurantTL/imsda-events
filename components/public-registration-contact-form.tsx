"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Save } from "lucide-react";

type Contact = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
};

type PublicRegistrationContactFormProps = {
  token: string;
  initialContact: Contact;
};

type SaveState =
  | { kind: "idle"; message: "" }
  | { kind: "saving"; message: "Saving contact details…" }
  | { kind: "saved"; message: "Contact details saved." }
  | { kind: "error"; message: string };

export function PublicRegistrationContactForm({
  token,
  initialContact,
}: PublicRegistrationContactFormProps) {
  const [contact, setContact] = useState(initialContact);
  const [saveState, setSaveState] = useState<SaveState>({
    kind: "idle",
    message: "",
  });

  function updateField(field: keyof Contact, value: string) {
    setContact((current) => ({ ...current, [field]: value }));
    if (saveState.kind !== "idle" && saveState.kind !== "saving") {
      setSaveState({ kind: "idle", message: "" });
    }
  }

  async function saveContact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveState({ kind: "saving", message: "Saving contact details…" });

    try {
      const response = await fetch(
        `/api/public/manage/${encodeURIComponent(token)}`,
        {
          method: "PATCH",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(contact),
        },
      );
      const payload = await response.json().catch(() => null) as {
        message?: string;
        registration?: { contact?: Contact };
      } | null;

      if (!response.ok) {
        throw new Error(
          payload?.message
          ?? "The contact details could not be saved. Try again.",
        );
      }
      if (payload?.registration?.contact) {
        setContact(payload.registration.contact);
      }
      setSaveState({ kind: "saved", message: "Contact details saved." });
    } catch (error) {
      setSaveState({
        kind: "error",
        message: error instanceof Error
          ? error.message
          : "The contact details could not be saved. Try again.",
      });
    }
  }

  return (
    <form
      className="public-manage-contact-card"
      onSubmit={saveContact}
    >
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Registration contact</p>
        <h2>Keep contact details current</h2>
        <p>
          Event updates and confirmation messages use the details saved with
          this registration.
        </p>
      </div>

      <div className="public-manage-contact-grid">
        <label className="public-registration-field">
          <span className="public-registration-field-label">
            First name <span aria-hidden="true">*</span>
          </span>
          <input
            autoComplete="given-name"
            maxLength={80}
            name="firstName"
            onChange={(event) => updateField("firstName", event.target.value)}
            required
            value={contact.firstName}
          />
        </label>
        <label className="public-registration-field">
          <span className="public-registration-field-label">
            Last name <span aria-hidden="true">*</span>
          </span>
          <input
            autoComplete="family-name"
            maxLength={80}
            name="lastName"
            onChange={(event) => updateField("lastName", event.target.value)}
            required
            value={contact.lastName}
          />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">
            Email <span aria-hidden="true">*</span>
          </span>
          <input
            autoComplete="email"
            inputMode="email"
            maxLength={160}
            name="email"
            onChange={(event) => updateField("email", event.target.value)}
            required
            type="email"
            value={contact.email}
          />
        </label>
        <label className="public-registration-field public-manage-contact-wide">
          <span className="public-registration-field-label">Phone</span>
          <input
            autoComplete="tel"
            inputMode="tel"
            maxLength={40}
            name="phone"
            onChange={(event) => updateField("phone", event.target.value)}
            type="tel"
            value={contact.phone}
          />
        </label>
      </div>

      <div className="public-manage-contact-actions">
        <button disabled={saveState.kind === "saving"} type="submit">
          <Save size={17} aria-hidden="true" />
          {saveState.kind === "saving" ? "Saving…" : "Save contact details"}
        </button>
        <p
          className={saveState.kind === "error" ? "is-error" : saveState.kind === "saved" ? "is-saved" : ""}
          role={saveState.kind === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {saveState.kind === "error" && <AlertCircle size={16} aria-hidden="true" />}
          {saveState.kind === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}
          {saveState.message}
        </p>
      </div>
    </form>
  );
}
