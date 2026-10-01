"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MapPin } from "lucide-react";
import { cardCell } from "@/components/table-card-labels";
import type { GeocodeReviewItem } from "@/modules/organizations/church-geocoding";

type ApiError = { message?: string; issues?: Array<{ message?: string }> };
type RunSummary = { processed: number; matched: number; noMatch: number };

/**
 * "Find map locations" (#724). Staff start the lookup, then review the
 * results: accept a match, adjust the point on the church's location page, or
 * skip. Nothing reaches the public map until a match is accepted.
 */
export function ChurchMapLocationsWorkspace({ enabled, eligible, items }: { enabled: boolean; eligible: number; items: GeocodeReviewItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function post(url: string, body?: unknown) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({})) as ApiError & Partial<RunSummary>;
    if (!response.ok) throw new Error(result.message ?? result.issues?.[0]?.message ?? "That didn't work. Nothing was changed.");
    return result;
  }

  async function run() {
    setBusy("run");
    setError("");
    setNotice("");
    try {
      const result = await post("/api/admin/organizations/map-locations") as RunSummary;
      setNotice(result.processed === 0
        ? "No churches need a lookup right now."
        : `Looked up ${result.processed} ${result.processed === 1 ? "church" : "churches"}: ${result.matched} matched, ${result.noMatch} with no match. Review the matches below.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  async function decide(item: GeocodeReviewItem, decision: "accept" | "skip") {
    setBusy(item.organizationId);
    setError("");
    setNotice("");
    try {
      await post(`/api/admin/organizations/${encodeURIComponent(item.organizationId)}/map-location`, { decision });
      setNotice(decision === "accept" ? `${item.name} is on the map.` : `Skipped ${item.name}.`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That didn't work. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel form-stack org-map-locations">
      {!enabled && (
        <div className="inline-notice" role="status">
          Finding map locations is turned off on this server. Set <code>GEOCODING_ENABLED=true</code> to use it.
        </div>
      )}
      {notice && <div className="inline-notice success" role="status">{notice}</div>}
      {error && <div className="inline-notice error" role="alert">{error}</div>}
      <p className="field-help">
        {eligible} {eligible === 1 ? "church has" : "churches have"} a street address and no map point yet. Only each church&apos;s public street
        address, city, state and ZIP are sent to the U.S. Census Bureau geocoder. Groups that meet in homes, towns-only addresses and locations set by hand are never sent.
      </p>
      <div>
        <button className="primary-button" disabled={!enabled || busy !== null || eligible === 0} onClick={() => void run()} type="button">
          <MapPin aria-hidden="true" size={16} /> {busy === "run" ? "Looking up…" : "Find map locations"}
        </button>
      </div>
      <p className="org-result-summary" role="status">
        {items.length} {items.length === 1 ? "result" : "results"} to review.
      </p>
      {items.length > 0 && (
        <div className="report-table-wrap">
          <table className="report-table table-cards table-cards-wide" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <th role="columnheader" scope="col">Church</th>
                <th role="columnheader" scope="col">Address</th>
                <th role="columnheader" scope="col">Result</th>
                <th role="columnheader" scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {items.map((item) => (
                <tr key={item.organizationId} role="row">
                  <th className="org-cell-name" role="rowheader" scope="row" translate="no">{item.name}</th>
                  <td {...cardCell("Address")}>{item.address}</td>
                  <td {...cardCell("Result")}>
                    {item.status === "MATCHED" ? (
                      <>
                        <span className="status-chip green">Matched</span>
                        <span className="org-cell-sub">{item.matchedAddress}</span>
                        <span className="org-cell-sub">{item.latitude?.toFixed(4)}, {item.longitude?.toFixed(4)}</span>
                      </>
                    ) : (
                      <span className="status-chip gold">No match</span>
                    )}
                  </td>
                  <td {...cardCell(null)} className="org-cell-actions">
                    {item.status === "MATCHED" && (
                      <button className="primary-button" disabled={busy !== null} onClick={() => void decide(item, "accept")} type="button">Accept</button>
                    )}
                    {/* A plain anchor: the map page needs its own Content-Security-Policy (#542). */}
                    <a className="secondary-button" href={`/admin/organizations/${item.organizationId}/location`}>Set on map</a>
                    <button className="secondary-button" disabled={busy !== null} onClick={() => void decide(item, "skip")} type="button">Skip</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
