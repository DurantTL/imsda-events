import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { BrandMark } from "@/components/brand-mark";
import { SquareReturnStatus } from "@/components/square-return-status";
import { getHostedReturnStatus } from "@/modules/payments/square-hosted-return";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Payment status",
  description: "The status of a payment made on Square.",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

type ReturnPageProps = { params: Promise<{ returnId: string }> };

/**
 * Where Square sends a payer after "Pay on Square" (#327). It shows a status and a masked
 * confirmation code only. It never opens the registration: the payer's browser remembers where
 * they started and goes back there, or they use the link in their confirmation email.
 */
export default async function SquareReturnPage({ params }: ReturnPageProps) {
  await connection();
  const { returnId } = await params;
  const status = await getHostedReturnStatus(returnId);
  if (!status) notFound();
  return (
    <main className="public-registration-page public-manage-page">
      <header className="public-registration-header">
        <div className="public-registration-header-inner">
          <Link className="public-registration-brand public-event-brand-link" href="/">
            <BrandMark />
            <span><strong>IMSDA</strong><small>Events</small></span>
          </Link>
        </div>
      </header>
      <section className="public-manage-card">
        <SquareReturnStatus returnId={returnId} initial={status} />
      </section>
    </main>
  );
}
