import type { Metadata } from "next";
import { AccessRestricted } from "@/components/access-restricted";
import { ImportWorkspace } from "@/components/import-workspace";
import { getImportReconciliation, listImportRuns } from "@/modules/imports/repository";
import { resolveEventContext } from "@/modules/events/selection";

export const metadata: Metadata = { title: "Import & reconcile" };

export default async function ImportsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const { event: requested } = await searchParams;
  const { event, permissions } = await resolveEventContext(requested);
  if (!permissions.includes("MANAGE_IMPORTS")) {
    return <AccessRestricted title="Staging imports are restricted" detail="Only event administrators can preview, reconcile, and commit source snapshots." />;
  }
  const [runs, reconciliation] = await Promise.all([listImportRuns(event.id), getImportReconciliation(event.id)]);
  return <ImportWorkspace key={event.id} eventId={event.id} eventName={event.name} initialRuns={runs} initialReconciliation={reconciliation} />;
}
