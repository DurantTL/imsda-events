import { PICK_DATE_GUIDANCE } from "@/modules/forms/typed-date";

/**
 * The helper line under a date question (#743). The typing hint is replaced by
 * "Pick a date." on a touch screen (a coarse pointer), by CSS, so the markup is
 * the same on the server and the client.
 */
export function DateGuidance({ id, typed, className }: { id: string; typed: string; className?: string }) {
  return (
    <small className={`field-help date-guidance${className ? ` ${className}` : ""}`} id={id}>
      <span className="date-guidance-typed">{typed}</span>
      <span className="date-guidance-pick">{PICK_DATE_GUIDANCE}</span>
    </small>
  );
}
