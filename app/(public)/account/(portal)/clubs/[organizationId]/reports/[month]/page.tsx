import { redirect } from "next/navigation";

/** A month's report is now under that month in Monthly Records (#653); the old link still works. */
export default async function ClubReportRedirect({ params }: { params: Promise<{ organizationId: string; month: string }> }) {
  const { organizationId, month } = await params;
  redirect(`/account/clubs/${organizationId}/records?month=${encodeURIComponent(month)}`);
}
