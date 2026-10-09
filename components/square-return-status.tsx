"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LoaderCircle, ShieldCheck, TriangleAlert } from "lucide-react";
import {
  hostedReturnMessage,
  hostedReturnStorageKey,
  type HostedReturnStatus,
} from "@/modules/payments/hosted-return-presentation";

const pollIntervalMs = 5_000;
const pollLimit = 24;

/** A path this app wrote itself: same-origin, never a protocol-relative or absolute address. */
function safeStoredPath(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : null;
}

export function SquareReturnStatus({
  returnId,
  initial,
}: {
  returnId: string;
  initial: HostedReturnStatus;
}) {
  const [status, setStatus] = useState(initial);

  useEffect(() => {
    // The browser that started the payment remembers where it was. Go back there, carrying the
    // return id so that page can say what became of the payment.
    try {
      const key = hostedReturnStorageKey(returnId);
      const stored = safeStoredPath(window.sessionStorage.getItem(key));
      if (stored) {
        window.sessionStorage.removeItem(key);
        window.location.replace(`${stored}?ret=${encodeURIComponent(returnId)}`);
      }
    } catch {
      // Storage is blocked; this page keeps the status and the instructions below.
    }
  }, [returnId]);

  useEffect(() => {
    if (status.state !== "CONFIRMING") return;
    let active = true;
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > pollLimit) {
        window.clearInterval(timer);
        return;
      }
      void fetch(`/api/public/square-return/${encodeURIComponent(returnId)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() as Promise<HostedReturnStatus> : null))
        .then((next) => {
          if (active && next) setStatus(next);
        })
        .catch(() => undefined);
    }, pollIntervalMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [returnId, status.state]);

  const tone = status.state === "CONFIRMED" ? "success" : status.state === "HELD" ? "error" : "pending";
  return (
    <section className="public-payment-stack" aria-labelledby="square-return-heading">
      <h1 id="square-return-heading">Payment status</h1>
      <div className={`public-square-notice is-${tone}`} role={status.state === "HELD" ? "alert" : "status"}>
        {status.state === "CONFIRMED"
          ? <ShieldCheck size={18} aria-hidden="true" />
          : status.state === "HELD"
            ? <TriangleAlert size={18} aria-hidden="true" />
            : <LoaderCircle size={18} className="is-spinning" aria-hidden="true" />}
        <span>{hostedReturnMessage(status.state)}</span>
      </div>
      <p>
        Registration <span translate="no">{status.maskedConfirmationCode}</span>
      </p>
      <p>
        To see your registration, use the private link in your confirmation email.
        If you registered with an account,{" "}
        <Link href="/account/registrations">sign in to your registrations</Link>.
      </p>
    </section>
  );
}
