import { z } from "zod";
import { eventPermissions } from "@/modules/access/permissions";

export const noteVisibilities = ["STAFF", "RESTRICTED"] as const;
export type NoteVisibility = (typeof noteVisibilities)[number];

/**
 * A note's subject: exactly one of a registration, an attendee, or a person.
 * The database enforces the same exclusivity with a check constraint.
 */
export type NoteSubject =
  | { registrationId: string; attendeeId?: undefined; personId?: undefined }
  | { attendeeId: string; registrationId?: undefined; personId?: undefined }
  | { personId: string; registrationId?: undefined; attendeeId?: undefined };

const bodySchema = z.string().trim().min(1, "A note needs a body.").max(4000);

export const noteInputSchema = z.object({
  body: bodySchema,
  visibility: z.enum(noteVisibilities).default("STAFF"),
  restrictedPermission: z.enum(eventPermissions).nullable().optional(),
}).superRefine((value, context) => {
  if (value.visibility === "RESTRICTED" && !value.restrictedPermission) {
    context.addIssue({
      code: "custom",
      path: ["restrictedPermission"],
      message: "A restricted note must name the permission required to read it.",
    });
  }
  if (value.visibility === "STAFF" && value.restrictedPermission) {
    context.addIssue({
      code: "custom",
      path: ["restrictedPermission"],
      message: "A staff-wide note cannot also be restricted to a permission.",
    });
  }
});

export const noteRevisionInputSchema = z.object({ body: bodySchema });

export type NoteRevisionRecord = {
  id: string;
  sequence: number;
  body: string;
  author: { id: string; displayName: string };
  createdAt: string;
};

export type NoteRecord = {
  id: string;
  visibility: NoteVisibility;
  restrictedPermission: string | null;
  author: { id: string; displayName: string };
  createdAt: string;
  updatedAt: string;
  body: string;
  revisionCount: number;
  revisions: NoteRevisionRecord[];
};

/** A visitor may read a note's body only when it is staff-wide, or when they
 * hold the specific permission it is restricted to. This is the one rule
 * every read path — the detail view and every export — must apply. */
export function canReadNote(
  note: { visibility: NoteVisibility; restrictedPermission: string | null },
  actorPermissions: ReadonlySet<string>,
) {
  if (note.visibility === "STAFF") return true;
  return note.restrictedPermission !== null && actorPermissions.has(note.restrictedPermission);
}
