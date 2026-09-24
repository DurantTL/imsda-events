"use client";

import { CsvImportDialog } from "@/components/csv-import-dialog";
import type { RosterMemberRecord } from "@/modules/club-rosters/repository";

/** Roster CSV (#384): the shared upload dialog, pointed at this club's roster. */
export function RosterCsvImport({ base, onImported }: { base: string; onImported: (members: RosterMemberRecord[], message: string) => void }) {
  return (
    <CsvImportDialog
      eyebrow="Roster CSV"
      help={(
        <p>
          Fill in the <a href={`${base}/template`}>CSV template</a> (First name, Last name, Birth date, Type, Current
          class, Role, Gender) in Excel or Google Sheets and save it as CSV. People already on this year&apos;s roster
          are matched by name and updated with whatever the file fills in; blank cells are left as they are. New people
          need a birth date.
        </p>
      )}
      importUrl={`${base}/import`}
      onImported={(result) => {
        if (Array.isArray(result.members)) {
          onImported(result.members as RosterMemberRecord[], `Roster updated: ${Number(result.added ?? 0)} added, ${Number(result.updated ?? 0)} updated.`);
        }
      }}
      templateHref={`${base}/template`}
      title="Upload a roster file"
    />
  );
}
