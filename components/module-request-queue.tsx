"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MODULE_REQUEST_DECLINE_REASON_MAX } from "@/modules/event-modules/request-domain";

export type QueuedModuleRequest = {
  id: string;
  eventId: string;
  eventName: string;
  moduleTitle: string;
  requesterName: string;
  reason: string;
  createdLabel: string;
};

/**
 * The pending queue in System management (#741 slice 3). Approve turns the
 * module on; Decline needs a reason, which the requester is emailed. The route
 * allows system administrators only; this page is only drawn for them.
 */
export function ModuleRequestQueue({ requests }: { requests: readonly QueuedModuleRequest[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  async function decide(id: string, body: object) {
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch(`/api/admin/module-requests/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.message ?? "The decision could not be saved.");
      }
      setDeclining(null);
      setDeclineReason("");
      router.refresh();
    } catch (caught) {
      setError({ id, message: caught instanceof Error ? caught.message : "The decision could not be saved." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <ul className="module-request-queue">
      {requests.map((request) => (
        <li className="module-request-item" key={request.id} data-request={request.id}>
          <div>
            <strong>{request.moduleTitle}</strong> for {request.eventName}
            <small>Asked by {request.requesterName} · {request.createdLabel}</small>
            <p>{request.reason}</p>
          </div>
          {declining === request.id ? (
            <form
              className="module-request-form"
              onSubmit={(event) => {
                event.preventDefault();
                void decide(request.id, { decision: "decline", declineReason });
              }}
            >
              <label htmlFor={`decline-${request.id}`}>Why is this declined? The requester is emailed this.</label>
              <textarea
                id={`decline-${request.id}`}
                value={declineReason}
                onChange={(event) => setDeclineReason(event.target.value)}
                maxLength={MODULE_REQUEST_DECLINE_REASON_MAX}
                required
                rows={2}
              />
              <div className="module-request-actions">
                <button className="primary-button" type="submit" disabled={busyId === request.id || declineReason.trim() === ""}>Decline request</button>
                <button className="secondary-button" type="button" onClick={() => setDeclining(null)}>Cancel</button>
              </div>
            </form>
          ) : (
            <div className="module-request-actions">
              <button
                className="primary-button"
                type="button"
                disabled={busyId === request.id}
                onClick={() => void decide(request.id, { decision: "approve" })}
                aria-label={`Approve ${request.moduleTitle} for ${request.eventName}`}
              >
                Approve
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={busyId === request.id}
                onClick={() => { setDeclining(request.id); setDeclineReason(""); setError(null); }}
                aria-label={`Decline ${request.moduleTitle} for ${request.eventName}`}
              >
                Decline
              </button>
            </div>
          )}
          {error?.id === request.id && <p className="form-error" role="alert">{error.message}</p>}
        </li>
      ))}
    </ul>
  );
}
