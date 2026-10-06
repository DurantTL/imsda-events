import Link from "next/link";
import { LogIn, AlertTriangle } from "lucide-react";
import { clubDirectorSignInNotice } from "@/modules/club-registrations/club-notices";

/**
 * The prominent "club directors, sign in" callout on a club event's public
 * pages (#799 G8): near the top, an icon plus text (never colour alone), and a
 * sign-in button. Renders nothing for an event without a club audience.
 */
export function ClubDirectorSignInNotice({ event }: { event: Parameters<typeof clubDirectorSignInNotice>[0] }) {
  const notice = clubDirectorSignInNotice(event);
  if (!notice) return null;
  return (
    <aside aria-labelledby="club-director-sign-in-title" className="club-director-notice" data-testid="club-director-sign-in-notice">
      <span aria-hidden="true" className="club-director-notice-icon"><AlertTriangle size={24} /></span>
      <div className="club-director-notice-copy">
        <p className="club-director-notice-eyebrow">Important for club directors</p>
        <h2 id="club-director-sign-in-title">{notice.title}</h2>
        <p>{notice.body}</p>
      </div>
      <Link className="primary-button club-director-notice-button" href={notice.href}>
        <LogIn aria-hidden="true" size={17} /> {notice.buttonLabel}
      </Link>
    </aside>
  );
}
