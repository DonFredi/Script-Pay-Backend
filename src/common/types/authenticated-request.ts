import type { Request } from "express";
import type { ApiKeyScope } from "@prisma/client";
import type { AuthenticatedUser } from "../decorators/current-user.decorator";

/**
 * Express's Request as augmented by AccessTokenGuard (`user`) and ApiKeyGuard
 * (`tenantId`, `apiKeyScopes`) — neither field exists until the corresponding
 * guard has run, so both stay optional here rather than asserted as always-present.
 */
export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
  tenantId?: string;
  apiKeyScopes?: ApiKeyScope[];
}
