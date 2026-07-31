import { SetMetadata } from "@nestjs/common";

export const SKIP_RESPONSE_TRANSFORM_KEY = "skipResponseTransform";

/**
 * Use on any controller/route whose response shape is dictated by an external
 * contract we don't control — e.g. the Daraja webhook, which must return
 * exactly { ResultCode, ResultDesc } or Safaricom's retry behavior kicks in.
 */
export const SkipResponseTransform = () => SetMetadata(SKIP_RESPONSE_TRANSFORM_KEY, true);
