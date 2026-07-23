import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ShieldX } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { SignOutButton } from "@/components/sign-out-button";
import { getCurrentSession } from "@/modules/access/current-session";

export const metadata: Metadata = { title: "No event access" };

export default async function NoAccessPage() {
  const session = await getCurrentSession();
  if (!session.user) redirect("/login");
  if (session.user.globalRole === "SYSTEM_ADMIN") redirect("/event-setup");
  return <main className="auth-page"><section className="auth-card no-access-card"><div className="auth-brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div><span className="access-state-icon"><ShieldX size={28} /></span><div className="auth-heading"><p className="eyebrow">Access needed</p><h1>No events are assigned</h1><p>{session.user.email} is signed in, but it does not have an active event assignment. Ask an IMSDA event administrator to add the account.</p></div><SignOutButton className="secondary-button full-button" /></section></main>;
}
