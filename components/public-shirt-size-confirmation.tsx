"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, Shirt } from "lucide-react";
import {
  shirtSizeOptions,
  type ShirtSize,
} from "@/modules/registrations/shirt-sizes";

type ShirtSizeAttendee = {
  id: string;
  name: string;
  shirtSize: ShirtSize | null;
  shirtSizeConfirmedAt: string | null;
};

type PublicShirtSizeConfirmationProps = {
  token: string;
  attendees: ShirtSizeAttendee[];
};

type SaveState =
  | { kind: "idle"; message: "" }
  | { kind: "saving"; message: "Saving shirt sizes…" }
  | { kind: "saved"; message: "Shirt sizes confirmed." }
  | { kind: "error"; message: string };

function confirmationLabel(value: string | null) {
  if (!value) return "Needs confirmation";
  return `Confirmed ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))}`;
}

export function PublicShirtSizeConfirmation({
  token,
  attendees: initialAttendees,
}: PublicShirtSizeConfirmationProps) {
  const [attendees, setAttendees] = useState(initialAttendees);
  const [selections, setSelections] = useState<Record<string, ShirtSize | "">>(
    Object.fromEntries(
      initialAttendees.map((attendee) => [
        attendee.id,
        attendee.shirtSize ?? "",
      ]),
    ),
  );
  const [saveState, setSaveState] = useState<SaveState>({
    kind: "idle",
    message: "",
  });
  const missingCount = attendees.filter((attendee) => (
    !selections[attendee.id]
  )).length;

  function updateSelection(attendeeId: string, shirtSize: ShirtSize | "") {
    setSelections((current) => ({ ...current, [attendeeId]: shirtSize }));
    if (saveState.kind !== "idle" && saveState.kind !== "saving") {
      setSaveState({ kind: "idle", message: "" });
    }
  }

  async function confirmShirtSizes(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (missingCount > 0) {
      setSaveState({
        kind: "error",
        message: "Choose a shirt size for every attendee.",
      });
      return;
    }
    setSaveState({ kind: "saving", message: "Saving shirt sizes…" });

    try {
      const response = await fetch(
        `/api/public/manage/${encodeURIComponent(token)}/shirt-sizes`,
        {
          method: "PATCH",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            attendees: attendees.map((attendee) => ({
              attendeeId: attendee.id,
              shirtSize: selections[attendee.id],
            })),
          }),
        },
      );
      const payload = await response.json().catch(() => null) as {
        message?: string;
        registration?: { attendees?: ShirtSizeAttendee[] };
      } | null;
      if (!response.ok) {
        throw new Error(
          payload?.message
          ?? "The shirt sizes could not be saved. Try again.",
        );
      }
      if (payload?.registration?.attendees) {
        setAttendees(payload.registration.attendees);
        setSelections(Object.fromEntries(
          payload.registration.attendees.map((attendee) => [
            attendee.id,
            attendee.shirtSize ?? "",
          ]),
        ));
      }
      setSaveState({ kind: "saved", message: "Shirt sizes confirmed." });
    } catch (error) {
      setSaveState({
        kind: "error",
        message: error instanceof Error
          ? error.message
          : "The shirt sizes could not be saved. Try again.",
      });
    }
  }

  return (
    <form
      className="public-manage-card public-shirt-size-card"
      onSubmit={confirmShirtSizes}
    >
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Convention shirts</p>
        <h2>Confirm shirt sizes</h2>
        <p>
          Choose the final shirt size for every attendee. You can return to this
          private page and reconfirm sizes if a correction is needed.
        </p>
      </div>

      <div className="public-shirt-size-list">
        {attendees.map((attendee, index) => (
          <label
            className="public-registration-field public-shirt-size-row"
            key={attendee.id}
          >
            <span className="public-shirt-size-person">
              <span><Shirt aria-hidden="true" size={17} /></span>
              <span>
                <small>Attendee {index + 1}</small>
                <strong>{attendee.name}</strong>
              </span>
              <em className={attendee.shirtSizeConfirmedAt ? "is-confirmed" : ""}>
                {confirmationLabel(attendee.shirtSizeConfirmedAt)}
              </em>
            </span>
            <select
              aria-label={`Shirt size for ${attendee.name}`}
              onChange={(event) => updateSelection(
                attendee.id,
                event.target.value as ShirtSize | "",
              )}
              required
              value={selections[attendee.id] ?? ""}
            >
              <option value="">Choose a size</option>
              {shirtSizeOptions.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="public-manage-contact-actions">
        <button
          disabled={saveState.kind === "saving" || missingCount > 0}
          type="submit"
        >
          <CheckCircle2 aria-hidden="true" size={17} />
          {saveState.kind === "saving" ? "Saving…" : "Confirm all shirt sizes"}
        </button>
        <p
          aria-live="polite"
          className={saveState.kind === "error" ? "is-error" : saveState.kind === "saved" ? "is-saved" : ""}
          role={saveState.kind === "error" ? "alert" : "status"}
        >
          {saveState.kind === "error" && <AlertCircle aria-hidden="true" size={16} />}
          {saveState.kind === "saved" && <CheckCircle2 aria-hidden="true" size={16} />}
          {saveState.message || (
            missingCount > 0
              ? `${missingCount} ${missingCount === 1 ? "attendee needs" : "attendees need"} a shirt size.`
              : "Every attendee has a selected size. Confirm to save the final choices."
          )}
        </p>
      </div>
    </form>
  );
}
