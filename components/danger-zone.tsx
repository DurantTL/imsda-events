import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A separate red section for destructive actions (#743). The heading and the
 * eyebrow carry the meaning in words and an icon, never colour alone. The
 * triggers inside are outlined (`danger-outline-button`); the filled red button
 * only ever appears inside the confirmation dialog, which names the object and
 * the consequence.
 */
export function DangerZone({
  heading,
  children,
  className = "",
}: {
  heading: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel danger-zone ${className}`.trim()}>
      <p className="danger-zone-eyebrow"><TriangleAlert aria-hidden="true" size={14} /> Danger zone</p>
      <h2>{heading}</h2>
      {children}
    </section>
  );
}

/** One destructive action: a short title, what it does, then its (outlined) trigger. */
export function DangerZoneItem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="danger-zone-item">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
