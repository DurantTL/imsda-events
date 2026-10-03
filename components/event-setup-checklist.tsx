"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Circle, ExternalLink } from "lucide-react";
import type { SetupChecklist, SetupStep } from "@/modules/events/setup-checklist";

const collapsedKey = (eventId: string) => `imsda-events:setup-checklist-collapsed:${eventId}`;

// Per-browser convenience. Storage can be blocked, so the choice then lasts for this page view only.
const listeners = new Set<() => void>();
const memory = new Map<string, boolean>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function readCollapsed(key: string): boolean {
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeCollapsed(key: string, value: boolean) {
  memory.set(key, value);
  try {
    if (value) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // The in-memory copy still applies for now.
  }
  listeners.forEach((listener) => listener());
}

/**
 * "Set up this event" on the Dashboard (#743). The server has already decided
 * which steps this viewer may act on (`buildSetupChecklist`), so every link here
 * opens for them. It disappears once nothing is left, and staff can collapse it
 * (remembered per browser, never required).
 */
export function EventSetupChecklist({
  eventId,
  checklist,
}: {
  eventId: string;
  checklist: SetupChecklist;
}) {
  const key = collapsedKey(eventId);
  const collapsed = useSyncExternalStore(subscribe, () => readCollapsed(key), () => false);
  if (checklist.hidden) return null;
  const total = checklist.steps.length;

  function toggle() {
    writeCollapsed(key, !collapsed);
  }

  return (
    <section className="panel setup-checklist" aria-labelledby="setup-checklist-title">
      <div className="setup-checklist-head">
        <div>
          <p className="eyebrow">Setup</p>
          <h2 id="setup-checklist-title">Set up this event</h2>
          <p className="setup-checklist-progress" role="status">{checklist.doneCount} of {total} done</p>
        </div>
        <button
          aria-controls="setup-checklist-steps"
          aria-expanded={!collapsed}
          className="text-button"
          onClick={toggle}
          type="button"
        >
          {collapsed ? <><ChevronDown aria-hidden="true" size={15} /> Show steps</> : <><ChevronUp aria-hidden="true" size={15} /> Hide steps</>}
        </button>
      </div>
      <ol className="setup-checklist-steps" hidden={collapsed} id="setup-checklist-steps">
        {checklist.steps.map((step) => <StepRow isNext={step.id === checklist.nextStepId} key={step.id} step={step} />)}
      </ol>
    </section>
  );
}

function StepRow({ step, isNext }: { step: SetupStep; isNext: boolean }) {
  return (
    <li className={`setup-step${step.done ? " is-done" : ""}${isNext ? " is-next" : ""}`} data-step={step.id}>
      {step.done ? <CheckCircle2 aria-hidden="true" size={18} /> : <Circle aria-hidden="true" size={18} />}
      <span className="setup-step-copy">
        <strong>{step.label}</strong>
        <small>{step.done ? "Done" : step.detail}</small>
      </span>
      {step.external
        ? <a className="text-button" href={step.href} rel="noreferrer" target="_blank">{step.actionLabel} <ExternalLink aria-hidden="true" size={14} /></a>
        : <Link className="text-button" href={step.href}>{step.actionLabel} <ArrowRight aria-hidden="true" size={14} /></Link>}
    </li>
  );
}
