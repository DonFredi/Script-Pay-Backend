import { SetMetadata } from "@nestjs/common";
import type { ApiKeyScope } from "@prisma/client";

export const API_KEY_SCOPES_KEY = "apiKeyScopes";

/** Usage: @RequireScopes("PAYMENTS_INITIATE") on a controller method behind ApiKeyGuard */
export const RequireScopes = (...scopes: ApiKeyScope[]) => SetMetadata(API_KEY_SCOPES_KEY, scopes);
