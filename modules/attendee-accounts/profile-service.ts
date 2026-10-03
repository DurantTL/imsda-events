import "server-only";

import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { writeAuditLog } from "@/modules/audit/audit-service";

const optionalProfileValue = (maximum: number) => z.string().trim().max(maximum);
// Same cap the address field uses for each component (modules/forms/address.ts).
const addressValue = optionalProfileValue(200);

export const attendeeProfileSchema = z.strictObject({
  firstName: optionalProfileValue(80),
  lastName: optionalProfileValue(80),
  phone: optionalProfileValue(40),
  shirtSize: optionalProfileValue(80),
  dietaryNeeds: optionalProfileValue(1_000),
  accessibilityNeeds: optionalProfileValue(1_000),
  // Optional; an empty string clears. Components follow the form ADDRESS field.
  mailingLine1: addressValue.optional(),
  mailingLine2: addressValue.optional(),
  mailingCity: addressValue.optional(),
  mailingRegion: addressValue.optional(),
  mailingPostalCode: addressValue.optional(),
  mailingCountry: addressValue.optional(),
  emergencyContactName: optionalProfileValue(120).optional(),
  emergencyContactRelationship: optionalProfileValue(80).optional(),
  emergencyContactPhone: optionalProfileValue(40).optional(),
});

/** What a PATCH may carry: an omitted address/emergency field means unchanged. */
export type AttendeeProfilePatch = z.infer<typeof attendeeProfileSchema>;
/** A full profile, as read back and shown in the form. */
export type AttendeeProfileInput = Required<AttendeeProfilePatch>;
type ProfileKey = keyof AttendeeProfileInput;

/** Optional values: "" in the API, null in the database. */
const optionalKeys = [
  "mailingLine1",
  "mailingLine2",
  "mailingCity",
  "mailingRegion",
  "mailingPostalCode",
  "mailingCountry",
  "emergencyContactName",
  "emergencyContactRelationship",
  "emergencyContactPhone",
] as const satisfies readonly ProfileKey[];

const profileSelect = {
  firstName: true,
  lastName: true,
  phone: true,
  shirtSize: true,
  dietaryNeeds: true,
  accessibilityNeeds: true,
  mailingLine1: true,
  mailingLine2: true,
  mailingCity: true,
  mailingRegion: true,
  mailingPostalCode: true,
  mailingCountry: true,
  emergencyContactName: true,
  emergencyContactRelationship: true,
  emergencyContactPhone: true,
} as const;

type StoredProfile = {
  [K in keyof typeof profileSelect]: string | null;
};

function serializeProfile(profile: StoredProfile, fallback = { firstName: "", lastName: "" }): AttendeeProfileInput {
  return {
    firstName: profile.firstName ?? fallback.firstName,
    lastName: profile.lastName ?? fallback.lastName,
    phone: profile.phone ?? "",
    shirtSize: profile.shirtSize ?? "",
    dietaryNeeds: profile.dietaryNeeds ?? "",
    accessibilityNeeds: profile.accessibilityNeeds ?? "",
    mailingLine1: profile.mailingLine1 ?? "",
    mailingLine2: profile.mailingLine2 ?? "",
    mailingCity: profile.mailingCity ?? "",
    mailingRegion: profile.mailingRegion ?? "",
    mailingPostalCode: profile.mailingPostalCode ?? "",
    mailingCountry: profile.mailingCountry ?? "",
    emergencyContactName: profile.emergencyContactName ?? "",
    emergencyContactRelationship: profile.emergencyContactRelationship ?? "",
    emergencyContactPhone: profile.emergencyContactPhone ?? "",
  };
}

export async function getAttendeeProfile(accountId: string) {
  const profile = await getPrisma().attendeeAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { ...profileSelect, displayName: true },
  });
  const displayNameParts = profile.displayName.trim().split(/\s+/);
  const fallbackFirstName = displayNameParts.shift() ?? "";
  const fallbackLastName = displayNameParts.join(" ");
  return serializeProfile(profile, { firstName: fallbackFirstName, lastName: fallbackLastName });
}

export async function updateAttendeeProfile(
  accountId: string,
  input: AttendeeProfilePatch,
) {
  const profile = attendeeProfileSchema.parse(input);
  // Omitted means unchanged (undefined is skipped by Prisma); "" clears.
  const optional = Object.fromEntries(
    optionalKeys.map((key) => [key, profile[key] === undefined ? undefined : (profile[key] || null)]),
  ) as Record<(typeof optionalKeys)[number], string | null | undefined>;
  return getPrisma().$transaction(async (tx) => {
    const before = serializeProfile(
      await tx.attendeeAccount.findUniqueOrThrow({ where: { id: accountId }, select: profileSelect }),
    );
    const updated = await tx.attendeeAccount.update({
      where: { id: accountId },
      data: {
        ...profile,
        ...optional,
        displayName: `${profile.firstName} ${profile.lastName}`.trim() || undefined,
      },
      select: profileSelect,
    });
    const after = serializeProfile(updated);
    // Field names only: the values (address, emergency contact, dietary and
    // accessibility needs) never go into the audit log.
    const changedFields = (Object.keys(after) as ProfileKey[]).filter(
      (key) => profile[key] !== undefined && before[key] !== after[key],
    );
    if (changedFields.length > 0) {
      await writeAuditLog({
        action: "ATTENDEE_PROFILE_UPDATED",
        entityType: "AttendeeAccount",
        entityId: accountId,
        summary: "An attendee updated their profile.",
        metadata: { actorAttendeeAccountId: accountId, changedFields },
      }, tx);
    }
    return after;
  });
}

/**
 * Prefill-only mapping of the mailing address and emergency contact (#742),
 * by form field key. `mailing_address` is the structured ADDRESS field
 * (components as in modules/forms/address.ts); the others are the plain
 * text keys some templates use. Nothing here is ever written back.
 */
function personalPrefill(profile: AttendeeProfileInput) {
  const address = Object.fromEntries(
    Object.entries({
      line1: profile.mailingLine1,
      line2: profile.mailingLine2,
      locality: profile.mailingCity,
      region: profile.mailingRegion,
      postalCode: profile.mailingPostalCode,
      country: profile.mailingCountry,
    }).filter(([, value]) => value),
  ) as Record<string, string>;
  const [line1, line2, city, state, zip, country] = [
    profile.mailingLine1, profile.mailingLine2, profile.mailingCity,
    profile.mailingRegion, profile.mailingPostalCode, profile.mailingCountry,
  ];
  return {
    ...(Object.keys(address).length > 0 ? { mailing_address: address } : {}),
    address_line_1: line1,
    address_line_2: line2,
    city,
    state,
    zip,
    country,
    emergency_contact_name: profile.emergencyContactName,
    emergency_contact_phone: profile.emergencyContactPhone,
  };
}

/** The profile with the address and emergency contact blanked. */
export function withoutPersonalDetails(profile: AttendeeProfileInput): AttendeeProfileInput {
  return { ...profile, ...Object.fromEntries(optionalKeys.map((key) => [key, ""])) } as AttendeeProfileInput;
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
    director_name: name,
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
    ...personalPrefill(profile),
  };
}
