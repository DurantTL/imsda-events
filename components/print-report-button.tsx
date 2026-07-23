"use client";

import { Printer } from "lucide-react";

export function PrintReportButton({
  label = "Print all reports",
}: {
  label?: string;
}) {
  return (
    <button
      className="secondary-button report-print-button"
      type="button"
      onClick={() => window.print()}
    >
      <Printer aria-hidden="true" size={15} />
      {label}
    </button>
  );
}
