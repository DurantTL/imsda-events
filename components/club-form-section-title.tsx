import type { ReactNode } from "react";

/**
 * A card's heading (#733). A fieldset's own legend is drawn on the card's top border, and iOS Safari
 * ignores the float that moves it inside, so the legend stays only as the group's accessible name
 * (visually hidden) and the same text is shown as an ordinary block inside the card's padding.
 */
export function ClubFormSectionTitle({ children }: { children: ReactNode }) {
  return (
    <>
      <legend className="club-form-section-legend">{children}</legend>
      <p aria-hidden="true" className="club-form-section-title public-registration-eyebrow">{children}</p>
    </>
  );
}
