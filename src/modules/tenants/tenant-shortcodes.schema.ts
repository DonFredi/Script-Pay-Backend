import { z } from "zod";

/**
 * An omitted optional credential and one submitted as "" mean the same thing:
 * not provided. The frontend's matching schema types these as
 * `.optional().or(z.literal(""))` and its api layer POSTs the form object
 * verbatim, so an untouched input arrives here as "" — which `.min(1)` rejected
 * outright. Creating a B2C shortcode from the dashboard therefore failed with a
 * "Too small" error on `passkey`, a field a B2C shortcode is not supposed to
 * carry in the first place.
 *
 * Same preprocess pattern, and same reasoning, as `optionalString` in
 * config/env.schema.ts. It has to run BEFORE the length check, which is why it
 * wraps rather than chains.
 *
 * It also strips a matched pair of wrapping quotes, which `.trim()` alone does not.
 *
 * A Daraja security credential is 344 characters of base64 that operators copy out
 * of Safaricom's portal — and often out of a JSON response, a quoted CSV cell, or a
 * shell variable, all of which carry the surrounding `"` along with the value. The
 * result stores as `"Ab3dEf…P=="` instead of `Ab3dEf…P==`, which is still a non-empty
 * string, still passes every check here, and still encrypts and decrypts perfectly.
 * It only fails at Safaricom, days later, as `The initiator information is invalid.`
 * — an error that points at the initiator NAME and gives no hint that the credential
 * has two extra characters on it. That cost a real debugging session; see
 * docs/decisions.md entry 39.
 *
 * Only a MATCHED leading+trailing pair is removed, so a value that legitimately
 * contains a quote on one side is left exactly as submitted rather than silently
 * altered.
 */
const stripWrappingQuotes = (v: string) => {
  const trimmed = v.trim();
  const quoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")));
  return quoted ? trimmed.slice(1, -1).trim() : trimmed;
};

const optionalCredential = () =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const cleaned = stripWrappingQuotes(v);
      return cleaned === "" ? undefined : cleaned;
    },
    z.string().trim().min(1).optional(),
  );

const shortcodeBaseSchema = z
  .object({
    type: z.enum(["TILL", "PAYBILL", "B2C"]),
    shortcode: z.string().trim().regex(/^\d{5,7}$/, "Shortcode must be 5 to 7 digits"),
    isDefault: z.boolean().optional().default(false),
    // Required for TILL/PAYBILL (STK), forbidden for B2C — enforced below rather than
    // with a discriminated union so the single "which fields are required" message
    // stays close to the same shape mpesaCredentialsSchema used before this was split.
    passkey: optionalCredential(),
    // B2C only. securityCredential is the value Safaricom's portal emits: the
    // initiator password already RSA-encrypted against their certificate — see
    // TenantShortcode.mpesaSecurityCredentialEncrypted for why this app never
    // touches the raw password.
    initiatorName: optionalCredential(),
    securityCredential: optionalCredential(),
  })
  // Rejects an unrecognized field instead of silently dropping it — see
  // docs/decisions.md entry 22, which set this precedent on the auth schemas.
  // Applied to the base object, since .refine() below returns a ZodEffects that
  // carries no .strict() of its own.
  .strict();

export const createShortcodeSchema = shortcodeBaseSchema.refine(
  (v) => {
    if (v.type === "B2C") return Boolean(v.initiatorName) && Boolean(v.securityCredential) && !v.passkey;
    return Boolean(v.passkey) && !v.initiatorName && !v.securityCredential;
  },
  {
    message:
      "TILL/PAYBILL shortcodes require a passkey and no B2C credentials; a B2C shortcode requires an initiator " +
      "name and security credential and no passkey",
    path: ["type"],
  },
);
export type CreateShortcodeDto = z.infer<typeof createShortcodeSchema>;

// Same field set as create, but every field is optional — updating a shortcode is a
// partial patch (e.g. rotating just the passkey), and `type`/`shortcode` themselves
// are also editable since a typo'd shortcode shouldn't require delete-and-recreate.
export const updateShortcodeSchema = shortcodeBaseSchema.partial();
export type UpdateShortcodeDto = z.infer<typeof updateShortcodeSchema>;
