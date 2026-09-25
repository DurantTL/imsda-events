"use client";

import { Check, X } from "lucide-react";
import {
  checkPasswordRequirements,
  type PasswordOwner,
} from "@/modules/access/password-policy";

/**
 * The password rules, ticked off live as the person types.
 *
 * Drawn from {@link checkPasswordRequirements}, the same shared list the
 * server's `validatePasswordShape` walks — so what this checklist shows as
 * met is exactly what the server will accept for the offline rules. (The
 * server also checks the password against a public breach corpus, which
 * needs a network round trip and cannot be ticked live; that check still runs
 * on submit.)
 */
export function PasswordRequirementsChecklist({
  password,
  owner,
}: {
  password: string;
  owner?: PasswordOwner;
}) {
  const requirements = checkPasswordRequirements(password, owner);
  return (
    <ul className="password-requirements" aria-label="Password requirements">
      {requirements.map((requirement) => (
        <li key={requirement.id} data-met={requirement.met}>
          {requirement.met
            ? <Check aria-hidden="true" size={13} />
            : <X aria-hidden="true" size={13} />}
          <span>{requirement.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** True once every rule this checklist can evaluate client-side is met. */
export function allPasswordRequirementsMet(password: string, owner?: PasswordOwner) {
  return checkPasswordRequirements(password, owner).every((requirement) => requirement.met);
}
