import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);
const wholeNumber = (label: string, min: number, max: number) =>
  z.int(`${label} must be a whole number.`).min(min, `${label} must be at least ${min}.`).max(max);

/** A room inside a site (#834). Null site is for an event with no sites; the repository requires a site otherwise. */
export const honorRoomInputSchema = z.object({
  name: text(80).min(1, "Enter the room name."),
  capacity: wholeNumber("Room capacity", 1, 10_000),
  locationId: z.string().min(1).max(64).nullable().default(null),
  sortOrder: wholeNumber("Order", 0, 99).default(0),
}).strict();

/** Bare fields, not `.partial()` of the input (Zod 4 applies defaults inside `.partial()`). A room never changes site. */
export const honorRoomUpdateSchema = z.object({
  name: text(80).min(1, "Enter the room name."),
  capacity: wholeNumber("Room capacity", 1, 10_000),
  sortOrder: wholeNumber("Order", 0, 99),
}).partial().strict();

/** Move a class: `roomId` null takes it out of its room; leave `sessionId` out to keep the session. */
export const honorMoveSchema = z.object({
  roomId: z.string().min(1).max(64).nullable(),
  sessionId: z.string().min(1).max(64).nullable().optional(),
}).strict();

export type HonorRoomInput = z.infer<typeof honorRoomInputSchema>;
export type HonorRoomUpdate = z.infer<typeof honorRoomUpdateSchema>;
export type HonorMoveInput = z.infer<typeof honorMoveSchema>;
