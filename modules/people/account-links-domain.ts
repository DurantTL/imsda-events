import { z } from "zod";

/**
 * How an account-to-person link was established. Mirrors the
 * `PersonLinkProvenance` Prisma enum — kept here too so callers can validate
 * input before it ever reaches Prisma.
 */
export const personLinkProvenanceValues = [
  "SELF_SERVICE_VERIFICATION",
  "STAFF_ACTION",
  "IMPORT",
] as const;

export type PersonLinkProvenance = (typeof personLinkProvenanceValues)[number];

const evidenceReferenceSchema = z
  .string()
  .trim()
  .min(1, "Evidence reference is required.")
  .max(300);

/**
 * A link from an `AttendeeAccount` to a `Person`. Provenance and actor
 * agree by construction: a self-service link is actored by the account
 * itself, never a staff user, and a staff-action or import link is actored
 * by a staff user, never the account — the same XOR the database's check
 * constraint enforces, checked here first so a bad request never reaches
 * Prisma as an opaque constraint violation.
 */
export const attendeeAccountPersonLinkInputSchema = z
  .object({
    personId: z.string().trim().min(1),
    provenance: z.enum(personLinkProvenanceValues),
    actorAttendeeAccountId: z.string().trim().min(1).optional(),
    actorUserId: z.string().trim().min(1).optional(),
    evidenceReference: evidenceReferenceSchema,
  })
  .superRefine((value, ctx) => {
    if (value.provenance === "SELF_SERVICE_VERIFICATION") {
      if (!value.actorAttendeeAccountId) {
        ctx.addIssue({
          code: "custom",
          path: ["actorAttendeeAccountId"],
          message: "A self-service link must record the account that verified itself.",
        });
      }
      if (value.actorUserId) {
        ctx.addIssue({
          code: "custom",
          path: ["actorUserId"],
          message: "A self-service link cannot also record a staff actor.",
        });
      }
    } else {
      if (!value.actorUserId) {
        ctx.addIssue({
          code: "custom",
          path: ["actorUserId"],
          message: "A staff-action or import link must record the staff member who established it.",
        });
      }
      if (value.actorAttendeeAccountId) {
        ctx.addIssue({
          code: "custom",
          path: ["actorAttendeeAccountId"],
          message: "A staff-action or import link cannot record the account as its own actor.",
        });
      }
    }
  });

export type AttendeeAccountPersonLinkInput = z.infer<typeof attendeeAccountPersonLinkInputSchema>;

/**
 * A link from a staff `User` to a `Person`. Every provenance is actored by
 * a staff user — for a self-service verification that is the same user
 * verifying their own identity, so `actorUserId` is always required and
 * never itself validated against `userId` here (that equality, when
 * `provenance` is SELF_SERVICE_VERIFICATION, is the repository's job, since
 * it is the one place that already knows which user is being linked).
 */
export const userPersonLinkInputSchema = z.object({
  personId: z.string().trim().min(1),
  provenance: z.enum(personLinkProvenanceValues),
  actorUserId: z.string().trim().min(1),
  evidenceReference: evidenceReferenceSchema,
});

export type UserPersonLinkInput = z.infer<typeof userPersonLinkInputSchema>;

export type AttendeeAccountPersonLinkRecord = {
  id: string;
  accountId: string;
  personId: string;
  provenance: PersonLinkProvenance;
  actorAttendeeAccountId: string | null;
  actorUserId: string | null;
  evidenceReference: string;
  createdAt: string;
};

export type UserPersonLinkRecord = {
  id: string;
  userId: string;
  personId: string;
  provenance: PersonLinkProvenance;
  actorUserId: string;
  evidenceReference: string;
  createdAt: string;
};
