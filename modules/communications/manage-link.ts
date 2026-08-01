/**
 * Placeholders a message body carries instead of a private link. Delivery mints
 * a fresh registration access token per message and swaps these for real URLs,
 * so a token is never written into an outbox row, a template version, an audit
 * log, or a captured preview.
 */
export const REGISTRATION_MANAGE_LINK_SENTINEL = "__IMSDA_PRIVATE_MANAGE_LINK__";

/**
 * The API base for the same private token, used by the check-in QR image whose
 * `<img src>` must reach a route rather than a page.
 */
export const REGISTRATION_MANAGE_API_SENTINEL = "__IMSDA_PRIVATE_MANAGE_API__";
