"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { inlinePhoneProblem } from "@/lib/field-validation";
import { StaffInvitationQuestions, type StaffAnswers } from "@/components/staff-invitation-questions";
import type { StaffQuestion } from "@/modules/staff-invitations/event-questions";
import { COVERAGE_SENTENCE, FAMILY_MAX_DEPENDANT_AGE, FAMILY_MAX_DEPENDANTS, NAME_MAX } from "@/modules/staff-invitations/domain";

type Child = { key: number; firstName: string; lastName: string; age: string };

type Props = {
  token: string;
  event: { name: string; slug: string; startsOn: string; endsOn: string; supportContact: string | null };
  person: { firstName: string; lastName: string; email: string; groupLabel: string };
  /** The event's own attendee questions, asked of everyone in the party. Never priced, meal or lodging ones. */
  questions: StaffQuestion[];
};

/**
 * The page behind a personal invitation link (#804): the invited person, an optional spouse, and children or dependants up to
 * age 18. It asks nothing about price or meals, because there is no charge and the conference covers every meal. The server
 * decides everything (the link, the family rule, the group); this only guides, and shows each problem it is told about.
 */
export function StaffInvitationRegistration({ token, event, person, questions }: Props) {
  const [firstName, setFirstName] = useState(person.firstName);
  const [lastName, setLastName] = useState(person.lastName);
  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  // The same phone check the server runs (#1193); the field starts blank, so a typed phone is always a new value.
  const phoneProblem = inlinePhoneProblem("Phone", phone, undefined, phoneTouched);
  const [hasSpouse, setHasSpouse] = useState(false);
  const [spouseFirst, setSpouseFirst] = useState("");
  const [spouseLast, setSpouseLast] = useState("");
  const [children, setChildren] = useState<Child[]>([]);
  const [nextKey, setNextKey] = useState(1);
  const [needsHousing, setNeedsHousing] = useState(false);
  const [housingNote, setHousingNote] = useState("");
  const [website, setWebsite] = useState("");
  const [primaryAnswers, setPrimaryAnswers] = useState<StaffAnswers>({});
  const [spouseAnswers, setSpouseAnswers] = useState<StaffAnswers>({});
  const [childAnswers, setChildAnswers] = useState<Record<number, StaffAnswers>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ confirmationCode: string; message: string } | null>(null);

  function addChild() {
    setChildren((current) => [...current, { key: nextKey, firstName: "", lastName, age: "" }]);
    setNextKey((key) => key + 1);
  }

  function updateChild(key: number, change: Partial<Child>) {
    setChildren((current) => current.map((child) => (child.key === key ? { ...child, ...change } : child)));
  }

  async function submit(submitEvent: FormEvent<HTMLFormElement>) {
    submitEvent.preventDefault();
    setError("");
    setPhoneTouched(true);
    if (phoneProblem.blocking) {
      setError("Check the highlighted answers and try again.");
      return;
    }
    const dependants = [];
    const answers: StaffAnswers[] = questions.length > 0 ? [primaryAnswers] : [];
    if (questions.length > 0 && hasSpouse) answers.push(spouseAnswers);
    for (const child of children) {
      if (questions.length > 0) answers.push(childAnswers[child.key] ?? {});
      const age = Number(child.age);
      if (child.age.trim() === "" || !Number.isInteger(age) || age < 0) {
        setError("Enter each child's age as a whole number.");
        return;
      }
      if (age > FAMILY_MAX_DEPENDANT_AGE) {
        setError(`Only children and dependants up to age ${FAMILY_MAX_DEPENDANT_AGE} are covered.`);
        return;
      }
      dependants.push({ firstName: child.firstName, lastName: child.lastName, age });
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/public/staff-invitations/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          phone,
          spouse: hasSpouse ? { firstName: spouseFirst, lastName: spouseLast } : null,
          dependants,
          needsHousing,
          housingNote,
          ...(questions.length > 0 ? { answers } : {}),
          website,
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: string; confirmation?: { confirmationCode: string; message: string } };
      if (!response.ok || !result.confirmation) {
        setError(result.message ?? "That couldn't be saved. Nothing was registered. Try again.");
        return;
      }
      setDone(result.confirmation);
    } catch {
      setError("We couldn't reach the server. Nothing was registered. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <header className="public-registration-header">
      <div className="public-registration-header-inner">
        <Link className="public-registration-brand public-event-brand-link" href={`/events/${encodeURIComponent(event.slug)}`}>
          <BrandMark /><span><strong>IMSDA</strong><small>Events</small></span>
        </Link>
      </div>
    </header>
  );

  if (done) {
    return (
      <main className="public-registration-page">
        {header}
        <section className="public-manage-card public-group-state" aria-live="polite">
          <p className="public-registration-eyebrow">{event.name}</p>
          <h1><CheckCircle2 aria-hidden="true" size={22} /> We have your registration</h1>
          <p>{done.message}</p>
          <p><strong>Reference:</strong> {done.confirmationCode}</p>
          <p>We emailed {person.email} a receipt. Keep this reference if you contact the event office.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="public-registration-page">
      {header}
      <form className="public-manage-card form-stack staff-invite-form" onSubmit={(formEvent) => void submit(formEvent)}>
        <p className="public-registration-eyebrow">{event.name} · {person.groupLabel} registration</p>
        <h1>Register for {event.name}</h1>
        <p>{event.startsOn === event.endsOn ? event.startsOn : `${event.startsOn} to ${event.endsOn}`}</p>
        <p>{COVERAGE_SENTENCE} There is nothing to pay, and every meal is covered, so you won&rsquo;t be asked to choose any.</p>
        {questions.length > 0 && <p className="field-help">We also ask the event&rsquo;s own questions for each person in your registration.</p>}
        <p className="field-help">The event office reviews every registration before it is confirmed. Housing is assigned later by the office.</p>

        <fieldset className="form-stack">
          <legend>About you</legend>
          <div className="form-grid two-column">
            <label>First name<input autoComplete="given-name" maxLength={NAME_MAX} onChange={(changeEvent) => setFirstName(changeEvent.target.value)} required value={firstName} /></label>
            <label>Last name<input autoComplete="family-name" maxLength={NAME_MAX} onChange={(changeEvent) => setLastName(changeEvent.target.value)} required value={lastName} /></label>
          </div>
          <div className="form-grid two-column">
            <label>Email<input disabled readOnly type="email" value={person.email} /></label>
            <label>Phone (optional)
              <input aria-describedby={phoneProblem.message ? "staff-invitation-phone-error" : undefined} aria-invalid={phoneProblem.message ? true : undefined} autoComplete="tel" inputMode="tel" maxLength={40} onBlur={() => setPhoneTouched(true)} onChange={(changeEvent) => setPhone(changeEvent.target.value)} type="tel" value={phone} />
              {phoneProblem.message && <small className="field-error" id="staff-invitation-phone-error" role="alert">{phoneProblem.message}</small>}
            </label>
          </div>
          {questions.length > 0 && (
            <StaffInvitationQuestions answers={primaryAnswers} idPrefix="you" personLabel="you" onChange={setPrimaryAnswers} questions={questions} />
          )}
        </fieldset>

        <fieldset className="form-stack">
          <legend>Your immediate family</legend>
          <label className="checkbox-label">
            <input checked={hasSpouse} onChange={(changeEvent) => setHasSpouse(changeEvent.target.checked)} type="checkbox" /> My spouse is coming
          </label>
          {hasSpouse && (
            <div className="form-grid two-column">
              <label>Spouse first name<input maxLength={NAME_MAX} onChange={(changeEvent) => setSpouseFirst(changeEvent.target.value)} required value={spouseFirst} /></label>
              <label>Spouse last name<input maxLength={NAME_MAX} onChange={(changeEvent) => setSpouseLast(changeEvent.target.value)} required value={spouseLast} /></label>
            </div>
          )}
          {hasSpouse && questions.length > 0 && (
            <StaffInvitationQuestions answers={spouseAnswers} idPrefix="spouse" personLabel="your spouse" onChange={setSpouseAnswers} questions={questions} />
          )}
          <p className="field-help">Children and dependants up to age {FAMILY_MAX_DEPENDANT_AGE} on the first day of the event.</p>
          {children.map((child, index) => (
            <div className="form-stack" key={child.key}>
            <div className="staff-invite-child">
              <label>Child {index + 1} first name<input maxLength={NAME_MAX} onChange={(changeEvent) => updateChild(child.key, { firstName: changeEvent.target.value })} required value={child.firstName} /></label>
              <label>Last name<input maxLength={NAME_MAX} onChange={(changeEvent) => updateChild(child.key, { lastName: changeEvent.target.value })} required value={child.lastName} /></label>
              <label>
                Age
                <input inputMode="numeric" max={FAMILY_MAX_DEPENDANT_AGE} min={0} onChange={(changeEvent) => updateChild(child.key, { age: changeEvent.target.value })} required type="number" value={child.age} />
              </label>
              <button className="text-button" onClick={() => setChildren((current) => current.filter((entry) => entry.key !== child.key))} type="button">
                <Trash2 aria-hidden="true" size={14} /> Remove child {index + 1}
              </button>
            </div>
            {questions.length > 0 && (
              <StaffInvitationQuestions
                answers={childAnswers[child.key] ?? {}}
                idPrefix={`child-${child.key}`}
                personLabel={`child ${index + 1}${child.firstName.trim() ? ` (${child.firstName.trim()})` : ""}`}
                onChange={(next) => setChildAnswers((current) => ({ ...current, [child.key]: next }))}
                questions={questions}
              />
            )}
            </div>
          ))}
          {children.length < FAMILY_MAX_DEPENDANTS && (
            <div>
              <button className="secondary-button" onClick={addChild} type="button"><Plus aria-hidden="true" size={15} /> Add a child</button>
            </div>
          )}
        </fieldset>

        <fieldset className="form-stack">
          <legend>Housing</legend>
          <label className="checkbox-label">
            <input checked={needsHousing} onChange={(changeEvent) => setNeedsHousing(changeEvent.target.checked)} type="checkbox" /> We need on-site housing
          </label>
          <label>
            Anything the office should know (optional)
            <textarea maxLength={500} onChange={(changeEvent) => setHousingNote(changeEvent.target.value)} rows={3} value={housingNote} />
          </label>
          <p className="field-help">This is a request, not a reservation. The office places staff, pastor and volunteer families in the rooms left over, or tells you if you will stay off site.</p>
        </fieldset>

        {/* A honeypot: people never see or fill it. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-10000px", height: 0, overflow: "hidden" }}>
          <label>Website<input autoComplete="off" onChange={(changeEvent) => setWebsite(changeEvent.target.value)} tabIndex={-1} value={website} /></label>
        </div>

        {error && <div className="inline-notice error" role="alert">{error}</div>}
        <div className="club-registration-toolbar">
          <button className="primary-button" disabled={busy} type="submit">{busy ? "Registering…" : "Register"}</button>
        </div>
        {event.supportContact && <p className="field-help">Questions? Contact {event.supportContact}.</p>}
      </form>
    </main>
  );
}
