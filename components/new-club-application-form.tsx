"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { ClubFormSectionTitle } from "@/components/club-form-section-title";
import { sponsorOptionLabel } from "@/modules/organizations/domain";
import {
  CHURCH_AGREEMENT,
  MAX_APPLICATION_ATTACHMENT_BYTES,
  MAX_OTHER_BOARD_MEMBERS,
  NEW_CLUB_TYPES,
  PHILOSOPHY_STATEMENT,
  newClubTypeLabels,
} from "@/modules/club-applications/domain";

const OTHER = "__other__";
const ACCEPT = "application/pdf,image/png,image/jpeg,image/webp";

type Props = {
  churches: Array<{ id: string; name: string; type: string }>;
  /** Today in the conference time zone, as a readable date. The server stamps the real one when it saves. */
  todayLabel: string;
  /** The private link's token, when the page was opened from one. */
  inviteToken?: string;
  prefill?: { email: string; name: string };
};

/**
 * The "Register a new club" application (#817), mirroring the conference's
 * paper Pathfinder Program Club Application. Used by the public page and by a
 * private invite link (which prefills the director's email). It only sends an
 * application for staff to review: nothing is created until a system
 * administrator approves it. The server checks everything again.
 */
export function NewClubApplicationForm({ churches, todayLabel, inviteToken, prefill }: Props) {
  const [openedAt] = useState(() => Date.now());
  const [values, setValues] = useState({
    clubName: "",
    clubType: "" as "" | (typeof NEW_CLUB_TYPES)[number],
    church: "",
    churchOther: "",
    pastorName: "",
    directorName: prefill?.name ?? "",
    directorAddress: "",
    directorEmail: prefill?.email ?? "",
    directorHomePhone: "",
    directorWorkPhone: "",
    pastorSignature: "",
    headElderSignature: "",
    clerkSignature: "",
    directorSignature: "",
    note: "",
  });
  const [agreed, setAgreed] = useState(false);
  const [boardMembers, setBoardMembers] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [website, setWebsite] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  function set<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (file && file.size > MAX_APPLICATION_ATTACHMENT_BYTES) {
      setError(`The attachment must be ${Math.floor(MAX_APPLICATION_ATTACHMENT_BYTES / (1024 * 1024))} MB or smaller.`);
      return;
    }
    setSaving(true);
    try {
      const isOther = values.church === OTHER;
      const data = {
        clubName: values.clubName,
        clubType: values.clubType,
        sponsoringChurchId: isOther ? null : values.church || null,
        sponsoringChurchOther: isOther ? values.churchOther : null,
        pastorName: values.pastorName,
        directorName: values.directorName,
        directorAddress: values.directorAddress,
        directorEmail: values.directorEmail,
        directorHomePhone: values.directorHomePhone,
        directorWorkPhone: values.directorWorkPhone,
        philosophyAgreed: agreed,
        pastorSignature: values.pastorSignature,
        headElderSignature: values.headElderSignature,
        clerkSignature: values.clerkSignature,
        directorSignature: values.directorSignature,
        otherBoardMembers: boardMembers.map((name) => name.trim()).filter(Boolean),
        note: values.note,
        formOpenedAt: openedAt,
        website,
      };
      const body = new FormData();
      body.set("data", JSON.stringify(data));
      if (inviteToken) body.set("inviteToken", inviteToken);
      if (file) body.set("attachment", file);
      const response = await fetch("/api/public/club-applications", { method: "POST", body });
      const result = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(result.message ?? "The application could not be sent. Please try again.");
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The application could not be sent. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <section className="public-manage-card club-form-done" role="status">
        <h2>Application received</h2>
        <p>
          Thank you. The conference youth department will review your application. Nothing is set up until it is approved, and you&apos;ll be
          emailed at <strong translate="no">{values.directorEmail.trim().toLowerCase()}</strong> either way.
        </p>
      </section>
    );
  }

  return (
    <form className="club-form-fill" onSubmit={(event) => void submit(event)}>
      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <ClubFormSectionTitle>The club</ClubFormSectionTitle>
        <div className="form-grid two-column">
          <label>
            Club name
            <input autoComplete="off" maxLength={120} onChange={(event) => set("clubName", event.target.value)} required value={values.clubName} />
          </label>
          <label>
            Type of club
            <select onChange={(event) => set("clubType", event.target.value as typeof values.clubType)} required value={values.clubType}>
              <option value="">Choose…</option>
              {NEW_CLUB_TYPES.map((type) => <option key={type} value={type}>{newClubTypeLabels[type]}</option>)}
            </select>
          </label>
          <label>
            Sponsoring church or company
            <select onChange={(event) => set("church", event.target.value)} required value={values.church}>
              <option value="">Choose a church or company…</option>
              {churches.map((church) => <option key={church.id} value={church.id}>{sponsorOptionLabel(church)}</option>)}
              <option value={OTHER}>Other (not in this list)</option>
            </select>
          </label>
          {values.church === OTHER && (
            <label>
              Name of the church or company
              <input autoComplete="off" maxLength={160} onChange={(event) => set("churchOther", event.target.value)} required value={values.churchOther} />
              <small className="field-help">The conference will match it to its church directory.</small>
            </label>
          )}
          <label>
            Church pastor
            <input autoComplete="off" maxLength={120} onChange={(event) => set("pastorName", event.target.value)} required value={values.pastorName} />
          </label>
        </div>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <ClubFormSectionTitle>Elected Pathfinder leader (the club director)</ClubFormSectionTitle>
        <div className="form-grid two-column">
          <label>
            Name
            <input autoComplete="name" maxLength={120} onChange={(event) => set("directorName", event.target.value)} required value={values.directorName} />
          </label>
          <label>
            Email
            <input autoComplete="email" maxLength={160} onChange={(event) => set("directorEmail", event.target.value)} required type="email" value={values.directorEmail} />
            <small className="field-help">The club director invite is sent here when the application is approved.</small>
          </label>
          <label className="club-form-field-wide">
            Mailing address
            <textarea autoComplete="street-address" maxLength={300} onChange={(event) => set("directorAddress", event.target.value)} required rows={3} value={values.directorAddress} />
          </label>
          <label>
            Home phone
            <input autoComplete="tel" maxLength={40} onChange={(event) => set("directorHomePhone", event.target.value)} type="tel" value={values.directorHomePhone} />
          </label>
          <label>
            Work phone
            <input maxLength={40} onChange={(event) => set("directorWorkPhone", event.target.value)} type="tel" value={values.directorWorkPhone} />
            <small className="field-help">Give at least one phone number.</small>
          </label>
        </div>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <ClubFormSectionTitle>Philosophy of Pathfindering</ClubFormSectionTitle>
        <p className="club-form-note">{PHILOSOPHY_STATEMENT}</p>
        <label className="nca-agree">
          <input checked={agreed} onChange={(event) => setAgreed(event.target.checked)} required type="checkbox" />
          <span>{CHURCH_AGREEMENT}</span>
        </label>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <ClubFormSectionTitle>Signatures (type your full name)</ClubFormSectionTitle>
        <div className="form-grid two-column">
          <label>
            Church pastor
            <input autoComplete="off" maxLength={120} onChange={(event) => set("pastorSignature", event.target.value)} required value={values.pastorSignature} />
          </label>
          <label>
            Head elder
            <input autoComplete="off" maxLength={120} onChange={(event) => set("headElderSignature", event.target.value)} required value={values.headElderSignature} />
          </label>
          <label>
            Church clerk
            <input autoComplete="off" maxLength={120} onChange={(event) => set("clerkSignature", event.target.value)} required value={values.clerkSignature} />
          </label>
          <label>
            Club director
            <input autoComplete="off" maxLength={120} onChange={(event) => set("directorSignature", event.target.value)} required value={values.directorSignature} />
          </label>
          <div className="club-form-field-wide nca-board">
            <span className="nca-board-title">Other church board members (optional)</span>
            {boardMembers.map((name, index) => (
              <div className="nca-board-row" key={index}>
                <input
                  aria-label={`Board member ${index + 1}`}
                  autoComplete="off"
                  maxLength={120}
                  onChange={(event) => setBoardMembers((current) => current.map((entry, at) => (at === index ? event.target.value : entry)))}
                  value={name}
                />
                <button aria-label={`Remove board member ${index + 1}`} className="secondary-button" onClick={() => setBoardMembers((current) => current.filter((_, at) => at !== index))} type="button">
                  <X aria-hidden="true" size={14} />
                </button>
              </div>
            ))}
            {boardMembers.length < MAX_OTHER_BOARD_MEMBERS && (
              <button className="secondary-button nca-board-add" onClick={() => setBoardMembers((current) => [...current, ""])} type="button">
                <Plus aria-hidden="true" size={14} /> Add a board member
              </button>
            )}
          </div>
        </div>
        <p className="field-help">Date: {todayLabel}</p>
      </fieldset>

      <fieldset className="public-manage-card form-stack" disabled={saving}>
        <ClubFormSectionTitle>Optional extras</ClubFormSectionTitle>
        <label>
          Attach the signed paper page or the church board minutes (PDF or image, up to 10 MB)
          <input accept={ACCEPT} onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" />
          <small className="field-help">Only conference administrators and Area Coordinators can open it.</small>
        </label>
        <label>
          Anything else we should know (optional)
          <textarea maxLength={1000} onChange={(event) => set("note", event.target.value)} rows={3} value={values.note} />
        </label>
      </fieldset>

      <div className="public-registration-honeypot" aria-hidden="true">
        <label htmlFor="new_club_website">Website</label>
        <input autoComplete="off" id="new_club_website" name="website" onChange={(event) => setWebsite(event.target.value)} tabIndex={-1} type="text" value={website} />
      </div>

      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <div className="intro-actions">
        <button className="primary-button" disabled={saving} type="submit">{saving ? "Sending…" : "Send application"}</button>
      </div>
    </form>
  );
}
