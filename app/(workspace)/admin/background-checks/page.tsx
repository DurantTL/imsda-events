import { redirect } from "next/navigation";

/** Moved under Clubs and churches (#427). */
export default function BackgroundChecksRedirectPage() {
  redirect("/admin/organizations/background-checks");
}
