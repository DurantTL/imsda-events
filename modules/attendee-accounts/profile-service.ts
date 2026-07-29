import "server-only";

import { z } from "zod";
import { getPrisma } from "@/lib/prisma";

const optionalProfileValue = (maximum: number) => z.string().trim().max(maximum);

export const attendeeProfileSchema = z.strictObject({
  firstName: optionalProfileValue(80),
  lastName: optionalProfileValue(80),
  phone: optionalProfileValue(40),
  shirtSize: optionalProfileValue(80),
  dietaryNeeds: optionalProfileValue(1_000),
  accessibilityNeeds: optionalProfileValue(1_000),
});

export type AttendeeProfileInput = z.infer<typeof attendeeProfileSchema>;

function serializeProfile(profile: AttendeeProfileInput) {
  return profile;
}

export async function getAttendeeProfile(accountId: string) {
  const profile = await getPrisma().attendeeAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      firstName: true,
      lastName: true,
      phone: true,
      shirtSize: true,
      dietaryNeeds: true,
      accessibilityNeeds: true,
      displayName: true,
    },
  });
  const displayNameParts = profile.displayName.trim().split(/\s+/);
  const fallbackFirstName = displayNameParts.shift() ?? "";
  const fallbackLastName = displayNameParts.join(" ");
  return serializeProfile({
    firstName: profile.firstName ?? fallbackFirstName,
    lastName: profile.lastName ?? fallbackLastName,
    phone: profile.phone ?? "",
    shirtSize: profile.shirtSize ?? "",
    dietaryNeeds: profile.dietaryNeeds ?? "",
    accessibilityNeeds: profile.accessibilityNeeds ?? "",
  });
}

export async function updateAttendeeProfile(
  accountId: string,
  input: AttendeeProfileInput,
) {
  const profile = attendeeProfileSchema.parse(input);
  const updated = await getPrisma().attendeeAccount.update({
    where: { id: accountId },
    data: {
      ...profile,
      displayName: `${profile.firstName} ${profile.lastName}`.trim() || undefined,
    },
    select: {
      firstName: true,
      lastName: true,
      phone: true,
      shirtSize: true,
      dietaryNeeds: true,
      accessibilityNeeds: true,
    },
  });
  return serializeProfile({
    firstName: updated.firstName ?? "",
    lastName: updated.lastName ?? "",
    phone: updated.phone ?? "",
    shirtSize: updated.shirtSize ?? "",
    dietaryNeeds: updated.dietaryNeeds ?? "",
    accessibilityNeeds: updated.accessibilityNeeds ?? "",
  });
}

export function attendeeProfilePrefill(
  profile: AttendeeProfileInput,
  verifiedEmail = "",
) {
  const name = `${profile.firstName} ${profile.lastName}`.trim();
  return {
    first_name: profile.firstName,
    primary_contact_first_name: profile.firstName,
    last_name: profile.lastName,
    primary_contact_last_name: profile.lastName,
    full_name: name,
    name,
    phone: profile.phone,
    phone_number: profile.phone,
    attendee_phone: profile.phone,
    email: verifiedEmail,
    contact_email: verifiedEmail,
    shirt_size: profile.shirtSize,
    dietary_needs: profile.dietaryNeeds,
    dietary_restrictions: profile.dietaryNeeds,
    accessibility_needs: profile.accessibilityNeeds,
    accommodations: profile.accessibilityNeeds,
  };
}
