import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import * as argon2 from "argon2";
import { PrismaPrivilegedService } from "../../modules/prisma/prisma-privileged.service";
import { API_KEY_SCOPES_KEY } from "../decorators/api-key-scopes.decorator";
import type { ApiKeyScope } from "@prisma/client";

/**
 * API keys are hashed with argon2 before storage — a leaked database backup does not
 * hand out usable keys. Each key carries explicit scopes so a merchant can issue a
 * read-only reporting key separately from a payments-initiating key, containing blast
 * radius if one leaks.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    // Resolves WHICH tenant this key belongs to — the tenant is the OUTPUT of this
    // lookup, not an input, so it can't go through withTenantContext. See
    // PrismaPrivilegedService's own doc comment.
    private readonly prisma: PrismaPrivilegedService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const rawKey: string | undefined = request.headers["x-api-key"];

    if (!rawKey) {
      throw new UnauthorizedException("Missing API key");
    }

    const prefix = rawKey.slice(0, 8);

    // Narrow by prefix first (indexed, cheap) before running the expensive argon2 verify
    // against every candidate — avoids a full-table hash comparison on every request.
    const candidates = await this.prisma.apiKey.findMany({
      where: { keyPrefix: prefix, revokedAt: null },
    });

    const pepper = process.env.API_KEY_HASH_PEPPER ?? "";

    let matched = null;
    for (const candidate of candidates) {
      if (await argon2.verify(candidate.keyHash, rawKey + pepper)) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      throw new UnauthorizedException("Invalid API key");
    }

    if (matched.expiresAt && matched.expiresAt < new Date()) {
      throw new UnauthorizedException("API key expired");
    }

    const requiredScopes = this.reflector.getAllAndOverride<ApiKeyScope[]>(API_KEY_SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredScopes?.length) {
      const hasAllScopes = requiredScopes.every((scope) => matched.scopes.includes(scope));
      if (!hasAllScopes) {
        throw new UnauthorizedException("API key missing required scope");
      }
    }

    // Fire-and-forget usage tracking — don't block the request on this write.
    void this.prisma.apiKey.update({
      where: { id: matched.id },
      data: { lastUsedAt: new Date() },
    });

    request.tenantId = matched.tenantId;
    request.apiKeyScopes = matched.scopes;
    request.apiKeyId = matched.id; // for audit-log traceability on routes that mutate state via API key auth

    return true;
  }
}
