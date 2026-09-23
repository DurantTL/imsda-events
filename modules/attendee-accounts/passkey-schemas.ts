import { z } from "zod";

/**
 * Only the outer shape is checked here; the WebAuthn library validates the
 * contents. Passed through as-is so no field the library needs is dropped.
 */
const credentialResponse = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal("public-key"),
  response: z.looseObject({ clientDataJSON: z.string().min(1).max(8192) }),
});

export const passkeyRegistrationSchema = z.object({
  response: credentialResponse.extend({
    response: z.looseObject({ clientDataJSON: z.string().min(1).max(8192), attestationObject: z.string().min(1).max(65536) }),
  }),
  name: z.string().max(60).optional(),
}).strict();

export const passkeyVerificationSchema = z.object({
  response: credentialResponse.extend({
    response: z.looseObject({
      clientDataJSON: z.string().min(1).max(8192),
      authenticatorData: z.string().min(1).max(8192),
      signature: z.string().min(1).max(8192),
    }),
  }),
}).strict();
