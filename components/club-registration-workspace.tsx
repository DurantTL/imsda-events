"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, UserPlus, UsersRound } from "lucide-react";
import {
  PublicRegistrationForm,
  type FormResponses,
  type RosterAttendee,
} from "@/components/public-registration-form";
import { clubRosterAttendeeTypeLabels } from "@/modules/club-rosters/domain";
import { rosterMemberIdFromClientId } from "@/modules/club-registrations/domain";
import type { ClubEventWorkspace } from "@/modules/club-registrations/repository";
import type { PublicRegistrationExperience } from "@/modules/forms/public-repository";

type Workspace = ClubEventWorkspace & { experience: PublicRegistrationExperience };

type DraftState = {
  selectedMemberIds: string[];
  responses: FormResponses;
  attendeeResponses: Record<string, FormResponses>;
};

export function ClubRegistrationWorkspace({
  contactPrefill,
  organizationId,
  workspace,
}: {
  contactPrefill: Record<string, string>;
  organizationId: string;
  workspace: Workspace;
}) {
  const router = useRouter();
  const rosterIds = useMemo(() => new Set(workspace.roster.map((person) => person.memberId)), [workspace.roster]);
  const [draft, setDraft] = useState<DraftState>(() => ({
    selectedMemberIds: (workspace.draft?.selectedMemberIds ?? []).filter((memberId) => rosterIds.has(memberId)),
    responses: (workspace.draft?.responses as FormResponses | undefined) ?? contactPrefill,
    attendeeResponses: (workspace.draft?.attendeeResponses as Record<string, FormResponses> | undefined) ?? {},
  }));
  const [step, setStep] = useState<"who" | "form">("who");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(workspace.draft ? "saved" : "idle");
  const pending = useRef<DraftState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const base = `/api/attendee/clubs/${encodeURIComponent(organizationId)}/events/${encodeURIComponent(workspace.event.id)}`;

  const flush = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    setSaveState("saving");
    try {
      const response = await fetch(`${base}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      setSaveState(response.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }, [base]);

  const queueSave = useCallback((next: DraftState) => {
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void flush(); }, 1200);
  }, [flush]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function toggle(memberId: string) {
    setDraft((current) => {
      const selected = current.selectedMemberIds.includes(memberId)
        ? current.selectedMemberIds.filter((id) => id !== memberId)
        : [...current.selectedMemberIds, memberId];
      const next = { ...current, selectedMemberIds: selected };
      queueSave(next);
      return next;
    });
  }

  function selectAll(all: boolean) {
    setDraft((current) => {
      const next = { ...current, selectedMemberIds: all ? workspace.roster.map((person) => person.memberId) : [] };
      queueSave(next);
      return next;
    });
  }

  const selected = workspace.roster.filter((person) => draft.selectedMemberIds.includes(person.memberId));

  const initialAttendees: RosterAttendee[] = useMemo(() => selected.map((person) => ({
    clientId: person.clientId,
    responses: {
      ...(person.prefillResponses as FormResponses),
      ...(draft.attendeeResponses[person.memberId] ?? {}),
      ...(person.ownedResponses as FormResponses),
    },
  })),
  // Built once per visit to the form step; later edits live in the form itself.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [step]);

  const onDraftChange = useCallback((form: { responses: FormResponses; attendees: RosterAttendee[] }) => {
    setDraft((current) => {
      const attendeeResponses = { ...current.attendeeResponses };
      for (const attendee of form.attendees) {
        const memberId = rosterMemberIdFromClientId(attendee.clientId);
        if (memberId) attendeeResponses[memberId] = attendee.responses;
      }
      const next = { ...current, responses: form.responses, attendeeResponses };
      queueSave(next);
      return next;
    });
  }, [queueSave]);

  const club = useMemo(() => ({
    initialAttendees,
    lockedAttendeeFieldKeys: workspace.lockedAttendeeFieldKeys,
    submitUrl: `${base}/registration`,
    onDraftChange,
    onSubmitted: () => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = null;
      router.refresh();
    },
  }), [initialAttendees, workspace.lockedAttendeeFieldKeys, base, onDraftChange, router]);

  const saveLabel = saveState === "saving" ? "Saving draft…" : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Draft not saved. Check your connection." : "";

  if (step === "form") {
    const { experience } = workspace;
    return (
      <div className="club-roster-stack">
        <div className="club-registration-toolbar">
          <button className="secondary-button" onClick={() => { void flush(); setStep("who"); }} type="button">
            <ArrowLeft aria-hidden="true" size={15} /> Change who&apos;s going
          </button>
          <span className="field-help" role="status">{saveLabel}</span>
        </div>
        <PublicRegistrationForm
          choiceUsage={experience.choiceUsage}
          club={club}
          event={experience.event}
          form={experience.form}
          initialResponses={draft.responses}
          lifecycle={experience.lifecycle}
          pricingDate={experience.pricingDate}
        />
      </div>
    );
  }

  return (
    <section className="public-manage-card">
      <div className="public-manage-card-heading club-roster-heading">
        <div>
          <p className="public-registration-eyebrow">Step 1 of 2</p>
          <h2>Who&apos;s going?</h2>
        </div>
        <span className="count-badge">{selected.length} chosen</span>
      </div>
      <p>
        Tick everyone from your roster who is attending. Ages are as of the event
        ({workspace.event.eventDate}). Your choices save automatically.
      </p>
      {workspace.roster.length === 0 ? (
        <p className="public-manage-empty">
          <UsersRound size={17} aria-hidden="true" /> Your roster is empty. Add your club members first.
        </p>
      ) : (
        <>
          <div className="club-roster-tools">
            <span>
              <button className="text-button" onClick={() => selectAll(true)} type="button">Select everyone</button>
              {" · "}
              <button className="text-button" onClick={() => selectAll(false)} type="button">Clear</button>
            </span>
            <span className="field-help" role="status">{saveLabel}</span>
          </div>
          <ul className="club-going-list">
            {workspace.roster.map((person) => (
              <li key={person.memberId}>
                <label className="checkbox-label">
                  <input
                    checked={draft.selectedMemberIds.includes(person.memberId)}
                    onChange={() => toggle(person.memberId)}
                    type="checkbox"
                  />
                  <span>
                    <strong translate="no">{person.lastName}, {person.firstName}</strong>
                    <small>
                      {clubRosterAttendeeTypeLabels[person.attendeeType]}
                      {person.role ? ` · ${person.role}` : ""}
                      {person.ageOnEventDate !== null ? <> · Age <span translate="no">{person.ageOnEventDate}</span></> : ""}
                    </small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="club-registration-toolbar">
        <Link className="secondary-button" href={`/account/clubs/${organizationId}`} onClick={() => { void flush(); }}>
          <UserPlus aria-hidden="true" size={15} /> Add someone new to the roster
        </Link>
        <button
          className="primary-button"
          disabled={selected.length === 0}
          onClick={() => { void flush(); setStep("form"); }}
          type="button"
        >
          Continue to the event form <ArrowRight aria-hidden="true" size={15} />
        </button>
      </div>
    </section>
  );
}
