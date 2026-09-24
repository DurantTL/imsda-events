"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CsvImportDialog } from "@/components/csv-import-dialog";

/** The Sterling Volunteers CSV upload (#388), refreshing the page's counts when saved. */
export function SterlingUpload() {
  const router = useRouter();
  const [notice, setNotice] = useState("");
  return (
    <>
      <div className="intro-actions honor-csv-actions">
        <CsvImportDialog
          eyebrow="Sterling Volunteers CSV"
          help={(
            <>
              <p>
                Export the volunteer list from Sterling Volunteers as CSV, or fill in the template (First name,
                Last name, Email, Birth date, Check date, Expiration date, Status). Each row is matched to one
                person by name plus email or birth date; rows that match nobody, or more than one person, are
                listed and skipped.
              </p>
              <p>
                Only the check and expiration dates are kept. The file, birth dates, and any status that
                isn&apos;t a clear check are never stored.
              </p>
            </>
          )}
          importUrl="/api/admin/background-checks/import"
          onImported={(result) => {
            setNotice(`Background checks recorded: ${Number(result.added ?? 0)} new, ${Number(result.updated ?? 0)} renewed.`);
            router.refresh();
          }}
          templateHref="/api/admin/background-checks/template"
          title="Upload background checks"
          variant="staff"
        />
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
    </>
  );
}
