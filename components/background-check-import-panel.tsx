"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BackgroundCheckImport } from "@/components/background-check-import";

/** The background check CSV upload (#388, #427, #527), refreshing the page's counts when saved. */
export function BackgroundCheckImportPanel() {
  const router = useRouter();
  const [notice, setNotice] = useState("");
  return (
    <>
      <div className="intro-actions honor-csv-actions">
        <BackgroundCheckImport
          onImported={(result) => {
            setNotice(`Background check list saved: ${Number(result.added ?? 0)} added, ${Number(result.changed ?? 0)} changed, ${Number(result.dropped ?? 0)} dropped.`);
            router.refresh();
          }}
        />
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
    </>
  );
}
