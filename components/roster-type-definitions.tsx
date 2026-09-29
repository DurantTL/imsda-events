import { clubRosterAttendeeTypeDefinitions, clubRosterAttendeeTypeLabels } from "@/modules/club-rosters/domain";

/** One line per roster member type (#576), for the add/edit form and the CSV help. */
export function RosterTypeDefinitions({ className }: { className?: string }) {
  return (
    <ul className={`roster-type-definitions${className ? ` ${className}` : ""}`}>
      {(Object.keys(clubRosterAttendeeTypeDefinitions) as (keyof typeof clubRosterAttendeeTypeDefinitions)[]).map((value) => (
        <li key={value}><strong>{clubRosterAttendeeTypeLabels[value]}:</strong> {clubRosterAttendeeTypeDefinitions[value]}</li>
      ))}
    </ul>
  );
}
