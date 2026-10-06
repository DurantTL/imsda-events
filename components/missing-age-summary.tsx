"use client";

import { focusFirstMissingAge } from "@/modules/club-registrations/roster-age-flow";
import { missingAgeSummaryItems } from "@/modules/club-registrations/roster-ages";

type Person = { memberId: string; firstName: string; lastName: string; ageOnEventDate: number | null; reportedAge: number | null };

/** Who still needs an age on the event date, by name, each line linking to that person's own age input (#799 G6). */
export function MissingAgeSummary({ missing }: { missing: readonly Person[] }) {
  const items = missingAgeSummaryItems(missing);
  if (items.length === 0) return null;
  return (
    <div className="inline-notice error club-age-summary" role="alert">
      <ul>
        {items.map((item) => (
          <li key={item.memberId}>
            <a
              href={`#${item.fieldId}`}
              onClick={(event) => {
                event.preventDefault();
                focusFirstMissingAge(item.fieldId, (id) => document.getElementById(id));
              }}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
