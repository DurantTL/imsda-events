import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import { PasswordResetRequestForm } from "@/components/password-reset-request-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return <main className="auth-page"><section className="auth-card"><div className="auth-brand"><BrandMark /><span><strong>IMSDA</strong><small>Events</small></span></div><div className="auth-heading"><p className="eyebrow">Account recovery</p><h1>Reset your password</h1><p>Enter your staff email. In this local build, the test link appears here instead of being emailed.</p></div><PasswordResetRequestForm /></section></main>;
}
