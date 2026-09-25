/**
 * Re-exported from the shared, principal-agnostic schemas in
 * `modules/passkeys/schemas.ts` so staff passkeys validate requests the same
 * way instead of duplicating the zod shapes.
 */
export { passkeyRegistrationSchema, passkeyVerificationSchema } from "@/modules/passkeys/schemas";
