import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { PasswordResetForm } from "@/components/password-reset-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div><div className="auth-heading"><p className="eyebrow">Account recovery</p><h1>Choose a new password</h1><p>This single-use link expires 30 minutes after it is created.</p></div><PasswordResetForm token={token} /></section></main>;
}
