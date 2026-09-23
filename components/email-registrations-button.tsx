"use client";

import { useState } from "react";
import { Mail } from "lucide-react";
import { SelectedAudienceDialog } from "@/components/selected-audience-dialog";

/**
 * Opens the chosen-registrations email dialog for a report's list, e.g. the
 * volunteers who said yes (WR26). Nothing sends until staff preview and
 * confirm in the dialog; mail goes to each registration's contact.
 */
export function EmailRegistrationsButton({
  eventId,
  registrationIds,
  label,
}: {
  eventId: string;
  registrationIds: string[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const unique = [...new Set(registrationIds)].slice(0, 250);
  if (unique.length === 0) return null;
  return (
    <>
      <button className="secondary-button report-download" onClick={() => setOpen(true)} type="button">
        <Mail aria-hidden="true" size={15} /> {label}
      </button>
      {open && <SelectedAudienceDialog eventId={eventId} onClose={() => setOpen(false)} registrationIds={unique} />}
    </>
  );
}
