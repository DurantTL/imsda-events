import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { SquarePaymentMatching } from "@/components/square-payment-matching";
import { resolveEventContext } from "@/modules/events/selection";
import { listRegistrations } from "@/modules/registrations/repository";
import {
  listUnmatchedSquarePayments,
  SquareMatchOperationError,
} from "@/modules/payments/square-match-repository";

export const metadata: Metadata = { title: "Unmatched Square payments" };

export default async function SquarePaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ event?: string; days?: string }>;
}) {
  const { event: requested, days } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_FINANCE")) {
    return (
      <AccessRestricted
        title="Finance is restricted"
        detail="Only event administrators and finance managers can match Square payments to registrations."
      />
    );
  }

  const windowDays = Number(days ?? 90);
  const registrations = await listRegistrations(event.id);
  let unmatched;
  let unavailable: string | null = null;
  try {
    unmatched = await listUnmatchedSquarePayments({
      days: Number.isFinite(windowDays) ? windowDays : 90,
    });
  } catch (error) {
    unavailable = error instanceof SquareMatchOperationError
      ? error.message
      : "Square could not be reached.";
  }

  return (
    <SquarePaymentMatching
      key={event.id}
      eventId={event.id}
      registrations={registrations}
      findings={unmatched?.findings ?? []}
      examined={unmatched?.examined ?? 0}
      windowDays={Number.isFinite(windowDays) ? windowDays : 90}
      squareUnreachable={unmatched?.unreachableSquare ?? false}
      unavailable={unavailable}
    />
  );
}
