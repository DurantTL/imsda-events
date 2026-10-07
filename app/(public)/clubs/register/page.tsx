import type { Metadata } from "next";
import { NewClubApplicationPage } from "@/components/new-club-application-page";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Register a new club",
  description: "Apply to start a new Pathfinder or Adventurer club in the Iowa-Missouri Conference. Open all year.",
  alternates: { canonical: "/clubs/register" },
  robots: { index: true, follow: true },
};

/** The public "Register a new club" page (#817): open all year, nothing is created until staff approve it. */
export default function RegisterNewClubPage() {
  return <NewClubApplicationPage />;
}
