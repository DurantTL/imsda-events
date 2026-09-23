import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { HonorCatalogWorkspace } from "@/components/honor-catalog-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listHonors } from "@/modules/honors/repository";

export const metadata: Metadata = { title: "Honor catalog" };

export default async function HonorCatalogPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <HonorCatalogWorkspace initialHonors={await listHonors()} />
    </>
  );
}
