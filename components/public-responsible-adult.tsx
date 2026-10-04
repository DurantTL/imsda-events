"use client";

import { useState, type FormEvent } from "react";
import { AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";
import { ResponsibleAdultChoice } from "@/components/responsible-adult-choice";
import { RESPONSIBLE_ADULT_NONE } from "@/modules/guardian-authority/domain";
import type { RegistrationResponsibleAdultView } from "@/modules/guardian-authority/repository";

type PublicResponsibleAdultProps = {
  token: string;
  view: RegistrationResponsibleAdultView;
  /** The event verifies every edit: shown, but changed through the verified route or the event team. */
  readOnly?: boolean;
};

type SaveState =
  | { kind: "idle"; message: "" }
  | { kind: "saving"; message: "Saving…" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

/** "Responsible adult" on the private registration page (#131): the registrant can change the choice made on the form. */
export function PublicResponsibleAdult({ token, view: initialView, readOnly = false }: PublicResponsibleAdultProps) {
  const [view, setView] = useState(initialView);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [state, setState] = useState<SaveState>({ kind: "idle", message: "" });
  // Shown value: the registrant's change, else what is recorded, else the only adult (preselected, never blank).
  const preselected = view.adults.length === 1 ? view.adults[0]!.attendeeId : (view.adults.find((adult) => adult.isAccountHolder) ?? view.adults[0])?.attendeeId ?? RESPONSIBLE_ADULT_NONE;
  const values = Object.fromEntries(view.minors.map((minor) => [minor.attendeeId, picks[minor.attendeeId] ?? minor.choice ?? preselected]));
  const editable = !readOnly && view.minors.some((minor) => !minor.lockedByStaff);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "saving", message: "Saving…" });
    try {
      const response = await fetch(`/api/public/manage/${encodeURIComponent(token)}/responsible-adult`, {
        method: "PUT",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choices: Object.fromEntries(view.minors.filter((minor) => !minor.lockedByStaff).map((minor) => [minor.attendeeId, values[minor.attendeeId]])) }),
      });
      const payload = await response.json().catch(() => null) as { message?: string; view?: RegistrationResponsibleAdultView | null; outcome?: { sentToReview: number } } | null;
      if (!response.ok) throw new Error(payload?.message ?? "The responsible adult could not be saved. Try again.");
      if (payload?.view) {
        setView(payload.view);
        setPicks({});
      }
      setState({
        kind: "saved",
        message: payload?.outcome && payload.outcome.sentToReview > 0
          ? "Saved. One choice differs from what is already recorded, so the event team will review it."
          : "Saved.",
      });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "The responsible adult could not be saved. Try again." });
    }
  }

  return (
    <section className="public-manage-card" aria-labelledby="public_manage_responsible_adult_title">
      <div className="public-manage-card-heading">
        <p className="public-registration-eyebrow">Minors on this registration</p>
        <h2 id="public_manage_responsible_adult_title">Responsible adult</h2>
        <p>The adult on this registration who is responsible for each minor. Saving records your choice.</p>
      </div>
      <form onSubmit={save}>
        <ResponsibleAdultChoice
          idPrefix="public_manage_responsible_adult"
          minors={view.minors.map((minor) => ({
            key: minor.attendeeId,
            name: minor.name,
            locked: minor.lockedByStaff || readOnly,
            lockNote: readOnly && !minor.lockedByStaff
              ? "This event verifies every change. To change this, contact the event team."
              : minor.lockReason === "OTHER_REGISTRATION"
                ? "Recorded on another registration. Contact the event team to change it."
                : "Set by the event team. Contact them to change it.",
            note: minor.choice === null ? "Not recorded yet — choose and save." : undefined,
          }))}
          adults={view.adults.map((adult) => ({ key: adult.attendeeId, name: adult.name }))}
          values={values}
          onChange={(minorKey, value) => {
            setPicks((current) => ({ ...current, [minorKey]: value }));
            if (state.kind !== "idle" && state.kind !== "saving") setState({ kind: "idle", message: "" });
          }}
        />
        {editable && (
          <button className="primary-button" type="submit" disabled={state.kind === "saving"}>
            <ShieldCheck size={18} aria-hidden="true" /> Save responsible adult
          </button>
        )}
        <p role={state.kind === "error" ? "alert" : "status"} aria-live="polite">
          {state.kind === "saved" && <CheckCircle2 size={16} aria-hidden="true" />}
          {state.kind === "error" && <AlertCircle size={16} aria-hidden="true" />}
          {state.message}
        </p>
      </form>
    </section>
  );
}
