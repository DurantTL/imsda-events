import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * A back link to a page's parent (#428). One shared component so every back
 * link across the club portal and staff pages looks and reads the same;
 * pair it with `safeReturnTo` when a page can be reached from more than one
 * place, so the link goes back to where the visitor actually came from.
 */
export function BackLink({
  href,
  children,
  variant = "portal",
}: {
  href: string;
  children: React.ReactNode;
  /** "portal" matches the club portal's quiet text link; "staff" matches the staff workspace's button row. */
  variant?: "portal" | "staff";
}) {
  const className = variant === "staff" ? "secondary-button more-back-link" : "text-button back-link";
  return (
    <Link className={className} href={href}>
      <ArrowLeft aria-hidden="true" size={14} /> {children}
    </Link>
  );
}
