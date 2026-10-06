import { NeedsAttention, StatusComplete } from "@/components/needs-attention";
import { classBadge, missingChoicesText, noClassAvailableText, type PersonClassReadiness } from "@/modules/honors/class-readiness";

/**
 * One person's class status (#799 G3): icon plus text, never colour alone.
 * Needs attention only while choices are open; the neutral states
 * ("Optional", "No class available") are plain text.
 */
export function ClassStatus({ person, open = true }: { person: PersonClassReadiness; open?: boolean }) {
  const badge = classBadge(person);
  const neutral = noClassAvailableText(person);
  return (
    <span className="class-person-status">
      {badge === "needs" && open && <><NeedsAttention label="Needs classes" /> <span>{missingChoicesText(person)}</span></>}
      {badge === "needs" && !open && <span>Class choices are closed.</span>}
      {badge === "chosen" && <StatusComplete label="Classes chosen" />}
      {badge === "optional" && <span>Optional: classes are not required for this person.</span>}
      {badge === "none-available" && !neutral && <span>No class available.</span>}
      {neutral && <span className="class-none-available">{neutral}</span>}
    </span>
  );
}
