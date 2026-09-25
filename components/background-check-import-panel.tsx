"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BackgroundCheckImport } from "@/components/background-check-import";

/** The background check CSV upload (#388, #427), refreshing the page's counts when saved. */
export function BackgroundCheckImportPanel() {
  const router = useRouter();
  const [notice, setNotice] = useState("");
  return (
    <>
      <div className="intro-actions honor-csv-actions">
        <BackgroundCheckImport
          onImported={(result) => {
            setNotice(`Background checks recorded: ${Number(result.added ?? 0)} new, ${Number(result.updated ?? 0)} renewed.`);
            router.refresh();
          }}
        />
      </div>
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
    </>
  );
}
