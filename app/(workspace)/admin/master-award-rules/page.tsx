import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MasterAwardRulesWorkspace } from "@/components/master-award-rules-workspace";
import { getCurrentSession } from "@/modules/access/current-session";
import { listMasterAwardRules, listRuleChoices } from "@/modules/earned-awards/rules-repository";

export const metadata: Metadata = { title: "Master Award rules" };

/** Master Award rules (#532): system administrators import, review, edit and activate them. */
export default async function MasterAwardRulesPage() {
  const { user } = await getCurrentSession();
  if (!user) redirect("/login");
  if (user.globalRole !== "SYSTEM_ADMIN") redirect("/no-access");

  const [rules, choices] = await Promise.all([listMasterAwardRules(), listRuleChoices()]);
  return (
    <>
      <Link className="secondary-button more-back-link" href="/admin">
        Back to system administration
      </Link>
      <MasterAwardRulesWorkspace choices={choices} initialRules={rules} />
    </>
  );
}
